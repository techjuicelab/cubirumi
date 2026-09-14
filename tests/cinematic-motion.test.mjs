import test from 'node:test';
import assert from 'node:assert/strict';
import { createCinematicMotionState, holdCinematicMotion, stepCinematicMotion, sampleCinematicMotion,
  neutralCinematicOffset, CINEMATIC_MANUAL_HOLD_MS, CINEMATIC_PROFILES } from '../src/cinematic-motion.ts';

const kinds = ['employee', 'room', 'building'];
const fields = ['yaw', 'elevation', 'zoomScale', 'targetX', 'targetY', 'targetZ'];
const span = values => Math.max(...values) - Math.min(...values);
function frame(kind, deltaSeconds = 1 / 60, nowMs = 0, changes = {}) {
  return { kind, deltaSeconds, nowMs, enabled: true, ...changes };
}
function run(kind, duration, fps = 60, state = createCinematicMotionState()) {
  for (let i = 0; i < duration * fps; i++) state = stepCinematicMotion(state, frame(kind, 1 / fps, i / fps * 1000));
  return state;
}

test('all three shot profiles have perceptible height, zoom and lateral variation', () => {
  const minimums = { employee: { elevation: .075, zoom: .09, yaw: .15 }, room: { elevation: .14, zoom: .13, yaw: .35 }, building: { elevation: .20, zoom: .16, yaw: .5 } };
  for (const kind of kinds) {
    const samples = Array.from({ length: 601 }, (_, i) => sampleCinematicMotion(kind, i / 2));
    assert.ok(span(samples.map(value => value.elevation)) > minimums[kind].elevation, `${kind} needs meaningful height variation`);
    assert.ok(span(samples.map(value => value.zoomScale)) > minimums[kind].zoom, `${kind} needs meaningful dolly/zoom variation`);
    assert.ok(span(samples.map(value => value.yaw)) > minimums[kind].yaw, `${kind} needs different viewpoints`);
    assert.ok(samples.some(value => value.zoomScale < .98) && samples.some(value => value.zoomScale > 1.02));
    for (const field of ['targetX', 'targetY', 'targetZ']) assert.ok(span(samples.map(value => value[field])) > .001, `${kind} ${field} must not remain static`);
    assert.ok(samples.some(value => value.yaw > 0) && samples.some(value => value.yaw < 0), 'bounded movement reverses instead of spinning forever');
  }
});

test('profiles remain within their own angular, scale and target bounds over long and exceptional clocks', () => {
  for (const kind of kinds) {
    const profile = CINEMATIC_PROFILES[kind];
    for (const time of [...Array.from({ length: 2000 }, (_, i) => i * 31.37), 1e100, Number.MAX_VALUE, NaN, Infinity, -Infinity, -1]) {
      const value = sampleCinematicMotion(kind, time);
      assert.ok(fields.every(field => Number.isFinite(value[field])));
      assert.ok(Math.abs(value.yaw) <= profile.yaw);
      assert.ok(Math.abs(value.elevation) <= profile.elevation);
      assert.ok(Math.abs(value.zoomScale - 1) <= profile.zoomVariation + 1e-12);
      for (const field of ['targetX', 'targetY', 'targetZ']) assert.ok(Math.abs(value[field]) <= profile[field]);
    }
  }
  assert.deepEqual(sampleCinematicMotion('unknown', 10), sampleCinematicMotion('room', 10));
});

test('trajectories are continuous across wave boundaries, without synchronized circular motion', () => {
  for (const kind of kinds) {
    for (let time = 0; time < 400; time += .31) {
      const before = sampleCinematicMotion(kind, time);
      const after = sampleCinematicMotion(kind, time + .001);
      for (const field of fields) assert.ok(Math.abs(after[field] - before[field]) < .00004, `${kind} ${field} jumps at ${time}`);
    }
    let sameDirection = 0, oppositeDirection = 0;
    for (let time = 0; time < 300; time += 5) {
      const before = sampleCinematicMotion(kind, time), after = sampleCinematicMotion(kind, time + 1);
      const paired = (after.elevation - before.elevation) * (after.zoomScale - before.zoomScale);
      if (paired > 0) sameDirection++;
      if (paired < 0) oppositeDirection++;
    }
    assert.ok(sameDirection > 10 && oppositeDirection > 10, 'height and zoom must not remain locked to the same direction');
  }
});

test('the initial offset is neutral and repeated sampling never mutates base state', () => {
  const original = createCinematicMotionState();
  assert.deepEqual(original.offset, neutralCinematicOffset());
  Object.freeze(original.offset); Object.freeze(original);
  const next = stepCinematicMotion(original, frame('room'));
  assert.notDeepEqual(next.offset, original.offset);
  assert.deepEqual(original, createCinematicMotionState());
  assert.deepEqual(stepCinematicMotion(original, frame('room')), next, 'the same input always produces the same output');
  assert.ok(!('baseYaw' in next) && !('baseZoom' in next));
});

