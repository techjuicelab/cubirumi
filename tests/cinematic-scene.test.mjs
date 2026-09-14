import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { OfficeScene } from '../src/office-scene.ts';
import { BuildingOverview, BUILDING_VIEW, PLATE, PLATE_HALF_HEIGHT } from '../src/building-overview.ts';
import { CameraPointers } from '../src/office-camera.ts';
import { officeBounds } from '../src/office-layout.ts';
import { createCinematicMotionState, CINEMATIC_MANUAL_HOLD_MS, CINEMATIC_PROFILES } from '../src/cinematic-motion.ts';

// Use the production camera methods; only the DOM/WebGL surfaces are replaced.
function fixture(kind = 'room', capacity = 6) {
  const group = new THREE.Group();
  group.position.set(3, 0, -2);
  const target = kind === 'employee' ? group.position.clone().add(new THREE.Vector3(0, 1.15, 0))
    : kind === 'building' ? new THREE.Vector3(0, 8, 0) : new THREE.Vector3(0, .3, .15);
  const scene = Object.assign(Object.create(OfficeScene.prototype), {
    figures: kind === 'employee' ? [{ id: 'observed-agent', group }] : [],
    paperFlights: [],
    agentSeats: new Map(kind === 'employee' ? [['observed-agent', 0]] : []),
    bounds: officeBounds(capacity),
    buildingView: kind === 'building',
    building: kind === 'building' ? { center: target.clone(), radius: 32 } : undefined,
    motion: createCinematicMotionState(),
    yaw: .61, elevation: .81, cameraZoom: kind === 'employee' ? 1.65 : 1,
    zoomGoal: kind === 'employee' ? 1.65 : 1,
    framing: kind === 'employee' ? 1 : 0, framingGoal: kind === 'employee' ? 1 : 0,
    cinematic: false, cinematicElapsed: 0, cinematicStartZoom: 1, cinematicStartFraming: 0,
    cinematicStartTarget: target.clone(),
    following: kind === 'employee', focusId: kind === 'employee' ? 'observed-agent' : null,
    autoRotate: true, autoRotateAfter: 0, paused: false, reducedMotion: false,
    cameraPointers: new CameraPointers(),
    camera: new THREE.OrthographicCamera(-13, 13, 10, -10, .1, 150),
    cameraTarget: target.clone(), targetGoal: target.clone(),
    sunLight: null, backWall: new THREE.Group(), leftWall: new THREE.Group(),
    container: { clientWidth: 1200, clientHeight: 800 },
    renderer: { setSize() {} },
  });
  scene.resize();
  scene.updateCamera(0, 0);
  return scene;
}

function buildingFixture(t, projectId = '') {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  const building = new BuildingOverview(window.document.createElement('div'), () => {});
  t.after(() => { building.dispose(); window.close(); globalThis.document = previousDocument; });
  const scene = fixture();
  scene.building = building;
  scene.buildingFocus = '';
  scene.world = new THREE.Group();
  scene.effects = new THREE.Group();
  scene.container.dataset = {};
  scene.autoRotate = false;
  scene.setBuildingFloors([buildingFloor('first', 5)]);
  scene.setBuildingView(true, projectId);
  run(scene, 3);
  assert.equal(scene.cinematic, false);
  return scene;
}
function buildingFloor(id, count) {
  return { id, name: id, agents: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, status: 'working' })) };
}

function basePose(scene) {
  return { yaw: scene.yaw, elevation: scene.elevation, zoom: scene.cameraZoom,
    target: scene.cameraTarget.toArray(), goal: scene.targetGoal.toArray() };
}
function renderedPose(scene) {
  return { position: scene.camera.position.toArray(), quaternion: scene.camera.quaternion.toArray(),
    zoom: scene.camera.zoom, projection: scene.camera.projectionMatrix.toArray() };
}
function run(scene, seconds, startMs = 0, delta = .1) {
  for (let i = 1; i <= Math.round(seconds / delta); i++) scene.updateCamera(delta, startMs + i * delta * 1000);
}
function assertNear(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}
function targetInView(scene) {
  const radius = Math.max(60, scene.buildingView ? scene.building.radius * 2.5
    : Math.hypot(scene.bounds.width, scene.bounds.depth) * 1.2);
  return scene.camera.position.clone().addScaledVector(scene.camera.getWorldDirection(new THREE.Vector3()), radius);
}

test('actual room, employee and building cameras vary height and viewpoint (room and employee also zoom) without accumulating into the base pose', () => {
  for (const kind of ['room', 'employee', 'building']) {
    const scene = fixture(kind), initial = basePose(scene);
    const heights = [], zooms = [], directions = [];
    for (let i = 1; i <= 2400; i++) {
      scene.updateCamera(.1, i * 100);
      heights.push(scene.camera.position.y);
      zooms.push(scene.camera.zoom);
      directions.push(scene.camera.getWorldDirection(new THREE.Vector3()).x);
      assert.ok([...scene.camera.position, ...scene.camera.projectionMatrix.elements].every(Number.isFinite));
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) > 2, `${kind} must change height`);
    if (kind === 'building') {
      // The whole-building fit is tight and follows the drawn pose, so the drift's optical zoom stays out of the building shot.
      assert.ok(zooms.every(zoom => zoom === 1), 'the building shot keeps its optical zoom at 1');
    } else {
      assert.ok(Math.max(...zooms) - Math.min(...zooms) > .09, `${kind} must move both closer and farther`);
      assert.ok(Math.min(...zooms) < .98 && Math.max(...zooms) > 1.02);
    }
    assert.ok(Math.max(...directions) - Math.min(...directions) > .08, `${kind} must change viewpoint`);
    assert.deepEqual(basePose(scene), initial, `${kind} must keep the user's base framing intact`);
  }
});

test('render-only target drift and optical zoom compose with an existing manual base zoom', () => {
  const scene = fixture();
  scene.zoom(.6);
  scene.autoRotateAfter = 0;
  scene.motion.heldUntilMs = 0;
  const initial = basePose(scene), initialHeight = scene.camera.top - scene.camera.bottom;
  run(scene, 12);
  const renderedTarget = targetInView(scene);
  const span = Math.min(45, Math.max(scene.bounds.width, scene.bounds.depth));
  const drift = new THREE.Vector3(scene.motion.offset.targetX, scene.motion.offset.targetY, scene.motion.offset.targetZ).multiplyScalar(span);
  assert.ok(drift.length() > .01, 'the target really moves in the rendered shot');
  assert.ok(renderedTarget.distanceTo(scene.cameraTarget.clone().add(drift)) < 1e-9, 'lookAt must use the composed target');
  assert.deepEqual(basePose(scene), initial);
  assert.equal(scene.camera.top - scene.camera.bottom, initialHeight, 'automatic motion must not rewrite base zoom/frustum');
  assert.equal(scene.camera.zoom, scene.motion.offset.zoomScale);
  const effectiveHeight = initialHeight / scene.camera.zoom;
  assert.ok(Math.abs(effectiveHeight - initialHeight) > .01, 'projection must apply the automatic zoom');
});

test('manual orbit, zoom, wheel and keyboard keep motion frozen for eighteen seconds then resume', () => {
  const inputs = [
    ['orbit', scene => scene.orbit(35, -12)],
    ['zoom', scene => scene.zoom(.25)],
    ['wheel', scene => scene.handleWheel({ deltaY: -40, deltaMode: 0, ctrlKey: false, preventDefault() {} })],
    ['keyboard', scene => scene.handleKeyDown({ key: 'ArrowLeft', preventDefault() {} })],
  ];
  for (const [name, input] of inputs) {
    const scene = fixture();
    run(scene, 9);
    const beforeMotion = structuredClone(scene.motion), before = performance.now();
    input(scene);
    const after = performance.now();
    assert.ok(scene.motion.heldUntilMs >= before + CINEMATIC_MANUAL_HOLD_MS, `${name} must schedule the full hold`);
    assert.ok(scene.motion.heldUntilMs <= after + CINEMATIC_MANUAL_HOLD_MS);
    assert.deepEqual(scene.motion.offset, beforeMotion.offset, `${name} must not recenter the shot`);
    scene.updateCamera(0, after);
    const manualBase = basePose(scene), manualRender = renderedPose(scene), heldMotion = structuredClone(scene.motion);
    scene.updateCamera(.1, scene.motion.heldUntilMs - 1);
    assert.deepEqual(scene.motion, heldMotion, `${name} must still be held after the older five-second delay`);
    assert.deepEqual(renderedPose(scene), manualRender);
    scene.updateCamera(.1, scene.motion.heldUntilMs);
    assert.ok(scene.motion.elapsedSeconds > heldMotion.elapsedSeconds);
    assert.notDeepEqual(renderedPose(scene), manualRender);
    assert.deepEqual(basePose(scene), manualBase, `${name} changes must survive automatic resumption`);
    assert.ok(scene.camera.position.distanceTo(new THREE.Vector3(...manualRender.position)) < .5, `${name} must resume without a cut`);
  }
});

test('a held pointer extends the manual hold until the final observed gesture frame', () => {
  const scene = fixture();
  run(scene, 8);
  const offset = structuredClone(scene.motion.offset), elapsed = scene.motion.elapsedSeconds;
  scene.cameraPointers.begin(1, 50, 50);
  scene.updateCamera(.1, 20_000);
  scene.updateCamera(.1, 25_000);
  assert.equal(scene.motion.heldUntilMs, 25_000 + CINEMATIC_MANUAL_HOLD_MS);
  assert.deepEqual(scene.motion.offset, offset);
  assert.equal(scene.motion.elapsedSeconds, elapsed);
  scene.cameraPointers.end(1);
  scene.updateCamera(.1, 42_999);
  assert.equal(scene.motion.elapsedSeconds, elapsed);
  scene.updateCamera(.1, 43_000);
  assert.ok(scene.motion.elapsedSeconds > elapsed);
});

