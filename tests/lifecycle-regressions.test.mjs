import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexLogObserver, agentId } from '../scripts/codex-observer.mjs';
import { createEventStore } from '../server/store.mjs';
import { normalizeEvent } from '../server/bridge.mjs';
import { updateAgentState } from '../src/office-state.ts';

const line = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp }) + '\n';
const event = overrides => normalizeEvent({ source: 'codex', type: 'agent.started', agentId: 'worker',
  sessionId: 'session', status: 'working', title: 'Fixture work', ...overrides });

async function fixture(t, records) {
  const directory = await mkdtemp(join(tmpdir(), 'office-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'state.sqlite'), rolloutPath = join(directory, 'worker.jsonl');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT);');
  database.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('worker', rolloutPath, directory, 'Fixture', 'vscode', null, null, null, 0, Date.now(), 0);
  t.after(() => database.close());
  await writeFile(rolloutPath, records);
  const store = createEventStore({ normalize: normalizeEvent });
  const sent = [];
  const observer = new CodexLogObserver({ dbPath, sessionsDir: directory, send: async incoming => {
    sent.push(incoming); store.append(normalizeEvent(incoming));
  } });
  t.after(() => observer.close());
  return { database, rolloutPath, store, sent, observer };
}

test('a historical Codex snapshot cannot revive a newer completed hook, while new Astra work still reenters', async t => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const completed = new Date(Date.now() - 30_000).toISOString();
  const modelObserved = new Date(Date.now() - 10_000).toISOString();
  const f = await fixture(t, line('event_msg', { type: 'task_started', turn_id: 'old' }, old)
    + line('turn_context', { turn_id: 'old', model: 'gpt-6-astra' }, modelObserved));
  f.store.append(event({ id: 'newer-completion', agentId: agentId('worker'), type: 'agent.completed', timestamp: completed, status: 'done' }));
  await f.observer.poll();
  assert.equal(f.store.state().agents[0].status, 'idle', 're-reading old activity must retain its observed time');
  assert.equal(f.sent[0].timestamp, old);
  const resumed = new Date(Date.now() + 1000).toISOString();
  await appendFile(f.rolloutPath, line('event_msg', { type: 'task_started', turn_id: 'new' }, resumed)
    + line('turn_context', { turn_id: 'new', model: 'gpt-6-astra' }, resumed));
  await f.observer.poll();
  assert.equal(f.store.state().agents[0].status, 'working');
  assert.equal(f.store.state().agents[0].model, 'gpt-6-astra');
});

test('archiving an already tracked Codex task retires it without another transcript write', async t => {
  const f = await fixture(t, line('event_msg', { type: 'task_started', turn_id: 'active' }, new Date().toISOString()));
  assert.equal((await f.observer.poll()).active, 1);
  f.database.prepare('UPDATE threads SET archived=1 WHERE id=?').run('worker');
  assert.equal((await f.observer.poll()).active, 0);
  assert.equal(f.store.state().agents[0].retired, true);
  assert.equal(f.store.state().agents[0].status, 'idle');
  await f.observer.poll();
  assert.equal(f.sent.filter(item => item.type === 'agent.retired').length, 1);
});

test('a delayed session end cannot close a newer child turn or let an older start revive a closed child', () => {
  const store = createEventStore({ normalize: normalizeEvent });
  const at = second => `2026-09-13T12:00:${String(second).padStart(2, '0')}.000Z`;
  store.append(event({ id: 'parent-old', agentId: 'parent', timestamp: at(0) }));
  store.append(event({ id: 'quiet-child', agentId: 'quiet', timestamp: at(1) }));
  store.append(event({ id: 'new-child-turn', agentId: 'new', timestamp: at(20) }));
  store.append(event({ id: 'old-session-end', agentId: 'parent', type: 'session.ended', timestamp: at(10), status: 'idle' }));
  assert.equal(store.state().agents.find(agent => agent.agentId === 'new').sessionEnded, false, 'later child work survives an earlier parent end');
  assert.equal(store.state().agents.find(agent => agent.agentId === 'new').status, 'working');
  store.append(event({ id: 'late-old-child-start', agentId: 'quiet', timestamp: at(5) }));
  const quiet = store.state().agents.find(agent => agent.agentId === 'quiet');
  assert.equal(quiet.sessionEnded, true, 'the session end is also an ordering boundary for quiet children');
  assert.equal(quiet.status, 'idle');
});

