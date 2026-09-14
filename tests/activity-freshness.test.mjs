import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_FRESHNESS_MS, presentAgentActivity } from '../src/activity-freshness.ts';

const observedAt = Date.parse('2026-09-14T00:00:00.000Z');
const worker = (changes = {}) => ({
  id: 'claude-worker', name: 'Claude 직원', role: '개발팀', color: '#8aac8f',
  status: 'working', task: '실제로 관측된 도구 실행', source: 'claude',
  lastEventAt: new Date(observedAt).toISOString(),
  ...changes,
});

test('activity remains current until the five-minute boundary', () => {
  assert.equal(ACTIVITY_FRESHNESS_MS, 5 * 60 * 1000);
  const agent = worker();
  assert.equal(presentAgentActivity(agent, observedAt), agent);
  assert.equal(presentAgentActivity(agent, observedAt + ACTIVITY_FRESHNESS_MS - 1), agent);
  assert.deepEqual(presentAgentActivity(agent, observedAt + ACTIVITY_FRESHNESS_MS), {
    ...agent, status: 'idle', unconfirmedStatus: 'working',
  });
});

test('unobserved working, thinking, reviewing and error records become unconfirmed', () => {
  for (const status of ['working', 'thinking', 'reviewing', 'error']) {
    for (const source of ['claude', 'codex', 'manual']) {
      const agent = worker({ status, source });
      const presentation = presentAgentActivity(agent, observedAt + ACTIVITY_FRESHNESS_MS);
      assert.equal(presentation.status, 'idle', `${source} ${status}`);
      assert.equal(presentation.unconfirmedStatus, status, `${source} ${status}`);
    }
  }
});

test('explicit approval requests and quiet statuses do not expire', () => {
  for (const status of ['approval', 'idle', 'done', 'waiting']) {
    const agent = worker({ status });
    assert.equal(presentAgentActivity(agent, observedAt + 30 * 24 * 60 * 60 * 1000), agent, status);
    const withoutTime = worker({ status, lastEventAt: undefined });
    assert.equal(presentAgentActivity(withoutTime, observedAt), withoutTime, `${status} without time`);
  }
});

test('owner, demonstration, retired and ended records are not projected as unconfirmed', () => {
  for (const exception of [{ id: 'boss' }, { source: 'demo' }, { retired: true }, { sessionEnded: true }]) {
    const agent = worker(exception);
    assert.equal(presentAgentActivity(agent, observedAt + ACTIVITY_FRESHNESS_MS), agent);
  }
});

test('active records without a usable observation timestamp are unconfirmed', () => {
  for (const lastEventAt of [undefined, '', 'not-a-date']) {
    const agent = worker({ lastEventAt });
    assert.deepEqual(presentAgentActivity(agent, observedAt), { ...agent, status: 'idle', unconfirmedStatus: 'working' });
  }
});

test('future observations and an invalid presentation clock do not invent elapsed time', () => {
  const agent = worker();
  for (const now of [observedAt - 1, observedAt - ACTIVITY_FRESHNESS_MS, NaN, Infinity, -Infinity]) {
    assert.equal(presentAgentActivity(agent, now), agent);
  }
});

test('presentation preserves the original error record and its observation metadata', () => {
  const agent = Object.freeze(worker({
    status: 'error', task: '실제 오류 기록', taskId: 'task-7', toolName: 'Bash',
    lastEventId: 'event-9', referenceEventId: 'event-8', activityKind: 'testing',
  }));
  const before = JSON.stringify(agent);
  const presentation = presentAgentActivity(agent, observedAt + ACTIVITY_FRESHNESS_MS);
  assert.notEqual(presentation, agent);
  assert.equal(JSON.stringify(agent), before);
  assert.equal(agent.status, 'error');
  assert.equal(Object.hasOwn(agent, 'unconfirmedStatus'), false);
  assert.deepEqual(presentation, { ...agent, status: 'idle', unconfirmedStatus: 'error' });
  assert.equal(presentAgentActivity(presentation, observedAt + ACTIVITY_FRESHNESS_MS + 1), presentation);
});

test('a new actual activity observation immediately restores the live presentation', () => {
  const now = observedAt + ACTIVITY_FRESHNESS_MS;
  const oldRecord = worker({ status: 'error' });
  assert.equal(presentAgentActivity(oldRecord, now).unconfirmedStatus, 'error');
  const freshRecord = { ...oldRecord, status: 'working', lastEventAt: new Date(now).toISOString() };
  assert.equal(presentAgentActivity(freshRecord, now), freshRecord);
  assert.equal(Object.hasOwn(freshRecord, 'unconfirmedStatus'), false);
  assert.equal(oldRecord.status, 'error');
});

test('model updates, task start and receipt metadata cannot renew activity freshness', () => {
  const now = observedAt + ACTIVITY_FRESHNESS_MS;
  const recent = new Date(now).toISOString();
  const agent = worker({ modelObservedAt: recent, taskStartedAt: recent, receivedAt: recent, timestamp: recent });
  assert.equal(presentAgentActivity(agent, now).unconfirmedStatus, 'working');
  const actualRecent = worker({ lastEventAt: recent, modelObservedAt: 'not-a-date', taskStartedAt: 'not-a-date' });
  assert.equal(presentAgentActivity(actualRecent, now), actualRecent);
});
