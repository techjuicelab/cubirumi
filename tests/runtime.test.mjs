import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchAgent, SERVICE_LABEL } from '../scripts/install-runtime.mjs';
import { createSupervisor, waitForBridge } from '../scripts/runtime.mjs';
import { defaultDataDir } from '../server/settings.mjs';

test('launch agent uses the installing Node executable and only necessary environment settings', () => {
  const config = createLaunchAgent({ root: '/work/office & notes', home: '/home/example',
    env: { PATH: '/bin:/usr/bin', CODEX_HOME: '/work/custom-codex', AGENT_OFFICE_DATA_DIR: '/work/private data',
      AGENT_OFFICE_DISABLE_USAGE: '1', AGENT_OFFICE_CODEX_BIN: '/work/custom-codex-bin', API_KEY: 'DO_NOT_COPY' } });
  assert.equal(config.nodePath, process.execPath);
  assert.equal(SERVICE_LABEL, 'io.agent-office.runtime');
  assert.match(config.plistPath, /io\.agent-office\.runtime\.plist$/);
  assert.ok(config.plist.includes(dirname(process.execPath)));
  assert.ok(config.plist.includes('office &amp; notes'));
  assert.ok(config.plist.includes('/work/custom-codex'));
  assert.ok(config.plist.includes('AGENT_OFFICE_DISABLE_USAGE'));
  assert.ok(config.plist.includes('/work/custom-codex-bin'));
  assert.equal(config.dataDir, '/work/private data');
  assert.doesNotMatch(config.plist, /DO_NOT_COPY|API_KEY/);
});

function fixture(env = {}, parentInput) {
  const spawned = [], timers = [], stopped = [];
  const supervisor = createSupervisor({ root: '/work/agent-office', nodePath: '/runtime/node', env, parentInput,
    spawnProcess(command, args, options) {
      const child = new EventEmitter(); child.signals = [];
      child.kill = signal => { child.signals.push(signal); child.emit('exit', 0); };
      spawned.push({ command, args, options, child }); return child;
    },
    schedule(fn, delay) { const timer = { fn, delay, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    cancel(timer) { timer.cancelled = true; }, log() {}, onStop(code) { stopped.push(code); },
  });
  return { supervisor, spawned, timers, stopped };
}

test('runtime children share a private data directory and launch identity without mutating the parent environment', () => {
  const env = {}, f = fixture(env);
  f.supervisor.startBridge(); f.supervisor.startObserver(); f.supervisor.startUsage();
  f.supervisor.startClaudeModels(); f.supervisor.startClaudeObserver();
  assert.equal(f.spawned.length, 5);
  for (const child of f.spawned) {
    assert.equal(child.options.env.AGENT_OFFICE_DATA_DIR, defaultDataDir());
    assert.equal(child.options.env.AGENT_OFFICE_INSTANCE_ID, f.supervisor.instanceId);
  }
  assert.ok(f.supervisor.instanceId); assert.deepEqual(env, {});
  const second = fixture({ AGENT_OFFICE_DATA_DIR: '/work/private data', AGENT_OFFICE_INSTANCE_ID: 'desktop-launch' });
  second.supervisor.startBridge();
  assert.equal(second.spawned[0].options.env.AGENT_OFFICE_DATA_DIR, '/work/private data');
  assert.equal(second.supervisor.instanceId, 'desktop-launch');
  const third = fixture(); assert.notEqual(third.supervisor.instanceId, f.supervisor.instanceId);
  f.supervisor.stop(); second.supervisor.stop(); third.supervisor.stop();
});

test('a foreign or unidentifiable service on the bridge port never starts collectors', async () => {
  for (const health of [
    { ok: true },
    { ok: true, service: 'different-service', instanceId: 'owned' },
    { ok: true, service: 'agent-office', instanceId: 'another-office' },
    { ok: true, service: 'agent-office' },
    { ok: false, service: 'agent-office', instanceId: 'owned' },
  ]) {
    const f = fixture({ AGENT_OFFICE_INSTANCE_ID: 'owned' }); f.supervisor.startBridge();
    const ready = await waitForBridge(f.supervisor, { attempts: 1,
      fetchImpl: async () => new Response(JSON.stringify(health)) });
    assert.equal(ready, false); assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.stopped, [1]);
  }
});

test('collectors wait for the matching bridge identity and cannot start after shutdown', async () => {
  const f = fixture({ AGENT_OFFICE_INSTANCE_ID: 'owned' }); f.supervisor.startBridge();
  let polls = 0;
  assert.equal(await waitForBridge(f.supervisor, { attempts: 2,
    wait: async () => { assert.equal(f.spawned.length, 1); },
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ ok: true, service: 'agent-office', instanceId: ++polls === 1 ? 'other' : 'owned' }));
    },
  }), true);
  assert.equal(f.spawned.length, 5); f.supervisor.stop();
  const ended = fixture({ AGENT_OFFICE_INSTANCE_ID: 'owned' }); ended.supervisor.startBridge();
  await waitForBridge(ended.supervisor, { attempts: 1, fetchImpl: async () => {
    ended.supervisor.stop();
    return new Response(JSON.stringify({ ok: true, service: 'agent-office', instanceId: 'owned' }));
  } });
  assert.equal(ended.spawned.length, 1); assert.deepEqual(ended.stopped, [0]);
});

