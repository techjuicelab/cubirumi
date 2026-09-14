import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOfficeServer, normalizeEvent } from '../server/bridge.mjs';
import { createEventStore } from '../server/store.mjs';

const baseTime = '2026-01-01T00:00:00.000Z';
const instruction = (changes = {}) => ({ id: 'instruction-1', source: 'claude', observation: 'hook', type: 'user.instruction',
  agentId: 'employee', agentName: '직원', title: '사용자 지시', status: 'working', timestamp: baseTime, ...changes });
const correction = (changes = {}) => ({ id: 'model-proof-1', source: 'claude', observation: 'claude-log', type: 'agent.model',
  agentId: 'employee', title: '실제 모델 확인', timestamp: '2026-01-01T00:02:00.000Z',
  modelEvidence: 'reported', model: 'claude-example-model', modelObservedAt: '2026-01-01T00:01:00.000Z',
  referenceEventId: 'instruction-1', ...changes });
const storeFor = (events = []) => createEventStore({ normalize: normalizeEvent, initialEvents: events });
const append = (store, event) => store.append(normalizeEvent(event));
const employee = store => store.state().agents.find(agent => agent.agentId === 'employee');

test('model proof requires Claude transcript evidence, a snapshot reference and a valid observed timestamp', () => {
  const event = normalizeEvent(correction({ prompt: 'PRIVATE_TEXT', transcript: 'PRIVATE_TEXT' }));
  assert.equal(event.type, 'agent.model'); assert.equal(event.modelObservedAt, correction().modelObservedAt);
  assert.equal(event.referenceEventId, 'instruction-1'); assert.equal(JSON.stringify(event).includes('PRIVATE_TEXT'), false);
  for (const invalid of [{ source: 'codex' }, { observation: 'hook' }, { observation: undefined },
    { modelEvidence: 'unknown' }, { model: undefined }, { modelObservedAt: undefined },
    { modelObservedAt: '2026-02-30T00:00:00Z' }, { modelObservedAt: '2026-01-01' }, { referenceEventId: undefined }]) {
    assert.throws(() => normalizeEvent(correction(invalid)));
  }
});

test('matching model proof changes only model metadata, including for an approval or retired employee', () => {
  for (const type of ['approval.requested', 'agent.retired', 'session.ended']) {
    const store = storeFor([instruction(), instruction({ id: 'current-event', type, timestamp: '2026-01-01T00:01:10.000Z' })]);
    const before = structuredClone(employee(store)); const projects = structuredClone(store.state().projects);
    append(store, correction({ referenceEventId: 'current-event', title: '다른 제목', status: 'working', taskId: 'wrong-task', projectId: 'wrong-project' }));
    const after = employee(store);
    assert.deepEqual(after, { ...before, model: 'claude-example-model', modelEvidence: 'reported', modelObservedAt: correction().modelObservedAt });
    assert.deepEqual(store.state().projects, projects); assert.equal(store.state().agents.length, 1);
  }
});

test('missing employees, stale references and previous-turn model evidence cannot change the roster', () => {
  const store = storeFor([instruction()]); const before = structuredClone(store.state().agents);
  append(store, correction({ id: 'missing', agentId: 'absent' }));
  append(store, correction({ id: 'raced', referenceEventId: 'old-event' }));
  append(store, correction({ id: 'old-proof', modelObservedAt: '2025-12-31T23:59:59.000Z' }));
  assert.deepEqual(store.state().agents, before);
});

test('delayed previous-turn lifecycle events cannot roll back the snapshot or admit its old model proof', () => {
  const store = storeFor([instruction(), instruction({ id: 'latest-instruction', timestamp: '2026-01-01T00:10:00.000Z' })]);
  const current = structuredClone(employee(store));
  append(store, instruction({ id: 'delayed-instruction', timestamp: '2026-01-01T00:05:00.000Z' }));
  append(store, instruction({ id: 'delayed-completion', type: 'agent.completed', timestamp: '2026-01-01T00:07:00.000Z' }));
  append(store, correction({ id: 'delayed-model-proof', referenceEventId: 'delayed-completion',
    modelObservedAt: '2026-01-01T00:06:00.000Z', timestamp: '2026-01-01T00:11:00.000Z' }));
  assert.deepEqual(employee(store), current);
  assert.equal(employee(store).status, 'working'); assert.equal(employee(store).modelEvidence, 'unknown');
  assert.equal(store.state().events.length, 5, 'delayed events may remain in history without changing current state');
});

