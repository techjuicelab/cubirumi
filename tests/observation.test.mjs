import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedAgents, connectionSnapshot, cctvCandidates, cctvRooms, modelActivity, UNKNOWN_MODEL } from '../src/observation.ts';
import { UNKNOWN_PROJECT, UNKNOWN_SESSION } from '../src/office-state.ts';

const agent = (id, fields = {}) => ({ id, name: `직원 ${id}`, role: '개발', source: 'codex', color: '#91b9ce',
  status: 'working', task: '관측한 작업', modelEvidence: 'unknown', ...fields });
let sequence = 0;
const event = (fields = {}) => ({ id: `observation-${++sequence}`, timestamp: '2026-01-01T00:00:00Z',
  source: 'codex', agentId: 'worker', type: 'agent.status', status: 'working',
  title: 'Read 실행 중', toolName: 'Read', ...fields });

test('expanded CCTV rooms group all connected employees without a seat count limit', () => {
  const roster = Array.from({ length: 60 }, (_, i) => agent(`worker-${i}`, { projectId: 'p', sessionId: 's' }));
  assert.deepEqual(cctvRooms(roster), [{ projectId: 'p', sessionId: 's', workingCount: 60 }]);
  assert.equal(cctvRooms([...roster, agent('quiet', { projectId: 'q', sessionId: 't', status: 'idle' })]).length, 2);
});

test('connected roster excludes demos, owner, retirement, and ended sessions without expiring quiet workers', () => {
  const quiet = agent('quiet', { status: 'idle', lastEventAt: '2000-01-01T00:00:00Z' });
  const longRunning = agent('long-running', { lastEventAt: '2000-01-01T00:00:00Z' });
  const agents = [agent('boss', { source: 'manual' }), agent('demo', { source: 'demo' }),
    agent('retired', { retired: true }), agent('ended', { sessionEnded: true }), quiet, longRunning,
    agent('manual', { source: 'manual', status: 'waiting' })];
  assert.deepEqual(connectedAgents(agents).map(item => item.id), ['quiet', 'long-running', 'manual']);
  const disconnected = connectionSnapshot(agents, false);
  assert.equal(disconnected.stale, true);
  assert.equal(disconnected.connectedCount, 3);
  assert.equal(disconnected.workingCount, 1);
  assert.deepEqual(disconnected.agents, connectionSnapshot(agents, true).agents);
  assert.equal(connectionSnapshot(agents, true).stale, false);
});

test('duplicate snapshots resolve before lifecycle filtering and do not merge providers', () => {
  const active = agent('same', { lastEventAt: '2026-01-01T00:00:00Z' });
  const retired = agent('same', { retired: true, lastEventAt: '2026-01-02T00:00:00Z' });
  assert.deepEqual(connectedAgents([retired, active]), []);
  assert.deepEqual(connectedAgents([active, retired]), []);
  assert.equal(connectedAgents([active, { ...active }]).length, 1);
  assert.equal(connectedAgents([active, agent('same', { source: 'claude' })]).length, 2);
});

test('CCTV covers every connected project, room and five-person page once, with working pages first', () => {
  const workers = Array.from({ length: 12 }, (_, i) => agent(`room-${i}`, {
    projectId: 'p1', projectName: '개발 프로젝트', sessionId: 's1', sessionName: '화면 작업',
    status: i < 7 ? 'idle' : 'working',
  }));
  const quiet = agent('quiet', { projectId: 'p2', sessionId: 's2', status: 'idle' });
  const otherRoom = agent('another-room', { projectId: 'p1', sessionId: 's3', status: 'reviewing' });
  const absent = agent('retired', { retired: true, projectId: 'p3', sessionId: 's4' });
  const original = structuredClone([...workers, quiet, otherRoom, absent]);
  const views = cctvCandidates(original);
  assert.equal(views.length, 5);
  assert.equal(views[0].workingCount, 3);
  assert.deepEqual(views[0].agentIds, ['room-5', 'room-6', 'room-7', 'room-8', 'room-9']);
  assert.ok(views.every(view => view.agents.length <= 5));
  const ids = views.flatMap(view => view.agentIds);
  assert.equal(ids.length, 14);
  assert.equal(new Set(ids).size, 14);
  assert.ok(ids.includes('quiet'));
  assert.ok(!ids.includes('retired'));
  assert.equal(views.find(view => view.sessionId === 's1').pageCount, 3);
  assert.equal(views.find(view => view.sessionId === 's1').roomAgentCount, 12);
  const roomPages = views.filter(view => view.sessionId === 's1').sort((a, b) => a.page - b.page);
  assert.deepEqual(roomPages.flatMap(view => view.agentIds), workers.map(worker => worker.id));
  assert.equal(new Set(views.map(view => view.key)).size, views.length);
  assert.deepEqual(original, [...workers, quiet, otherRoom, absent], 'calculations never reorder or mutate caller state');
});

