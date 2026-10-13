import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_FRESHNESS_MS, presentAgentActivity, splitDormantFloors } from '../src/activity-freshness.ts';

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = offset => new Date(observedAt + offset).toISOString();
const quiet = (id, projectId, lastEventAt, changes = {}) => worker({ id, status: 'idle', projectId, projectName: `${projectId} 프로젝트`, lastEventAt, ...changes });

test('a floor quiet for the chosen time leaves the view at the boundary, and floors in use keep every person on them', () => {
  const staff = [
    quiet('old-a', 'rested', at(-3 * DAY)), quiet('old-b', 'rested', at(0)),
    quiet('recent', 'used', at(-5 * DAY)), quiet('recent-b', 'used', at(DAY - HOUR)),
  ];
  const before = splitDormantFloors(staff, observedAt + DAY - 1, DAY);
  assert.deepEqual(before.staff, staff);
  assert.deepEqual(before.dormant, []);
  const after = splitDormantFloors(staff, observedAt + DAY, DAY);
  assert.deepEqual(after.staff.map(agent => agent.id), ['recent', 'recent-b'], 'an old record stays while its floor is still in use');
  assert.deepEqual(after.dormant, [{ id: 'rested', name: 'rested 프로젝트', lastEventAt: at(0) }], 'the floor is as old as its latest report');
  assert.equal(after.staff[0], staff[2], 'people are passed through, not copied or changed');
});

test('visible work, approval requests and errors hold their floor however old the report is', () => {
  for (const status of ['working', 'thinking', 'reviewing', 'approval', 'error']) {
    const staff = [quiet('holder', 'held', at(-30 * DAY), { status }), quiet('neighbour', 'held', at(-30 * DAY))];
    const result = splitDormantFloors(staff, observedAt, DAY);
    assert.deepEqual(result.staff, staff, status);
    assert.deepEqual(result.dormant, [], status);
  }
});

test('work too old to confirm does not hold a floor once it is presented as unconfirmed', () => {
  const stale = worker({ id: 'stale-worker', projectId: 'abandoned', projectName: '떠난 프로젝트', lastEventAt: at(-3 * DAY) });
  const presented = [presentAgentActivity(stale, observedAt)];
  assert.equal(presented[0].unconfirmedStatus, 'working');
  assert.deepEqual(splitDormantFloors(presented, observedAt, DAY).dormant.map(floor => floor.id), ['abandoned']);
  assert.deepEqual(splitDormantFloors([stale], observedAt, DAY).dormant, [], 'the raw working report still reads as visible work');
});

test('elapsed time that cannot be measured hides nothing', () => {
  for (const lastEventAt of [undefined, '', 'not-a-date']) {
    const staff = [quiet('timeless', 'unknown-time', lastEventAt), quiet('old', 'unknown-time', at(-30 * DAY))];
    assert.deepEqual(splitDormantFloors(staff, observedAt, DAY).staff, staff, String(lastEventAt));
  }
  const old = [quiet('old', 'rested', at(-30 * DAY))];
  for (const now of [NaN, Infinity, -Infinity]) assert.deepEqual(splitDormantFloors(old, now, DAY), { staff: old, dormant: [] });
  assert.deepEqual(splitDormantFloors(old, observedAt - 60 * DAY, DAY).dormant, [], 'a report from the future has not aged');
});

test('zero or an invalid limit keeps every floor', () => {
  const staff = [quiet('old', 'rested', at(-365 * DAY))];
  for (const limit of [0, -1, NaN, Infinity, undefined]) assert.deepEqual(splitDormantFloors(staff, observedAt, limit), { staff, dormant: [] }, String(limit));
});

test('people without a reported project rest together, and the input is never mutated', () => {
  const staff = Object.freeze([
    Object.freeze(quiet('nameless-a', undefined, at(-2 * DAY), { projectName: undefined })),
    Object.freeze(quiet('nameless-b', undefined, at(-3 * DAY), { projectName: undefined })),
    Object.freeze(quiet('named', 'used', at(0))),
  ]);
  const result = splitDormantFloors(staff, observedAt + HOUR, DAY);
  assert.deepEqual(result.staff.map(agent => agent.id), ['named']);
  assert.deepEqual(result.dormant, [{ id: '__unreported_project__', name: '프로젝트 미확인', lastEventAt: at(-2 * DAY) }]);
  assert.notEqual(result.staff, staff);
});

