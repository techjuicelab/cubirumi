import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingDirector } from '../src/building-director.ts';

const worker = (projectId, sessionId, id, status = 'working', extra = {}) => ({
  projectId, sessionId, id, status, source: 'claude', ...extra,
});
const room = (projectId, sessionId, count = 1, status = 'working') => Array.from({ length: count }, (_, i) => worker(projectId, sessionId, `${projectId}-${sessionId}-${i}`, status));
const at = (now, current, extra = {}) => ({ now, current, ...extra });

test('CCTV starts wide using connected rooms and floor scope never escapes its selected floor', () => {
  const director = new BuildingDirector(0);
  const agents = [...room('a', 'first'), ...room('a', 'second'), ...room('b', 'busy', 30),
    worker('demo', 'fake', 'demo', 'working', { source: 'demo' }),
    worker('ended', 'gone', 'ended', 'working', { sessionEnded: true }),
    worker('retired', 'gone', 'retired', 'working', { retired: true })];
  let current = director.next(agents, { now: 0, scope: 'floor', projectId: 'a' });
  assert.deepEqual(current, { projectId: 'a', sessionId: 'first', view: 'overview', reason: 'initial', focusAfterMs: 5500 });
  for (const now of [25_000, 50_000, 75_000, 100_000]) {
    const previous = current.sessionId;
    current = director.next(agents, at(now, current, { scope: 'floor', projectId: 'a' }));
    assert.equal(current.projectId, 'a'); assert.notEqual(current.sessionId, previous);
  }
  assert.equal(director.next(agents, { now: 125_000, scope: 'floor', projectId: 'missing' }), undefined);
  const building = new BuildingDirector(0);
  assert.equal(building.next(agents, { now: 0 }).projectId, 'b');
  assert.equal(building.next([worker('x', 'y', 'gone', 'working', { retired: true })], { now: 25_000 }), undefined);
});

test('floor visits share attention across active floors and never tour quiet rooms', () => {
  const director = new BuildingDirector(0);
  const agents = [...room('busy', 'one', 20), ...room('busy', 'two', 10), ...room('busy', 'three', 5),
    ...room('busy', 'idle', 2, 'idle'), ...room('small', 'one', 2), ...room('quiet', 'one', 2, 'idle'),
    ...room('finished', 'one', 2, 'done'), ...room('waiting', 'one', 2, 'waiting')];
  let current; const shots = [];
  for (let now = 0; now <= 600_000; now += 25_000) {
    const shot = director.next(agents, at(now, current));
    if (shot) { shots.push(shot); current = shot; }
  }
  const count = id => shots.filter(shot => shot.projectId === id).length;
  assert.ok(count('busy') > 0); assert.ok(count('small') > 0);
  for (const id of ['quiet', 'finished', 'waiting']) assert.equal(count(id), 0);
  assert.equal(shots.some(shot => shot.sessionId === 'idle'), false);
  assert.equal(new Set(shots.filter(shot => shot.projectId === 'busy').map(shot => shot.sessionId)).size, 3);
  for (let i = 2; i < shots.length; i++) assert.ok(new Set(shots.slice(i - 2, i + 1).map(shot => shot.projectId)).size > 1);
});

test('a single active room keeps its view without revisiting quiet floors', () => {
  const director = new BuildingDirector(0);
  const agents = [...room('a', 'busy', 30), ...room('z', 'idle', 2, 'idle')];
  let current; const floors = [];
  for (let now = 0; now <= 100_000; now += 25_000) {
    const shot = director.next(agents, at(now, current));
    if (shot) { current = shot; floors.push(current.projectId); }
  }
  assert.deepEqual(floors, ['a']);
});

test('finished rooms yield to active work after minimum dwell and resume only when activity returns', () => {
  const director = new BuildingDirector(0);
  let agents = [...room('a', 'one', 2), ...room('b', 'two'), ...room('z', 'quiet', 2, 'idle')];
  let current = director.next(agents, { now: 0 });
  assert.equal(current.projectId, 'a');
  agents = agents.map(agent => agent.projectId === 'a' ? { ...agent, status: 'done' } : agent);
  assert.equal(director.next(agents, at(1000, current)), undefined);
  assert.equal(director.next(agents, at(11_999, current)), undefined);
  current = director.next(agents, at(12_000, current));
  assert.equal(current.projectId, 'b');
  agents = agents.map(agent => ({ ...agent, status: 'idle' }));
  assert.equal(director.next(agents, at(50_000, current)), undefined);
  assert.equal(director.next(agents, at(150_000, current)), undefined);
  agents = agents.map(agent => agent.projectId === 'a' ? { ...agent, status: 'thinking' } : agent);
  current = director.next(agents, at(151_000, current));
  assert.equal(current.projectId, 'a');
});

test('initial quiet selection is skipped and approval or error remains observable within the chosen scope', () => {
  const director = new BuildingDirector(0);
  const agents = [...room('a', 'idle', 3, 'idle'), ...room('b', 'approval', 1, 'approval'),
    ...room('c', 'error', 1, 'error')];
  let current = director.next(agents, at(0, { projectId: 'a', sessionId: 'idle' }));
  assert.equal(current.projectId, 'b');
  current = director.next(agents, at(25_000, current));
  assert.equal(current.projectId, 'c');
  director.reset(50_000);
  assert.equal(director.next(agents, { now: 50_000, scope: 'floor', projectId: 'a' }), undefined);
  assert.equal(director.next(agents, { now: 51_000, scope: 'floor', projectId: 'c' }).projectId, 'c');
});