test('changing working status changes CCTV priority without moving any employee to another page', () => {
  const roster = Array.from({ length: 8 }, (_, i) => agent(`worker-${i}`, {
    projectId: 'project', sessionId: 'chat', status: i === 7 ? 'working' : 'idle',
  }));
  const before = cctvCandidates(roster);
  assert.equal(before[0].page, 1);
  const after = cctvCandidates(roster.map(worker => ({ ...worker, status: worker.id === 'worker-0' ? 'working' : 'idle' })));
  assert.equal(after[0].page, 0);
  for (const previous of before) {
    const current = after.find(view => view.key === previous.key);
    assert.deepEqual(current.agentIds, previous.agentIds);
    assert.equal(current.page, previous.page);
  }
});

test('CCTV keeps missing groups explicit and normalizes invalid or oversized page limits', () => {
  const roster = Array.from({ length: 6 }, (_, i) => agent(`unknown-${i}`, { status: 'idle' }));
  for (const pageSize of [0, Number.NaN, Infinity, 99]) {
    const views = cctvCandidates(roster, { pageSize });
    assert.equal(views.length, 2);
    assert.equal(views[0].projectId, UNKNOWN_PROJECT);
    assert.equal(views[0].sessionId, UNKNOWN_SESSION);
    assert.equal(views[0].projectName, '프로젝트 미확인');
    assert.equal(views[0].sessionName, '채팅방 미확인');
  }
  assert.equal(cctvCandidates(roster, { pageSize: 2 }).length, 3);
  assert.deepEqual(cctvCandidates([]), []);
});

test('model activity counts unique tool-start, explicit handoff and response-end observations only', () => {
  const roster = [agent('worker', { model: 'model-a', modelEvidence: 'reported', taskId: 'turn-a' })];
  const start = event({ id: 'one-start', taskId: 'turn-a' });
  const rows = modelActivity(roster, [start, { ...start },
    event({ type: 'tool.started', title: '명시적 도구 시작', taskId: 'turn-a' }),
    event({ type: 'handoff', toAgentId: 'receiver', title: '자료 전달', taskId: 'turn-a' }),
    event({ type: 'agent.completed', title: '응답 종료', taskId: 'turn-a' }),
    event({ type: 'agent.started' }), event({ type: 'user.instruction' }),
    event({ type: 'handoff', toAgentId: '' }), event({ type: 'handoff', toAgentId: 'worker' }),
    event({ status: 'thinking', title: 'Read 결과 수신' }),
    event({ title: '실행 모델 확인' }), event({ title: '파일 변경 기록 확인', toolName: 'apply_patch' }),
    event({ agentId: 'boss', model: 'boss-model', modelEvidence: 'reported' }),
    event({ source: 'demo', model: 'demo-model', modelEvidence: 'reported' }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { key: 'model:model-a', model: 'model-a', label: 'model-a', modelEvidence: 'reported',
    connectedCount: 1, workingCount: 1, toolStarts: 2, handoffs: 1, responsesEnded: 1, observedEvents: 4 });
});

test('event model evidence wins; fallback requires the same provider, agent and compatible turn', () => {
  const roster = [agent('worker', { model: 'current-model', modelEvidence: 'reported', taskId: 'current-turn' }),
    agent('unreported', { model: 'selected-but-unverified', modelEvidence: 'unknown', status: 'idle' }),
    agent('parent', { model: 'parent-model', modelEvidence: 'reported', status: 'idle' }),
    agent('child', { parentAgentId: 'parent', status: 'idle' })];
  const rows = modelActivity(roster, [
    event({ model: 'historical-model', modelEvidence: 'reported', taskId: 'old-turn' }),
    event({ model: 'ignored-selection', modelEvidence: 'unknown', taskId: 'current-turn' }),
    event({ taskId: 'old-turn' }), event({ agentId: 'child' }),
    event({ source: 'claude' }), event({ agentId: 'unreported' }),
  ]);
  assert.equal(rows.find(row => row.model === 'historical-model').toolStarts, 1);
  assert.equal(rows.find(row => row.model === 'current-model').toolStarts, 1);
  assert.equal(rows.find(row => row.model === 'parent-model').toolStarts, 0);
  const unknown = rows.find(row => row.key === UNKNOWN_MODEL);
  assert.equal(unknown.toolStarts, 4);
  assert.equal(unknown.connectedCount, 2);
  assert.equal(unknown.model, undefined);
  assert.ok(!rows.some(row => row.model === 'selected-but-unverified' || row.model === 'ignored-selection'));
});

test('departures remove present counts but retain observed history, and bridge loss does not invent new events', () => {
  const departed = agent('old-worker', { retired: true, model: 'old-model', modelEvidence: 'reported', taskId: 'old-turn' });
  const ended = agent('ended-worker', { sessionEnded: true, model: 'ended-model', modelEvidence: 'reported' });
  const rows = modelActivity([departed, ended], [event({ agentId: 'old-worker', type: 'agent.completed', taskId: 'old-turn' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].connectedCount, 0);
  assert.equal(rows[0].workingCount, 0);
  assert.equal(rows[0].responsesEnded, 1);
  assert.equal(connectionSnapshot([departed, ended], false).stale, true);
  assert.deepEqual(modelActivity([], []), []);
  assert.deepEqual(modelActivity([], [event({ type: 'user.instruction', model: 'unused', modelEvidence: 'reported' })]), []);
});