test('manual interaction holds both trajectory and offset for eighteen seconds, then resumes continuously', () => {
  const moving = run('room', 10);
  const held = holdCinematicMotion(moving, 50000);
  assert.equal(held.heldUntilMs, 50000 + CINEMATIC_MANUAL_HOLD_MS);
  assert.deepEqual(held.offset, moving.offset);
  assert.deepEqual(stepCinematicMotion(held, frame('room', .2, 67999)), held);
  const resumed = stepCinematicMotion(held, frame('room', 1 / 60, 68000));
  assert.ok(resumed.elapsedSeconds > held.elapsedSeconds);
  for (const field of fields) assert.ok(Math.abs(resumed.offset[field] - held.offset[field]) < .001);
  const continuedGesture = stepCinematicMotion(held, frame('room', .2, 60000, { interacting: true }));
  assert.equal(continuedGesture.heldUntilMs, 78000);
  assert.deepEqual(continuedGesture.offset, held.offset);
  assert.equal(holdCinematicMotion(continuedGesture, 55000).heldUntilMs, 78000, 'older input cannot shorten a manual hold');
});

test('pause, reduced-motion, disabled mode and zero delta freeze the current composition', () => {
  const moving = run('employee', 15);
  for (const gating of [{ paused: true }, { reducedMotion: true }, { enabled: false }]) {
    assert.deepEqual(stepCinematicMotion(moving, frame('building', 120, 120000, gating)), moving);
  }
  for (const delta of [0, -1, NaN, Infinity]) assert.deepEqual(stepCinematicMotion(moving, frame('room', delta, 120000)), moving);
  const resumed = stepCinematicMotion(moving, frame('employee', 1 / 60, 240000));
  assert.ok(resumed.elapsedSeconds - moving.elapsedSeconds < .017, 'paused wall time does not advance the motion phase');
  for (const field of fields) assert.ok(Math.abs(resumed.offset[field] - moving.offset[field]) < .001);
});

test('profile transitions and long frame gaps never create an abrupt camera step', () => {
  let state = run('building', 26);
  for (const kind of ['employee', 'building', 'room', 'employee']) {
    const before = state;
    state = stepCinematicMotion(state, frame(kind, 1 / 60, 100000));
    assert.ok(Math.abs(state.offset.yaw - before.offset.yaw) <= .00076);
    assert.ok(Math.abs(state.offset.elevation - before.offset.elevation) <= .00042);
    assert.ok(Math.abs(state.offset.zoomScale - before.offset.zoomScale) <= .00034);
    for (const field of ['targetX', 'targetY', 'targetZ']) assert.ok(Math.abs(state.offset[field] - before.offset[field]) <= .000026);
  }
  const gap = stepCinematicMotion(state, frame('building', 3600, 1000000));
  assert.equal(gap.elapsedSeconds - state.elapsedSeconds, .25);
  assert.ok(Math.abs(gap.offset.yaw - state.offset.yaw) <= .01126);
  assert.ok(Math.abs(gap.offset.zoomScale - state.offset.zoomScale) <= .00501);
});

test('low and high frame rates produce comparable framing while the smoothed motion still changes height and zoom', () => {
  for (const kind of kinds) {
    const low = run(kind, 60, 30), high = run(kind, 60, 120);
    for (const field of fields) assert.ok(Math.abs(low.offset[field] - high.offset[field]) < .001, `${kind} ${field} depends too strongly on frame rate`);
    let state = createCinematicMotionState();
    const frames = [];
    for (let i = 0; i < 2400; i++) {
      state = stepCinematicMotion(state, frame(kind, .1, i * 100));
      if (i % 10 === 0) frames.push(state.offset);
    }
    assert.ok(span(frames.map(value => value.elevation)) > .07);
    assert.ok(span(frames.map(value => value.zoomScale)) > .09);
  }
});

test('invalid persisted motion state cannot poison camera offsets with non-finite values', () => {
  const state = { elapsedSeconds: NaN, heldUntilMs: Infinity,
    offset: { yaw: Infinity, elevation: -Infinity, zoomScale: NaN, targetX: NaN, targetY: Infinity, targetZ: -Infinity } };
  const next = stepCinematicMotion(state, frame('room', .1, NaN));
  assert.ok(Number.isFinite(next.elapsedSeconds) && Number.isFinite(next.heldUntilMs));
  assert.ok(fields.every(field => Number.isFinite(next.offset[field])));
});