test('session closure reaches old children despite a restarted parent and a later model correction, including after reload', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-session-order-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createEventStore({ dataDir, normalize: normalizeEvent });
  const at = second => `2026-09-13T12:00:${String(second).padStart(2, '0')}.000Z`;
  const emit = fields => store.append(event({ source: 'claude', ...fields }));
  emit({ id: 'parent-new', agentId: 'parent', timestamp: at(20) });
  emit({ id: 'child-old', agentId: 'child', timestamp: at(1) });
  emit({ id: 'model-proof', agentId: 'child', type: 'agent.model', timestamp: at(30), observation: 'claude-log',
    referenceEventId: 'child-old', model: 'claude-own', modelEvidence: 'reported', modelObservedAt: at(2) });
  emit({ id: 'session-end', agentId: 'parent', type: 'session.ended', timestamp: at(10), status: 'idle' });
  assert.equal(store.state().agents.find(agent => agent.agentId === 'parent').status, 'working');
  assert.equal(store.state().agents.find(agent => agent.agentId === 'child').sessionEnded, true);
  const restored = createEventStore({ dataDir, normalize: normalizeEvent });
  restored.append(event({ source: 'claude', id: 'old-start-retry', agentId: 'child', timestamp: at(5) }));
  const child = restored.state().agents.find(agent => agent.agentId === 'child');
  assert.equal(child.sessionEnded, true);
  assert.equal(child.status, 'idle');
  assert.equal(child.lastEventAt, at(10));
  assert.equal(child.model, 'claude-own');
});

test('manual instructions preserve the target provider and session closure matches live and restored state', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-manual-target-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createEventStore({ dataDir, normalize: normalizeEvent }), live = [];
  const at = second => `2026-09-13T13:00:${String(second).padStart(2, '0')}.000Z`;
  const apply = fields => { const incoming = event(fields); store.append(incoming); updateAgentState(live, incoming); };
  apply({ id: 'claude-target', source: 'claude', agentId: 'shared-worker', timestamp: at(0) });
  apply({ id: 'claude-peer', source: 'claude', agentId: 'peer', timestamp: at(1) });
  apply({ id: 'owner-input', source: 'manual', type: 'user.instruction', agentId: 'shared-worker', timestamp: at(2) });
  assert.equal(live.find(agent => agent.id === 'shared-worker').source, 'claude');
  assert.equal(store.state().agents.length, 2, 'an owner instruction must not create a second manual worker');
  assert.equal(store.state().events.at(-1).source, 'manual', 'event provenance remains the owner');
  apply({ id: 'peer-closes', source: 'claude', type: 'session.ended', agentId: 'peer', status: 'idle', timestamp: at(3) });
  assert.ok(live.every(agent => agent.sessionEnded && agent.status === 'idle'));
  const restored = createEventStore({ dataDir, normalize: normalizeEvent });
  const hydrated = [];
  for (const record of restored.state().agents) updateAgentState(hydrated, record);
  const states = agents => agents.map(agent => [agent.source, agent.id ?? agent.agentId, agent.status, agent.sessionEnded]).sort();
  assert.deepEqual(states(hydrated), states(live));
});