test('a floor limit keeps the floors reported from most recently, in their own order, and lists the rest from the most recent', () => {
  const staff = [
    quiet('a', 'oldest', at(-5 * HOUR)), quiet('b', 'newest', at(-1 * HOUR)), quiet('c', 'middle', at(-3 * HOUR)),
    quiet('d', 'second', at(-2 * HOUR)), quiet('e', 'oldest', at(-4 * HOUR)),
  ];
  assert.deepEqual(splitDormantFloors(staff, observedAt, 0, 4), { staff, dormant: [] }, 'four floors fit a limit of four');
  const limited = splitDormantFloors(staff, observedAt, 0, 2);
  assert.deepEqual(limited.staff.map(agent => agent.id), ['b', 'd'], 'kept people stay in their reported order');
  assert.deepEqual(limited.dormant.map(floor => floor.id), ['middle', 'oldest']);
  assert.equal(limited.dormant[1].lastEventAt, at(-4 * HOUR), 'a floor is as recent as its latest report');
  for (const limit of [0, -1, .5, NaN, Infinity, undefined]) assert.deepEqual(splitDormantFloors(staff, observedAt, 0, limit), { staff, dormant: [] }, String(limit));
});

test('floors showing work, an approval request or an error are never left out, even past the floor limit', () => {
  const staff = [
    quiet('recent-quiet', 'quiet-new', at(0)), quiet('old-work', 'busy-old', at(0), { status: 'working' }),
    quiet('old-approval', 'waiting-old', at(-30 * DAY), { status: 'approval' }), quiet('quiet-b', 'quiet-old', at(-HOUR)),
  ];
  const two = splitDormantFloors(staff, observedAt, 0, 3);
  assert.deepEqual(two.staff.map(agent => agent.id), ['recent-quiet', 'old-work', 'old-approval'], 'the room left after busy floors goes to the most recent quiet floor');
  const one = splitDormantFloors(staff, observedAt, 0, 1);
  assert.deepEqual(one.staff.map(agent => agent.id), ['old-work', 'old-approval'], 'busy floors alone may exceed the limit');
  assert.deepEqual(one.dormant.map(floor => floor.id), ['quiet-new', 'quiet-old']);
});

test('the time limit applies first, then the floor limit counts only the floors still in use', () => {
  const staff = [quiet('a', 'days-old', at(-3 * DAY)), quiet('b', 'now', at(0)), quiet('c', 'half-hour', at(-HOUR / 2)), quiet('d', 'two-hours', at(-2 * HOUR))];
  const result = splitDormantFloors(staff, observedAt, HOUR, 2);
  assert.deepEqual(result.staff.map(agent => agent.id), ['b', 'c']);
  assert.deepEqual(result.dormant.map(floor => floor.id), ['two-hours', 'days-old']);
  assert.deepEqual(splitDormantFloors(staff, observedAt, HOUR, 3).dormant.map(floor => floor.id), ['two-hours', 'days-old'], 'a rested floor does not take a place under the limit');
});

test('an unknown observation time ranks last for the floor limit and is listed without a time', () => {
  const staff = [quiet('timeless', 'unknown-time', undefined), quiet('old', 'known-old', at(-30 * DAY)), quiet('new', 'known-new', at(0))];
  assert.deepEqual(splitDormantFloors(staff, observedAt, DAY, 0).dormant.map(floor => floor.id), ['known-old'], 'the time limit alone never hides it');
  const limited = splitDormantFloors(staff, observedAt, 0, 2);
  assert.deepEqual(limited.staff.map(agent => agent.id), ['old', 'new']);
  assert.deepEqual(limited.dormant, [{ id: 'unknown-time', name: 'unknown-time 프로젝트' }]);
});
