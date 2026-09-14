import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opaqueId } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { claudeProjectsDir, collectClaudeModels, pollClaudeModels, createClaudeModelCollector } from '../scripts/claude-models.mjs';

const START = '2026-09-13T01:00:00.000Z';
const OBSERVED = '2026-09-13T01:00:20.000Z';
const END = '2026-09-13T01:01:00.000Z';
const NOW = Date.parse('2026-09-13T01:02:00.000Z');
const SESSION = 'fixture-session';
const root = fileURLToPath(new URL('../', import.meta.url));
const agentId = (raw = null, session = SESSION) => `claude-${opaqueId(session)}-${raw === null ? 'main' : opaqueId(raw)}`;
const snapshot = (raw = null, extra = {}) => ({ id: `event-${raw || 'main'}`, agentId: agentId(raw),
  source: 'claude', modelEvidence: 'unknown', sessionId: SESSION, taskStartedAt: START,
  timestamp: END, status: 'idle', title: 'PRIVATE SNAPSHOT TITLE', ...extra });
const record = (raw, model, extra = {}) => ({ type: 'assistant', sessionId: SESSION,
  isSidechain: raw !== null, ...(raw === null ? {} : { agentId: raw }), timestamp: OBSERVED,
  message: { role: 'assistant', model, content: 'PRIVATE ASSISTANT OUTPUT', tool_input: { secret: 'PRIVATE INPUT' } }, ...extra });

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-office-models-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'claude'), projectsDir = join(configDir, 'projects');
  const project = join(projectsDir, '-private-project'), subagents = join(project, SESSION, 'subagents');
  await mkdir(subagents, { recursive: true });
  async function transcript(path, records) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    return path;
  }
  return { dir, configDir, projectsDir, project, subagents, transcript };
}

