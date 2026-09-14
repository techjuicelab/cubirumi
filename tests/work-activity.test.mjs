import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorkActivity } from '../src/work-activity.ts';
import { DeskWork } from '../src/desk-work.ts';
import { WorkMarkers } from '../src/work-markers.ts';

const observation = (activityKind, status = 'working', id = 'worker', taskId = 'task-1') => ({ id, taskId, status, activityKind });
const options = { detail: true, reducedMotion: false, paused: false, away: false };

test('brief research stays auxiliary, repeated evidence keeps phase, sustained documents become primary', () => {
  const work = new WorkActivity();
  work.observe(observation('coding'), 0);
  work.observe(observation('coding'), 2);
  assert.equal(work.frame(2).mainSince, 0);
  work.observe(observation('research'), 3);
  assert.deepEqual([work.frame(4).main, work.frame(4).auxiliary], ['coding', 'research']);
  work.observe(observation('coding'), 4.5);
  assert.equal(work.frame(4.5).auxiliary, null);
  work.observe(observation('documents'), 5);
  work.observe(observation('documents'), 6);
  assert.equal(work.frame(7).main, 'coding');
  assert.equal(work.frame(8).main, 'documents');
  assert.equal(work.frame(8).auxiliary, null);
});

test('unknown action does not inherit coding and agent or task replacement cannot inherit work', () => {
  const work = new WorkActivity();
  work.observe(observation('coding'), 0);
  work.observe(observation(undefined), 1);
  assert.equal(work.frame(1).main, 'general');
  work.observe(observation('documents', 'working', 'new-worker'), 2);
  assert.equal(work.frame(2).main, 'documents');
  work.observe(observation('research', 'working', 'new-worker', 'task-2'), 3);
  assert.equal(work.frame(3).main, 'research');
  assert.equal(work.frame(3).auxiliary, null);
});

test('response end stows props without inventing success; error freezes and approval yields immediately when reduced', () => {
  const work = new WorkActivity();
  work.observe(observation('coding'), 0);
  work.observe(observation(undefined, 'idle'), 2);
  assert.equal(work.frame(2.3).working, false);
  assert.ok(work.frame(2.3).amount > 0 && work.frame(2.3).amount < 1);
  assert.equal(work.frame(3).main, null);
  work.observe(observation('testing'), 4);
  work.observe(observation('testing', 'error'), 5);
  assert.equal(work.frame(30).main, 'testing');
  assert.equal(work.frame(30).error, true);
  assert.equal(work.frame(30).working, false);
  work.observe(observation(undefined, 'approval'), 31);
  assert.equal(work.frame(31, true).main, null);
});

test('desk mounts lazily, freezes at pause and frees old props on identity replacement', () => {
  const work = new DeskWork();
  work.observe(observation('coding'), 0);
  work.update(1, { ...options, detail: false });
  assert.equal(work.group.children.length, 0);
  work.update(2, options); work.update(3, options);
  const first = work.group.children[0];
  first.updateMatrixWorld(true);
  const before = first.getObjectByName('robot-elbow').position.toArray();
  work.update(3, { ...options, paused: true });
  assert.deepEqual(first.getObjectByName('robot-elbow').position.toArray(), before);
  work.observe(observation('documents', 'working', 'another-agent'), 3);
  assert.equal(first.parent === null, true, 'identity replacement frees the old props');
  work.update(4, options);
  assert.equal(work.group.children[0].name, 'work-props-documents');
  work.update(5, { ...options, away: true });
  assert.equal(work.group.visible, false);
  assert.equal(work.group.children.length, 0);
  work.dispose();
});

test('reduced motion stows instantly and a long-running action reuses resources', () => {
  const work = new DeskWork();
  work.observe(observation('documents'), 0);
  const reduced = { ...options, reducedMotion: true };
  work.update(0, reduced);
  const props = work.group.children[0];
  const geometry = props.getObjectByName('decorative-paper').geometry;
  for (let i = 1; i < 120; i++) { work.observe(observation('documents'), i); work.update(i, reduced); }
  assert.equal(work.group.children[0] === props, true, 'the long-running scene keeps its props object');
  assert.equal(props.getObjectByName('decorative-paper').geometry === geometry, true, 'and its paper geometry');
  work.observe(observation(undefined, 'idle'), 120);
  work.update(120, reduced);
  assert.equal(work.group.children.length, 0);
  work.dispose();
});