test('only a managed desktop parent pipe controls runtime child lifetime', () => {
  for (const event of ['end', 'close', 'error']) {
    const input = new EventEmitter(); input.resume = () => {}; input.destroy = () => {};
    const f = fixture({ AGENT_OFFICE_MANAGED_DESKTOP: '1' }, input);
    f.supervisor.startBridge(); f.supervisor.startObserver();
    input.emit(event, ...(event === 'error' ? [new Error('parent pipe closed')] : []));
    assert.equal(f.supervisor.closing, true); assert.deepEqual(f.stopped, [0]);
    assert.equal(input.listenerCount('end'), 0); assert.equal(input.listenerCount('close'), 0);
    for (const child of f.spawned) assert.deepEqual(child.child.signals, ['SIGTERM']);
  }
  const input = new EventEmitter(), f = fixture({}, input);
  f.supervisor.startBridge(); input.emit('end'); input.emit('close');
  assert.equal(f.supervisor.closing, false); f.supervisor.stop();
});

test('closing an actual parent pipe exits the managed runtime and its own stub children', { timeout: 8000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-office-parent-pipe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'server')); await mkdir(join(root, 'scripts'));
  const stub = "process.stdout.write(`child:${process.pid}\\n`); setInterval(() => {}, 1000);";
  await writeFile(join(root, 'server', 'index.mjs'), stub);
  await writeFile(join(root, 'scripts', 'codex-observer.mjs'), stub);
  const moduleUrl = new URL('../scripts/runtime.mjs', import.meta.url).href;
  const source = `import { createSupervisor } from ${JSON.stringify(moduleUrl)};\nconst supervisor = createSupervisor({ root: ${JSON.stringify(root)} });\nsupervisor.startBridge(); supervisor.startObserver();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, AGENT_OFFICE_MANAGED_DESKTOP: '1', AGENT_OFFICE_DATA_DIR: join(root, 'private') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pids = new Set(); let output = '';
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stub children did not start')), 3000);
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const match of output.matchAll(/child:(\d+)\n/gu)) pids.add(Number(match[1]));
      if (pids.size === 2) { clearTimeout(timeout); resolve(); }
    });
  });
  const exited = once(child, 'exit'); child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  pids.clear();
});

test('missing Codex database stops only the observer and schedules a bounded retry', () => {
  const f = fixture(); f.supervisor.startBridge(); f.supervisor.startObserver();
  f.spawned[1].child.emit('exit', 2);
  assert.equal(f.supervisor.closing, false);
  assert.equal(f.supervisor.children.has('bridge'), true);
  assert.deepEqual(f.spawned[0].child.signals, []);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 30_000);
  f.timers[0].fn();
  assert.equal(f.spawned.length, 3);
  assert.equal(f.spawned[2].command, '/runtime/node');
  assert.ok(f.spawned[2].args[0].endsWith('/scripts/codex-observer.mjs'));
  f.supervisor.stop(); assert.deepEqual(f.stopped, [0]);
});

test('observer spawn error followed by exit schedules only one retry; bridge failure shuts down cleanly', () => {
  const f = fixture(); f.supervisor.startBridge(); f.supervisor.startObserver();
  f.spawned[1].child.emit('error', new Error('failed')); f.spawned[1].child.emit('exit', 1);
  assert.equal(f.timers.length, 1);
  f.spawned[0].child.emit('exit', 1);
  assert.equal(f.supervisor.closing, true); assert.equal(f.timers[0].cancelled, true);
  assert.deepEqual(f.stopped, [1]);
});

test('Claude-only users can keep the office running without launching the Codex observer', () => {
  const f = fixture({ AGENT_OFFICE_DISABLE_OBSERVER: '1' });
  f.supervisor.startBridge(); f.supervisor.startObserver();
  assert.equal(f.spawned.length, 1); assert.equal(f.timers.length, 0);
  f.supervisor.stop(); assert.deepEqual(f.stopped, [0]);
});

test('Claude model reconciliation starts independently and a crash leaves the bridge running', () => {
  const f = fixture({ AGENT_OFFICE_DISABLE_OBSERVER: '1' });
  f.supervisor.startBridge(); f.supervisor.startObserver(); f.supervisor.startClaudeModels();
  assert.equal(f.spawned.length, 2);
  assert.ok(f.spawned[1].args[0].endsWith('/scripts/claude-models.mjs'));
  f.spawned[1].child.emit('exit', 1);
  assert.equal(f.supervisor.children.has('bridge'), true);
  assert.equal(f.timers[0].delay, 30_000);
  f.timers[0].fn();
  assert.equal(f.spawned.length, 3);
  f.supervisor.stop();
  const disabled = fixture({ AGENT_OFFICE_DISABLE_CLAUDE_MODELS: '1' });
  disabled.supervisor.startClaudeModels();
  assert.equal(disabled.spawned.length, 0);
});

test('Claude conversation observation starts independently, retries a crash, and respects its opt-out', () => {
  const f = fixture({ AGENT_OFFICE_DISABLE_OBSERVER: '1' });
  f.supervisor.startBridge(); f.supervisor.startClaudeObserver();
  assert.ok(f.spawned[1].args[0].endsWith('/scripts/claude-observer.mjs'));
  f.spawned[1].child.emit('exit', 1);
  assert.equal(f.supervisor.children.has('bridge'), true);
  assert.equal(f.timers[0].delay, 30_000);
  f.timers[0].fn(); assert.equal(f.spawned.length, 3);
  f.supervisor.stop();
  const disabled = fixture({ AGENT_OFFICE_DISABLE_CLAUDE_OBSERVER: '1' });
  disabled.supervisor.startClaudeObserver(); assert.equal(disabled.spawned.length, 0);
});

test('custom CODEX_HOME without a database fails quietly and does not create Codex state', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-office-clean-codex-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/codex-observer.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--once', '--dry-run'], {
    env: { ...process.env, CODEX_HOME: temporary, AGENT_OFFICE_DATA_DIR: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 2); assert.equal(run.stdout, '');
  assert.match(run.stderr, /읽기 전용/); assert.deepEqual(await readdir(temporary), []);
});