test('manual instructions retain hook grouping and model boundaries equally in live and reloaded snapshots', async t => {
  for (const source of ['codex', 'claude', 'manual']) {
    const dataDir = await mkdtemp(join(tmpdir(), 'office-manual-evidence-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const store = createEventStore({ dataDir, normalize: normalizeEvent }), live = [];
    const apply = fields => { const incoming = event(fields); store.append(incoming); updateAgentState(live, incoming); };
    apply({ id: 'observed-target', source, agentId: 'target', observation: 'hook', sessionName: 'Observed chat',
      model: 'old-model', modelEvidence: 'reported', modelObservedAt: '2026-09-13T13:00:00.000Z', timestamp: '2026-09-13T13:00:00.000Z' });
    apply({ id: 'manual-new-turn', source: 'manual', type: 'user.instruction', agentId: 'target', timestamp: '2026-09-13T13:01:00.000Z' });
    const restored = createEventStore({ dataDir, normalize: normalizeEvent }), hydrated = [];
    for (const record of restored.state().agents) updateAgentState(hydrated, record);
    const evidence = agent => Object.fromEntries(['source', 'model', 'modelEvidence', 'modelObservedAt', 'taskStartedAt',
      'observation', 'sessionId', 'sessionName', 'sessionObservation'].map(key => [key, agent[key]]));
    assert.deepEqual(evidence(live[0]), evidence(hydrated[0]), `${source} live and restored evidence must agree`);
    assert.equal(live[0].source, source);
    assert.equal(live[0].observation, 'manual');
    assert.equal(live[0].sessionObservation, 'hook');
    assert.equal(live[0].model, undefined);
    assert.equal(live[0].modelEvidence, 'unknown');
    assert.equal(live[0].taskStartedAt, '2026-09-13T13:01:00.000Z');
  }
});

test('provider-scoped equal IDs stay separate and ambiguous manual instructions never pick or fabricate a worker', () => {
  const store = createEventStore({ normalize: normalizeEvent }), live = [];
  const apply = fields => { const incoming = event(fields); store.append(incoming); updateAgentState(live, incoming); };
  apply({ id: 'codex-presence', agentId: 'same-id', source: 'codex', status: 'idle' });
  apply({ id: 'claude-presence', agentId: 'same-id', source: 'claude', status: 'idle' });
  assert.equal(live.length, 2);
  apply({ id: 'ambiguous-instruction', agentId: 'same-id', source: 'manual', type: 'user.instruction', status: 'working' });
  apply({ id: 'unknown-instruction', agentId: 'unknown', source: 'manual', type: 'user.instruction', status: 'working' });
  assert.equal(store.state().agents.length, 2);
  assert.equal(live.length, 2);
  assert.ok(live.every(agent => agent.status === 'idle'));
  apply({ id: 'claude-only-end', agentId: 'same-id', source: 'claude', type: 'session.ended' });
  assert.equal(live.find(agent => agent.source === 'codex').sessionEnded, false);
  assert.equal(live.find(agent => agent.source === 'claude').sessionEnded, true);
});

test('explicit owner instruction recipients update the existing target without changing the sender identity', () => {
  const store = createEventStore({ normalize: normalizeEvent }), live = [];
  const apply = fields => { const incoming = event(fields); store.append(incoming); updateAgentState(live, incoming); };
  apply({ id: 'target-present', source: 'claude', agentId: 'target', agentName: 'Existing name', status: 'idle' });
  apply({ id: 'owner-targets', source: 'manual', type: 'user.instruction', agentId: 'owner', agentName: 'Owner',
    toAgentId: 'target', status: 'thinking', title: 'New input' });
  assert.equal(live.length, 1);
  assert.equal(live[0].name, 'Existing name');
  assert.equal(live[0].source, 'claude');
  assert.equal(live[0].status, 'thinking');
  assert.equal(store.state().agents[0].agentId, 'target');
  assert.equal(store.state().events.at(-1).agentId, 'owner');
});

test('a manual employee snapshot restores after an instruction without inventing an unknown recipient', () => {
  const store = createEventStore({ normalize: normalizeEvent });
  store.append(event({ source: 'manual', id: 'manual-present', agentId: 'manual-worker', status: 'idle' }));
  store.append(event({ source: 'manual', id: 'manual-input', agentId: 'manual-worker', type: 'user.instruction', status: 'thinking' }));
  const hydrated = [];
  for (const record of store.state().agents) updateAgentState(hydrated, record);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].source, 'manual');
  assert.equal(hydrated[0].status, 'thinking');
});

test('a full journal appends durably between bounded compactions and reload keeps the latest state and deduplication window', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-journal-compaction-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const make = index => event({ id: `compact-${index}`, agentId: 'compact-worker', title: `Fixture ${index}` });
  const store = createEventStore({ dataDir, normalize: normalizeEvent,
    initialEvents: Array.from({ length: 5000 }, (_, index) => make(index)) });
  const journalPath = join(dataDir, 'events.jsonl');
  const initialInode = (await stat(journalPath)).ino;
  store.append(make(5000));
  assert.equal((await stat(journalPath)).ino, initialInode, 'the first event after capacity must append, not rewrite 5000 records');
  assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 5001);
  // A separate store opening the files models process loss without a shutdown compaction.
  const recovered = createEventStore({ dataDir, normalize: normalizeEvent });
  assert.equal(recovered.state().agents[0].title, 'Fixture 5000');
  assert.equal(recovered.health().persistence.retainedEventCount, 5000);
  assert.equal(recovered.duplicate('compact-0'), undefined);
  assert.equal(recovered.duplicate('compact-1').id, 'compact-1');
  const beforeBatchInode = (await stat(journalPath)).ino;
  for (let index = 5001; index <= 5255; index++) recovered.append(make(index));
  assert.equal((await stat(journalPath)).ino, beforeBatchInode);
  assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 5255);
  recovered.append(make(5256));
  assert.notEqual((await stat(journalPath)).ino, beforeBatchInode);
  assert.equal((await readFile(journalPath, 'utf8')).trim().split('\n').length, 5000);
  const restored = createEventStore({ dataDir, normalize: normalizeEvent });
  assert.equal(restored.state().agents[0].title, 'Fixture 5256');
  assert.equal(restored.duplicate('compact-256'), undefined);
  assert.equal(restored.duplicate('compact-257').id, 'compact-257');
});