test('new work is visible while paused, reflection keeps quiet motion and early replacements do not jump in size', () => {
  const work = new DeskWork();
  work.observe(observation('coding'), 0);
  work.update(0, { ...options, paused: true });
  assert.equal(work.group.children[0].scale.x, 1);
  work.update(1, options);
  work.observe(observation('research', 'thinking'), 1);
  work.update(1, options); work.update(1.8, options);
  const drone = work.group.getObjectByName('research-drone');
  const before = drone.position.toArray();
  work.update(2.4, options);
  assert.notDeepEqual(drone.position.toArray(), before, 'thinking after a fast tool result must not freeze the entire scene');
  const reflecting = drone.position.toArray();
  work.update(2.4, { ...options, paused: true });
  assert.deepEqual(drone.position.toArray(), reflecting, 'explicit pause still freezes the auxiliary action');
  work.dispose();
  const early = new DeskWork();
  early.observe(observation('coding'), 0);
  early.update(0, options); early.update(.1, options);
  const old = early.group.children[0], scale = old.scale.x;
  early.observe(observation('general'), .1); early.update(.1, options);
  assert.equal(old.scale.x, scale);
  early.dispose();
});

test('an external call holds the desk props where they stand and resumes them without a time jump', () => {
  const control = new DeskWork(), held = new DeskWork();
  const elbow = work => work.group.getObjectByName('robot-elbow').position.toArray();
  const call = (status = 'working') => ({ ...observation('general', status), toolName: 'MCP 도구' });
  for (const work of [control, held]) {
    work.observe(observation('coding'), 0);
    for (let i = 0; i <= 20; i++) work.update(i / 10, options);
  }
  held.observe(call(), 2);
  assert.equal(held.onHold, true);
  held.update(2, options);
  const waiting = elbow(held);
  for (let i = 21; i <= 50; i++) {
    if (i % 7 === 0) held.observe(call(i % 2 ? 'thinking' : 'working'), i / 10);
    held.update(i / 10, options);
    assert.deepEqual(elbow(held), waiting, `the robot arm waits at ${i / 10}s`);
    assert.equal(held.group.children[0].name, 'work-props-coding', 'the call does not replace the desk scene');
    assert.equal(held.group.getObjectByName('work-pause-indicator').visible, false, 'a call is not a paused or failed task');
  }
  assert.equal(held.group.userData.onHold, true);
  held.observe(observation('coding'), 5);
  assert.equal(held.onHold, false);
  for (let i = 0; i <= 20; i++) {
    held.update(5 + i / 10, options);
    if (i) control.update(2 + i / 10, options);
    const [a, b] = [elbow(held), elbow(control)];
    assert.ok(a.every((value, axis) => Math.abs(value - b[axis]) < 1e-9), `resumed from the held pose: ${a} vs ${b}`);
  }
  assert.notDeepEqual(elbow(held), waiting, 'and keeps moving after the call');
  control.dispose(); held.dispose();
});

test('a call keeps the auxiliary action and never promotes it, while approval or error ends the hold at once', () => {
  const work = new DeskWork();
  const call = (status = 'working') => ({ ...observation('general', status), toolName: 'MCP 도구' });
  work.observe(observation('coding'), 0); work.update(0, options);
  work.observe(observation('research'), 1); work.update(1, options);
  for (let t = 2; t <= 30; t++) { work.observe(call(), t); work.update(t, options); }
  assert.deepEqual([work.frame(30).main, work.frame(30).auxiliary], ['coding', 'research'], 'no replacement or promotion during a long call');
  assert.equal(work.group.children.length, 2);
  work.observe(call('error'), 31); work.update(31, options);
  assert.equal(work.onHold, false, 'an error ends the call');
  assert.equal(work.group.getObjectByName('work-error-indicator')?.visible, true, 'and the desk shows the error state');
  work.observe(call(), 32);
  assert.equal(work.onHold, true);
  work.observe(call('approval'), 33);
  assert.equal(work.onHold, false, 'approval ends the call');
  assert.equal(work.frame(33, true).main, null, 'and yields the desk immediately with reduced motion');
  work.dispose();
  const mounted = new DeskWork();
  mounted.observe(call(), 0);
  mounted.update(0, { ...options, detail: false });
  mounted.update(3, options);
  const props = mounted.group.children[0];
  assert.equal(props.name, 'work-props-general');
  assert.equal(props.scale.x, 1, 'props mounted during a call are not stuck at zero size');
  mounted.observe({ ...observation('general') }, 5); mounted.update(5, options); mounted.update(5.2, options);
  assert.equal(props.scale.x, 1, 'and do not regrow after it');
  mounted.dispose();
});