test('pause, reduced motion and automatic-camera off freeze the existing shot without recentering', () => {
  for (const [name, toggle] of [
    ['pause', (scene, active) => scene.setPaused(active)],
    ['reduced motion', (scene, active) => scene.setReducedMotion(active)],
    ['automatic camera off', (scene, active) => scene.setAutoRotate(!active)],
  ]) {
    const scene = fixture();
    run(scene, 17);
    const movingPose = renderedPose(scene), movingState = structuredClone(scene.motion);
    toggle(scene, true);
    scene.updateCamera(.1, 150_000);
    assert.deepEqual(renderedPose(scene), movingPose, `${name} must freeze the composed shot`);
    assert.deepEqual(scene.motion, movingState);
    toggle(scene, false);
    scene.updateCamera(.1, 150_100);
    assertNear(scene.motion.elapsedSeconds - movingState.elapsedSeconds, .1, `${name} must resume active time only`);
    assert.ok(scene.camera.position.distanceTo(new THREE.Vector3(...movingPose.position)) < .5);
  }
});

test('building framing depends on its own bounds even when the hidden room contains hundreds of desks', () => {
  const small = fixture('building', 6), large = fixture('building', 512);
  run(small, 35); run(large, 35);
  assert.deepEqual(basePose(small), basePose(large));
  assert.deepEqual(renderedPose(small), renderedPose(large));
  assert.ok(targetInView(small).distanceTo(small.building.center) < 1);
});

test('employee framing and target drift keep the same scale in a large room', () => {
  const small = fixture('employee', 6), large = fixture('employee', 512);
  run(small, 35); run(large, 35);
  assertNear(small.camera.top / small.camera.zoom, large.camera.top / large.camera.zoom, 'employee projected scale');
  assert.ok(targetInView(small).distanceTo(targetInView(large)) < 1e-9, 'hidden desks must not magnify close-up drift');
  assert.ok(small.camera.getWorldDirection(new THREE.Vector3()).distanceTo(large.camera.getWorldDirection(new THREE.Vector3())) < 1e-9);
});

test('pausing during a cinematic shot transition freezes its target and base zoom as well as ambient motion', () => {
  const scene = fixture();
  scene.cinematic = true;
  scene.cinematicStartTarget.copy(scene.cameraTarget);
  scene.cinematicStartZoom = scene.cameraZoom;
  scene.cinematicStartFraming = scene.framing;
  scene.targetGoal.set(8, 1.15, 3);
  scene.zoomGoal = 1.65;
  scene.framingGoal = 1;
  scene.updateCamera(.1, 100);
  scene.setPaused(true);
  const before = renderedPose(scene), base = basePose(scene), elapsed = scene.cinematicElapsed;
  scene.updateCamera(.1, 200);
  assert.equal(scene.cinematicElapsed, elapsed, 'pause must stop an in-progress camera transition');
  assert.deepEqual(basePose(scene), base);
  assert.deepEqual(renderedPose(scene), before);
  scene.setPaused(false);
  scene.updateCamera(.1, 300);
  assert.ok(scene.cinematicElapsed > elapsed);
});

test('turning observation off during a building transition freezes the selected camera beyond the manual hold', () => {
  const scene = fixture('building');
  scene.cinematic = true;
  scene.cinematicStartTarget.copy(scene.cameraTarget);
  scene.targetGoal.add(new THREE.Vector3(12, 3, -8));
  scene.cinematicStartZoom = scene.cameraZoom;
  scene.zoomGoal = 1.5;
  scene.updateCamera(.5, 500);
  const before = renderedPose(scene);
  scene.stopFollowing();
  scene.setAutoRotate(false);
  for (let index = 0; index < 10; index++) scene.updateCamera(.1, 120_000 + index * 100);
  assert.deepEqual(renderedPose(scene), before);
});

test('same-shot building refresh preserves a manual pan throughout the eighteen-second hold', t => {
  const scene = buildingFixture(t, 'first');
  scene.stopFollowing();
  scene.pan(120, 0);
  const manualTarget = scene.targetGoal.clone();
  assert.ok(manualTarget.distanceTo(scene.building.focusPoint('first')) > 1);
  const heldMotion = structuredClone(scene.motion);
  for (let i = 0; i < 3; i++) {
    // Match renderAll's geometry refresh followed by its unchanged building shot.
    scene.setBuildingFloors([buildingFloor('first', 5)]);
    scene.setBuildingView(true, 'first');
    assert.ok(scene.targetGoal.equals(manualTarget), 'an observed event must not recenter the manual pan');
    assert.equal(scene.cinematic, false, 'a repeated shot must not restart the transition');
  }
  scene.updateCamera(1, scene.motion.heldUntilMs - 1);
  assert.ok(scene.cameraTarget.equals(manualTarget));
  assert.deepEqual(scene.motion, heldMotion);
});

test('the scene reports only a user zoom beyond the automatic shot, and a new shot forgets it', t => {
  const room = fixture();
  assert.equal(room.isZoomedIn(), false, 'the automatic room overview is not a user zoom');
  room.zoom(.3);
  assert.equal(room.isZoomedIn(), true);
  room.zoom(-.3);
  assert.equal(room.isZoomedIn(), false, 'zooming back to the overview releases it');
  room.zoom(.5);
  room.resetCamera();
  assert.equal(room.isZoomedIn(), false, 'resetting the camera releases it');

  const employee = fixture('employee');
  employee.focus('observed-agent', { cinematic: false, zoom: 1.65 });
  assert.equal(employee.isZoomedIn(), false, 'an automatic close-up is not a user zoom');
  employee.stopFollowing();
  assert.equal(employee.isZoomedIn(), false, 'taking over the camera without zooming does not count');
  employee.zoom(.3);
  assert.equal(employee.isZoomedIn(), true, 'zooming past the automatic close-up does');
  employee.focus(null);
  assert.equal(employee.isZoomedIn(), false);

  const moving = fixture();
  moving.cinematic = true; moving.cameraZoom = 1.4;
  moving.stopFollowing();
  assert.equal(moving.isZoomedIn(), false, 'interrupting an automatic zoom-out is not a user zoom');
  moving.zoom(.3);
  assert.equal(moving.isZoomedIn(), true, 'zooming from the interrupted shot is');

  const building = buildingFixture(t);
  assert.equal(building.isZoomedIn(), false);
  building.zoom(.4);
  building.pan(120, 0);
  const manualTarget = building.targetGoal.clone();
  building.motion = { ...building.motion, heldUntilMs: 0 };
  building.setBuildingFloors([buildingFloor('first', 5), buildingFloor('second', 60)]);
  assert.ok(building.targetGoal.equals(manualTarget), 'a zoomed building keeps its framing after the manual hold when floors change');
});

test('building pan follows the full drag beyond the smaller selected office bounds', t => {
  const scene = buildingFixture(t);
  scene.setBuildingFloors([buildingFloor('first', 0), buildingFloor('upper', 100)]);
  scene.setBuildingView(true); run(scene, 3);
  scene.stopFollowing();
  scene.yaw = 0;
  const before = scene.targetGoal.clone();
  const distance = 600 * (scene.camera.top - scene.camera.bottom) / scene.container.clientHeight;
  scene.pan(-600, 0);
  assertNear(scene.targetGoal.x, before.x + distance, 'a building drag uses its projection rather than the office floor boundary');
  assert.ok(scene.targetGoal.x > scene.bounds.maxX + 10);
  assert.equal(scene.targetGoal.y, before.y);
  scene.resetCamera();
  assert.ok(scene.targetGoal.equals(scene.building.center));
});

test('live building changes retain manual scale and rebase a removed upper-floor pan until an explicit reset', t => {
  const scene = buildingFixture(t);
  const firstRadius = scene.building.radius, firstTop = scene.camera.top;
  const baseZoom = scene.cameraZoom, baseYaw = scene.yaw;
  const expanded = [buildingFloor('first', 5), buildingFloor('second', 60), buildingFloor('third', 60)];
  let surfaceResizes = 0;
  scene.renderer.setSize = () => { surfaceResizes++; };
  scene.setBuildingFloors(expanded);
  scene.setBuildingView(true);
  scene.updateCamera(.1, 5000);
  assert.ok(scene.building.radius > firstRadius * 2, 'the real stacked building has expanded');
  assert.ok(scene.camera.top > firstTop * 2, 'the projection must expand without a browser resize or a new shot');
  run(scene, 2, 5000);
  const fit = modelPixels(scene);
  assert.ok(fit.minY >= 0 && fit.maxY <= 800 && fit.minX >= 0 && fit.maxX <= 1200,
    `once the camera reaches the new centre, the expanded projection fits the whole building: x ${fit.minX.toFixed(1)}..${fit.maxX.toFixed(1)} y ${fit.minY.toFixed(1)}..${fit.maxY.toFixed(1)}`);
  assert.ok(scene.targetGoal.equals(scene.building.center), 'an automatic overview follows the new stack center');
  assert.equal(scene.cinematic, false);

  scene.stopFollowing();
  scene.pan(120, 0);
  const manualTop = scene.camera.top;
  scene.setBuildingFloors([buildingFloor('first', 5)]);
  scene.setBuildingView(true);
  assertNear(scene.building.radius, firstRadius, 'the real building still shrinks');
  assertNear(scene.camera.top, manualTop, 'manual projection does not zoom in when the building shrinks');
  assert.ok(scene.targetGoal.equals(scene.building.focusPoint()), 'a removed upper-floor pan returns to the smaller building');
  assert.equal(scene.cameraZoom, baseZoom);
  assert.equal(scene.yaw, baseYaw);
  assert.equal(surfaceResizes, 0, 'changing geometry should only update the camera projection');
  scene.resetCamera();
  assertNear(scene.camera.top, firstTop, 'an explicit reset fits the smaller building');
  assert.ok(scene.targetGoal.equals(scene.building.center));
});

test('a manually viewed upper floor stays reachable as 100 workers shrink to two and zero without changing zoom or direction', t => {
  const scene = buildingFixture(t);
  scene.setBuildingFloors([buildingFloor('first', 100), buildingFloor('upper', 100)]);
  scene.setBuildingView(true, 'upper'); run(scene, 3);
  scene.stopFollowing(); scene.orbit(2, 0); scene.updateCamera(1, 0);
  const view = [scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation];
  const oldTarget = scene.targetGoal.clone();
  scene.setBuildingFloors([buildingFloor('first', 2), buildingFloor('upper', 2)]);
  assert.ok(oldTarget.y > scene.building.bounds.max.y, 'the previous upper floor is outside the compacted building');
  assert.ok(scene.targetGoal.equals(scene.building.focusPoint('upper')));
  scene.updateCamera(1, 0);
  assert.deepEqual([scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation], view);
  assert.equal(scene.autoRotate, false);
  assert.equal(scene.building.floors.size, 2);
  const target = scene.targetGoal.clone();
  scene.setBuildingFloors([buildingFloor('first', 0), buildingFloor('upper', 0)]);
  assert.equal(scene.building.floors.size, 2, 'quiet project floors survive without their old worker desks');
  assert.ok(scene.targetGoal.equals(target), 'an in-bounds manual target stays fixed');
  assert.deepEqual([scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation], view);
});

