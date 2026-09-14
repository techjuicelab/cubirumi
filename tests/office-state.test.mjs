import test from 'node:test';
import assert from 'node:assert/strict';
import { modelColor, owner, pageAgents, projectKey, sessionKey, updateAgentState, summarizeOfficeActivity, UNKNOWN_PROJECT, UNKNOWN_SESSION } from '../src/office-state.ts';

let sequence = 0;
const event = (fields = {}) => ({ id: `event-${++sequence}`, timestamp: `2026-09-12T12:00:${String(sequence).padStart(2,'0')}Z`,
  type: 'agent.status', agentId: 'codex-root', source: 'codex', title: '도구를 실행했어요', ...fields });

test('reported model changes update clothing while preserving employee identity and name', () => {
  const agents = [owner()];
  const first = updateAgentState(agents, event({ agentName: '코디', model: 'gpt-6-astra', modelEvidence: 'reported', observation: 'codex-log' }));
  const oldName = first.name;
  const changed = updateAgentState(agents, event({ model: 'gpt-5.6-sol', modelEvidence: 'reported' }));
  assert.equal(first, changed);
  assert.equal(changed.name, oldName);
  assert.equal(changed.color, modelColor('gpt-5.6-sol'));
  updateAgentState(agents, event({ model: 'unverified-model', modelEvidence: 'unknown' }));
  assert.equal(changed.model, 'gpt-5.6-sol');
});

test('a new turn without reported model clears the old model while same-turn tools preserve it', () => {
  const agents = [];
  const first = updateAgentState(agents, event({ agentName: '코디', taskId: 'turn-one', model: 'gpt-6-astra', modelEvidence: 'reported' }));
  updateAgentState(agents, event({ taskId: 'turn-one', modelEvidence: 'unknown', toolName: 'exec_command' }));
  assert.equal(first.model, 'gpt-6-astra');
  assert.equal(first.modelEvidence, 'reported');
  updateAgentState(agents, event({ taskId: 'turn-two', modelEvidence: 'unknown', type: 'user.instruction' }));
  assert.equal(first.taskId, 'turn-two');
  assert.equal(first.model, undefined);
  assert.equal(first.modelEvidence, 'unknown');
  assert.equal(first.color, modelColor(undefined));
  assert.equal(first.name, '코디');
  assert.equal(agents[0], first);
  updateAgentState(agents, event({ taskId: 'turn-two', model: 'gpt-5.6-sol', modelEvidence: 'reported' }));
  assert.equal(first.model, 'gpt-5.6-sol');
  updateAgentState(agents, event({ toolName: 'exec_command' }));
  assert.equal(first.model, 'gpt-5.6-sol', 'a routine event without a turn ID must not invent a new turn');
});

test('Claude prompt boundaries clear old models even without a turn ID and reject earlier model evidence', () => {
  const agents = [];
  const first = updateAgentState(agents, event({ source: 'claude', model: 'claude-old', modelEvidence: 'reported' }));
  const instruction = event({ source: 'claude', type: 'user.instruction', modelEvidence: 'unknown' });
  updateAgentState(agents, instruction);
  assert.equal(first.modelEvidence, 'unknown');
  assert.equal(first.model, undefined);
  assert.equal(first.taskStartedAt, instruction.timestamp);
  updateAgentState(agents, event({ source: 'claude', type: 'agent.model', referenceEventId: instruction.id,
    model: 'claude-old', modelEvidence: 'reported', modelObservedAt: '2020-01-01T00:00:00Z' }));
  assert.equal(first.modelEvidence, 'unknown');
  assert.equal(first.lastEventAt, instruction.timestamp);
});

test('subagents do not inherit the parent model and missing grouping remains explicitly unknown', () => {
  const agents = [];
  updateAgentState(agents, event({ model: 'gpt-6-astra', modelEvidence: 'reported' }));
  const child = updateAgentState(agents, event({ agentId: 'child', parentAgentId: 'codex-root' }));
  assert.equal(child.model, undefined);
  assert.equal(child.modelEvidence, 'unknown');
  assert.equal(projectKey(child), UNKNOWN_PROJECT);
  assert.equal(sessionKey(child), UNKNOWN_SESSION);
});

test('reported parent chat grouping survives a child hook and preserves snapshot authority', () => {
  const agents = [];
  const child = updateAgentState(agents, event({ agentId: 'child', parentAgentId: 'root', sessionId: 'child-chat', sessionName: '자식 임시 채팅', observation: 'hook' }));
  updateAgentState(agents, event({ agentId: 'child', sessionId: 'root-chat', sessionName: '부모 채팅', observation: 'codex-log' }));
  updateAgentState(agents, event({ agentId: 'child', sessionId: 'child-chat', sessionName: '자식 채팅', observation: 'hook' }));
  assert.equal(child.sessionId, 'root-chat');
  assert.equal(child.sessionName, '부모 채팅');
  assert.equal(child.sessionObservation, 'codex-log');
  assert.equal(child.observation, 'hook', 'the last action source is distinct from grouping evidence');

  const restored = [];
  const snapshot = updateAgentState(restored, event({ agentId: 'child', sessionId: 'root-chat', sessionName: '부모 채팅', observation: 'hook', sessionObservation: 'codex-log' }));
  updateAgentState(restored, event({ agentId: 'child', sessionId: 'child-chat', observation: 'hook' }));
  assert.equal(snapshot.sessionId, 'root-chat');
  updateAgentState(restored, event({ agentId: 'child', sessionId: 'confirmed-chat', observation: 'app-server' }));
  assert.equal(snapshot.sessionId, 'confirmed-chat');
  assert.equal(snapshot.sessionName, undefined, 'a changed chat does not retain an unrelated old name');
});

