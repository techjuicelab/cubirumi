import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDirector } from '../src/camera-director.ts';
const worker = (id, status = 'working') => ({ id, status, source: 'codex' });
test('cinematic shots wait, linger, and share attention across real working employees', () => {
  const director = new CameraDirector(0);
  const agents = [worker('a'), worker('b'), worker('c', 'approval'), worker('idle', 'idle')];
  assert.equal(director.next(agents, 5999), undefined);
  assert.equal(director.next(agents, 6000).agentId, 'c');
  assert.equal(director.next(agents, 16000), undefined);
  assert.equal(director.next(agents, 19000).agentId, 'a');
  assert.equal(director.next(agents, 30000).agentId, 'b');
});
test('manual interaction, reading panels and reduced-motion/paused gating prevent camera theft', () => {
  const director = new CameraDirector(0);
  director.hold(5000);
  assert.equal(director.next([worker('a')], 22999), undefined);
  assert.equal(director.next([worker('a')], 23000).agentId, 'a');
  assert.equal(director.next([worker('b')], 40000, false), undefined);
  assert.equal(director.next([worker('b')], 42000), undefined);
  assert.equal(director.next([worker('b')], 43000).agentId, 'b');
});
test('quiet, retired and ended workers do not attract auto camera; a quiet room eases back to wide view', () => {
  const director = new CameraDirector(0);
  director.next([worker('a')], 6000);
  const inactive = [worker('a', 'idle'), worker('waiting', 'waiting'), worker('finished', 'done'),
    { ...worker('demo'), source: 'demo' }, { ...worker('retired'), retired: true }, { ...worker('ended'), sessionEnded: true }];
  assert.deepEqual(director.next(inactive, 17000), { agentId: null, zoom: 1 });
  assert.equal(director.next(inactive, 24000), undefined);
});

test('observed error stays eligible, finished employees yield, and resumed work receives focus again', () => {
  const director = new CameraDirector(0);
  let agents = [worker('a'), worker('b', 'error')];
  assert.equal(director.next(agents, 6000).agentId, 'a');
  agents = [worker('a', 'done'), worker('b', 'error')];
  assert.equal(director.next(agents, 16999), undefined);
  assert.equal(director.next(agents, 17000).agentId, 'b');
  agents = [worker('a', 'idle'), worker('b', 'waiting')];
  assert.deepEqual(director.next(agents, 28000), { agentId: null, zoom: 1 });
  assert.equal(director.next(agents, 35000), undefined);
  agents = [worker('a', 'reviewing'), worker('b', 'waiting')];
  assert.equal(director.next(agents, 42000).agentId, 'a');
});

test('one working employee can regain focus after a manual camera hold without repetitive reframing', () => {
  const director = new CameraDirector(0);
  assert.equal(director.next([worker('a')], 6000).agentId, 'a');
  assert.equal(director.next([worker('a')], 17000), undefined);
  director.hold(18000);
  assert.equal(director.next([worker('a')], 35999), undefined);
  assert.equal(director.next([worker('a')], 36000).agentId, 'a');
});

test('returning to a crowded room remembers earlier shots and gives later employees a turn', () => {
  const director = new CameraDirector(0);
  const a = Array.from({ length: 30 }, (_, i) => worker(`a${i}`));
  const b = [worker('b0'), worker('b1')];
  const shots = [director.next(a, 6000).agentId, director.next(a, 17000).agentId];
  director.roomChanged(25000);
  shots.push(director.next(b, 31000).agentId, director.next(b, 42000).agentId);
  director.roomChanged(50000);
  shots.push(director.next(a, 56000).agentId, director.next(a, 67000).agentId);
  assert.deepEqual(shots, ['a0', 'a1', 'b0', 'b1', 'a2', 'a3']);
});