// Building interaction wiring: production OfficeScene methods on a real BuildingOverview, rays from the default building camera.
function buildingPair(t) {
  const scene = buildingFixture(t);
  scene.setBuildingFloors([buildingFloor('first', 5), buildingFloor('top', 3)]);
  scene.setBuildingView(true); run(scene, 3);
  const selected = [], opened = [];
  scene.onSelect = id => selected.push(id);
  scene.onFloor = id => opened.push(id);
  return { scene, selected, opened };
}
const towardBuildingCamera = new THREE.Vector3(Math.sin(BUILDING_VIEW.yaw) * Math.cos(BUILDING_VIEW.elevation), Math.sin(BUILDING_VIEW.elevation),
  Math.cos(BUILDING_VIEW.yaw) * Math.cos(BUILDING_VIEW.elevation));
function aimAt(scene, floorId, x, y, z) {
  const floor = scene.building.floors.get(floorId);
  floor.group.updateWorldMatrix(true, false);
  const target = floor.group.localToWorld(new THREE.Vector3(x, y, z));
  scene.raycaster = new THREE.Raycaster(target.clone().addScaledVector(towardBuildingCamera, 300), towardBuildingCamera.clone().negate());
}

test('a building click focuses a floor first, then opens a drawn person or the focused office, and a see-through ceiling keeps the focus floor clickable', t => {
  const { scene, selected, opened } = buildingPair(t);
  const first = scene.building.floors.get('first'), top = scene.building.floors.get('top');
  aimAt(scene, 'top', top.points[0].x, .1, top.depth / 2 - 1);
  scene.clickBuilding();
  assert.equal(scene.building.focusedFloor, 'top', 'the first click focuses the floor');
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('top')), true, 'the camera glides to the focused floor');
  assert.ok(scene.zoomGoal >= 1 && scene.zoomGoal <= 1.22, `the glide zooms in at most 1.22, as far as the whole model stays on screen (${scene.zoomGoal})`);
  assert.deepEqual([selected, opened], [[], []], 'focusing a floor opens nothing');
  aimAt(scene, 'top', top.points[1].x, 1.96, top.points[1].z);
  scene.clickBuilding();
  assert.deepEqual(selected, ['top-1'], 'a drawn person on the focus floor opens that person');
  aimAt(scene, 'top', top.points[0].x, .1, top.depth / 2 - 1);
  scene.clickBuilding();
  assert.deepEqual(opened, ['top'], 'open space on the focus floor opens its office');

  aimAt(scene, 'first', first.points[0].x, .1, first.depth / 2 - 1);
  scene.clickBuilding();
  assert.equal(scene.building.focusedFloor, 'first');
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('first')), true);
  aimAt(scene, 'first', first.points[0].x, 1.9, first.points[0].z);
  assert.equal(scene.building.pickFloor(scene.raycaster), 'top', 'this ray enters the storey above first');
  scene.clickBuilding();
  assert.deepEqual(selected, ['top-1', 'first-0'], 'the focus-floor person seen through the ceiling answers the click');
  assert.equal(scene.building.focusedFloor, 'first', 'and the focus stays');
});

test('PageUp and PageDown step the building focus with the camera only in the building view, and leaving the building clears the focus', t => {
  const { scene } = buildingPair(t);
  const press = key => { let prevented = false; scene.handleKeyDown({ key, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(press('PageDown'), true);
  assert.equal(scene.building.focusedFloor, 'top', 'PageDown without a focus starts from the top floor');
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('top')), true);
  assert.equal(press('PageDown'), true);
  assert.equal(scene.building.focusedFloor, 'first');
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('first')), true, 'the camera follows each step');
  assert.equal(press('PageUp'), true);
  assert.equal(scene.building.focusedFloor, 'top');
  scene.setBuildingView(false);
  assert.equal(scene.building.focusedFloor, null, 'the next building visit starts without a focused floor');
  const goal = scene.targetGoal.clone();
  assert.equal(press('PageUp'), false, 'the office view leaves PageUp to the page');
  assert.equal(scene.building.focusedFloor, null);
  assert.equal(scene.targetGoal.equals(goal), true);
});

test('the first building intro starts on the given floor without motion and rises to the whole building over the requested three seconds', t => {
  const { scene } = buildingPair(t);
  scene.setBuildingView(false); run(scene, 3);
  assert.equal(scene.building.hasFloor('first'), true);
  assert.equal(scene.building.hasFloor('missing'), false);
  for (const [name, prepare, from, ms] of [
    ['reduced motion', target => target.setReducedMotion(true), 'first', 3000],
    ['paused', target => target.setPaused(true), 'first', 3000],
    ['unknown floor', () => {}, 'missing', 3000],
    ['no duration', () => {}, 'first', 0],
  ]) {
    prepare(scene);
    assert.equal(scene.playBuildingIntro(from, ms), false, name);
    assert.equal(scene.buildingView, false, `${name}: the office view is untouched`);
    scene.setReducedMotion(false); scene.setPaused(false);
  }
  assert.equal(scene.playBuildingIntro('first', 3000), true);
  assert.equal(scene.buildingView, true);
  assert.equal(scene.cameraTarget.equals(scene.building.focusPoint('first')), true, 'the camera is placed on the ground floor without motion');
  assert.ok(scene.cameraZoom >= 1 && scene.cameraZoom <= 1.22, `at the floor approach zoom (${scene.cameraZoom})`);
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('')), true, 'the shot rises toward the whole building');
  assert.equal(scene.cinematic, true);
  assert.equal(scene.cinematicSeconds, 3);
  run(scene, 2.9);
  assert.equal(scene.cinematic, true, 'the rise lasts the requested time rather than the default 2.6 seconds');
  run(scene, .2);
  assert.equal(scene.cinematic, false);
  assert.ok(scene.cameraTarget.distanceTo(scene.building.focusPoint('')) < 1e-9);
  assert.equal(scene.cinematicSeconds, undefined, 'later shots use the default length again');
});

test('every scene method the page calls, including the optional contract methods, exists on the real scene with its arity', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const names = new Set([...main.matchAll(/\bscene\??\.([A-Za-z]\w*)(?:\?\.)?\(/gu)].map(match => match[1]));
  const start = main.indexOf('type SceneContract = {');
  assert.ok(start > 0, 'main.ts declares the scene contract');
  const contract = main.slice(start, main.indexOf('};', start));
  const optional = [...contract.matchAll(/^\s+(\w+)\?:/gmu)].map(match => match[1]);
  assert.deepEqual(optional, ['setOwnerNames', 'setBridgeConnected', 'pulseRouter', 'setCardOpen', 'sendInstructionPlane', 'playBuildingIntro', 'setApprovalCount']);
  for (const name of optional) names.add(name);
  assert.ok(names.size > 20, `the page calls many scene methods (${names.size})`);
  assert.deepEqual([...names].filter(name => typeof OfficeScene.prototype[name] !== 'function'), [], 'no call goes to a missing method');
  const arity = { setOwnerNames: 1, setBridgeConnected: 1, pulseRouter: 0, setCardOpen: 1, sendInstructionPlane: 2, playBuildingIntro: 2, setApprovalCount: 1 };
  for (const [name, count] of Object.entries(arity)) assert.equal(OfficeScene.prototype[name].length, count, name);
});

test('the building shot fits and centres its model in the free area: --hud-clearance until the page reports its HUD insets', t => {
  // A stand-in building without silhouette points fits its bounding sphere (radius 32), so the numbers are exact.
  const scene = fixture('building');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous); else delete globalThis.getComputedStyle; });
  let clearance = ' 176px';
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => name === '--hud-clearance' ? clearance : '' });
  scene.container = { clientWidth: 1200, clientHeight: 800, nodeType: 1 };
  assertNear(scene.camera.top, 32, 'without any HUD the sphere fits the window height');
  scene.resize();
  assert.equal(scene.camera.view?.enabled, true);
  assert.deepEqual([scene.camera.view.offsetX, scene.camera.view.offsetY], [0, 88], 'the model centres in the 624px above the bottom HUD');
  assertNear(scene.camera.top, 32 * 800 / 624, 'and shrinks to fit that height');
  clearance = '60dvh'; scene.resize();
  assert.equal(scene.camera.view?.enabled === true, false, 'a clearance that is not in pixels does not guess an inset');
  assertNear(scene.camera.top, 32, 'nor a smaller fit');

  scene.setHudInsets({ top: 100, right: 0, bottom: 200, left: 300 });
  assert.deepEqual([scene.camera.view.offsetX, scene.camera.view.offsetY], [-150, 50], 'reported insets replace the clearance on every side');
  assertNear(scene.camera.top, 32 * 800 / 500, 'the free 900x500 area is height-limited');
  scene.setHudInsets({ top: 500, right: 0, bottom: 500, left: 0 });
  assertNear(scene.camera.top, 32 * 800 / 240, 'insets never take more than 70% of the height together');
  assert.equal(scene.camera.view?.enabled === true, false, 'equal insets need no offset');
  scene.setHudInsets({ top: Number.NaN, right: -5, bottom: '90', left: Infinity });
  assert.deepEqual(scene.hudInsets, { top: 0, right: 0, bottom: 0, left: 0 }, 'unusable values count as no inset');
  assertNear(scene.camera.top, 32, 'the building shot without insets');
  scene.setHudInsets({ top: 100, right: 0, bottom: 200, left: 300 });
  scene.buildingView = false; scene.resize();
  assert.equal(scene.camera.view?.enabled === true, false, 'the office view keeps its centred shot');
});