test('new active rooms wait for minimum dwell and short activity bursts cannot jump the camera', () => {
  const director = new BuildingDirector(0);
  let agents = [...room('a', 'busy'), ...room('b', 'new', 1, 'idle'), ...room('c', 'burst', 1, 'idle')];
  let current = director.next(agents, { now: 0 });
  agents = agents.map(agent => agent.projectId === 'b' ? { ...agent, status: 'working' } : agent);
  assert.equal(director.next(agents, at(1000, current)), undefined);
  assert.equal(director.nextAt, 12_000);
  assert.equal(director.next(agents, at(11_999, current)), undefined);
  current = director.next(agents, at(12_000, current));
  assert.equal(current.projectId, 'b'); assert.equal(current.reason, 'activity');
  agents = agents.map(agent => agent.projectId === 'c' ? { ...agent, status: 'working' } : agent);
  assert.equal(director.next(agents, at(12_500, current)), undefined);
  agents = agents.map(agent => agent.projectId === 'c' ? { ...agent, status: 'idle' } : agent);
  assert.equal(director.next(agents, at(13_000, current)), undefined);
  assert.equal(director.next(agents, at(24_000, current)), undefined, 'the canceled burst must not shorten the ordinary cycle');
  assert.equal(director.next(agents, at(36_999, current)), undefined);
  assert.ok(director.next(agents, at(37_000, current)));
});

test('manual hold and disabled gates defer both ordinary rotation and new work, then resume smoothly', () => {
  const director = new BuildingDirector(0);
  let agents = [...room('a', 'one'), ...room('b', 'two', 1, 'idle')];
  let current = director.next(agents, { now: 0 });
  director.hold(20_000);
  agents = agents.map(agent => ({ ...agent, status: 'working' }));
  assert.equal(director.next(agents, at(21_000, current)), undefined);
  assert.equal(director.next(agents, at(37_999, current)), undefined);
  current = director.next(agents, at(38_000, current)); assert.equal(current.projectId, 'b');
  assert.equal(director.next(agents, at(60_000, current, { enabled: false })), undefined);
  assert.equal(director.next(agents, at(180_000, current, { enabled: false })), undefined);
  assert.equal(director.next(agents, at(181_000, current)), undefined);
  assert.equal(director.next(agents, at(205_999, current)), undefined);
  assert.ok(director.next(agents, at(206_000, current)));
});

test('initial hold delays the first shot, while explicit reset clears hold and immediately restores wide view', () => {
  const director = new BuildingDirector(0), agents = [...room('a', 'one'), ...room('b', 'two')];
  director.hold(0);
  assert.equal(director.next(agents, { now: 17_999 }), undefined);
  let current = director.next(agents, { now: 18_000 }); assert.equal(current.reason, 'initial');
  director.hold(20_000); director.reset(21_000);
  current = director.next(agents, at(21_000, current)); assert.equal(current.reason, 'initial');
  assert.equal(director.nextAt, 46_000);
  director.reset(22_000);
  assert.equal(director.next(agents, at(22_000, current, { enabled: false })), undefined);
});

test('external room selection gets its own dwell and cycleSeconds governs ordinary rotation', () => {
  const director = new BuildingDirector(0), agents = [...room('a', 'one'), ...room('b', 'two')];
  const first = director.next(agents, { now: 0, cycleSeconds: 45 });
  const chosen = { projectId: 'b', sessionId: 'two' };
  assert.notEqual(first.projectId, chosen.projectId);
  assert.equal(director.next(agents, at(10_000, chosen, { cycleSeconds: 45 })), undefined);
  assert.equal(director.next(agents, at(54_999, chosen, { cycleSeconds: 45 })), undefined);
  assert.equal(director.next(agents, at(55_000, chosen, { cycleSeconds: 45 })).projectId, 'a');
});

test('an already displayed room is recognized during initial hold without spending a second cycle on its initial shot', () => {
  const director = new BuildingDirector(0), agents = [...room('a', 'one'), ...room('b', 'two')];
  const current = { projectId: 'a', sessionId: 'one' };
  director.hold(0, 25_000);
  assert.equal(director.next([], at(0, current, { enabled: false })), undefined);
  assert.equal(director.next(agents, at(1000, current)), undefined);
  assert.equal(director.next(agents, at(24_999, current)), undefined);
  const shot = director.next(agents, at(25_000, current));
  assert.equal(shot.projectId, 'b'); assert.notEqual(shot.reason, 'initial');
});

test('explicit holds anchor manual selection and disabled recovery to the action time rather than the next tick', () => {
  const director = new BuildingDirector(0), agents = [...room('a', 'one'), ...room('b', 'two')];
  let current = director.next(agents, { now: 0 });
  current = { projectId: 'b', sessionId: 'two' }; director.hold(10_000, 25_000);
  assert.equal(director.next(agents, at(11_000, current)), undefined);
  assert.equal(director.next(agents, at(34_999, current)), undefined);
  current = director.next(agents, at(35_000, current)); assert.equal(current.projectId, 'a');
  assert.equal(director.next(agents, at(60_000, current, { enabled: false })), undefined);
  director.hold(60_000, 25_000);
  assert.equal(director.next(agents, at(61_000, current)), undefined);
  assert.equal(director.next(agents, at(84_999, current)), undefined);
  assert.equal(director.next(agents, at(85_000, current)).projectId, 'b');
});
