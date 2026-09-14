import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { codexUsageSnapshot, readCodexUsage, createUsageCollector, postCodexUsage, USAGE_POLL_MS } from '../scripts/codex-usage.mjs';
import { createSupervisor } from '../scripts/runtime.mjs';

const now = Date.parse('2026-01-01T00:00:00Z');
const result = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: now / 1000 + 900 } },
  codex_bengalfox: { primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: now / 1000 + 100 } },
  private_account_id: { primary: { usedPercent: 77 } } }, rateLimitResetCredits: { credits: [{ id: 'private-credit' }] } };
const sample = () => codexUsageSnapshot(result, { now });
const absent = () => codexUsageSnapshot(null, { now });

test('Codex quota extraction keeps separate known buckets and never serializes account or credit identifiers', () => {
  const value = sample(); assert.equal(value.windows.length, 2);
  assert.equal(value.windows[0].id, 'codex:primary'); assert.equal(value.windows[1].id, 'codex_bengalfox:primary');
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.equal(absent().status, 'unavailable');
  assert.deepEqual(codexUsageSnapshot({ rateLimits: { primary: { usedPercent: null } } }, { now }).windows, []);
  assert.deepEqual(codexUsageSnapshot({ rateLimitsByLimitId: {}, rateLimits: result.rateLimitsByLimitId.codex }, { now }).windows, []);
  const legacy = codexUsageSnapshot({ rateLimits: result.rateLimitsByLimitId.codex }, { now });
  assert.equal(legacy.windows[0].remainingPercent, 83);
});

test('the RPC subprocess sends only the read-only handshake and quota method, then shuts down', async () => {
  const requests = [], children = [];
  const value = await readCodexUsage({ now: () => now, spawnProcess(command, args, options) {
    assert.deepEqual(args, ['app-server', '--stdio']); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import readline from 'node:readline';
      const rl=readline.createInterface({input:process.stdin}); let step=0;
      rl.on('line',line=>{ const message=JSON.parse(line); const expected=['initialize','initialized','account/rateLimits/read'][step++];
        if(message.method!==expected) process.exit(4);
        if(message.id===1) console.log(JSON.stringify({id:1,result:{}}));
        if(message.id===2) console.log(JSON.stringify({id:2,result:${JSON.stringify(result)}}));
      });
    `], options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = value => { requests.push(JSON.parse(value).method); return write(value); };
    children.push(child); return child;
  } });
  assert.equal(value.status, 'live'); assert.deepEqual(requests, ['initialize', 'initialized', 'account/rateLimits/read']);
  await Promise.all(children.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : undefined));
});

test('unsupported/authentication/timeout failures return only fixed reasons, with no invented quota', async () => {
  const run = error => readCodexUsage({ timeoutMs: 1000, spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e',
    `process.stdin.once('data',()=>console.log(JSON.stringify({id:1,error:${JSON.stringify(error)}})))`], options) });
  assert.equal((await run({ code: -32601, message: 'private identifier' })).reason, 'unsupported');
  const auth = await run({ code: -1, message: 'Authentication failed for private identifier' });
  assert.equal(auth.reason, 'authentication-required'); assert.equal(JSON.stringify(auth).includes('private'), false);
  const timeout = await readCodexUsage({ timeoutMs: 50, spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options) });
  assert.equal(timeout.reason, 'timeout'); assert.deepEqual(timeout.windows, []);
});

test('collector polls serially every minute, backs off failures, and stops scheduled work', async () => {
  const timers = [], sent = []; let fail = false;
  const collector = createUsageCollector({ read: async () => fail ? absent() : sample(), post: async value => sent.push(value),
    schedule(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel(timer) { timer.cancelled = true; } });
  await collector.start(); assert.equal(timers[0].delay, USAGE_POLL_MS); assert.equal(sent.length, 1);
  fail = true; await timers[0].fn(); assert.equal(timers[1].delay, USAGE_POLL_MS);
  await timers[1].fn(); assert.equal(timers[2].delay, USAGE_POLL_MS * 2);
  await timers[2].fn(); assert.equal(timers[3].delay, USAGE_POLL_MS * 4);
  collector.stop(); assert.equal(timers[3].cancelled, true); await timers[3].fn(); assert.equal(sent.length, 4);
});

test('collector retries receiver failures and prevents concurrent polls; stop aborts an in-flight read', async () => {
  const timers = []; let release, observedSignal, reads = 0;
  const collector = createUsageCollector({ read: ({ signal }) => { reads++; observedSignal = signal; return new Promise(resolve => { release = resolve; }); },
    post: async () => { throw new Error('offline'); }, schedule(fn, delay) { timers.push({ fn, delay }); return timers.at(-1); } });
  const pending = collector.start(); await collector.start(); assert.equal(reads, 1);
  release(sample()); await pending; assert.equal(timers[0].delay, 60000);
  const next = timers[0].fn(); collector.stop(); assert.equal(observedSignal.aborted, true); release(sample()); await next;
  assert.equal(timers.length, 1);
});

test('posting usage rejects nonlocal receivers and sends only sanitized anonymous measurements', async () => {
  await assert.rejects(postCodexUsage(sample(), { endpoint: 'https://example.com/api/usage' }));
  let body;
  await postCodexUsage({ ...sample(), token: 'private' }, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error'); body = options.body; return { ok: true };
  } });
  assert.equal(body.includes('private'), false);
});

test('runtime keeps bridge alive after usage collector failure and supports disabling the collector', () => {
  const timers = [], stopped = [];
  const supervisor = createSupervisor({ env: {}, spawnProcess() { const child = new EventEmitter(); child.kill = () => child.emit('exit', 0); return child; },
    schedule(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, cancel() {}, onStop: code => stopped.push(code), log() {} });
  supervisor.startBridge(); supervisor.startUsage(); supervisor.children.get('usage').emit('exit', 1);
  assert.equal(supervisor.closing, false); assert.equal(supervisor.children.has('bridge'), true); assert.equal(timers[0].delay, 30000);
  supervisor.stop(); assert.deepEqual(stopped, [0]);
  const disabled = createSupervisor({ env: { AGENT_OFFICE_DISABLE_USAGE: '1' }, spawnProcess() { throw new Error('must not spawn'); } });
  disabled.startUsage(); assert.equal(disabled.children.size, 0);
});