/** HUD insets the built page measured in the three-floor building shot (CSS px from each stage edge), by window size. */
const HUD_SIZES = [
  { width: 800, height: 600, insets: { top: 226, right: 70, bottom: 176, left: 86 } },
  { width: 1280, height: 800, insets: { top: 209, right: 80, bottom: 205, left: 238 } },
  { width: 1440, height: 900, insets: { top: 214, right: 80, bottom: 205, left: 238 } },
  { width: 375, height: 812, insets: { top: 197, right: 51, bottom: 211, left: 66 } },
  { width: 1280, height: 600, insets: { top: 209, right: 209, bottom: 176, left: 238 } },
];
const stack = count => Array.from({ length: count }, (_, index) => buildingFloor(`floor-${index}`, 5));
function resizeFixture(scene, width, height, insets) {
  scene.container.clientWidth = width; scene.container.clientHeight = height;
  scene.setHudInsets(insets);
}
function toScreen(scene, point, out = new THREE.Vector3()) {
  out.copy(point).project(scene.camera);
  return { x: (out.x * .5 + .5) * scene.container.clientWidth, y: (-out.y * .5 + .5) * scene.container.clientHeight };
}
/** Pixel extents of the drawn model, from its real instances and vertices (not the silhouette points the fit uses). */
function modelPixels(scene) {
  const building = scene.building, matrix = new THREE.Matrix4(), corner = new THREE.Vector3(), scratch = new THREE.Vector3();
  scene.camera.updateMatrixWorld();
  const model = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, signTop: Infinity };
  const take = (point, sign = false) => {
    const { x, y } = toScreen(scene, point, scratch);
    model.minX = Math.min(model.minX, x); model.maxX = Math.max(model.maxX, x);
    model.minY = Math.min(model.minY, y); model.maxY = Math.max(model.maxY, y);
    if (sign) model.signTop = Math.min(model.signTop, y);
  };
  for (const mesh of [building.structure, building.glass, building.bushes]) {
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    const { min, max } = mesh.geometry.boundingBox;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix); matrix.premultiply(mesh.matrixWorld);
      for (let c = 0; c < 8; c++) take(corner.set(c & 1 ? max.x : min.x, c & 2 ? max.y : min.y, c & 4 ? max.z : min.z).applyMatrix4(matrix));
    }
  }
  building.ground.updateWorldMatrix(true, false);
  const ground = building.ground.geometry.getAttribute('position');
  for (let i = 0; i < ground.count; i++) take(corner.fromBufferAttribute(ground, i).applyMatrix4(building.ground.matrixWorld));
  building.signText.updateWorldMatrix(true, false);
  for (let c = 0; c < 4; c++) take(corner.set(c & 1 ? .5 : -.5, c & 2 ? .5 : -.5, 0).applyMatrix4(building.signText.matrixWorld), true);
  const plate = toScreen(scene, building.groundPlateAnchor, scratch);
  return { ...model, plateX: plate.x, plateTop: plate.y - PLATE_HALF_HEIGHT, plateBottom: plate.y + PLATE_HALF_HEIGHT };
}
function assertInsideFree(scene, insets, label) {
  const width = scene.container.clientWidth, height = scene.container.clientHeight, model = modelPixels(scene), slack = .5;
  const fmt = value => value.toFixed(1);
  assert.ok(model.signTop >= insets.top - slack, `${label}: the rooftop sign top ${fmt(model.signTop)} is below the top HUD at ${insets.top}`);
  assert.ok(model.minY >= insets.top - slack, `${label}: the model top ${fmt(model.minY)} is below the top HUD at ${insets.top}`);
  assert.ok(model.maxY <= height - insets.bottom + slack, `${label}: the ground plate bottom ${fmt(model.maxY)} is above the bottom HUD at ${height - insets.bottom}`);
  assert.ok(model.plateTop >= insets.top - slack && model.plateBottom <= height - insets.bottom + slack,
    `${label}: the ground-floor plate ${fmt(model.plateTop)}..${fmt(model.plateBottom)} is between the HUD blocks`);
  assert.ok(model.plateX >= 0 && model.plateX <= width, `${label}: the ground-floor plate anchor ${fmt(model.plateX)} is on screen`);
  assert.ok(model.minX >= insets.left - slack && model.maxX <= width - insets.right + slack,
    `${label}: the model ${fmt(model.minX)}..${fmt(model.maxX)} is between the side HUD blocks ${insets.left}..${width - insets.right}`);
  return model;
}

test('the whole building shot keeps the rooftop sign, the ground plate and the ground-floor plate between the HUD blocks', t => {
  const scene = buildingFixture(t);
  for (const floors of [1, 3, 8, 12]) {
    for (const { width, height, insets } of HUD_SIZES) {
      const label = `${floors} floors at ${width}x${height}`;
      resizeFixture(scene, width, height, insets);
      scene.setBuildingFloors(stack(floors));
      // The shot the crane rise ends on: leaving and entering the building restores the automatic whole-building framing.
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      assert.equal(scene.cinematic, false);
      const model = assertInsideFree(scene, insets, label);
      // No conservative room: the drawn geometry fills the limiting axis of the free area.
      const fill = box => Math.max((box.maxY - box.minY) / (height - insets.top - insets.bottom), (box.maxX - box.minX) / (width - insets.left - insets.right));
      assert.ok(fill(model) >= .85 && fill(model) <= .97, `${label}: the model fills the free area tightly (${fill(model).toFixed(3)})`);
      // The automatic drift turns, tilts and pans the shot; the fit follows the drawn pose and leaves the drift's optical zoom out.
      const { yaw, elevation, zoomVariation, targetX, targetY, targetZ } = CINEMATIC_PROFILES.building;
      for (const [sy, se, sz] of [[-1, -1, 1], [-1, 1, -1], [1, -1, -1], [1, 1, 1], [0, 1, 1], [1, 0, -1]]) {
        scene.motion = { ...scene.motion, offset: { yaw: sy * yaw, elevation: se * elevation, zoomScale: 1 + sz * zoomVariation,
          targetX: sz * targetX, targetY: se * targetY, targetZ: sy * targetZ } };
        scene.updateCamera(0, 0);
        const drifted = assertInsideFree(scene, insets, `${label} at drift ${sy},${se},${sz}`);
        assert.ok(fill(drifted) >= .85, `${label}: at drift ${sy},${se},${sz} the model still fills the free area (${fill(drifted).toFixed(3)})`);
      }
      scene.motion = createCinematicMotionState(); scene.updateCamera(0, 0);
    }
  }
});

test('the automatic building shot keeps one scale through the whole drift, inside the free area and still filling it', t => {
  const scene = buildingFixture(t);
  const { yaw, elevation, targetX, targetY, targetZ } = CINEMATIC_PROFILES.building;
  for (const [floors, size] of [[1, 1], [3, 0], [3, 1], [3, 4], [8, 1], [12, 3]]) {
    const { width, height, insets } = HUD_SIZES[size], label = `${floors} floors at ${width}x${height}`;
    const fill = box => Math.max((box.maxY - box.minY) / (height - insets.top - insets.bottom), (box.maxX - box.minX) / (width - insets.left - insets.right));
    resizeFixture(scene, width, height, insets);
    scene.setBuildingFloors(stack(floors));
    scene.autoRotate = true; scene.motion = createCinematicMotionState();
    scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
    const tops = [], directions = [];
    const check = name => {
      tops.push(scene.camera.top);
      const model = assertInsideFree(scene, insets, `${label} ${name}`);
      assert.ok(fill(model) >= .85, `${label} ${name}: the model fills the free area (${fill(model).toFixed(3)})`);
    };
    for (const [sy, se] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0]]) {
      scene.motion = { ...scene.motion, offset: { yaw: sy * yaw, elevation: se * elevation, zoomScale: 1,
        targetX: sy * targetX, targetY: se * targetY, targetZ: sy * targetZ } };
      scene.updateCamera(0, 3000);
      check(`at drift ${sy},${se}`);
    }
    scene.motion = createCinematicMotionState();
    for (let step = 1; step <= 900; step++) {
      scene.updateCamera(.1, 3000 + step * 100);
      tops.push(scene.camera.top); directions.push(scene.camera.getWorldDirection(new THREE.Vector3()).x);
      if (step % 150 === 0) check(`after ${step / 10}s of drift`);
    }
    // Desks and people keep their size: only the view offset follows the drawn pose.
    assert.ok(Math.max(...tops) <= Math.min(...tops) * 1.0001, `${label}: one scale through the drift (${Math.min(...tops).toFixed(3)}..${Math.max(...tops).toFixed(3)})`);
    // Low, wide buildings refit most with the angle and drift least (one floor may hold still); tall buildings still drift.
    if (floors >= 8) assert.ok(Math.max(...directions) - Math.min(...directions) > .002, `${label}: the shot still drifts`);
  }
  scene.autoRotate = false; scene.motion = createCinematicMotionState();
});

test('a focused floor glides into the free area between the HUD blocks at every window size, zooming in only while the whole model stays on screen', t => {
  const scene = buildingFixture(t);
  const { yaw, elevation } = CINEMATIC_PROFILES.building;
  const onScreen = label => {
    const model = modelPixels(scene), width = scene.container.clientWidth, height = scene.container.clientHeight;
    assert.ok(model.minX >= -.5 && model.maxX <= width + .5 && model.minY >= -.5 && model.maxY <= height + .5,
      `${label}: the model ${model.minX.toFixed(1)}..${model.maxX.toFixed(1)} x ${model.minY.toFixed(1)}..${model.maxY.toFixed(1)} stays on the ${width}x${height} screen`);
  };
  for (const floors of [3, 8, 12]) {
    for (const { width, height, insets } of HUD_SIZES) {
      resizeFixture(scene, width, height, insets);
      scene.setBuildingFloors(stack(floors));
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      for (const id of ['floor-0', `floor-${floors - 1}`]) {
        const label = `${id} of ${floors} floors at ${width}x${height}`;
        scene.building.focusFloor(id); scene.glideToBuildingFloor(id); run(scene, 3);
        assert.ok(scene.cameraZoom > 1 && scene.cameraZoom <= 1.22, `${label}: the glide zooms in, at most 1.22 (${scene.cameraZoom})`);
        scene.camera.updateMatrixWorld();
        const floor = scene.building.floors.get(id);
        const plate = toScreen(scene, floor.anchor), slab = toScreen(scene, floor.group.position);
        for (const [name, point, margin] of [['plate', plate, PLATE_HALF_HEIGHT], ['floor centre', slab, 0]]) {
          assert.ok(point.y - margin >= insets.top && point.y + margin <= height - insets.bottom, `${label}: the ${name} ${point.y.toFixed(1)} is between the HUD blocks`);
          assert.ok(point.x >= insets.left && point.x <= width - insets.right, `${label}: the ${name} ${point.x.toFixed(1)} is between the side HUD blocks`);
        }
        onScreen(label);
      }
      scene.building.focusFloor(null);
      // Automatic watching approaches a floor inside the whole-building view; while the drift can move, every drift pose keeps
      // the rooftop sign and the ground plate on screen.
      scene.autoRotate = true;
      for (const id of ['floor-0', `floor-${floors - 1}`]) {
        scene.setBuildingView(true, id); run(scene, 3);
        for (const [sy, se] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          scene.motion = { ...scene.motion, offset: { ...scene.motion.offset, yaw: sy * yaw, elevation: se * elevation } };
          scene.updateCamera(0, 3000);
          onScreen(`automatic approach to ${id} of ${floors} floors at ${width}x${height}, drift ${sy},${se}`);
        }
        scene.motion = createCinematicMotionState(); scene.setBuildingView(true); run(scene, 3);
      }
      scene.autoRotate = false;
    }
  }
});