test('completed responses and ended sessions preserve employees until explicit retirement', () => {
  const agents = [];
  const agent = updateAgentState(agents, event({ type: 'agent.started', sessionId: 'chat-one' }));
  updateAgentState(agents, event({ type: 'agent.completed', status: 'done', sessionId: 'chat-one' }));
  assert.equal(agent.status, 'idle');
  assert.equal(agent.retired, false);
  updateAgentState(agents, event({ type: 'session.ended', sessionId: 'chat-one' }));
  assert.equal(agent.sessionEnded, true);
  assert.equal(agent.retired, false);
  updateAgentState(agents, event({ type: 'agent.retired', sessionId: 'chat-one' }));
  assert.equal(agent.retired, true);
  updateAgentState(agents, event({ type: 'user.instruction', sessionId: 'chat-one' }));
  assert.equal(agent.retired, false);
  assert.equal(agent.sessionEnded, false);
});

test('older history cannot overwrite a newer snapshot and pagination exposes every active employee once', () => {
  const agents = [owner()];
  for (let i = 0; i < 13; i++) updateAgentState(agents, event({ agentId: `worker-${i}`, status: 'working' }));
  updateAgentState(agents, event({ agentId: 'worker-0', timestamp: '2026-01-01T00:00:00Z', type: 'agent.retired' }));
  assert.equal(agents.find(a => a.id === 'worker-0').retired, false);
  const all = [0,1,2].flatMap(page => pageAgents(agents, page));
  assert.equal(all.length, 13);
  assert.equal(new Set(all.map(agent => agent.id)).size, 13);
});

test('an ended session without an ID does not stop unrelated unknown sessions', () => {
  const agents = [];
  updateAgentState(agents, event({ agentId: 'one', status: 'working' }));
  updateAgentState(agents, event({ agentId: 'two', status: 'working' }));
  updateAgentState(agents, event({ agentId: 'one', type: 'session.ended' }));
  assert.equal(agents.find(a => a.id === 'two').status, 'working');
});

test('activity summaries distinguish idle floors, other chats and agents on another page', () => {
  const basic = { name: '직원', role: '개발', color: modelColor(undefined), task: '업무', source: 'codex', modelEvidence: 'unknown' };
  const quiet = { ...basic, id: 'quiet', status: 'idle', projectId: 'quiet-floor', sessionId: 'quiet-chat' };
  const typing = { ...basic, id: 'typing', status: 'working', projectId: 'active-floor', sessionId: 'one' };
  const thinking = { ...basic, id: 'thinking', status: 'thinking', projectId: 'active-floor', sessionId: 'one' };
  const reviewing = { ...basic, id: 'reviewing', status: 'reviewing', projectId: 'active-floor', sessionId: 'two' };
  const retired = { ...basic, id: 'retired', status: 'working', retired: true, projectId: 'quiet-floor' };
  const agents = [owner(), quiet, typing, thinking, reviewing, retired];
  assert.deepEqual(summarizeOfficeActivity(agents, [owner(), quiet], 'quiet-floor', 'quiet-chat'), {
    total: 3, floor: 0, workzone: 0, visible: 0, otherFloors: 3, otherWorkzones: 0, otherPages: 0,
  });
  assert.deepEqual(summarizeOfficeActivity(agents, [owner(), typing], 'active-floor', 'one'), {
    total: 3, floor: 3, workzone: 2, visible: 1, otherFloors: 0, otherWorkzones: 1, otherPages: 1,
  });
});

test('session endings preserve newer child work and prevent older starts from reviving quiet children', () => {
  const agents = [];
  const at = second => `2026-09-13T12:00:${String(second).padStart(2, '0')}.000Z`;
  const emit = fields => updateAgentState(agents, event({ type: 'agent.started', sessionId: 'session', status: 'working', ...fields }));
  emit({ agentId: 'parent', timestamp: at(0) });
  emit({ agentId: 'quiet', timestamp: at(1) });
  emit({ agentId: 'new', timestamp: at(20) });
  emit({ agentId: 'parent', type: 'session.ended', timestamp: at(10), status: 'idle' });
  assert.equal(agents.find(agent => agent.id === 'new').sessionEnded, false);
  assert.equal(agents.find(agent => agent.id === 'new').status, 'working');
  emit({ agentId: 'quiet', timestamp: at(5) });
  assert.equal(agents.find(agent => agent.id === 'quiet').sessionEnded, true);
  assert.equal(agents.find(agent => agent.id === 'quiet').lastEventAt, at(10));
});

test('late session closure still reaches quiet children when the parent has restarted, and model corrections do not block it', () => {
  const agents = [];
  const at = second => `2026-09-13T12:00:${String(second).padStart(2, '0')}.000Z`;
  const emit = fields => updateAgentState(agents, event({ source: 'claude', type: 'agent.started', sessionId: 'session', status: 'working', ...fields }));
  emit({ agentId: 'parent', timestamp: at(20) });
  const child = emit({ agentId: 'child', timestamp: at(1) });
  emit({ agentId: 'child', type: 'agent.model', timestamp: at(30), referenceEventId: child.lastEventId,
    model: 'claude-own', modelEvidence: 'reported', modelObservedAt: at(2) });
  emit({ agentId: 'parent', type: 'session.ended', timestamp: at(10), status: 'idle' });
  assert.equal(agents.find(agent => agent.id === 'parent').status, 'working');
  assert.equal(child.status, 'idle');
  assert.equal(child.sessionEnded, true);
  assert.equal(child.model, 'claude-own');
  assert.equal(child.lastEventAt, at(10));
});