test('normal lifecycle events with equal timestamps retain their received order and can receive matching model proof', () => {
  const store = storeFor([instruction()]);
  append(store, instruction({ id: 'same-time-approval', type: 'approval.requested' }));
  assert.equal(employee(store).status, 'approval'); assert.equal(employee(store).id, 'same-time-approval');
  append(store, instruction({ id: 'same-time-completion', type: 'agent.completed' }));
  assert.equal(employee(store).status, 'idle'); assert.equal(employee(store).id, 'same-time-completion');
  const before = structuredClone(employee(store));
  append(store, correction({ referenceEventId: before.id, modelObservedAt: baseTime, timestamp: baseTime }));
  assert.deepEqual(employee(store), { ...before, model: correction().model, modelEvidence: 'reported', modelObservedAt: baseTime });
});

test('Claude instructions without task IDs clear the old model and retain an explicit turn boundary', () => {
  const store = storeFor([instruction()]); append(store, correction());
  append(store, instruction({ id: 'instruction-2', timestamp: '2026-01-01T01:00:00.000Z' }));
  const next = employee(store);
  assert.equal(next.modelEvidence, 'unknown'); assert.equal(Object.hasOwn(next, 'model'), false);
  assert.equal(Object.hasOwn(next, 'modelObservedAt'), false); assert.equal(next.taskStartedAt, next.timestamp);
  append(store, instruction({ id: 'same-turn-tool', type: 'agent.status', title: '도구 실행', timestamp: '2026-01-01T01:00:10.000Z' }));
  assert.equal(employee(store).taskStartedAt, '2026-01-01T01:00:00.000Z');
  append(store, correction({ id: 'previous-turn-proof', referenceEventId: 'same-turn-tool' }));
  assert.equal(employee(store).modelEvidence, 'unknown');
  append(store, instruction({ id: 'instruction-3', timestamp: '2026-01-01T02:00:00.000Z', modelEvidence: 'reported', model: 'new-reported-model' }));
  assert.equal(employee(store).model, 'new-reported-model');
  assert.equal(employee(store).taskStartedAt, '2026-01-01T02:00:00.000Z');
});

test('legacy snapshots recover the last preserved Claude instruction boundary before accepting a model proof', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-office-legacy-model-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = createEventStore({ dataDir, normalize: normalizeEvent, initialEvents: [instruction(),
    instruction({ id: 'new-instruction', timestamp: '2026-01-01T03:00:00.000Z' }),
    instruction({ id: 'new-tool', type: 'agent.status', timestamp: '2026-01-01T03:00:10.000Z' }),
    instruction({ id: 'late-old-instruction', timestamp: '2026-01-01T02:00:00.000Z' })] });
  assert.equal(employee(first).taskStartedAt, '2026-01-01T03:00:00.000Z');
  const path = join(dataDir, 'agents.json'); const saved = JSON.parse(readFileSync(path, 'utf8'));
  delete saved.agents[0].taskStartedAt; writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
  const second = createEventStore({ dataDir, normalize: normalizeEvent });
  assert.equal(employee(second).taskStartedAt, '2026-01-01T03:00:00.000Z');
  append(second, correction({ referenceEventId: 'new-tool' }));
  assert.equal(employee(second).modelEvidence, 'unknown');
});

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: { Host: '127.0.0.1:4780', 'Content-Type': 'application/json' }, agent: false }, res => {
      let value = ''; res.on('data', chunk => value += chunk); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(value) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
test('accepted model corrections restore from both snapshot and journal after real server restarts', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-office-model-proof-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let server;
  const start = async () => { server = createOfficeServer({ dataDir }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
  const stop = () => new Promise(resolve => server.close(resolve));
  t.after(() => { if (server?.listening) return stop(); });
  let port = await start();
  assert.equal((await request(port, '/api/events', instruction())).status, 202);
  const before = (await request(port, '/api/state')).json.agents[0];
  assert.equal((await request(port, '/api/events', correction())).status, 202);
  const after = (await request(port, '/api/state')).json.agents[0];
  assert.equal(after.id, before.id); assert.equal(after.timestamp, before.timestamp); assert.equal(after.model, 'claude-example-model');
  await stop(); port = await start();
  assert.deepEqual((await request(port, '/api/state')).json.agents[0], after);
  await stop(); unlinkSync(join(dataDir, 'agents.json')); port = await start();
  assert.deepEqual((await request(port, '/api/state')).json.agents[0], after);
  const journal = readFileSync(join(dataDir, 'events.jsonl'), 'utf8');
  assert.equal(journal.includes('agent.model'), true); assert.equal(journal.includes('referenceEventId'), true);
});