test('building clicks aim through the fitted view offset and a manual zoom', t => {
  const { scene, selected } = buildingPair(t);
  const width = 1280, height = 800;
  resizeFixture(scene, width, height, { top: 206, right: 80, bottom: 205, left: 238 });
  scene.renderer.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) };
  scene.pointer = new THREE.Vector2(); scene.raycaster = new THREE.Raycaster();
  scene.zoom(.4); run(scene, 1);
  assert.equal(scene.camera.view?.enabled, true);
  assert.ok(Math.abs(scene.camera.view.offsetX) > 20 && Math.abs(scene.camera.view.offsetY) > 1, 'the shot is really offset');
  const person = (floorId, index) => {
    const floor = scene.building.floors.get(floorId), seat = floor.points[index];
    floor.group.updateWorldMatrix(true, false);
    scene.camera.updateMatrixWorld();
    const { x, y } = toScreen(scene, floor.group.localToWorld(new THREE.Vector3(seat.x, 1.5, seat.z - .2)));
    return { clientX: x, clientY: y };
  };
  scene.aimRay(person('top', 1));
  assert.equal(scene.building.pickFloor(scene.raycaster), 'top', 'the pointer ray enters the storey drawn under it');
  assert.equal(scene.building.pickAgent(scene.raycaster, 'top'), 'top-1', 'and meets the person drawn under it');
  scene.clickBuilding();
  assert.equal(scene.building.focusedFloor, 'top');
  run(scene, 3);
  assert.equal(scene.cameraZoom, 1.22, 'the glide changed zoom and target');
  scene.aimRay(person('top', 1));
  scene.clickBuilding();
  assert.deepEqual(selected, ['top-1'], 'the person under the pointer answers after the glide');
  scene.aimRay(person('first', 0));
  assert.equal(scene.building.pickAgent(scene.raycaster, 'first'), 'first-0', 'a lower-floor person is aimed exactly as drawn');
});

test('a manual orbit keeps the fitted building offset while zooming, and a reset fits the default pose again', t => {
  const scene = buildingFixture(t);
  resizeFixture(scene, 1280, 800, { top: 206, right: 80, bottom: 205, left: 238 });
  scene.setBuildingFloors(stack(3)); run(scene, 3);
  const offset = () => [scene.camera.view.offsetX, scene.camera.view.offsetY];
  const fitted = offset();
  scene.orbit(400, 60); scene.zoom(.3); scene.zoom(-.1);
  assert.deepEqual(offset(), fitted, 'zooming after an orbit does not shift the image');
  scene.resetCamera();
  assert.deepEqual(offset(), fitted);
  scene.setHudInsets({ top: 206, right: 80, bottom: 205, left: 238 });
  assert.deepEqual(offset(), fitted, 'unchanged insets change nothing');
});

/** Points that stand for a storey's interior: each seated person's head, monitor and desk top, in world space. */
function interiorPoints(floor) {
  floor.group.updateWorldMatrix(true, false);
  return floor.points.flatMap(seat => [[seat.x, 1.5, seat.z - .2], [seat.x, 1.85, seat.z - 1.35], [seat.x, 1, seat.z - 1.1]]
    .map(([x, y, z]) => floor.group.localToWorld(new THREE.Vector3(x, y, z))));
}
/** Laid-out nameplates in CSS px: the estimated box of each shown plate (heights include the ledge shadow). */
function plateBoxes(scene, width, height) {
  scene.camera.updateMatrixWorld();
  scene.building.updateLabels(scene.camera, width, height, scene.frameArea);
  return scene.building.order.filter(floor => !floor.label.hidden).map(floor => {
    const compact = floor.label.dataset.compact === 'true', tight = floor.label.dataset.tight === 'true';
    // A compact name cut short to the free area is no wider than the inline max width the layout wrote.
    const cut = parseFloat(floor.label.style.maxWidth) || Infinity;
    const w = tight ? 18 + 6.2 * floor.labelNumber.textContent.length : compact ? Math.min(floor.plateCompactWidth, cut) : floor.plateWidth;
    const h = compact ? PLATE.compactHeight : PLATE.fullHeight;
    return { name: floor.labelNumber.textContent, compact, tight, left: floor.labelX, right: floor.labelX + w, top: floor.labelY - h / 2, bottom: floor.labelY + h / 2,
      y: floor.labelY, floorY: floor.screenY };
  });
}

test('whole-building nameplates stand right of the storeys level with their own floor: full with counts on three floors at desktop sizes, never over a desk or a head', t => {
  const scene = buildingFixture(t);
  for (const floors of [1, 3, 5, 6, 7, 8, 12]) {
    for (const { width, height, insets } of HUD_SIZES) {
      const label = `${floors} floors at ${width}x${height}`;
      resizeFixture(scene, width, height, insets);
      scene.setBuildingFloors(stack(floors));
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      // From nine floors only the focus floor is detailed and carries a plate; the camera stays on the whole building.
      if (floors >= 9) scene.building.focusFloor(`floor-${floors - 1}`);
      const plates = plateBoxes(scene, width, height);
      if (floors <= 3 && width >= 1280 && height >= 800) {
        assert.ok(plates.every(plate => !plate.compact && !plate.tight), `${label}: full plates with exact counts (${plates.map(plate => plate.compact).join()})`);
      }
      if (floors >= 9) assert.equal(plates.length, 1, `${label}: the focus floor's plate`);
      else if (floors <= 3) assert.equal(plates.length, floors, `${label}: up to three floors never hide a plate`);
      else if (scene.building.plateStride === 1) assert.equal(plates.length, floors, `${label}: an uncrowded stack names every floor`);
      else assert.ok(plates.length >= 2, `${label}: a crowded stack is thinned but still names every few floors (${plates.length})`);
      // Every shown plate stays level with its own storey: at most shiftShare of the storey spacing away, never beside another.
      const drawn = scene.building.order.filter(floor => floor.onScreen);
      const spacing = Math.min(Infinity, ...drawn.slice(1).map((floor, index) => Math.abs(floor.screenY - drawn[index].screenY)));
      for (const plate of plates) {
        const allowed = drawn.length > 1 ? PLATE.shiftShare * spacing : 0, away = Math.abs(plate.y - plate.floorY);
        assert.ok(away <= allowed + .5, `${label}: plate ${plate.name} sits ${away.toFixed(1)}px from its storey (at most ${allowed.toFixed(1)})`);
      }
      const points = scene.building.order.flatMap(interiorPoints).map(point => toScreen(scene, point));
      for (const plate of plates) {
        const name = `${label}: plate ${plate.name}`;
        const covered = points.find(point => point.x >= plate.left && point.x <= plate.right && point.y >= plate.top && point.y <= plate.bottom);
        assert.ok(!covered, `${name} ${plate.left.toFixed(1)}..${plate.right.toFixed(1)} covers an interior point ${covered?.x.toFixed(1)},${covered?.y.toFixed(1)}`);
        assert.ok(plate.right <= width - insets.right + .5, `${name} ends at ${plate.right.toFixed(1)}, left of the side HUD at ${width - insets.right}`);
        assert.ok(plate.top >= 0 && plate.bottom <= height, `${name} is on the stage`);
      }
      for (let i = 1; i < plates.length; i++) {
        assert.ok(plates[i - 1].top >= plates[i].bottom - .5, `${label}: plate ${plates[i].name} stays above ${plates[i - 1].name} without overlapping`);
      }
      if (floors >= 9) scene.building.focusFloor(null);
    }
  }
});

test('the first-entry crane rise keeps its starting floor inside the free area at every window size', t => {
  const scene = buildingFixture(t);
  for (const floors of [3, 12]) {
    for (const { width, height, insets } of HUD_SIZES) {
      resizeFixture(scene, width, height, insets);
      scene.setBuildingFloors(stack(floors));
      for (const id of ['floor-0', `floor-${floors - 1}`]) {
        const label = `crane from ${id} of ${floors} floors at ${width}x${height}`;
        scene.setBuildingView(false);
        assert.equal(scene.playBuildingIntro(id, 3000), true, label);
        const centre = scene.building.focusPoint(id);
        for (let step = 0; step <= 30; step++) {
          if (step) scene.updateCamera(.1, step * 100);
          scene.camera.updateMatrixWorld();
          const { x, y } = toScreen(scene, centre);
          assert.ok(x >= insets.left && x <= width - insets.right && y >= insets.top && y <= height - insets.bottom,
            `${label} at step ${step}: the floor centre ${x.toFixed(1)},${y.toFixed(1)} is in the free area`);
        }
        assert.equal(scene.cinematic, false, `${label}: the rise ends on the whole building`);
        assertInsideFree(scene, insets, `${label} after the rise`);
      }
    }
  }
});

/**
 * Decision 53: the insets the built page also reports beside the floor caption (the caption as a left block under the HUD edge
 * above it, its edge 8px of headroom right of the caption), and for the two short windows the HUD blocks around the stage in
 * CSS px [left, top, right, bottom].
 */