async function receiver(t, state, { failPosts = 0 } = {}) {
  const requests = [], posted = [];
  const server = createServer(async (request, response) => {
    requests.push([request.method, request.url]);
    if (request.method === 'GET' && request.url === '/api/state') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(state)); return;
    }
    if (request.method === 'POST' && request.url === '/api/events') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(failPosts-- > 0 ? 503 : 200); response.end('{}'); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}/api/events`, requests, posted };
}

test('model repair matches registered session and raw child filename hashes, including workflow folders', async t => {
  const f = await fixture(t);
  await f.transcript(join(f.project, `${SESSION}.jsonl`), [record(null, 'claude-main-own'), record('child', 'claude-parent-sidechain')]);
  await f.transcript(join(f.subagents, 'agent-child.jsonl'), [record('child', 'claude-child-own')]);
  await f.transcript(join(f.subagents, 'workflows', 'wf-1', 'agent-flow.jsonl'), [record('flow', 'claude-flow-own')]);
  await f.transcript(join(f.subagents, 'agent-unregistered.jsonl'), [record('unregistered', 'claude-unregistered')]);
  const agents = [snapshot(), snapshot('child'), snapshot('flow'), snapshot('unborn'),
    snapshot('known', { model: 'claude-known', modelEvidence: 'reported' }), snapshot('fake', { source: 'codex' }),
    snapshot('child', { agentId: agentId('child', 'other-session'), id: 'mismatched-session-hash' })];
  const events = await collectClaudeModels({ agents }, { projectsDir: f.projectsDir, now: NOW });
  assert.deepEqual(events.map(event => [event.agentId, event.model]), [
    [agentId(), 'claude-main-own'], [agentId('child'), 'claude-child-own'], [agentId('flow'), 'claude-flow-own'],
  ]);
  for (const event of events) {
    assert.equal(event.type, 'agent.model'); assert.equal(event.observation, 'claude-log');
    assert.equal(event.modelEvidence, 'reported'); assert.equal(event.modelObservedAt, OBSERVED);
    assert.equal(event.timestamp, new Date(NOW).toISOString());
    assert.ok(!Object.hasOwn(event, 'status')); assert.ok(!Object.hasOwn(event, 'sessionId'));
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|transcript|subagents|unregistered|parent-sidechain/u);
  const again = await collectClaudeModels({ agents }, { projectsDir: f.projectsDir, now: NOW + 1000 });
  assert.deepEqual(again.map(event => event.id), events.map(event => event.id), 'retry identity does not depend on send time');
  const changed = await collectClaudeModels({ agents: [snapshot(null, { id: 'new-lifecycle' })] }, { projectsDir: f.projectsDir, now: NOW });
  assert.notEqual(changed[0].id, events[0].id, 'CAS reference is part of the event identity');
});

test('repair rejects previous tasks, future records, foreign sessions, anonymous children, and parent fallback', async t => {
  const f = await fixture(t);
  await f.transcript(join(f.project, `${SESSION}.jsonl`), [record(null, 'claude-parent-only')]);
  const children = ['old', 'future', 'foreign', 'anonymous', 'missing'];
  await f.transcript(join(f.subagents, 'agent-old.jsonl'), [record('old', 'claude-old', { timestamp: '2026-09-13T00:59:59.999Z' })]);
  await f.transcript(join(f.subagents, 'agent-future.jsonl'), [record('future', 'claude-future', { timestamp: '2026-09-13T01:01:00.001Z' })]);
  await f.transcript(join(f.subagents, 'agent-foreign.jsonl'), [record('foreign', 'claude-foreign', { sessionId: 'foreign-session' })]);
  await f.transcript(join(f.subagents, 'agent-anonymous.jsonl'), [record(null, 'claude-anonymous', { isSidechain: true })]);
  assert.deepEqual(await collectClaudeModels({ agents: children.map(raw => snapshot(raw)) }, { projectsDir: f.projectsDir }), []);
  assert.deepEqual(await collectClaudeModels({ agents: [snapshot(null, { taskStartedAt: 'invalid' })] }, { projectsDir: f.projectsDir }), []);
  assert.deepEqual(await collectClaudeModels({ agents: [snapshot(null, { sessionId: '../escape' })] }, { projectsDir: f.projectsDir }), []);
});

test('repair refuses symbolic-link projects, directories, transcript files, and hard links', async t => {
  const f = await fixture(t);
  const outside = join(f.dir, 'outside'); await mkdir(outside);
  const source = await f.transcript(join(outside, `${SESSION}.jsonl`), [record(null, 'claude-outside')]);
  await symlink(outside, join(f.projectsDir, 'linked-project'), 'dir');
  await symlink(source, join(f.project, `${SESSION}.jsonl`));
  const child = await f.transcript(join(outside, 'agent-child.jsonl'), [record('child', 'claude-outside-child')]);
  await link(child, join(f.subagents, 'agent-child.jsonl'));
  await mkdir(join(f.subagents, 'workflows')); await symlink(outside, join(f.subagents, 'workflows', 'linked-workflow'), 'dir');
  let reads = 0;
  const events = await collectClaudeModels({ agents: [snapshot(), snapshot('child')] }, { projectsDir: f.projectsDir,
    readEvidence: async () => { reads++; return { model: 'claude-must-not-read', timestamp: OBSERVED }; } });
  assert.deepEqual(events, []); assert.equal(reads, 0);
  await symlink(f.projectsDir, join(f.dir, 'linked-root'), 'dir');
  assert.deepEqual(await collectClaudeModels({ agents: [snapshot()] }, { projectsDir: join(f.dir, 'linked-root') }), []);
  assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: f.configDir }), f.projectsDir);
});

test('isolated HTTP polling reads registry, dry-runs without POST, and retries the identical failed correction', async t => {
  const f = await fixture(t);
  await f.transcript(join(f.project, `${SESSION}.jsonl`), [record(null, 'claude-fixture')]);
  const state = { agents: [snapshot()], unrelated: 'PRIVATE SERVER DATA' };
  const target = await receiver(t, state, { failPosts: 1 });
  const options = { endpoint: target.endpoint, projectsDir: f.projectsDir, now: NOW };
  const preview = await pollClaudeModels({ ...options, dryRun: true });
  assert.equal(preview.length, 1); assert.deepEqual(target.requests, [['GET', '/api/state']]);
  await assert.rejects(pollClaudeModels(options));
  await pollClaudeModels(options);
  assert.equal(target.posted.length, 2); assert.deepEqual(target.posted[0], target.posted[1]);
  assert.equal(target.posted[0].referenceEventId, 'event-main');
  assert.deepEqual(state.agents, [snapshot()], 'model collection does not mutate its input lifecycle');
  assert.doesNotMatch(JSON.stringify(target.posted), /PRIVATE|status|prompt|transcript/u);
  for (const endpoint of ['https://example.com/api/events', 'http://127.0.0.1/api/state', 'http://user:pass@localhost/api/events', 'http://localhost/api/events?token=x']) {
    await assert.rejects(pollClaudeModels({ ...options, endpoint }));
  }
});

test('serial collector does not overlap reads and keeps retrying failures until stopped', async () => {
  const scheduled = []; let reads = 0, release, canceled = false;
  const collector = createClaudeModelCollector({ poll: async ({ signal }) => {
    reads++; assert.equal(signal.aborted, false);
    if (reads === 1) await new Promise(resolve => { release = resolve; });
    if (reads === 2) throw new Error('PRIVATE FAILURE');
  }, schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, cancel: () => { canceled = true; } });
  const first = collector.start(); assert.equal(collector.running, true);
  await collector.start(); assert.equal(reads, 1);
  release(); await first;
  assert.equal(scheduled[0].delay, 10_000);
  await scheduled.shift().callback(); assert.equal(reads, 2); assert.equal(scheduled.length, 1);
  await scheduled.shift().callback(); assert.equal(reads, 3);
  collector.stop(); assert.equal(canceled, true);
  await scheduled[0].callback(); assert.equal(reads, 3);
});

test('CLI --once --dry-run uses temporary CLAUDE_CONFIG_DIR and emits sanitized JSON only', async t => {
  const f = await fixture(t);
  await f.transcript(join(f.project, `${SESSION}.jsonl`), [record(null, 'claude-fixture-cli')]);
  const target = await receiver(t, { agents: [snapshot()] });
  const before = await readdir(f.configDir);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/claude-models.mjs', '--once', '--dry-run'], { cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir, AGENT_OFFICE_ENDPOINT: target.endpoint }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 5000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const events = JSON.parse(result.stdout); assert.equal(events[0].model, 'claude-fixture-cli');
  assert.doesNotMatch(result.stdout, /PRIVATE|subagents|transcript|prompt|auth/u);
  assert.deepEqual(target.requests, [['GET', '/api/state']]);
  assert.deepEqual(await readdir(f.configDir), before, 'the model watcher writes no local state or logs');
});
