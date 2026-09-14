import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../server/bridge.mjs';
import { createEventStore } from '../server/store.mjs';
import { updateAgentState } from '../src/office-state.ts';

const event = (changes = {}) => ({ id: 'observed-message', type: 'message.sent', source: 'codex', observation: 'codex-log',
  agentId: 'employee', title: '메시지 전송 기록', timestamp: '2026-01-01T00:02:00.000Z', ...changes });

test('generic message events permit no guessed recipient and retain only permitted metadata', () => {
  const normalized = normalizeEvent(event({ prompt: 'PRIVATE', text: 'PRIVATE', output: 'PRIVATE' }));
  assert.equal(normalized.type, 'message.sent'); assert.equal(normalized.status, undefined);
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE|prompt|output/u);
  for (const changes of [{ toAgentId: 'recipient' }, { toAgentName: '누군가' }]) assert.throws(() => normalizeEvent(event(changes)));
});

test('message history never changes work, model, lifecycle ordering or registry membership in server and UI', () => {
  for (const type of ['agent.status', 'agent.completed', 'approval.requested', 'agent.retired', 'session.ended']) {
    const initial = normalizeEvent(event({ id: 'lifecycle', type, status: 'working', model: 'reported-model', modelEvidence: 'reported',
      taskId: 'original-task', projectId: 'original-project', timestamp: '2026-01-01T00:00:00.000Z' }));
    const store = createEventStore({ normalize: normalizeEvent, initialEvents: [initial] });
    const agents = []; updateAgentState(agents, initial);
    const before = structuredClone(store.state().agents), uiBefore = structuredClone(agents);
    const message = normalizeEvent(event({ status: 'working', taskId: 'wrong-task', projectId: 'wrong-project', model: 'wrong-model', modelEvidence: 'reported' }));
    store.append(message); updateAgentState(agents, message);
    assert.deepEqual(store.state().agents, before); assert.deepEqual(agents, uiBefore);
    const unknown = normalizeEvent(event({ id: 'unknown-message', agentId: 'unknown-employee' }));
    store.append(unknown); assert.equal(updateAgentState(agents, unknown), undefined);
    assert.deepEqual(store.state().agents, before); assert.deepEqual(agents, uiBefore);
    assert.equal(store.state().events.length, 3, 'communication remains available in history');
  }
});