const BESIDE_SIZES = [
  { ...HUD_SIZES[0], beside: { top: 127, right: 173, bottom: 176, left: 277 }, short: true, blocks: { caption: [110, 139, 269, 226],
    selector: [111, 91, 541, 127], 'company plate': [21, 20, 779, 64], usage: [627, 85, 782, 262], 'camera tools': [730, 209, 782, 392], rail: [18, 117, 86, 440] } },
  { ...HUD_SIZES[4], beside: { top: 74, right: 209, bottom: 176, left: 412 }, short: true, blocks: { caption: [245, 113, 404, 209],
    'company plate': [28, 24, 1252, 74], usage: [1071, 89, 1252, 274], 'camera tools': [1069, 524, 1252, 576], rail: [28, 117, 238, 440] } },
  { ...HUD_SIZES[1], beside: { top: 74, right: 209, bottom: 205, left: 412 } },
  { ...HUD_SIZES[2], beside: { top: 74, right: 209, bottom: 205, left: 423 } },
  { ...HUD_SIZES[3], beside: { top: 109, right: 51, bottom: 211, left: 222 } },
];
/** Short windows whose shot fits beside the caption for tall buildings, with the insets the page layout gives (1100x650 and 1280x650 from the CSS rules). */
const APPROACH_SIZES = [
  BESIDE_SIZES[0], BESIDE_SIZES[1],
  { width: 1100, height: 650, insets: { top: 209, right: 0, bottom: 176, left: 238 }, beside: { top: 74, right: 209, bottom: 176, left: 412 } },
  { width: 1280, height: 650, insets: { top: 209, right: 0, bottom: 176, left: 238 }, beside: { top: 74, right: 209, bottom: 176, left: 412 } },
];
const intersects = (box, [left, top, right, bottom]) => box.minX < right && box.maxX > left && box.minY < bottom && box.maxY > top;
const boxText = box => [box.minX, box.minY, box.maxX, box.maxY].map(value => value.toFixed(1)).join(',');

test('in a short window the whole building fits beside the floor caption under the higher HUD edge, clearly larger and clear of every HUD block; other windows keep the shot below the caption', t => {
  const scene = buildingFixture(t);
  for (const floors of [1, 3, 8, 12]) {
    for (const size of BESIDE_SIZES) {
      const { width, height, insets, beside } = size, label = `${floors} floors at ${width}x${height}`;
      resizeFixture(scene, width, height, insets);
      scene.setBuildingFloors(stack(floors));
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      assert.equal(scene.frameBeside, false, `${label}: without the report the shot stays below the caption`);
      const below = { model: modelPixels(scene), top: scene.camera.top, offset: [scene.camera.view?.offsetX, scene.camera.view?.offsetY] };
      scene.setHudInsets({ ...insets, beside });
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      // A single wide storey at 800x600 only just fits the 350px column beside the caption and would gain too little there, so it keeps that shot.
      const expected = size.short === true && !(floors === 1 && width === 800);
      assert.equal(scene.frameBeside, expected, `${label}: fits beside the caption`);
      if (!expected) {
        assert.equal(scene.camera.top, below.top, `${label}: the scale of the shot below the caption is unchanged`);
        assert.deepEqual([scene.camera.view?.offsetX, scene.camera.view?.offsetY], below.offset, `${label}: and so is its offset`);
        continue;
      }
      const model = assertInsideFree(scene, beside, label);
      const grow = (model.maxY - model.minY) / (below.model.maxY - below.model.minY);
      assert.ok(grow >= 1.4, `${label}: the model is drawn ${grow.toFixed(3)} times as tall as below the caption`);
      const fill = Math.max((model.maxY - model.minY) / (height - beside.top - beside.bottom), (model.maxX - model.minX) / (width - beside.left - beside.right));
      assert.ok(fill >= .85, `${label}: the model fills the free area beside the caption (${fill.toFixed(3)})`);
      for (const [name, block] of Object.entries(size.blocks)) {
        assert.ok(!intersects(model, block), `${label}: the model ${boxText(model)} stays clear of the ${name} ${block.join(',')}`);
      }
      const points = scene.building.order.flatMap(interiorPoints).map(point => toScreen(scene, point));
      for (const plate of plateBoxes(scene, width, height)) {
        const box = { minX: plate.left, maxX: plate.right, minY: plate.top, maxY: plate.bottom }, name = `${label}: plate ${plate.name} ${boxText(box)}`;
        assert.ok(!points.some(point => point.x >= plate.left && point.x <= plate.right && point.y >= plate.top && point.y <= plate.bottom), `${name} covers no desk or head`);
        for (const [blockName, block] of Object.entries(size.blocks)) assert.ok(!intersects(box, block), `${name} stays clear of the ${blockName} ${block.join(',')}`);
      }
    }
  }
});

test('beside the floor caption the automatic drift keeps one scale inside the free area, and the choice has hysteresis instead of flickering', t => {
  const scene = buildingFixture(t);
  const { yaw, elevation, targetX, targetY, targetZ } = CINEMATIC_PROFILES.building;
  for (const [floors, index] of [[3, 0], [8, 0], [3, 1], [12, 1]]) {
    const { width, height, insets, beside } = BESIDE_SIZES[index], label = `${floors} floors at ${width}x${height}`;
    const fill = box => Math.max((box.maxY - box.minY) / (height - beside.top - beside.bottom), (box.maxX - box.minX) / (width - beside.left - beside.right));
    resizeFixture(scene, width, height, { ...insets, beside });
    scene.setBuildingFloors(stack(floors));
    scene.autoRotate = true; scene.motion = createCinematicMotionState();
    scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
    assert.equal(scene.frameBeside, true, `${label}: fits beside the caption`);
    const area = scene.frameArea, tops = [];
    for (const [sy, se] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0]]) {
      scene.motion = { ...scene.motion, offset: { yaw: sy * yaw, elevation: se * elevation, zoomScale: 1, targetX: sy * targetX, targetY: se * targetY, targetZ: sy * targetZ } };
      scene.updateCamera(0, 3000);
      tops.push(scene.camera.top);
      const model = assertInsideFree(scene, beside, `${label} at drift ${sy},${se}`);
      assert.ok(fill(model) >= .85, `${label} at drift ${sy},${se}: the model fills the free area (${fill(model).toFixed(3)})`);
    }
    scene.motion = createCinematicMotionState();
    let flips = 0;
    for (let step = 1; step <= 600; step++) {
      // The page reports the same measurement on every render; equal values change nothing.
      if (step % 10 === 0) scene.setHudInsets({ ...insets, beside: { ...beside } });
      scene.updateCamera(.1, 3000 + step * 100);
      tops.push(scene.camera.top);
      if (!scene.frameBeside) flips++;
      if (step % 150 === 0) assertInsideFree(scene, beside, `${label} after ${step / 10}s of drift`);
    }
    assert.equal(flips, 0, `${label}: the drift never leaves the fit beside the caption`);
    assert.ok(Math.max(...tops) <= Math.min(...tops) * 1.0001, `${label}: one scale through the drift (${Math.min(...tops).toFixed(3)}..${Math.max(...tops).toFixed(3)})`);
    assert.equal(scene.frameArea, area, `${label}: the fit keeps writing into the same area object`);
  }
  scene.autoRotate = false; scene.motion = createCinematicMotionState();

  // The gain: a raised edge that gains only a little neither enters the fit beside the caption nor leaves one already there.
  const { width, height, insets, beside } = BESIDE_SIZES[1];
  resizeFixture(scene, width, height, insets);
  scene.setBuildingFloors(stack(3)); scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
  const report = top => scene.setHudInsets({ ...insets, beside: { ...beside, top } });
  report(170); assert.equal(scene.frameBeside, false, 'a small gain does not enter the fit beside the caption');
  report(74); assert.equal(scene.frameBeside, true, 'a clear gain does');
  report(170); assert.equal(scene.frameBeside, true, 'the same small gain keeps it');
  report(195); assert.equal(scene.frameBeside, false, 'a gain under the staying share leaves it');
  report(170); assert.equal(scene.frameBeside, false, 'and the small gain does not bring it back');
  // The short window: a height just over the entering limit keeps a fit beside the caption but does not start one.
  const resize = to => { scene.container.clientHeight = to; scene.resize(); };
  report(74); assert.equal(scene.frameBeside, true);
  resize(675); assert.equal(scene.frameBeside, true, 'a 290px band below the caption stays beside it');
  resize(690); assert.equal(scene.frameBeside, false, 'a 305px band below the caption is not a short window');
  resize(675); assert.equal(scene.frameBeside, false, 'and a 290px band does not enter it again');
  resize(600); assert.equal(scene.frameBeside, true, 'a 215px band does');
});

/**
 * The insets main.ts measures in the building shot of a short window (at most 650px high) at a width from 651px, from the page's
 * HUD blocks [left, top, right, bottom] as the CSS rules place them (the measured blocks of BESIDE_SIZES): up to 1000px the narrow
 * floor rail, the project selector and the caption under it; from 1001px the wide rail and the caption beside it. The camera
 * tools stand centred but never above 12px under the usage HUD, stop 12px above the dock where it shares their column (under
 * 760px wide), and move to the bottom edge from 1100px. The controls hint above the dock starts 176px above the bottom edge.
 */
function shortWindowInsets(width, height) {
  const tools = (right, usageBottom) => {
    const left = width - right - 52, dockRight = (width + Math.min(620, width - 44)) / 2, clearance = dockRight > left ? 142 : 0;
    const top = Math.max(12, Math.min(Math.max(height / 2 - 91.5, usageBottom + 12), height - 183 - 12 - clearance));
    return [left, top, width - right, top + 183];
  };
  const blocks = width <= 1000
    ? { upper: [[21, 20, width - 21, 64], [111, 91, 111 + Math.min(width - 300, 430), 127]], caption: [110, 139, 269, 226],
      sides: [[18, 117, 86, height - 160], [width - 173, 85, width - 18, 262], tools(18, 262)] }
    : { upper: [[28, 24, width - 28, 74]], caption: [245, 113, 404, 209],
      sides: [[28, 117, 238, height - 160], [width - 209, 89, width - 28, 274],
        width >= 1100 ? [width - 211, height - 76, width - 28, height - 24] : tools(28, 274)] };
  const bottom = 176, upper = Math.max(...blocks.upper.map(block => block[3])), top = Math.max(upper, blocks.caption[3]);
  // As the page measures: a side block narrows the stage where it covers a quarter of the band from `edge` down to the bottom HUD.
  const sides = edge => {
    let left = 0, right = 0;
    for (const [l, t, r, b] of blocks.sides) {
      if (Math.min(b, height - bottom) - Math.max(t, edge) < (height - bottom - edge) * .25) continue;
      if (l + r < width) left = Math.max(left, r); else right = Math.max(right, width - l);
    }
    return { left, right };
  };
  const raised = sides(upper);
  return { insets: { top, bottom, ...sides(top) }, beside: { top: upper, right: raised.right, bottom, left: Math.max(raised.left, blocks.caption[2] + 8) },
    blocks: [...blocks.upper, blocks.caption, ...blocks.sides] };
}