test('a new person taking over a calling desk ends the previous hold and starts their own from what they report', () => {
  const work = new DeskWork();
  const call = (activityKind, status, id) => ({ ...observation(activityKind, status, id), toolName: 'MCP 도구' });
  work.observe(observation('coding', 'thinking', 'first'), 0); work.update(0, options);
  work.observe(call('general', 'thinking', 'first'), 1); work.update(1, options);
  assert.equal(work.onHold, true);
  assert.equal(work.heldWaiting, true, 'the first caller reflects while holding');
  assert.equal(work.heldKind, 'coding');
  work.observe(call('documents', 'working', 'second'), 5);
  assert.equal(work.onHold, true, 'the newcomer is on a call of their own');
  assert.equal(work.holdStartedAt, 5, 'their hold starts at the takeover');
  assert.equal(work.heldSeconds, 4, 'the previous occupant\'s hold is closed');
  assert.equal(work.heldWaiting, false, 'the newcomer is working, not reflecting');
  assert.equal(work.heldKind, undefined, 'nothing of the first caller\'s desk is kept');
  work.update(5, options);
  assert.equal(work.group.children.length, 1);
  assert.equal(work.group.children[0].name, 'work-props-documents', 'the newcomer\'s reported action decides the desk');
  assert.equal(work.group.children[0].scale.x, 1, 'shown fully grown while time is held');
  assert.equal(work.group.getObjectByName('work-pause-indicator')?.visible ?? false, false);
  work.observe(call('research', 'working', 'second'), 6);
  assert.equal(work.frame(6).main, 'documents', 'a mid-call action still cannot replace the held scene');
  work.observe(observation('documents', 'working', 'second'), 8);
  assert.equal(work.onHold, false);
  assert.equal(work.heldSeconds, 7, 'both holds are excluded from work time');
  work.observe(call('general', 'thinking', 'third'), 9);
  assert.equal(work.holdStartedAt, 9);
  assert.equal(work.heldSeconds, 7, 'taking over a desk that is not on hold adds no held time');
  assert.equal(work.heldWaiting, true, 'a reflecting newcomer holds the quiet pose they reported');
  work.dispose();
});

test('an open card keeps only a selection ring for its employee while every other marker stays', () => {
  const markers = new WorkMarkers();
  const figures = ['a', 'b', 'c'].map((id, i) => {
    const group = new THREE.Group();
    group.position.set(i * 3, 0, 0);
    return { id, status: i === 1 ? 'approval' : 'working', activityKind: 'coding', origin: new THREE.Vector3(i * 3, 0, 0), group };
  });
  const byName = name => markers.group.getObjectByName(name);
  const ring = byName('work-status-ring'), diamond = byName('approval-status-diamond'), selection = byName('work-selection-ring');
  const counts = () => [ring.count, diamond.count, selection.count];
  markers.update(figures, 1, null, true, new Set());
  // Decision 22: approval shows a diamond above the head instead of a floor ring.
  assert.deepEqual(counts(), [2, 1, 0]);
  markers.update(figures, 1, null, true, new Set(), 'b');
  assert.deepEqual(counts(), [2, 0, 1]);
  const matrix = new THREE.Matrix4();
  selection.getMatrixAt(0, matrix);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(matrix).x, 3, 'the ring sits under the carded employee');
  markers.update(figures, 1, 'b', true, new Set(), 'b');
  assert.equal(selection.count, 1, 'focus and an open card share one ring');
  markers.update(figures, 1, null, true, new Set(), null);
  assert.deepEqual(counts(), [2, 1, 0]);
  assert.equal(markers.group.children.length, 15);
  markers.dispose();
});

test('work markers use constant meshes for 512 staff and distinguish selected, busy, error, approval and idle', () => {
  const markers = new WorkMarkers();
  const figures = Array.from({ length: 512 }, (_, i) => ({ id: `worker-${i}`,
    status: i === 1 ? 'error' : i === 2 ? 'approval' : i === 3 ? 'idle' : 'working', activityKind: 'coding',
    origin: new THREE.Vector3(i * 3, 0, 0), group: new THREE.Group() }));
  markers.update(figures, 1, 'worker-3', true, new Set());
  const byName = name => markers.group.getObjectByName(name);
  const ring = byName('work-status-ring'), triangle = byName('error-status-triangle');
  const diamond = byName('approval-status-diamond'), selection = byName('work-selection-ring');
  assert.equal(ring.count, 509);
  assert.equal(triangle.count, 1);
  assert.equal(diamond.count, 1);
  assert.equal(selection.count, 1);
  assert.equal(ring.material.color.getHexString(), 'ff5b54');
  assert.equal(diamond.material.color.getHexString(), 'e6bd61');
  assert.equal(new THREE.Color().fromBufferAttribute(triangle.geometry.getAttribute('color'), 0).getHexString(), 'ba3344');
  for (const mesh of [ring, triangle, diamond]) assert.equal(mesh.material.toneMapped, false, mesh.name);
  const before = [...ring.instanceMatrix.array];
  markers.update(figures, 2, 'worker-3', true, new Set());
  assert.deepEqual([...ring.instanceMatrix.array], before);
  assert.equal(markers.group.children.length, 15);
  markers.dispose();
});