test('in a short window from 900 to 1280px wide a wider window never draws the building smaller, and the caption decision keeps its hysteresis at the layout edges', t => {
  // The layout model reproduces every short-window measurement of the built page.
  for (const size of [BESIDE_SIZES[0], BESIDE_SIZES[1], ...APPROACH_SIZES.slice(2)]) {
    const { insets, beside } = shortWindowInsets(size.width, size.height);
    assert.deepEqual({ insets, beside }, { insets: size.insets, beside: size.beside }, `the page layout at ${size.width}x${size.height}`);
  }
  const scene = buildingFixture(t);
  const { yaw, elevation, targetX, targetY, targetZ } = CINEMATIC_PROFILES.building;
  const EDGES = [1000, 1001, 1020, 1044, 1045];
  // Across the page's layout edge the wide floor rail moves the caption 135px right: the column beside it shrinks from 550px at
  // 1000px to 380px at 1001px, too narrow for one or two storeys 600px high or two or three floors 650px high to keep their size
  // there (the page layout needs a product decision). Listed exactly, so a layout change that ends or widens the loss fails here.
  const SHRINK_AT_LAYOUT_EDGE = { 600: [1, 2], 650: [2, 3] };
  for (const height of [600, 650]) {
    for (const floors of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const drift of [false, true]) {
        const shot = `${floors} floors ${height}px high${drift ? ' with the drift' : ''}`, step = drift ? 5 : 1;
        const widths = [...new Set([...Array.from({ length: 380 / step + 1 }, (_, i) => 900 + i * step), ...EDGES])].sort((a, b) => a - b);
        // One page layout: a single storey keeps the fit beside the caption only in the narrow layout at 600px; the others always take it.
        const expectBeside = width => floors > 1 || (height === 600 && width <= 1000);
        scene.autoRotate = drift; scene.motion = createCinematicMotionState();
        const place = width => {
          const { insets, beside } = shortWindowInsets(width, height);
          scene.container.clientWidth = width; scene.container.clientHeight = height;
          scene.setHudInsets({ ...insets, beside }); scene.resize(); scene.updateCamera(0, 3000);
          return { width, beside: scene.frameBeside, scale: height / (2 * scene.camera.top) };
        };
        place(widths[0]); scene.setBuildingFloors(stack(floors)); scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
        const up = widths.map(place), down = [...widths].reverse().map(place);
        const at = (path, width) => path.find(entry => entry.width === width);
        const narrowColumn = SHRINK_AT_LAYOUT_EDGE[height].includes(floors);
        const layouts = narrowColumn ? [[900, 1000], [1001, 1280]] : [[900, 1280]];
        if (narrowColumn) {
          const kept = at(up, 1001).scale / at(up, 1000).scale;
          assert.ok(kept < .98 && kept >= .7, `${shot}: widening across the layout edge keeps ${kept.toFixed(3)} of the size (a listed loss, never under 0.7)`);
        }
        for (const [from, to] of layouts) {
          let largest = 0, smallest = Infinity;
          for (const { width, scale } of up.filter(entry => entry.width >= from && entry.width <= to)) {
            assert.ok(scale >= largest * .98, `${shot}: widening to ${width}px draws ${scale.toFixed(3)} px per unit, under ${largest.toFixed(3)} of a narrower window`);
            largest = Math.max(largest, scale);
          }
          for (const { width, scale } of down.filter(entry => entry.width >= from && entry.width <= to)) {
            assert.ok(scale <= smallest * 1.02, `${shot}: narrowing to ${width}px draws ${scale.toFixed(3)} px per unit, over ${smallest.toFixed(3)} of a wider window`);
            smallest = Math.min(smallest, scale);
          }
        }
        // No flicker: inside one layout the shot switches at most once each way, entering the fit beside the caption while widening at
        // a wider window than it leaves that fit while narrowing.
        for (const [from, to] of [[900, 1000], [1001, 1280]]) {
          const switches = path => path.filter((entry, i) => i > 0 && entry.beside !== path[i - 1].beside
            && [entry, path[i - 1]].every(({ width }) => width >= from && width <= to));
          const enter = switches(up), leave = switches(down), text = list => list.map(entry => `${entry.width}${entry.beside ? ' beside' : ' below'}`).join(', ');
          assert.ok(enter.length <= 1 && leave.length <= 1, `${shot} from ${from} to ${to}px: widening switches at ${text(enter) || 'no width'}, narrowing at ${text(leave) || 'no width'}`);
          if (enter.length && leave.length) {
            assert.ok(enter[0].beside && !leave[0].beside && enter[0].width > leave[0].width, `${shot}: enters beside the caption widening at ${text(enter)}, leaves narrowing at ${text(leave)}`);
          }
        }
        // The shot at the layout edges, for a single storey, a low stack and a crowded one.
        for (const width of [1, 3, 8].includes(floors) ? EDGES : []) {
          const label = `${shot} at ${width}px`, { insets, beside } = shortWindowInsets(width, height);
          assert.equal(at(up, width).beside, expectBeside(width), `${label}: widening fits ${expectBeside(width) ? 'beside' : 'below'} the caption`);
          assert.equal(at(down, width).beside, expectBeside(width), `${label}: narrowing fits ${expectBeside(width) ? 'beside' : 'below'} the caption`);
          // Three floors 650px high gain less than the entering 1.25 times beside the caption until about 1030px: a window resized
          // there keeps that fit (the staying 1.1 times), a fresh entry stays below the caption.
          const enter = expectBeside(width) && !(floors === 3 && height === 650 && (width === 1001 || width === 1020));
          scene.motion = createCinematicMotionState();
          resizeFixture(scene, width, height, insets);
          scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
          const belowOnly = height / (2 * scene.camera.top);
          scene.setHudInsets({ ...insets, beside });
          scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
          assert.equal(scene.frameBeside, enter, `${label}: a fresh entry fits ${enter ? 'beside' : 'below'} the caption`);
          const scale = height / (2 * scene.camera.top), area = enter ? beside : insets;
          assertNear(scale, enter ? at(up, width).scale : belowOnly, `${label}: a fresh entry draws the size of the ${enter ? 'resized window' : 'shot below the caption'}`, 1e-6);
          assert.ok(scale >= belowOnly - 1e-9, `${label}: ${scale.toFixed(3)} px per unit, never under the ${belowOnly.toFixed(3)} of the shot below the caption`);
          const fill = box => Math.max((box.maxY - box.minY) / (height - area.top - area.bottom), (box.maxX - box.minX) / (width - area.left - area.right));
          const model = assertInsideFree(scene, area, label);
          assert.ok(fill(model) >= .85, `${label}: the model fills the free area (${fill(model).toFixed(3)})`);
          // The nameplates lay out against the chosen area, whose side edges are the reported ones: beside the caption they never shrink.
          assert.deepEqual([scene.frameArea.left, scene.frameArea.right], [area.left, area.right], `${label}: the fit area keeps the reported side edges`);
          const points = scene.building.order.flatMap(interiorPoints).map(point => toScreen(scene, point));
          for (const plate of plateBoxes(scene, width, height)) {
            assert.ok(!points.some(point => point.x >= plate.left && point.x <= plate.right && point.y >= plate.top && point.y <= plate.bottom),
              `${label}: plate ${plate.name} ${plate.left.toFixed(1)}..${plate.right.toFixed(1)} covers no desk or head`);
          }
          if (drift) {
            const tops = [];
            for (const [sy, se] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
              scene.motion = { ...scene.motion, offset: { yaw: sy * yaw, elevation: se * elevation, zoomScale: 1, targetX: sy * targetX, targetY: se * targetY, targetZ: sy * targetZ } };
              scene.updateCamera(0, 3000);
              tops.push(scene.camera.top);
              const drifted = assertInsideFree(scene, area, `${label} at drift ${sy},${se}`);
              assert.ok(fill(drifted) >= .85, `${label} at drift ${sy},${se}: the model fills the free area (${fill(drifted).toFixed(3)})`);
            }
            assert.ok(Math.max(...tops) <= Math.min(...tops) * 1.0001, `${label}: one scale through the drift (${Math.min(...tops).toFixed(3)}..${Math.max(...tops).toFixed(3)})`);
            scene.motion = createCinematicMotionState();
          } else if (floors > 1) {
            // The approach to the ground floor zooms at most 1.22 and keeps the whole model, rooftop sign included, on screen.
            scene.building.focusFloor('floor-0'); scene.glideToBuildingFloor('floor-0'); run(scene, 3);
            assert.ok(scene.cameraZoom >= 1 && scene.cameraZoom <= 1.22, `${label}: the glide zoom stays between 1 and 1.22 (${scene.cameraZoom})`);
            const focused = modelPixels(scene);
            assert.ok(focused.minX >= -.5 && focused.maxX <= width + .5 && focused.minY >= -.5 && focused.maxY <= height + .5 && focused.signTop >= -.5,
              `${label}: the approached model ${boxText(focused)} stays on screen`);
            scene.building.focusFloor(null);
          }
        }
      }
    }
  }
  scene.autoRotate = false; scene.motion = createCinematicMotionState();
});

test('in a short window from 651 to 1000px wide no nameplate reaches under a HUD block, widening or narrowing, still or drifting', t => {
  // The narrow layout's column beside the caption: the fit there is chosen only where the plate column still clears the usage HUD.
  const scene = buildingFixture(t);
  const hits = (plate, [left, top, right, bottom]) => plate.left < right && plate.right > left && plate.top < bottom && plate.bottom > top;
  let besideShots = 0;
  for (const height of [560, 600, 650]) {
    for (let floors = 1; floors <= 8; floors++) {
      for (const drift of [false, true]) {
        const step = drift ? 6 : 3, widths = Array.from({ length: Math.floor(349 / step) + 1 }, (_, i) => 651 + i * step);
        scene.autoRotate = drift; scene.motion = createCinematicMotionState();
        const place = width => {
          const { insets, beside, blocks } = shortWindowInsets(width, height);
          scene.container.clientWidth = width; scene.container.clientHeight = height;
          scene.setHudInsets({ ...insets, beside }); scene.resize(); scene.updateCamera(0, 3000);
          if (scene.frameBeside) besideShots++;
          for (const plate of plateBoxes(scene, width, height)) {
            const block = blocks.find(box => hits(plate, box));
            if (block) {
              assert.fail(`${floors} floors ${height}px high${drift ? ' with the drift' : ''} at ${width}px ${scene.frameBeside ? 'beside' : 'below'} the caption: `
                + `plate ${plate.name} ${plate.left.toFixed(1)}..${plate.right.toFixed(1)} reaches under the HUD block ${block.join(',')}`);
            }
          }
        };
        place(widths[0]); scene.setBuildingFloors(stack(floors)); scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
        widths.forEach(place); [...widths].reverse().forEach(place);
      }
    }
  }
  assert.ok(besideShots > 0, 'the sweep includes shots fitted beside the caption');
  scene.autoRotate = false; scene.motion = createCinematicMotionState();
});

test('beside the floor caption a focused floor still glides on screen and clicks aim at the person drawn under the pointer', t => {
  const { scene, selected } = buildingPair(t);
  scene.setBuildingFloors(stack(3));
  for (const index of [0, 1]) {
    const { width, height, insets, beside } = BESIDE_SIZES[index], label = `3 floors at ${width}x${height}`;
    resizeFixture(scene, width, height, { ...insets, beside });
    scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
    assert.equal(scene.frameBeside, true, `${label}: fits beside the caption`);
    scene.renderer.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) };
    scene.pointer = new THREE.Vector2(); scene.raycaster = new THREE.Raycaster();
    const person = (floorId, seat) => {
      const floor = scene.building.floors.get(floorId), point = floor.points[seat];
      floor.group.updateWorldMatrix(true, false); scene.camera.updateMatrixWorld();
      const { x, y } = toScreen(scene, floor.group.localToWorld(new THREE.Vector3(point.x, 1.5, point.z - .2)));
      return { clientX: x, clientY: y };
    };
    scene.aimRay(person('floor-2', 1));
    assert.equal(scene.building.pickFloor(scene.raycaster), 'floor-2', `${label}: the pointer ray enters the storey drawn under it`);
    scene.clickBuilding(); run(scene, 3);
    assert.equal(scene.building.focusedFloor, 'floor-2');
    assert.ok(scene.cameraZoom > 1 && scene.cameraZoom <= 1.22, `${label}: the glide zooms in, at most 1.22 (${scene.cameraZoom})`);
    const model = modelPixels(scene);
    assert.ok(model.minX >= -.5 && model.maxX <= width + .5 && model.minY >= -.5 && model.maxY <= height + .5, `${label}: the focused model ${boxText(model)} stays on screen`);
    scene.aimRay(person('floor-2', 1)); scene.clickBuilding();
    assert.equal(selected.at(-1), 'floor-2-1', `${label}: the person under the pointer answers after the glide`);
    scene.aimRay(person('floor-0', 0));
    assert.equal(scene.building.pickAgent(scene.raycaster, 'floor-0'), 'floor-0-0', `${label}: a lower-floor person is aimed exactly as drawn`);
    scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
  }
});

test('beside the floor caption a lower-floor approach, the automatic drift around it and the crane rise keep the whole model on screen', t => {
  const scene = buildingFixture(t);
  const { yaw, elevation } = CINEMATIC_PROFILES.building;
  const onScreen = label => {
    const model = modelPixels(scene), width = scene.container.clientWidth, height = scene.container.clientHeight;
    assert.ok(model.minX >= -.5 && model.maxX <= width + .5 && model.minY >= -.5 && model.maxY <= height + .5 && model.signTop >= -.5,
      `${label}: the model ${boxText(model)} (sign top ${model.signTop.toFixed(1)}) stays on the ${width}x${height} screen`);
  };
  const towardFloor = (id, label) => {
    // The approach moves the camera from the building centre toward the floor, never past it nor away from it.
    const centre = scene.building.focusPoint(''), floor = scene.building.focusPoint(id), goal = scene.targetGoal;
    assertNear(centre.distanceTo(goal) + goal.distanceTo(floor), centre.distanceTo(floor), `${label}: the target lies between the centre and the floor`, 1e-6);
  };
  for (const floors of [3, 5, 8, 12]) {
    for (const { width, height, insets, beside } of APPROACH_SIZES) {
      resizeFixture(scene, width, height, { ...insets, beside });
      scene.setBuildingFloors(stack(floors));
      scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
      const shot = `${floors} floors at ${width}x${height}`;
      if (floors >= 5) assert.equal(scene.frameBeside, true, `${shot}: fits beside the caption`);
      for (const id of ['floor-0', 'floor-1']) {
        const label = `${id} of ${shot}`;
        scene.building.focusFloor(id); scene.glideToBuildingFloor(id); run(scene, 3);
        assert.ok(scene.cameraZoom >= 1 && scene.cameraZoom <= 1.22, `${label}: the glide zoom stays between 1 and 1.22 (${scene.cameraZoom})`);
        towardFloor(id, label);
        onScreen(label);
      }
      scene.building.focusFloor(null);
      scene.autoRotate = true;
      for (const id of ['floor-0', 'floor-1']) {
        scene.setBuildingView(true, id); run(scene, 3);
        for (const [sy, se] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          scene.motion = { ...scene.motion, offset: { ...scene.motion.offset, yaw: sy * yaw, elevation: se * elevation } };
          scene.updateCamera(0, 3000);
          onScreen(`automatic approach to ${id} of ${shot}, drift ${sy},${se}`);
        }
        scene.motion = createCinematicMotionState(); scene.setBuildingView(true); run(scene, 3);
      }
      scene.autoRotate = false;
      for (const id of ['floor-0', 'floor-1']) {
        const label = `crane from ${id} of ${shot}`;
        scene.setBuildingView(false);
        assert.equal(scene.playBuildingIntro(id, 3000), true, label);
        for (let step = 0; step <= 30; step++) {
          if (step) scene.updateCamera(.1, step * 100);
          onScreen(`${label} at step ${step}`);
        }
        assert.equal(scene.cinematic, false, `${label}: the rise ends on the whole building`);
        assertInsideFree(scene, scene.frameBeside ? beside : insets, `${label} after the rise`);
      }
    }
  }

  // A caption decision that changes while the camera approaches a floor refits that approach instead of keeping the old zoom.
  const { width, height, insets, beside } = BESIDE_SIZES[1];
  for (const [from, to] of [[insets, { ...insets, beside }], [{ ...insets, beside }, insets]]) {
    const label = `8 floors at ${width}x${height} ${to.beside ? 'entering' : 'leaving'} the fit beside the caption mid-glide`;
    resizeFixture(scene, width, height, from);
    scene.setBuildingFloors(stack(8));
    scene.setBuildingView(false); scene.setBuildingView(true); run(scene, 3);
    assert.equal(scene.frameBeside, !!from.beside, label);
    scene.building.focusFloor('floor-0'); scene.glideToBuildingFloor('floor-0'); run(scene, 1);
    assert.equal(scene.cinematic, true, `${label}: still gliding`);
    scene.setHudInsets(to);
    assert.equal(scene.frameBeside, !!to.beside, `${label}: the decision changed`);
    run(scene, 3);
    towardFloor('floor-0', label);
    onScreen(label);
    const zoom = scene.cameraZoom;
    scene.glideToBuildingFloor('floor-0'); run(scene, 3);
    assertNear(scene.cameraZoom, zoom, `${label}: the refitted approach is the one a new glide chooses`, 1e-9);
    scene.building.focusFloor(null);
  }
});

test('building clicks aim exactly while the automatic drift turns and tilts the refitted shot', t => {
  const { scene } = buildingPair(t);
  const { width, height, insets } = HUD_SIZES[1];
  resizeFixture(scene, width, height, insets);
  scene.renderer.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) };
  scene.pointer = new THREE.Vector2(); scene.raycaster = new THREE.Raycaster();
  run(scene, 1);
  const rest = [scene.camera.view.offsetX, scene.camera.view.offsetY, scene.camera.top];
  const { yaw, elevation, zoomVariation, targetX } = CINEMATIC_PROFILES.building;
  scene.motion = { ...scene.motion, offset: { ...scene.motion.offset, yaw: -yaw, elevation, zoomScale: 1 + zoomVariation, targetX } };
  scene.updateCamera(0, 0);
  assert.equal(scene.camera.zoom, 1, 'the building shot keeps its optical zoom');
  assert.notDeepEqual([scene.camera.view.offsetX, scene.camera.view.offsetY, scene.camera.top], rest, 'the drifted pose is refitted');
  assertInsideFree(scene, insets, 'the drifted shot');
  const person = (floorId, index) => {
    const floor = scene.building.floors.get(floorId), seat = floor.points[index];
    floor.group.updateWorldMatrix(true, false);
    scene.camera.updateMatrixWorld();
    const { x, y } = toScreen(scene, floor.group.localToWorld(new THREE.Vector3(seat.x, 1.5, seat.z - .2)));
    return { clientX: x, clientY: y };
  };
  scene.aimRay(person('top', 1));
  assert.equal(scene.building.pickFloor(scene.raycaster), 'top', 'the pointer ray enters the storey drawn under it');
  assert.equal(scene.building.pickAgent(scene.raycaster, 'top'), 'top-1', 'and meets the person drawn under it');
  scene.aimRay(person('first', 0));
  assert.equal(scene.building.pickAgent(scene.raycaster, 'first'), 'first-0', 'a lower-floor person is aimed exactly as drawn');
});

test('a building shot of another project releases a focused floor so the haze and the camera stay on the same floor', t => {
  const { scene } = buildingPair(t);
  scene.handleKeyDown({ key: 'PageDown', preventDefault() {} });
  assert.equal(scene.building.focusedFloor, 'top');
  scene.setBuildingView(true, 'top');
  assert.equal(scene.building.focusedFloor, 'top', 'a shot of the focused floor keeps the focus');
  scene.setBuildingView(true, 'first');
  assert.equal(scene.building.focusedFloor, null, 'automatic watching of another floor clears the focus');
  assert.equal(scene.targetGoal.equals(scene.building.focusPoint('first')), true, 'and the camera goes to that floor');
});
