import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OfficeScene } from '../src/office-scene.ts';
import { CameraPointers, CAMERA_LIMITS } from '../src/office-camera.ts';
import { officeBounds, seatPosition, routeBetweenSeats, routeToApproval, approvalSpot } from '../src/office-layout.ts';
import { activityMessage } from '../src/activity-bubble.ts';
import { idleYawnDelay, YAWN_DURATION, WINDOW_LIGHT, OWNER_ACTION_SECONDS, CALL_ENTER_SECONDS, CALL_TURN_RADIANS, CALL_WAVE_BARS } from '../src/office-effects.ts';
import { WorkMarkers } from '../src/work-markers.ts';
import { appearanceFor, appearanceKey } from '../src/appearance.ts';

// Exercise the actual roster and handoff methods without creating a browser or WebGL context.
// Only the rendering surfaces are replaced; assignment and event behavior remain production code.
function fixture() {
  const figures = Array.from({ length: 6 }, (_, seat) => ({
    id: `unassigned-${seat}`,
    seat,
    group: new THREE.Group(),
    head: new THREE.Group(),
    leftArm: new THREE.Group(),
    rightArm: new THREE.Group(),
    leftLeg: new THREE.Group(),
    rightLeg: new THREE.Group(),
    leftKnee: new THREE.Group(),
    rightKnee: new THREE.Group(),
    homeYaw: Math.PI,
    phase: seat * 1.7,
    yawnStartedAt: null,
    nextYawnAt: 30 + seat * 3,
    yawnCycle: 0,
    origin: new THREE.Vector3(seatPosition(seat).x, 0, seatPosition(seat).z),
    halo: { visible: false, position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), material: { color: new THREE.Color() } },
    label: { style: {}, dataset: {}, querySelector: () => null },
    activity: activityMessage({ status: 'idle' }),
    bubble: { style: { setProperty(name, value) { this[name] = value; } }, dataset: {}, title: '', remove() {} },
    bubbleContent: { textContent: '' },
    bubbleWidth: 90,
    compactBubbleWidth: 90,
    nameWidth: 180,
    shirt: { color: new THREE.Color() },
    signal: { visible: false, children: [] },
    screen: new THREE.Mesh(new THREE.PlaneGeometry(1.025, .66), new THREE.MeshStandardMaterial()),
    paper: Object.assign(new THREE.Group(), { visible: false }),
  }));
  for (const figure of figures) {
    figure.group.position.copy(figure.origin);
    figure.screen.position.set(figure.origin.x - .22, 1.9, figure.origin.z - 1.252);
    figure.leftArm.position.set(-.34, 1.4, .01);
    figure.rightArm.position.set(.34, 1.4, .01);
    figure.group.add(figure.head, figure.leftArm, figure.rightArm, figure.leftLeg, figure.rightLeg, figure.paper);
    for (const [arm, side] of [[figure.leftArm, -1], [figure.rightArm, 1]]) {
      const hand = new THREE.Object3D();
      hand.position.set(side * .035, -.33, .13);
      arm.add(hand);
    }
  }
  const scene = Object.assign(Object.create(OfficeScene.prototype), {
    figures,
    world: new THREE.Group(),
    effects: new THREE.Group(),
    paperFlights: [],
    seenPlaneEvents: new Set(),
    agentSeats: new Map(),
    deliveries: [],
    queued: [],
    approvalRequests: new Set(),
    approvalVisits: new Map(),
    fixtureRows: new Map(),
    geometryCache: new Map(),
    roomShell: new THREE.Group(),
    bounds: officeBounds(6),
    zoomGoal: 1,
    framing: 0,
    framingGoal: 0,
    cinematic: false,
    cinematicStartFraming: 0,
    cinematicElapsed: 0,
    cinematicStartZoom: 1,
    cinematicStartTarget: new THREE.Vector3(),
    focusId: null,
    elapsed: 0,
    speed: 1,
    paused: false,
    reducedMotion: false,
    suspended: false,
    following: false,
    labelsVisible: true,
    activityBubblesVisible: true,
    visibleBubbles: new Set(),
    autoRotate: false,
    autoRotateAfter: 0,
    powerSaving: false,
    animationId: 0,
    lastFrameTime: null,
    yaw: .61,
    elevation: .81,
    cameraZoom: 1,
    cameraPointers: new CameraPointers(),
    camera: new THREE.OrthographicCamera(-13, 13, 10, -10, .1, 150),
    cameraTarget: new THREE.Vector3(0, .3, .15),
    targetGoal: new THREE.Vector3(),
    backWall: new THREE.Group(),
    leftWall: new THREE.Group(),
    container: { clientWidth: 1200, clientHeight: 800, dataset: {} },
    renderer: { setSize() {}, setPixelRatio() {}, render() {}, info: { render: { calls: 0, triangles: 0 } },
      domElement: { style: {}, hasPointerCapture: () => false } },
    // Animation scheduling is irrelevant to roster/pose tests; render lifecycle is covered separately below.
    syncRenderLoop() {},
    ensureCapacity(capacity) {
      while (figures.length < capacity) {
        const figure = fixture().figures[0];
        figure.seat = figures.length;
        const position = seatPosition(figure.seat);
        figure.origin.set(position.x, 0, position.z);
        figures.push(figure);
      }
    },
  });
  return { scene, figures };
}

const agent = (id) => ({ id, status: 'working', name: id });
const visible = (figures) => figures.filter((figure) => figure.group.visible);

test('quiet employees leave the scene without losing their desk, camera or observed messages', () => {
  const { scene, figures } = fixture();
  const worker = { ...agent('worker'), showCharacter: true, activityKind: 'coding' };
  scene.setAgents([agent('boss'), worker]);
  scene.updateDeskWork(); scene.elapsed = 1; scene.updateDeskWork();
  const seat = scene.agentSeats.get('worker'), figure = figures[seat];
  const origin = figure.origin.clone(), bounds = scene.bounds;
  scene.focusId = 'worker'; scene.cameraZoom = 2; scene.zoomGoal = 2;
  const cameraTarget = scene.cameraTarget.clone();
  for (const status of ['idle', 'waiting', 'done']) {
    scene.setAgents([agent('boss'), { ...worker, status, showCharacter: false }]);
    scene.updateDeskWork();
    assert.deepEqual(visible(figures).map(figure => figure.id), ['boss']);
    assert.equal(figure.halo.visible, false);
    assert.equal(figure.label.style.display, 'none');
    assert.equal(figure.bubble.style.display, 'none');
    assert.equal(figure.deskWork.group.visible, false, 'cached work details cannot outlive the character');
    assert.equal(scene.agentSeats.get('worker'), seat);
    assert.deepEqual(figure.origin, origin);
    assert.equal(scene.bounds === bounds, true, 'hiding a character keeps the same room bounds object');
    assert.equal(scene.focusId, 'worker');
    assert.equal(scene.cameraZoom, 2); assert.equal(scene.zoomGoal, 2);
    assert.deepEqual(scene.cameraTarget, cameraTarget);
    assert.equal(scene.hasVisibleAgent('worker'), true, 'the monitor remains a recorded communication endpoint');
    assert.equal(scene.sendMessagePlane('worker', `quiet-message-${status}`), true);
  }
  assert.equal(scene.sendPaperPlane('boss', 'worker', 'quiet-handoff'), true);
  scene.setAgents([agent('boss'), worker]); scene.updateDeskWork();
  assert.equal(figures[seat] === figure, true, 'the returning worker keeps the same figure');
  assert.equal(figure.group.visible, true);
  assert.equal(figure.signal.visible, true);
  assert.equal(figure.halo.material.color.getHexString(), 'ff5b54');
  assert.equal(scene.focusId, 'worker');
  assert.equal(scene.paperFlights.length, 4);
});

test('a followed approval visitor becoming quiet freezes the current camera through their return and later work', () => {
  const { scene, figures } = fixture();
  const visitor = { ...agent('visitor'), status: 'approval', showCharacter: true };
  scene.setAgents([agent('boss'), visitor]);
  for (let frame = 0; frame < 10; frame++) scene.updateAnimation(.1);
  scene.focus('visitor', { cinematic: true, zoom: 2 });
  scene.updateCamera(.5, 0);
  const target = scene.cameraTarget.clone(), zoom = scene.cameraZoom, framing = scene.framing;
  scene.setAgents([agent('boss'), { ...visitor, status: 'idle', showCharacter: false }]);
  for (let frame = 0; frame < 150; frame++) {
    scene.updateAnimation(.1); scene.updateCamera(.1, frame * 100);
  }
  assert.deepEqual(scene.cameraTarget, target);
  assert.equal(scene.cameraZoom, zoom); assert.equal(scene.framing, framing);
  assert.equal(scene.focusId, 'visitor');
  assert.equal(scene.following, false); assert.equal(scene.cinematic, false);
  const figure = figures[scene.agentSeats.get('visitor')];
  assert.equal(figure.group.visible, false);
  scene.setAgents([agent('boss'), { ...visitor, status: 'working' }]);
  scene.updateAnimation(.1); scene.updateCamera(.1, 16_000);
  assert.equal(figure.group.visible, true);
  assert.deepEqual(scene.cameraTarget, target);
  assert.equal(scene.cameraZoom, zoom);
});

test('observed work mounts at its monitor, keeps brief auxiliary actions and releases a departed identity', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), { ...agent('worker'), activityKind: 'coding' }]);
  scene.updateDeskWork(); scene.elapsed = 1; scene.updateDeskWork();
  const figure = figures[scene.agentSeats.get('worker')];
  const desk = figure.deskWork;
  assert.equal(desk.group.children[0].name, 'work-props-coding');
  assert.deepEqual(desk.group.position.toArray(), figure.screen.getWorldPosition(new THREE.Vector3()).toArray());
  scene.setAgents([agent('boss'), { ...agent('worker'), activityKind: 'research' }]);
  scene.updateDeskWork();
  assert.equal(figure.bubble.dataset.workKind, 'coding');
  assert.equal(figure.bubble.dataset.workAuxiliary, 'research');
  scene.setAgents([agent('boss')]);
  assert.equal(desk.group.parent === null, true, 'a departed identity\'s desk props leave the scene');
  assert.equal(desk.group.children.length, 0);
});

test('room details have a twelve-worker budget without omitting staff', () => {
  const { scene } = fixture();
  scene.setAgents([agent('boss'), ...Array.from({ length: 32 }, (_, i) => ({ ...agent(`worker-${i}`), activityKind: 'documents' }))]);
  scene.updateDeskWork();
  assert.equal(scene.container.dataset.workProps, '12');
  assert.equal(scene.figures.filter(figure => figure.group.visible).length, 33);
  scene.buildingView = true; scene.elapsed = 1; scene.updateDeskWork();
  assert.equal(scene.container.dataset.workProps, '0');
  assert.equal(scene.figures.reduce((n, figure) => n + (figure.deskWork?.group.children.length ?? 0), 0), 0);
});

test('zooming while animation is paused still reveals the selected worker props', () => {
  const { scene } = fixture();
  scene.paused = true;
  scene.camera.top = 80; scene.camera.bottom = -80;
  scene.setAgents([agent('boss'), { ...agent('worker'), activityKind: 'coding' }]);
  scene.updateDeskWork();
  assert.equal(scene.container.dataset.workProps, '0');
  scene.camera.top = 8; scene.camera.bottom = -8; scene.focusId = 'worker';
  scene.updateDeskWork();
  const figure = scene.figures[scene.agentSeats.get('worker')];
  assert.equal(scene.container.dataset.workProps, '1');
  assert.equal(figure.deskWork.group.children[0].scale.x, 1);
});

test('live boss-only roster hides unoccupied figures, labels and selection rings', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss')]);

  assert.deepEqual(visible(figures).map((figure) => figure.id), ['boss']);
  assert.equal(figures.filter((figure) => figure.label.style.display !== 'none').length, 1);
  assert.equal(figures.filter((figure) => figure.halo.visible).length, 1);
  scene.deliver('boss', 'planner');
  scene.deliver('developer', 'boss');
  assert.equal(scene.deliveries.length, 0, 'unoccupied department names cannot receive or send documents');
  assert.equal(scene.queued.length, 0);
});

test('working hands type toward the keyboard above the tabletop while repeated status events keep time moving', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss')]);
  const worker = figures[scene.agentSeats.get('boss')];
  const heights = [];
  const angles = [];
  for (let frame = 0; frame < 60; frame++) {
    scene.setAgents([agent('boss')]);
    scene.updateAnimation(1 / 60);
    worker.group.updateMatrixWorld(true);
    const hand = worker.leftArm.children[0].getWorldPosition(new THREE.Vector3());
    heights.push(hand.y);
    angles.push(worker.leftArm.rotation.x);
    assert.ok(hand.z < worker.origin.z - .35, 'the hand reaches toward the desk rather than behind the employee');
  }
  assert.ok(Math.max(...angles) - Math.min(...angles) > .45);
  assert.ok(Math.min(...heights) + .105 > 1.26, 'the rendered hand reaches above the desk surface');
  assert.ok(Math.max(...heights) - Math.min(...heights) > .1);
  assert.ok(scene.elapsed > .99, 'setAgents must not reset the animation clock');
});

test('thinking and reviewing animate both arms and paperwork, then idle hides the paper and stops arm work', () => {
  const { scene, figures } = fixture();
  for (const status of ['thinking', 'reviewing']) {
    scene.setAgents([{ ...agent('boss'), status }]);
    const worker = figures[scene.agentSeats.get('boss')];
    scene.updateAnimation(.1);
    const before = [worker.leftArm.rotation.x, worker.rightArm.rotation.x, worker.paper.position.y];
    scene.updateAnimation(.2);
    assert.equal(worker.paper.visible, true);
    assert.notEqual(worker.leftArm.rotation.x, before[0]);
    assert.notEqual(worker.rightArm.rotation.x, before[1]);
    assert.notEqual(worker.paper.position.y, before[2]);
  }
  scene.setAgents([{ ...agent('boss'), status: 'idle' }]);
  scene.updateAnimation(.1);
  const worker = figures[scene.agentSeats.get('boss')];
  const idle = [worker.leftArm.rotation.x, worker.rightArm.rotation.x];
  scene.updateAnimation(.2);
  assert.equal(worker.paper.visible, false);
  assert.deepEqual([worker.leftArm.rotation.x, worker.rightArm.rotation.x], idle);
});

test('pause, reduced motion and overview freeze arm animation without changing reported work status', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss')]);
  const worker = figures[scene.agentSeats.get('boss')];
  scene.updateAnimation(.1);
  scene.setPaused(true);
  const beforePause = worker.leftArm.rotation.x;
  const pausedTime = scene.elapsed;
  scene.updateAnimation(.2);
  assert.equal(worker.leftArm.rotation.x, beforePause);
  assert.equal(scene.elapsed, pausedTime);
  scene.setPaused(false);
  scene.setReducedMotion(true);
  scene.updateAnimation(.1);
  const reduced = worker.leftArm.rotation.x;
  scene.updateAnimation(.2);
  assert.equal(worker.leftArm.rotation.x, reduced);
  assert.equal(worker.status, 'working');
  scene.setReducedMotion(false);
  scene.setSuspended(true);
  const suspendedTime = scene.elapsed;
  scene.updateAnimation(.2);
  assert.equal(scene.elapsed, suspendedTime);
  scene.setSuspended(false);
  scene.updateAnimation(.1);
  assert.notEqual(worker.leftArm.rotation.x, reduced);
});

test('the real character assembly faces its monitor, sits on the chair and bends knees under the desk', (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: { setProperty(name, value) { this[name] = value; } }, dataset: {}, children: [],
    setAttribute() {}, append(...children) { this.children.push(...children); },
    querySelector(selector) { return selector.includes('first') ? this.children[0] : this.children.at(-1); } }) };
  t.after(() => { globalThis.document = previousDocument; });
  const { scene } = fixture();
  scene.world = new THREE.Group();
  scene.materials = new Map();
  scene.container = { append() {}, dataset: {}, clientWidth: 1200, clientHeight: 800 };
  // Obtain the production seat coordinates, then assemble its real desk, chair and employee.
  const seed = scene.createFigure(1);
  seed.group.removeFromParent(); seed.halo.removeFromParent();
  scene.workstation(seed.origin.x, seed.origin.z, 1);
  const figure = scene.createFigure(1);
  scene.figures[1] = figure;
  scene.setAgents([agent('planner')]);
  scene.updateAnimation(.1);
  scene.world.updateMatrixWorld(true);
  const head = figure.head.getWorldPosition(new THREE.Vector3());
  const eye = figure.group.getObjectByName('employee-eye-left').getWorldPosition(new THREE.Vector3());
  const chair = scene.world.getObjectByName('chair-seat-1');
  const chairBack = scene.world.getObjectByName('chair-back-1');
  const desk = scene.world.getObjectByName('desk-top-1');
  const pelvisBounds = new THREE.Box3().setFromObject(figure.group.getObjectByName('employee-pelvis'));
  const chairBounds = new THREE.Box3().setFromObject(chair);
  assert.ok(eye.z < head.z - .3, 'the face points toward world -Z');
  assert.ok(desk.position.z < figure.origin.z);
  assert.ok(chairBack.position.z > figure.origin.z, 'the chair back is behind the employee');
  assert.ok(Math.abs(pelvisBounds.min.y - chairBounds.max.y) < .00001, 'the actual beveled pelvis and chair surfaces meet');
  const thigh = figure.leftLeg.getWorldPosition(new THREE.Vector3());
  const knee = figure.leftKnee.getWorldPosition(new THREE.Vector3());
  const shoe = figure.leftKnee.getObjectByName('employee-shoe').getWorldPosition(new THREE.Vector3());
  assert.ok(knee.z < thigh.z - .3 && Math.abs(knee.y - thigh.y) < .00001, 'seated thighs extend horizontally toward the desk');
  assert.ok(shoe.y < knee.y - .4, 'lower legs hang down from bent knees');
  const deskTop = new THREE.Box3().setFromObject(desk).max.y;
  for (let frame = 0; frame < 30; frame++) {
    scene.updateAnimation(1 / 60); scene.world.updateMatrixWorld(true);
    for (const arm of [figure.leftArm, figure.rightArm]) {
      const hand = arm.getObjectByName('employee-hand').getWorldPosition(new THREE.Vector3());
      assert.ok(hand.z < figure.origin.z - .35);
      assert.ok(hand.y + .105 > deskTop, 'typing remains visible above the real beveled desktop');
    }
  }
});

test('delivery stands up and returns to the monitor-facing seated pose', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), agent('planner')]);
  scene.updateAnimation(.1);
  const courier = figures[scene.agentSeats.get('boss')];
  assert.equal(courier.group.rotation.y, Math.PI);
  assert.equal(courier.leftKnee.rotation.x, Math.PI / 2);
  scene.deliver('boss', 'planner');
  assert.equal(courier.leftKnee.rotation.x, 0);
  assert.equal(courier.leftLeg.rotation.x, 0);
  scene.updateAnimation(.1);
  assert.notEqual(courier.group.rotation.y, courier.homeYaw, 'walking follows the path rather than the seated direction');
  for (let frame = 0; scene.deliveries.length && frame < 800; frame++) scene.updateAnimation(.1);
  assert.equal(scene.deliveries.length, 0);
  assert.equal(courier.group.position.distanceTo(courier.origin), 0);
  assert.equal(courier.group.rotation.y, courier.homeYaw);
  assert.equal(courier.leftLeg.rotation.x, -Math.PI / 2);
  assert.equal(courier.leftKnee.rotation.x, Math.PI / 2);
});

test('arbitrary IDs expand past six without retaining phantom aliases or overlapping desks', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), agent('planner')]);
  scene.setAgents([agent('boss'), ...Array.from({ length: 7 }, (_, i) => agent(`worker-${i}`))]);
  assert.equal(visible(figures).length, 8);
  assert.equal(scene.agentSeats.size, 8);
  assert.equal(new Set(scene.agentSeats.values()).size, 8);
  assert.equal(scene.agentSeats.has('planner'), false);
  assert.equal(scene.agentSeats.has('worker-6'), true);
  scene.deliver('boss', 'planner');
  assert.equal(scene.deliveries.length, 0);
  scene.deliver('boss', 'worker-6');
  assert.equal(scene.deliveries[0].recipient.id, 'worker-6');
});

test('named newcomers preserve occupied seats, and removing the recipient cancels stale handoffs', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), agent('custom')]);
  const originalSeat = scene.agentSeats.get('custom');
  scene.deliver('boss', 'custom');
  scene.deliver('boss', 'custom');
  const courier = scene.deliveries[0].courier;
  scene.setAgents([agent('boss'), agent('planner'), agent('custom')]);
  assert.equal(scene.agentSeats.get('custom'), originalSeat);
  assert.notEqual(scene.agentSeats.get('planner'), originalSeat);
  assert.equal(scene.deliveries.length, 1, 'an unchanged identity keeps its current handoff');
  scene.setAgents([agent('boss'), agent('planner')]);
  assert.equal(scene.deliveries.length, 0);
  assert.equal(scene.queued.length, 0);
  assert.equal(courier.group.position.distanceTo(courier.origin), 0);
  assert.equal(courier.paper.visible, false);
  assert.equal(visible(figures).length, 2);
});

test('removing all agents cancels their queued and active handoffs and clears selection', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), agent('planner')]);
  scene.focus('planner');
  scene.deliver('boss', 'planner');
  scene.deliver('boss', 'planner');

  scene.setAgents([]);

  assert.equal(visible(figures).length, 0);
  assert.equal(figures.filter((figure) => figure.label.style.display !== 'none').length, 0);
  assert.equal(figures.filter((figure) => figure.halo.visible).length, 0);
  assert.equal(scene.agentSeats.size, 0);
  assert.equal(scene.deliveries.length, 0);
  assert.equal(scene.queued.length, 0);
  assert.equal(scene.focusId, null);
});

test('camera completes multiple full turns, stays above the floor and reaches both wide zoom limits', () => {
  const { scene } = fixture();
  const quadrants = new Set();
  for (let step = 0; step < 160; step++) {
    scene.orbit(-40, step % 2 ? 10000 : -10000);
    quadrants.add(`${Math.sin(scene.yaw) >= 0}/${Math.cos(scene.yaw) >= 0}`);
    assert.ok(scene.elevation >= CAMERA_LIMITS.minElevation && scene.elevation <= CAMERA_LIMITS.maxElevation);
    scene.updateCamera(.1, 0);
    assert.ok(scene.camera.position.y > scene.cameraTarget.y);
  }
  assert.equal(quadrants.size, 4, 'every side of the office remains reachable after several revolutions');
  scene.zoom(-100);
  assert.equal(scene.cameraZoom, .45);
  const wideSpan = scene.camera.right - scene.camera.left;
  scene.zoom(100);
  assert.equal(scene.cameraZoom, 4);
  assert.ok(wideSpan / (scene.camera.right - scene.camera.left) > 8);
  scene.resetCamera();
  assert.equal(scene.cameraZoom, 1);
  assert.equal(scene.yaw, .61);
  assert.equal(scene.elevation, .81);
});

test('ordinary wheel, trackpad pinch and canvas keyboard change the actual camera', () => {
  const { scene } = fixture();
  let prevented = 0;
  const event = { deltaY: -100, deltaMode: 0, ctrlKey: false, preventDefault: () => prevented++ };
  scene.handleWheel(event);
  assert.ok(scene.cameraZoom > 1);
  const ordinary = scene.cameraZoom;
  scene.handleWheel({ ...event, ctrlKey: true, deltaY: -10 });
  assert.ok(scene.cameraZoom > ordinary);
  scene.handleWheel({ ...event, deltaMode: 1, deltaY: 10000 });
  assert.ok(scene.cameraZoom >= .45);
  const key = (key) => ({ key, preventDefault: () => prevented++ });
  const yaw = scene.yaw;
  scene.handleKeyDown(key('ArrowRight'));
  assert.notEqual(scene.yaw, yaw);
  scene.handleKeyDown(key('+'));
  scene.handleKeyDown(key('Home'));
  assert.equal(scene.cameraZoom, 1);
  assert.equal(scene.yaw, .61);
  assert.equal(prevented, 6);
});

test('focus centers and enlarges a moving employee; manual navigation releases tracking and briefly pauses auto rotation', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), agent('designer')]);
  scene.updateAnimation(.1);
  const worker = figures[scene.agentSeats.get('designer')];
  scene.focus('designer');
  assert.equal(scene.cameraZoom, 2.4);
  assert.deepEqual(scene.targetGoal.toArray(), [worker.group.position.x, 1.15, worker.group.position.z]);
  scene.updateCamera(1, 0);
  assert.ok(scene.cameraTarget.distanceTo(scene.targetGoal) < .0001);
  worker.group.position.x += 2;
  scene.updateCamera(1, 0);
  assert.equal(scene.cameraTarget.x, worker.group.position.x);
  scene.setAutoRotate(true);
  scene.orbit(30, 0);
  const manualYaw = scene.yaw;
  const manualTarget = scene.targetGoal.clone();
  const manualOffset = structuredClone(scene.motion.offset);
  worker.group.position.x += 4;
  scene.updateCamera(1, performance.now());
  assert.equal(scene.following, false);
  assert.ok(scene.targetGoal.equals(manualTarget));
  assert.equal(scene.yaw, manualYaw);
  scene.updateCamera(1, scene.motion.heldUntilMs - 1);
  assert.deepEqual(scene.motion.offset, manualOffset, 'manual framing stays protected for the full eighteen-second hold');
  scene.updateCamera(1, scene.motion.heldUntilMs);
  assert.equal(scene.yaw, manualYaw, 'automatic motion must never accumulate into the base yaw');
  assert.notDeepEqual(scene.motion.offset, manualOffset, 'automatic motion resumes through the rendered offset');
  scene.setAutoRotate(false);
  const stoppedOffset = structuredClone(scene.motion.offset);
  scene.updateCamera(1, scene.motion.heldUntilMs + 1000);
  assert.equal(scene.yaw, manualYaw);
  assert.deepEqual(scene.motion.offset, stoppedOffset);
});

test('an employee departure preserves a manual camera but releases an active follow shot', () => {
  const { scene } = fixture();
  scene.setAgents([agent('boss'), agent('worker')]);
  scene.focus('worker'); scene.updateCamera(1, 0); scene.zoom(.5);
  const target = scene.targetGoal.clone(), zoom = scene.cameraZoom;
  scene.setAgents([agent('boss')]);
  assert.equal(scene.focusId, null);
  assert.equal(scene.cinematic, false);
  assert.equal(scene.cameraZoom, zoom);
  assert.ok(scene.targetGoal.equals(target));
  scene.setAgents([agent('boss'), agent('worker')]);
  scene.focus('worker'); scene.setAgents([agent('boss')]);
  assert.equal(scene.cinematic, true);
  assert.equal(scene.focusId, null);
  assert.equal(scene.zoomGoal, 1);
});

test('touch pinch and pan share one gesture, and cancellation cannot select or leave a captured pointer behind', () => {
  const pointers = new CameraPointers();
  pointers.begin(1, 0, 0);
  assert.equal(pointers.move(1, 3, 2), null);
  assert.equal(pointers.end(1), true, 'a short tap still selects a worker');
  pointers.begin(1, 0, 0);
  pointers.begin(2, 100, 0);
  const pinch = pointers.move(2, 200, 40);
  assert.ok(pinch.zoomRatio > 2);
  assert.equal(pinch.panX, 50);
  assert.equal(pinch.panY, 20);
  assert.equal(pinch.orbitX, 0);
  assert.equal(pointers.end(2), false);
  assert.equal(pointers.end(1), false, 'lifting the second finger does not become a click');
  pointers.begin(3, 50, 50, true);
  const pan = pointers.move(3, 70, 90);
  assert.equal(pan.panX, 20);
  assert.equal(pan.panY, 40);
  assert.equal(pan.orbitY, 0);
  const { scene } = fixture();
  scene.cameraPointers = pointers;
  pointers.begin(4, 100, 100);
  const released = [];
  scene.renderer.domElement.hasPointerCapture = () => true;
  scene.renderer.domElement.releasePointerCapture = (id) => released.push(id);
  scene.cancelPointers();
  assert.deepEqual(released, [3, 4]);
  assert.equal(pointers.active, false);
  assert.equal(pointers.move(3, 500, 500), null);
  assert.equal(pointers.end(3), false);
  pointers.begin(5, 10, 10);
  assert.equal(pointers.end(5), true, 'a new tap works after cancellation');
});

test('floor panning follows the dragged content and cannot lower the target below ground', () => {
  const { scene } = fixture();
  scene.yaw = 0;
  scene.targetGoal.set(0, .3, 0);
  scene.pan(100, 100);
  assert.ok(scene.targetGoal.x < 0);
  assert.ok(scene.targetGoal.z < 0);
  assert.equal(scene.targetGoal.y, .3);
  scene.pan(1000000, -1000000);
  assert.ok(scene.targetGoal.x < scene.bounds.minX - 10);
  assert.ok(scene.targetGoal.z > scene.bounds.maxZ + 10);
  assert.ok(scene.targetGoal.toArray().every(Number.isFinite));
  assert.equal(scene.targetGoal.y, .3);
});

test('middle-button pan keeps its full drag distance after 100 workers shrink to two and zero', t => {
  const scene = actualGeometryFixture(t);
  const workers = Array.from({ length: 100 }, (_, index) => agent(`pan-${index}`));
  scene.setAgents([agent('boss'), ...workers]);
  scene.stopFollowing();
  const projection = scene.camera.top - scene.camera.bottom;
  for (const count of [100, 2, 0]) {
    scene.setAgents([agent('boss'), ...workers.slice(0, count)]);
    scene.targetGoal.set(0, .3, 0);
    scene.yaw = 0;
    const pointers = scene.cameraPointers;
    pointers.begin(42, 500, 600, true);
    const gesture = pointers.move(42, 500, 200);
    scene.pan(gesture.panX, gesture.panY);
    pointers.end(42);
    const expected = 400 * projection / scene.container.clientHeight / Math.sin(scene.elevation);
    assert.ok(Math.abs(scene.targetGoal.z - expected) < 1e-8, `${count} workers must not restrict the same drag`);
    assert.equal(scene.targetGoal.y, .3);
  }
  scene.resetCamera();
  assert.deepEqual(scene.targetGoal.toArray(), [scene.bounds.centerX, .3, scene.bounds.centerZ]);
});

test('hidden labels stay hidden through roster updates and unoccupied seats stay hidden when labels return', () => {
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss')]);
  scene.setLabelsVisible(false);
  scene.setAgents([agent('boss'), agent('planner')]);
  assert.ok(figures.every(figure => figure.label.style.display === 'none'));
  scene.setLabelsVisible(true);
  assert.equal(figures.filter(figure => figure.label.style.display === 'flex').length, 2);
  scene.setAgents([agent('boss')]);
  assert.equal(figures.filter(figure => figure.label.style.display === 'flex').length, 1);
});

test('quiet employee names stay hidden until selection while working and actionable names remain visible', () => {
  const { scene, figures } = fixture();
  scene.setAgents([{ ...agent('quiet'), status: 'idle' }, { ...agent('working'), status: 'working' },
    { ...agent('approval'), status: 'approval' }, { ...agent('error'), status: 'error' }]);
  const quiet = figures[scene.agentSeats.get('quiet')];
  assert.equal(quiet.label.style.display, 'none');
  for (const id of ['working', 'approval', 'error']) assert.equal(figures[scene.agentSeats.get(id)].label.style.display, 'flex');
  scene.focus('quiet'); scene.updateCamera(1, 0); scene.updateOverlays();
  assert.equal(quiet.label.style.display, 'flex');
  assert.equal(quiet.bubble.style.display, 'none');
  scene.focus(null); scene.updateOverlays();
  assert.equal(quiet.label.style.display, 'none');
  scene.setLabelsVisible(false); scene.setLabelsVisible(true);
  assert.equal(quiet.label.style.display, 'none', 'the global label toggle does not restore idle clutter');
});

test('front-facing cutaway walls and window frames stay separate from static batching at every camera side', (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  t.after(() => { globalThis.document = originalDocument; });
  const { scene } = fixture();
  scene.world = new THREE.Group();
  scene.scene = new THREE.Scene();
  scene.scene.add(scene.world, scene.effects);
  scene.materials = new Map();
  scene.buildRoom();
  const backChildren = [...scene.backWall.children];
  assert.ok(backChildren.length > 10, 'window frames belong to the same cutaway group as their wall');
  scene.batchStaticMeshes();
  assert.deepEqual(scene.backWall.children, backChildren);
  assert.equal(scene.backWall.parent === scene.world, true, 'batching keeps the back wall under the world');
  for (const [yaw, back, left] of [[.6, true, true], [Math.PI, false, true], [-Math.PI / 2, true, false], [-2.4, false, false]]) {
    scene.yaw = yaw;
    scene.updateCamera(1, 0);
    assert.equal(scene.backWall.visible, back);
    assert.equal(scene.leftWall.visible, left);
  }
  scene.scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  for (const material of scene.materials.values()) material.dispose();
});

test('power saving renders at 30fps and hidden or suspended views stop scheduling without fast-forwarding on return', (t) => {
  const originals = Object.fromEntries(['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(originals)) globalThis[key] = value; });
  globalThis.document = { hidden: false };
  globalThis.window = { devicePixelRatio: 2 };
  let requests = 0;
  const cancelled = [];
  globalThis.requestAnimationFrame = () => ++requests;
  globalThis.cancelAnimationFrame = id => cancelled.push(id);
  const { scene } = fixture();
  scene.animate = () => {};
  scene.syncRenderLoop = OfficeScene.prototype.syncRenderLoop;
  let renders = 0;
  let ratio = 0;
  scene.renderer.render = () => renders++;
  scene.renderer.setPixelRatio = value => { ratio = value; };
  scene.setPowerSaving(true);
  assert.equal(ratio, 1.25);
  scene.renderFrame(0);
  scene.renderFrame(16.7);
  assert.equal(renders, 1);
  scene.renderFrame(33.4);
  assert.equal(renders, 2);
  const beforeHidden = scene.elapsed;
  const lastRequest = scene.animationId;
  document.hidden = true;
  scene.syncRenderLoop();
  assert.equal(scene.animationId, 0);
  assert.ok(cancelled.includes(lastRequest));
  const requestCount = requests;
  scene.renderFrame(50000);
  assert.equal(requests, requestCount);
  assert.equal(scene.elapsed, beforeHidden);
  document.hidden = false;
  scene.syncRenderLoop();
  scene.renderFrame(50001);
  assert.ok(scene.elapsed - beforeHidden < .02, 'returning to the tab does not replay hidden time');
  scene.setSuspended(true);
  assert.equal(scene.animationId, 0);
  scene.setSuspended(false);
  assert.ok(scene.animationId > 0);
  scene.setPowerSaving(false);
  assert.equal(ratio, 2);
});

test('an initially hidden scene draws the current roster once without waiting for animation frames or advancing time', async t => {
  const originalDocument = globalThis.document, originalRequest = globalThis.requestAnimationFrame;
  t.after(() => { globalThis.document = originalDocument; globalThis.requestAnimationFrame = originalRequest; });
  globalThis.document = { hidden: true };
  let requests = 0;
  globalThis.requestAnimationFrame = () => ++requests;
  const { scene } = fixture();
  const renderedRosters = [];
  scene.renderer.render = () => renderedRosters.push([...scene.agentSeats.keys()]);
  scene.renderFrame(0);
  await Promise.resolve();
  assert.equal(renderedRosters.length, 1, 'initial hidden loading still paints a static canvas');
  assert.equal(scene.container.dataset.sceneReady, 'true');
  assert.equal(scene.container.dataset.animationState, 'hidden');
  assert.equal(scene.elapsed, 0);
  assert.equal(scene.lastFrameTime, null);
  assert.equal(requests, 0);
  scene.setAgents([agent('boss')]);
  scene.setAgents([agent('boss'), agent('latest-worker')]);
  scene.resize();
  await Promise.resolve();
  assert.equal(renderedRosters.length, 2, 'synchronous roster and surface changes coalesce into a single static frame');
  assert.deepEqual(renderedRosters.at(-1), ['boss', 'latest-worker']);
  assert.equal(scene.elapsed, 0);
  assert.equal(requests, 0);
  await Promise.resolve();
  assert.equal(renderedRosters.length, 2, 'a static frame never schedules a repeating render');
});

test('hidden surface resizing redraws once and visible return resumes with a fresh animation clock', async t => {
  const originals = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(originals)) globalThis[key] = value; });
  globalThis.document = { hidden: false };
  let requests = 0, renders = 0;
  globalThis.requestAnimationFrame = () => ++requests;
  globalThis.cancelAnimationFrame = () => {};
  const { scene } = fixture();
  scene.syncRenderLoop = OfficeScene.prototype.syncRenderLoop;
  scene.renderer.render = () => renders++;
  scene.setAgents([agent('boss'), agent('worker')]);
  scene.renderFrame(100);
  scene.sendPaperPlane('boss', 'worker', 'before-hidden');
  const flight = scene.paperFlights[0];
  const flightTime = flight.elapsed;
  const flightPosition = flight.plane.position.clone();
  const beforeHidden = scene.elapsed;
  document.hidden = true;
  scene.syncRenderLoop();
  scene.container.clientWidth = 640;
  scene.resize();
  await Promise.resolve();
  assert.equal(renders, 2);
  assert.equal(scene.elapsed, beforeHidden);
  assert.equal(flight.elapsed, flightTime);
  assert.ok(flight.plane.position.equals(flightPosition), 'a hidden still frame cannot advance an in-flight message');
  assert.equal(scene.animationId, 0);
  assert.equal(scene.camera.right / scene.camera.top, 640 / 800);
  const hiddenRequests = requests;
  document.hidden = false;
  scene.syncRenderLoop();
  assert.equal(requests, hiddenRequests + 1);
  scene.renderFrame(900_000);
  assert.ok(scene.elapsed - beforeHidden > 0 && scene.elapsed - beforeHidden < .02);
  assert.equal(renders, 3);
  document.hidden = true;
  scene.resize();
  scene.disposed = true;
  await Promise.resolve();
  assert.equal(renders, 3, 'a queued hidden redraw cannot render after disposal');
});

test('hidden still requests are skipped when the view resumes or is explicitly suspended before they run', async t => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; });
  globalThis.document = { hidden: true };
  const { scene } = fixture();
  let renders = 0;
  scene.renderer.render = () => renders++;
  scene.setAgents([agent('boss')]);
  document.hidden = false;
  await Promise.resolve();
  assert.equal(renders, 0, 'the resumed rAF loop owns the next visible frame');
  document.hidden = true;
  scene.resize();
  scene.suspended = true;
  await Promise.resolve();
  assert.equal(renders, 0, 'an explicitly suspended scene stays suspended');
  scene.setAgents([agent('boss'), agent('worker')]);
  await Promise.resolve();
  assert.equal(renders, 0);
});

function actualGeometryFixture(t, { canvas = false, context = () => ({ fillRect() {}, fillText() {} }) } = {}) {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: { setProperty(name, value) { this[name] = value; } }, dataset: {}, children: [],
    // Opting into a 2D context builds the real owner-sign and nameplate lettering planes and their CanvasTextures.
    getContext: canvas ? context : undefined,
    setAttribute() {}, append(...children) { this.children.push(...children); }, remove() {},
    querySelector(selector) { return selector.includes('first') ? this.children[0] : this.children.at(-1); } }) };
  t.after(() => { globalThis.document = originalDocument; });
  const { scene } = fixture();
  scene.world = new THREE.Group();
  scene.scene = new THREE.Scene();
  scene.scene.add(scene.world);
  scene.materials = new Map();
  scene.figures = [];
  scene.farFigures = null;
  scene.farDesks = null;
  scene.container.append = () => {};
  scene.ensureCapacity = OfficeScene.prototype.ensureCapacity;
  scene.buildRoom();
  t.after(() => {
    const geometries = new Set(scene.geometryCache.values());
    const materials = new Set(scene.materials.values());
    scene.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  });
  return scene;
}

test('a manually panned and zoomed camera keeps its actual projection when the live room grows or shrinks', t => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), agent('worker')]);
  scene.zoom(.4);
  scene.pan(100, -50);
  scene.updateCamera(1, 0);
  const target = scene.targetGoal.clone();
  const halfHeight = scene.camera.top;
  const cameraZoom = scene.cameraZoom;
  const workers = Array.from({ length: 30 }, (_, index) => agent(`extra-${index}`));
  for (const roster of [[agent('boss'), agent('worker'), ...workers], [agent('boss'), agent('worker')]]) {
    scene.setAgents(roster);
    scene.updateCamera(1, performance.now() + 60_000);
    assert.ok(scene.targetGoal.equals(target), 'live roster changes must not recenter a manual pan');
    assert.equal(scene.cameraZoom, cameraZoom);
    assert.ok(Math.abs(scene.camera.top - halfHeight) < 1e-8, 'the same zoom number must also retain the same world scale');
  }
  scene.focus(null);
  assert.ok(scene.targetGoal.equals(new THREE.Vector3(scene.bounds.centerX, .3, scene.bounds.centerZ)), 'an explicit shot can frame the current room again');
});

test('building roster changes retain a manual view after its old motion hold expires', () => {
  const { scene } = fixture();
  scene.building = { radius: 25, center: new THREE.Vector3(), setFloors() { this.radius = 80; this.center.y = 20; },
    focusPoint() { return this.center.clone(); }, show() {} };
  scene.setBuildingView(true);
  scene.updateCamera(2.6, 0);
  scene.orbit(30, 10);
  scene.motion.heldUntilMs = 0;
  const target = scene.targetGoal.clone(), halfHeight = scene.camera.top;
  scene.setBuildingFloors([]);
  assert.ok(scene.targetGoal.equals(target), 'even unzoomed manual rotation protects the selected building center');
  assert.equal(scene.camera.top, halfHeight);
  scene.resetCamera(); scene.updateCamera(1, 0);
  assert.ok(scene.targetGoal.equals(scene.building.center));
  assert.notEqual(scene.camera.top, halfHeight, 'explicit reset fits the new building size');
});

test('hidden real characters stay absent at near and distant detail levels while their monitors and seats remain', t => {
  const scene = actualGeometryFixture(t);
  const workers = Array.from({ length: 35 }, (_, index) => ({ ...agent(`worker-${index}`), showCharacter: true }));
  scene.setAgents([agent('boss'), ...workers]);
  const figure = scene.figures[scene.agentSeats.get('worker-34')];
  const deskCount = scene.fixtureRows.size;
  scene.setAgents([agent('boss'), ...workers.map(worker => ({ ...worker, status: 'idle', showCharacter: false }))]);
  for (const halfHeight of [10, 120]) {
    scene.camera.top = halfHeight; scene.camera.bottom = -halfHeight;
    scene.updateDetailLevels();
    assert.equal(figure.group.visible, false);
    assert.equal(figure.detail.visible, false);
    const matrix = new THREE.Matrix4();
    scene.farFigures.getMatrixAt(figure.seat, matrix);
    assert.equal(matrix.determinant(), 0, 'distant instances must disappear too');
    assert.equal(scene.fixtureRows.size, deskCount);
  }
  scene.camera.top = 10; scene.camera.bottom = -10; scene.updateDetailLevels();
  assert.equal(figure.screen.visible, true, 'an inactive desk still has a monitor');
  assert.equal(scene.sendMessagePlane(figure.id, 'ended-turn'), true);
  scene.setAgents([agent('boss'), ...workers]);
  scene.focusId = figure.id; scene.updateDetailLevels();
  assert.equal(scene.figures[scene.agentSeats.get(figure.id)] === figure, true, 'the hidden worker returns in the same figure');
  assert.equal(figure.group.visible, true); assert.equal(figure.detail.visible, true);
});

test('quiet retained seats do not downgrade the few visible employees or hide their names', t => {
  const scene = actualGeometryFixture(t);
  const workers = Array.from({ length: 35 }, (_, index) => ({ ...agent(`worker-${index}`),
    status: index ? 'idle' : 'working', showCharacter: index === 0 }));
  scene.setAgents([agent('boss'), ...workers]);
  const figure = scene.figures[scene.agentSeats.get('worker-0')];
  const count = scene.figures.length, desks = scene.fixtureRows.size;
  scene.camera.top = 80; scene.camera.bottom = -80;
  scene.updateDetailLevels();
  assert.equal(figure.detail.visible, true, 'detail budget counts the two visible characters, not 36 retained seats');
  scene.updateCamera(1, 0); scene.world.updateMatrixWorld(true); scene.updateOverlays();
  assert.equal(figure.label.style.display, 'flex');
  assert.equal(scene.figures.length, count); assert.equal(scene.fixtureRows.size, desks);
  scene.setAgents([agent('boss'), ...workers.map(worker => ({ ...worker, status: 'working', showCharacter: true }))]);
  scene.updateDetailLevels();
  assert.equal(figure.detail.visible, false, 'crowded active offices still use the existing bounded LOD');
});

test('real geometry grows through 1, 6, 12, 30 and 60 people, preserving desks and reusing them after shrink', (t) => {
  const scene = actualGeometryFixture(t);
  const identities = new Map();
  for (const count of [1, 6, 12, 30, 60]) {
    const roster = [agent('boss'), ...Array.from({ length: count - 1 }, (_, i) => agent(`live-${i}`))];
    scene.setAgents(roster);
    scene.updateAnimation(.1);
    assert.equal(scene.agentSeats.size, count);
    assert.equal(scene.figures.length, count);
    assert.equal(scene.figures.filter(figure => figure.group.visible).length, count);
    assert.equal(new Set([...scene.agentSeats.values()]).size, count);
    for (const entry of roster) {
      const figure = scene.figures[scene.agentSeats.get(entry.id)];
      assert.ok(figure.group.getObjectByName('employee-hand') instanceof THREE.Mesh);
      assert.ok(figure.screen instanceof THREE.Mesh);
      assert.ok(figure.origin.x >= scene.bounds.minX && figure.origin.x <= scene.bounds.maxX);
      assert.ok(figure.origin.z >= scene.bounds.minZ && figure.origin.z <= scene.bounds.maxZ);
      if (identities.has(entry.id)) assert.equal(figure.group.uuid, identities.get(entry.id));
      else identities.set(entry.id, figure.group.uuid);
    }
  }
  assert.ok(scene.bounds.depth > 60, 'the floor extends beyond the original room');
  const sixtyDesks = scene.fixtureRows.size;
  const originalOwner = scene.figures[0].group.uuid;
  for (let i = 0; i < 4; i++) scene.setAgents([agent('boss')]);
  assert.equal(scene.figures.length, 1);
  assert.ok(scene.fixtureRows.size < sixtyDesks, 'empty desk rows are removed immediately');
  assert.equal(scene.fixtureRows.size, 1);
  scene.setAgents([agent('boss'), ...Array.from({ length: 59 }, (_, i) => agent(`live-${i}`))]);
  assert.equal(scene.figures[0].group.uuid, originalOwner, 'the surviving owner keeps their identity across shrink and regrowth');
  scene.resetCamera();
  scene.updateCamera(1, 0);
  scene.camera.updateMatrixWorld(true);
  for (const figure of scene.figures) {
    const projected = figure.origin.clone().project(scene.camera);
    assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1, 'reset fits every desk on the expanded floor');
  }
  scene.updateDetailLevels();
  assert.equal(scene.farFigures.count, 60);
  const far = scene.figures[59];
  scene.focus(far.id);
  scene.updateCamera(1, 0);
  scene.updateDetailLevels();
  assert.equal(far.detail.visible, true, 'a distant employee restores the complete animated body when focused');
  const boss = scene.figures[0];
  boss.group.updateMatrixWorld(true);
  const head = boss.head.getWorldPosition(new THREE.Vector3());
  const eye = boss.group.getObjectByName('employee-eye-left').getWorldPosition(new THREE.Vector3());
  assert.ok(eye.z > head.z + .3, 'the owner faces the reception area on the positive Z side');
  assert.equal(scene.fixtureRows.get(-1).rotation.y, Math.PI, 'the owner desk and chair turn together');
  assert.ok(boss.origin.x < scene.figures[1].origin.x - 8, 'the owner is in a separate wing');
});

test('512 observed employees plus the owner receive unique persistent seat identities', () => {
  const { scene } = fixture();
  const roster = [agent('boss'), ...Array.from({ length: 512 }, (_, i) => agent(`worker-${i}`))];
  scene.setAgents(roster);
  assert.equal(scene.agentSeats.size, 513);
  assert.equal(new Set(scene.agentSeats.values()).size, 513);
  assert.equal(scene.agentSeats.get('boss'), 0);
  const positions = new Set([...scene.agentSeats.values()].map(index => JSON.stringify(seatPosition(index))));
  assert.equal(positions.size, 513);
});

test('cinematic focus interpolates the center and effective zoom for 2.6 seconds without an initial jump', () => {
  const { scene } = fixture();
  scene.setAgents([agent('boss'), agent('worker')]);
  scene.resize();
  const span = scene.camera.top - scene.camera.bottom;
  const originalTarget = scene.cameraTarget.clone();
  scene.focus('worker', { cinematic: true, zoom: 1.65 });
  assert.equal(scene.cameraZoom, 1);
  assert.equal(scene.camera.top - scene.camera.bottom, span);
  assert.ok(scene.cameraTarget.equals(originalTarget));
  for (let i = 0; i < 13; i++) scene.updateCamera(.1, 0);
  assert.ok(scene.cameraZoom > 1.25 && scene.cameraZoom < 1.4);
  assert.ok(scene.cameraTarget.distanceTo(scene.targetGoal) > .01);
  for (let i = 0; i < 14; i++) scene.updateCamera(.1, 0);
  assert.equal(scene.cameraZoom, 1.65);
  assert.equal(scene.cinematic, false);
  assert.ok(scene.cameraTarget.distanceTo(scene.targetGoal) < .001);
  scene.focus('boss', { cinematic: true, zoom: 1.5 });
  scene.updateCamera(.1, 0);
  scene.orbit(30, 0);
  const interruptedZoom = scene.cameraZoom;
  scene.updateCamera(1, 0);
  assert.equal(scene.cameraZoom, interruptedZoom, 'manual control cancels the remaining camera transition');
  scene.focus('boss', { cinematic: true, zoom: 1.5 });
  scene.setReducedMotion(true);
  assert.equal(scene.cinematic, false);
  assert.equal(scene.cameraZoom, 1.5);
  assert.ok(scene.cameraTarget.equals(scene.targetGoal), 'reduced motion settles a running transition immediately');
  scene.setReducedMotion(false);
  scene.stopFollowing();
  assert.equal(scene.following, false);
  assert.equal(scene.cameraZoom, 1.5, 'turning off the director preserves the current framing');
});

test('approval visitors walk to reception, wait for an actual resolution, and return without blocking their next work', (t) => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const { scene, figures } = fixture();
  scene.setAgents([agent('boss'), { ...agent('worker'), status: 'approval' }]);
  const employee = figures[scene.agentSeats.get('worker')];
  for (let frame = 0; scene.approvalVisits.get('worker')?.stage !== 'waiting' && frame < 500; frame++) scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.get('worker').stage, 'waiting');
  const waiting = employee.group.position.clone();
  for (let frame = 0; frame < 100; frame++) scene.updateAnimation(.1);
  assert.ok(employee.group.position.equals(waiting), 'time alone cannot resolve an approval');
  assert.equal(employee.label.dataset.confirmed, undefined);
  assert.equal(employee.leftKnee.rotation.x, 0);
  scene.resolveApproval('worker');
  assert.equal(employee.label.dataset.confirmed, 'true');
  assert.equal(scene.approvalVisits.get('worker').stage, 'return');
  for (let frame = 0; scene.approvalVisits.size && frame < 500; frame++) scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.size, 0);
  assert.ok(employee.group.position.equals(employee.origin));
  assert.equal(employee.leftKnee.rotation.x, Math.PI / 2);
  scene.setAgents([agent('boss'), agent('worker')]);
  const angle = employee.leftArm.rotation.x;
  scene.updateAnimation(.2);
  assert.notEqual(employee.leftArm.rotation.x, angle);
});

test('approval queues have distinct waiting positions; status changes and retirement release the visitor without an invented stamp', () => {
  const { scene } = fixture();
  const roster = [agent('boss'), ...Array.from({ length: 12 }, (_, i) => ({ ...agent(`approval-${i}`), status: 'approval' }))];
  scene.setAgents(roster);
  assert.equal(scene.approvalVisits.size, 9);
  assert.equal(new Set([...scene.approvalVisits.values()].map(visit => visit.slot)).size, 9);
  assert.equal(scene.approvalRequests.size, 12);
  const visitor = scene.approvalVisits.get('approval-0').figure;
  scene.updateAnimation(.1);
  const before = visitor.group.position.clone();
  scene.setAgents(roster.map(entry => entry.id === 'approval-0' ? { ...entry, status: 'working' } : entry));
  assert.equal(scene.approvalVisits.get('approval-0').stage, 'return');
  assert.ok(visitor.group.position.equals(before), 'changing status in transit does not teleport the employee');
  assert.equal(visitor.label.dataset.confirmed, undefined);
  scene.setAgents(roster.filter(entry => entry.id !== 'approval-0'));
  assert.equal(scene.approvalVisits.has('approval-0'), false);
  assert.equal(scene.approvalRequests.has('approval-0'), false);
  assert.equal(visitor.group.visible, false);
  scene.setAgents([]);
  assert.equal(scene.approvalVisits.size, 0);
  assert.equal(scene.approvalRequests.size, 0);
});

test('the actual owner holds a stamp and makes a short downward arm stroke only after approval.resolved', (t) => {
  const scene = actualGeometryFixture(t);
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('visitor'), status: 'approval' }]);
  const boss = scene.figures[0];
  assert.ok(boss.approvalStamp.getObjectByName('owner-approval-stamp') instanceof THREE.Group);
  for (let i = 0; i < 60; i++) scene.updateAnimation(.1);
  assert.equal(boss.approvalStamp.visible, false, 'a pending question does not produce an approval gesture');
  scene.resolveApproval('visitor');
  const heights = [];
  const angles = [];
  for (let i = 0; i < 8; i++) {
    scene.updateAnimation(.1);
    scene.world.updateMatrixWorld(true);
    heights.push(boss.approvalStamp.children[1].getWorldPosition(new THREE.Vector3()).y);
    angles.push(boss.rightArm.rotation.x);
    assert.equal(boss.approvalStamp.visible, true);
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > .07, 'the stamp itself moves vertically over the owner desk');
  assert.ok(Math.max(...angles) - Math.min(...angles) > .3);
  for (let i = 0; i < 20; i++) scene.updateAnimation(.1);
  assert.equal(boss.approvalStamp.visible, false, 'the owner returns to their normal pose after the gesture');
});

test('the full 512-worker geometry can switch from instanced overview to an animated individual close-up', (t) => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), ...Array.from({ length: 512 }, (_, i) => agent(`large-${i}`))]);
  scene.updateAnimation(.1);
  scene.resetCamera();
  scene.updateCamera(1, 0);
  scene.updateDetailLevels();
  assert.equal(scene.figures.length, 513);
  assert.equal(scene.farFigures.count, 513);
  assert.equal(scene.farDesks.count, 513);
  scene.updateOverlays();
  const readableBubbles = scene.figures.filter(figure => figure.bubble.style.display === 'block');
  assert.ok(readableBubbles.length > 0 && readableBubbles.length < 513, 'distant activity remains readable without stacking 513 text boxes');
  assert.ok(readableBubbles.every(figure => figure.bubble.dataset.compact === 'true'));
  assert.equal([...scene.fixtureRows.values()].filter(row => row.visible).length, 0, 'tiny desks use a shared draw instance at building scale');
  const worker = scene.figures[512];
  assert.equal(worker.detail.visible, false);
  scene.focus(worker.id, { zoom: 2.4 });
  scene.updateCamera(1, 0);
  scene.updateDetailLevels();
  assert.equal(worker.detail.visible, true);
  scene.updateOverlays();
  assert.equal(worker.bubble.style.display, 'block');
  assert.equal(worker.bubble.dataset.compact, 'false');
  assert.ok(worker.group.getObjectByName('employee-hand') instanceof THREE.Mesh);
  assert.equal(scene.farFigures.boundingSphere, null, 'picking bounds are refreshed after instances move or grow');
});

test('observed activity bubbles follow the real walking head while name and activity toggles remain independent', () => {
  const { scene, figures } = fixture();
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('worker'), task: 'src/app.ts 입력 검증 수정', toolName: 'Edit' }]);
  scene.updateAnimation(.1);
  scene.focus('worker'); scene.updateCamera(1, 0); scene.stopFollowing(); scene.updateOverlays();
  const employee = figures[scene.agentSeats.get('worker')];
  assert.equal(employee.bubble.style.display, 'block');
  assert.equal(employee.bubbleContent.textContent, 'src/app.ts 입력 검증 수정');
  const original = employee.bubble.style.transform;
  scene.deliver('worker', 'boss'); scene.updateAnimation(.2); scene.updateOverlays();
  assert.notEqual(employee.bubble.style.transform, original, 'a moving courier carries the text with their head');
  assert.equal(employee.bubbleContent.textContent, 'src/app.ts 입력 검증 수정', 'a cosmetic delivery does not invent an observed activity');
  scene.setActivityBubblesVisible(false); scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'none');
  assert.equal(employee.label.style.display, 'flex');
  scene.setLabelsVisible(false); scene.setActivityBubblesVisible(true); scene.updateOverlays();
  assert.equal(employee.label.style.display, 'none');
  assert.equal(employee.bubble.style.display, 'block');
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('worker'), status: 'idle', task: '오래된 수정 작업', toolName: 'Edit' }]);
  scene.updateOverlays();
  assert.equal(employee.bubbleContent.textContent, '');
  assert.equal(employee.bubble.style.display, 'none', 'idle employees do not consume a speech balloon');
  assert.equal(scene.visibleBubbles.has('worker'), false);
  scene.setLabelsVisible(true);
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('worker'), status: 'waiting' }]);
  scene.focus('worker'); scene.updateCamera(1, 0); scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'none', 'selection does not bring back a waiting bubble');
  assert.equal(employee.label.style.display, 'flex', 'an idle employee can still be identified');
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('worker'), status: 'approval', task: '' }]);
  scene.updateOverlays();
  assert.equal(employee.bubbleContent.textContent, '확인 요청');
  assert.equal(employee.bubble.style.display, 'block', 'actionable approval waiting stays visible');
  scene.setAgents([agent('boss')]); scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'none');
  assert.equal(scene.visibleBubbles.has('worker'), false);
});

test('activity and name overlays hide outside the viewport and behind the camera', () => {
  const { scene, figures } = fixture();
  scene.setAgents([{ ...agent('worker'), task: 'Read 결과 수신' }]);
  scene.updateAnimation(.1); scene.focus('worker'); scene.updateCamera(1, 0); scene.updateOverlays();
  const employee = figures[scene.agentSeats.get('worker')];
  assert.equal(employee.bubble.style.display, 'block');
  const forward = scene.camera.getWorldDirection(new THREE.Vector3());
  employee.group.position.copy(scene.camera.position).addScaledVector(forward, -5);
  scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'none');
  assert.equal(employee.label.style.display, 'none');
  employee.group.position.set(10000, 0, 10000); scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'none');
  employee.group.position.copy(employee.origin); scene.updateOverlays();
  assert.equal(employee.bubble.style.display, 'block');
});

test('selected employees keep the readable bubble when projected heads overlap', () => {
  const { scene, figures } = fixture();
  scene.setAgents([{ ...agent('one'), task: 'Read 실행 중' }, { ...agent('two'), task: 'Edit 실행 중' }]);
  scene.updateAnimation(.1);
  const first = figures[scene.agentSeats.get('one')], second = figures[scene.agentSeats.get('two')];
  second.group.position.copy(first.group.position);
  scene.focus('two'); scene.updateCamera(1, 0); scene.updateOverlays();
  assert.equal(second.bubble.style.display, 'block');
  assert.equal(second.bubble.dataset.selected, 'true');
  assert.equal(first.bubble.style.display, 'none');
});

test('the real bubble DOM keeps metadata as inert text and does not intercept agent selection', (t) => {
  const scene = actualGeometryFixture(t);
  const task = '<img src=x onerror=alert(1)>';
  scene.setAgents([{ ...agent('worker'), task }]);
  scene.updateAnimation(.1); scene.focus('worker'); scene.updateCamera(1, 0); scene.updateOverlays();
  const employee = scene.figures[scene.agentSeats.get('worker')];
  assert.equal(employee.bubble.className, 'office-activity-bubble');
  assert.equal(employee.bubble.style.pointerEvents, 'none');
  assert.equal(employee.bubble.children.length, 1);
  assert.equal(employee.bubbleContent.textContent, task);
  assert.equal(employee.bubble.innerHTML, undefined);
  assert.equal(employee.bubbleContent.innerHTML, undefined);
  assert.equal(employee.group.visible, true);
});

test('observed handoff planes leave and arrive at the actual rotated computers while employees stay independent', (t) => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), agent('sender'), agent('receiver')]);
  const sender = scene.figures[scene.agentSeats.get('sender')];
  const recipient = scene.figures[scene.agentSeats.get('boss')];
  sender.group.position.x += 2;
  const start = sender.screen.getWorldPosition(new THREE.Vector3());
  const end = recipient.screen.getWorldPosition(new THREE.Vector3());
  assert.equal(scene.sendPaperPlane('sender', 'boss', 'observed-handoff-1'), true);
  const flight = scene.paperFlights[0];
  assert.ok(flight.plane.position.distanceTo(start) < 1e-8);
  assert.ok(flight.curve.getPoint(1).distanceTo(end) < 1e-8);
  assert.ok(flight.curve.getTangent(0).z > .9, 'the employee screen emits outward toward world +Z');
  assert.ok(flight.curve.getTangent(1).z > .9, 'the rotated owner screen receives from world -Z');
  assert.ok(flight.curve.getPoint(.5).y > start.y + .8, 'the route visibly arches above desks');
  assert.equal(scene.deliveries.length, 0, 'a computer handoff does not invent a walking document courier');
  assert.equal(scene.approvalVisits.size, 0);
  const original = flight.plane.quaternion.clone();
  const planeGeometry = flight.plane.geometry;
  scene.setAgents([agent('boss'), agent('sender'), agent('receiver'), ...Array.from({ length: 8 }, (_, index) => agent(`new-${index}`))]);
  assert.equal(flight.plane.parent === scene.effects, true, 'office expansion cannot batch an animated plane into static furniture');
  assert.equal(flight.plane.geometry === planeGeometry, true, 'the flying plane keeps its own geometry');
  scene.updateAnimation(.2);
  assert.ok(flight.plane.position.distanceTo(start) > .05);
  assert.ok(flight.plane.quaternion.angleTo(original) > .02);
  assert.ok(flight.plane.getWorldDirection(new THREE.Vector3()).dot(flight.curve.getTangent(flight.elapsed / flight.duration)) > .999);
  while (flight.elapsed < flight.duration) scene.updateAnimation(.1);
  assert.ok(flight.plane.position.distanceTo(end) < 1e-8);
  assert.equal(flight.plane.visible, false);
  assert.equal(flight.arrival.visible, true);
  const disposed = [];
  flight.plane.geometry.addEventListener('dispose', () => disposed.push('plane'));
  flight.arrival.geometry.addEventListener('dispose', () => disposed.push('arrival'));
  let disposedMaterials = 0;
  for (const material of [...flight.plane.material, flight.arrival.material]) material.addEventListener('dispose', () => disposedMaterials++);
  for (let frame = 0; frame < 10; frame++) scene.updateAnimation(.1);
  assert.deepEqual(disposed.sort(), ['arrival', 'plane']);
  assert.equal(disposedMaterials, 4);
  assert.equal(scene.paperFlights.length, 0);
  assert.equal(scene.effects.children.length, 0);
  assert.equal(scene.sendPaperPlane('sender', 'boss', 'observed-handoff-1'), false, 'replayed events stay deduplicated after arrival');
});

test('paper flights reject phantom endpoints and duplicates, and retiring or replacing either endpoint clears the effect', () => {
  const { scene } = fixture();
  scene.setAgents([agent('sender'), agent('receiver')]);
  assert.equal(scene.sendPaperPlane('sender', 'missing', 'missing'), false);
  assert.equal(scene.sendPaperPlane('sender', 'sender', 'self'), false);
  assert.equal(scene.sendPaperPlane('sender', 'receiver', 'event-1'), true);
  assert.equal(scene.sendPaperPlane('sender', 'receiver', 'event-1'), false);
  assert.equal(scene.sendPaperPlane('sender', 'receiver'), false, 'unidentified repeated calls cannot duplicate an active route');
  scene.setAgents([agent('sender'), agent('replacement')]);
  assert.equal(scene.paperFlights.length, 0);
  assert.equal(scene.effects.children.length, 0);
  assert.equal(scene.sendPaperPlane('sender', 'receiver', 'event-2'), false);
  assert.equal(scene.sendPaperPlane('sender', 'replacement', 'event-2'), true, 'unrenderable calls did not consume the event identity');
  scene.setAgents([]);
  assert.equal(scene.paperFlights.length, 0);
  assert.equal(scene.effects.children.length, 0);
});

test('paper flights pause without advancing and reduced motion uses only a brief static computer receipt', () => {
  const { scene } = fixture();
  scene.setAgents([agent('sender'), agent('receiver')]);
  scene.sendPaperPlane('sender', 'receiver', 'event-1');
  const flight = scene.paperFlights[0];
  scene.updateAnimation(.2);
  scene.setPaused(true);
  const position = flight.plane.position.clone();
  const time = flight.elapsed;
  scene.updateAnimation(.2);
  assert.equal(flight.elapsed, time);
  assert.ok(flight.plane.position.equals(position));
  scene.setReducedMotion(true);
  assert.equal(flight.plane.visible, false);
  assert.equal(flight.arrival.visible, true);
  scene.setPaused(false);
  scene.updateAnimation(.2);
  assert.deepEqual(flight.arrival.scale.toArray(), [1, 1, 1]);
  for (let frame = 0; frame < 8; frame++) scene.updateAnimation(.1);
  assert.equal(scene.paperFlights.length, 0);
  scene.sendPaperPlane('sender', 'receiver', 'event-2');
  assert.equal(scene.paperFlights[0].plane.visible, false);
  assert.equal(scene.paperFlights[0].arrival.visible, true);
  scene.setAgents([]);
});

test('a burst is limited to 32 observed flights without adding imaginary communication or retaining retired effects', () => {
  const { scene } = fixture();
  scene.setAgents([agent('sender'), agent('receiver')]);
  for (let event = 0; event < 32; event++) assert.equal(scene.sendPaperPlane('sender', 'receiver', `burst-${event}`), true);
  assert.equal(scene.sendPaperPlane('sender', 'receiver', 'over-capacity'), false);
  assert.equal(scene.paperFlights.length, 32);
  assert.equal(scene.queued.length, 0);
  assert.equal(scene.effects.children.length, 64);
  scene.setAgents([]);
  assert.equal(scene.effects.children.length, 0);
  assert.equal(scene.paperFlights.length, 0);
});

test('idle yawns are individually scheduled, cover the real mouth, tilt the head back and restore the seated pose', (t) => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([{ id: 'worker-a', status: 'idle' }, { id: 'worker-b', status: 'waiting' }]);
  const worker = scene.figures[scene.agentSeats.get('worker-a')];
  const other = scene.figures[scene.agentSeats.get('worker-b')];
  assert.notEqual(worker.nextYawnAt, other.nextYawnAt);
  assert.equal(worker.nextYawnAt, idleYawnDelay('worker-a'));
  const due = worker.nextYawnAt;
  for (let i = 0; i < 10; i++) scene.setAgents([{ id: 'worker-a', status: 'idle' }, { id: 'worker-b', status: 'waiting' }]);
  assert.equal(worker.nextYawnAt, due, 'polling does not restart the idle timer');
  scene.elapsed = due;
  scene.updateAnimation(.01);
  const began = worker.yawnStartedAt;
  assert.notEqual(began, null);
  for (let frame = 0; frame < 12; frame++) scene.updateAnimation(.1);
  scene.world.updateMatrixWorld(true);
  const hand = worker.rightArm.getObjectByName('employee-hand').getWorldPosition(new THREE.Vector3());
  const mouth = worker.yawnMouth.getWorldPosition(new THREE.Vector3());
  assert.ok(hand.distanceTo(mouth) < .16, `the covering hand meets the real mouth: distance=${hand.distanceTo(mouth)}`);
  assert.ok(worker.head.rotation.x < -.2);
  assert.equal(worker.yawnMouth.visible, true);
  assert.equal(worker.smile.visible, false);
  assert.ok(worker.eyes.every(eye => eye.scale.y < .2));
  assert.equal(worker.status, 'idle', 'cosmetic yawning does not invent an observed work status');
  while (scene.elapsed - began < YAWN_DURATION + .1) scene.updateAnimation(.1);
  assert.equal(worker.yawnStartedAt, null);
  assert.equal(worker.yawnMouth.visible, false);
  assert.equal(worker.smile.visible, true);
  assert.deepEqual(worker.rightArm.position.toArray(), [.34, 1.4, .01]);
  assert.equal(worker.head.rotation.x, 0);
  assert.equal(worker.leftLeg.rotation.x, -Math.PI / 2);
  assert.ok(worker.nextYawnAt > scene.elapsed + 20, 'another yawn cannot start immediately');
});

test('working, thinking, approval visits and document delivery immediately cancel an idle yawn', () => {
  for (const transition of ['working', 'thinking', 'reviewing', 'approval', 'error', 'visit', 'delivery']) {
    const { scene, figures } = fixture();
    const roster = [agent('boss'), { id: 'worker', status: 'idle' }];
    scene.setAgents(roster);
    const worker = figures[scene.agentSeats.get('worker')];
    scene.elapsed = worker.nextYawnAt;
    scene.updateAnimation(.01);
    for (let frame = 0; frame < 10; frame++) scene.updateAnimation(.1);
    assert.notEqual(worker.yawnStartedAt, null);
    if (transition === 'visit') scene.requestApproval('worker');
    else if (transition === 'delivery') scene.deliver('worker', 'boss');
    else scene.setAgents([agent('boss'), { id: 'worker', status: transition }]);
    assert.equal(worker.yawnStartedAt, null, transition);
    assert.equal(worker.head.rotation.x, 0, transition);
    assert.deepEqual(worker.rightArm.position.toArray(), [.34, 1.4, .01], transition);
    scene.updateAnimation(.1);
    assert.equal(worker.yawnStartedAt, null, transition);
  }
});

test('pause freezes a yawn and reduced motion cancels it without changing the observed idle status', () => {
  const { scene, figures } = fixture();
  scene.setAgents([{ id: 'worker', status: 'waiting' }]);
  const worker = figures[scene.agentSeats.get('worker')];
  scene.elapsed = worker.nextYawnAt;
  scene.updateAnimation(.01);
  scene.updateAnimation(.25);
  scene.setPaused(true);
  const pose = [worker.head.rotation.x, worker.rightArm.rotation.x, ...worker.rightArm.position.toArray()];
  scene.updateAnimation(.25);
  assert.deepEqual([worker.head.rotation.x, worker.rightArm.rotation.x, ...worker.rightArm.position.toArray()], pose);
  scene.setReducedMotion(true);
  assert.equal(worker.yawnStartedAt, null);
  assert.equal(worker.head.rotation.x, 0);
  scene.setPaused(false);
  scene.elapsed += 80;
  scene.updateAnimation(.1);
  assert.equal(worker.yawnStartedAt, null);
  assert.equal(worker.status, 'waiting');
});

// Live office shrinking: exercise the rendered room and desks, not just the roster count.
test('100 indoor workers shrink to two and then zero desks while the owner office remains', t => {
  const scene = actualGeometryFixture(t);
  const workers = Array.from({ length: 100 }, (_, index) => agent(`active-${index}`));
  let previousBounds;
  for (const roster of [workers, workers.slice(-2), []]) {
    scene.setAgents([agent('boss'), ...roster]);
    const capacity = roster.length + 1;
    assert.equal(scene.figures.length, capacity);
    assert.equal(scene.container.dataset.capacity, String(capacity));
    assert.equal(scene.fixtureRows.size, Math.ceil(roster.length / 5) + 1);
    assert.equal(scene.farDesks.count, capacity);
    const screens = [];
    scene.world.traverse(object => { if (/^screen-\d+$/.test(object.name)) screens.push(object); });
    assert.equal(screens.length, capacity, 'empty desks and monitors are removed from the real scene graph');
    assert.ok(scene.world.getObjectByName('desk-top-0'), 'the owner desk survives zero active workers');
    assert.deepEqual(scene.bounds, officeBounds(capacity));
    const shell = new THREE.Box3().setFromObject(scene.roomShell);
    // Rounded slab edges extend slightly beyond the logical floor rectangle.
    assert.ok(Math.abs(shell.min.x - scene.bounds.minX) < .08);
    assert.ok(Math.abs(shell.max.x - scene.bounds.maxX) < .08);
    assert.ok(Math.abs(shell.min.z - scene.bounds.minZ) < .08);
    assert.ok(Math.abs(shell.max.z - scene.bounds.maxZ) < .08);
    if (previousBounds) {
      assert.ok(scene.bounds.width < previousBounds.width);
      assert.ok(scene.bounds.depth <= previousBounds.depth);
    }
    previousBounds = { ...scene.bounds };
  }
  scene.setAgents([agent('boss'), ...workers.slice(-2)]);
  assert.equal(scene.figures.length, 3);
  assert.equal(scene.agentSeats.get('active-99'), 2);
  assert.equal(scene.world.getObjectByName('screen-3') === undefined, true, 'the vacated monitor is removed');
});

test('shrinking past a manually viewed rear seat recenters only the pan while preserving its zoom and direction', t => {
  const scene = actualGeometryFixture(t);
  const workers = Array.from({ length: 100 }, (_, index) => agent(`rear-${index}`));
  scene.setAgents([agent('boss'), ...workers]);
  scene.focus('rear-99'); scene.updateCamera(3, 0);
  scene.stopFollowing(); scene.pan(1, 0); scene.updateCamera(1, 0);
  const previousTarget = scene.targetGoal.clone();
  const view = [scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation];
  assert.ok(previousTarget.z > officeBounds(3).maxZ);
  scene.setAgents([agent('boss'), ...workers.slice(-2)]);
  assert.deepEqual(scene.targetGoal.toArray(), [(seatPosition(1).x + seatPosition(2).x) / 2, .3, seatPosition(1).z]);
  scene.updateCamera(1, 0);
  assert.deepEqual([scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation], view);
  assert.equal(scene.autoRotate, false);
  assert.equal(scene.following, false);
  scene.scene.updateMatrixWorld(true);
  const projected = workers.slice(-2).map(worker => scene.figures[scene.agentSeats.get(worker.id)]
    .group.getWorldPosition(new THREE.Vector3()).project(scene.camera));
  assert.ok(projected.every(point => Math.abs(point.x) < 1 && Math.abs(point.y) < 1), 'the camera returns to the remaining workers without overriding a close zoom');
  // Decision 16: the owner-only room keeps the reserved first desk column (x up to 3.6), so a pan still over that floor is kept.
  scene.setAgents([agent('boss')]); scene.updateCamera(1, 0);
  assert.deepEqual(scene.targetGoal.toArray(), [(seatPosition(1).x + seatPosition(2).x) / 2, .3, seatPosition(1).z]);
  assert.deepEqual([scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation], view);
  // A pan left over the removed second desk column still recenters on the owner-only room.
  scene.setAgents([agent('boss'), ...workers.slice(-2)]);
  scene.targetGoal.set(seatPosition(2).x, .3, seatPosition(2).z);
  assert.ok(scene.targetGoal.x > officeBounds(1).maxX);
  scene.setAgents([agent('boss')]); scene.updateCamera(1, 0);
  assert.deepEqual(scene.targetGoal.toArray(), [scene.bounds.centerX, .3, scene.bounds.centerZ]);
  assert.deepEqual([scene.cameraZoom, scene.camera.top, scene.yaw, scene.elevation], view);
});

// Local shapes, sizes, colors and attachment point of every look part; independent of seat and resource identity.
const lookSignature = figure => figure.look.parts.map(part => {
  const where = part.parent === figure.head ? 'head' : part.parent === figure.leftArm ? 'wrist' : part.parent === figure.detail ? 'body' : 'detached';
  const meshes = [];
  part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    meshes.push([object.geometry.type, object.geometry.attributes.position.count, ...object.position.toArray(),
      ...object.scale.toArray(), ...object.rotation.toArray().slice(0, 3)]
      .map(value => typeof value === 'number' ? value.toFixed(3) : value).join('/') + `#${material.color.getHexString()}`);
  });
  return `${where}:${meshes.join(',')}`;
}).join(';');

test('each person keeps one look through seat compaction, re-entry and reuse of a departed person\'s figure', t => {
  const scene = actualGeometryFixture(t);
  const byVariation = new Map();
  for (let i = 0; byVariation.size < 6; i++) {
    const id = `look-${i}`, variation = appearanceFor(id).variation;
    if (!byVariation.has(variation)) byVariation.set(variation, id);
  }
  const ids = [...byVariation.values()];
  const figureOf = id => scene.figures[scene.agentSeats.get(id)];
  const signatures = new Map();
  const expectLook = id => {
    const figure = figureOf(id), appearance = appearanceFor(id);
    assert.equal(figure.look.agentId, id);
    assert.equal(figure.look.key, appearanceKey(appearance));
    const skin = new THREE.Color(appearance.skin).getHexString(), hair = new THREE.Color(appearance.hair).getHexString();
    assert.ok(figure.look.skin.length >= 10 && figure.look.skin.every(mesh => mesh.material.color.getHexString() === skin), `${id} skin`);
    assert.ok(figure.look.hair.length === 2 && figure.look.hair.every(mesh => mesh.material.color.getHexString() === hair), `${id} brows`);
    assert.equal(Boolean(figure.ponytail), appearance.headwear === 'ponytail');
    assert.equal(Boolean(figure.watchFace), appearance.outfit === 'vest-watch');
    const signature = lookSignature(figure);
    assert.ok(!signature.includes('detached'), 'every look part stays attached inside the detail LOD');
    if (signatures.has(figure.look.key)) assert.equal(signature, signatures.get(figure.look.key), `${id} matches every other ${figure.look.key} look`);
    else signatures.set(figure.look.key, signature);
  };
  scene.setAgents([agent('boss'), ...ids.map(id => agent(id))]);
  for (const id of [...ids, 'boss']) expectLook(id);
  assert.equal(figureOf('boss').look.key, 'boss');
  assert.equal(new Set(ids.map(id => figureOf(id).look.key)).size, 6, 'six different people show all six looks');
  const rear = ids.at(-1), rearFigure = figureOf(rear);
  scene.setAgents([agent('boss'), agent(rear)]);
  assert.equal(scene.agentSeats.get(rear), 1);
  assert.equal(figureOf(rear) === rearFigure, true, 'compaction moves the same person to the front desk');
  expectLook(rear);
  scene.setAgents([agent('boss'), agent(rear), ...ids.slice(0, -1).map(id => agent(id))]);
  for (const id of ids) expectLook(id);
  const leaving = ids[0], reused = figureOf(leaving);
  let newcomer = 'newcomer-0';
  for (let i = 1; appearanceKey(appearanceFor(newcomer)) === reused.look.key; i++) newcomer = `newcomer-${i}`;
  let dressed = 0;
  const dress = scene.dressFigure;
  scene.dressFigure = function (...args) { dressed++; return dress.apply(this, args); };
  scene.setAgents([agent('boss'), agent(rear), agent(newcomer), ...ids.slice(1, -1).map(id => agent(id))]);
  assert.equal(figureOf(newcomer) === reused, true, 'the vacated body is reused rather than rebuilt');
  assert.equal(dressed, 1);
  expectLook(newcomer);
  dressed = 0;
  const arrivals = Array.from({ length: 20 }, (_, i) => `arrival-${i}`);
  scene.setAgents([agent('boss'), agent(rear), agent(newcomer), ...ids.slice(1, -1).map(id => agent(id)), ...arrivals.map(id => agent(id))]);
  assert.equal(dressed, 0, 'arrivals are built in their own look instead of being dressed twice');
  for (const id of [...arrivals, rear, newcomer, 'boss']) expectLook(id);
});

test('a reused figure changes look in place and frees only swapped parts that nobody else shares', t => {
  const scene = actualGeometryFixture(t);
  const pick = (prefix, matches) => { for (let i = 0; ; i++) if (matches(appearanceFor(`${prefix}-${i}`))) return `${prefix}-${i}`; };
  const neighbor = pick('neighbor', look => look.headwear === 'beanie');
  const first = pick('first', look => look.headwear === 'beanie');
  const vest = pick('vest', look => look.outfit === 'vest-watch');
  const lanyard = pick('lanyard', look => look.outfit === 'round-collar-lanyard');
  const last = pick('last', look => look.headwear === 'beanie');
  const resources = () => {
    const geometries = new Set(), materials = new Set();
    let meshes = 0;
    scene.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++; geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    return [meshes, geometries.size, materials.size, scene.geometryCache.size];
  };
  scene.setAgents([agent('boss'), agent(neighbor), agent(first)]);
  const figure = scene.figures[scene.agentSeats.get(first)];
  const { head, leftArm, label, detail, trim } = figure;
  const before = resources();
  const beanie = scene.figures[scene.agentSeats.get(neighbor)].look.parts.find(part => part.geometry?.parameters?.radius === .47);
  let sharedDisposed = 0, trimDisposed = 0, faceDisposed = 0;
  beanie.geometry.addEventListener('dispose', () => sharedDisposed++);
  trim.addEventListener('dispose', () => trimDisposed++);
  scene.setAgents([agent('boss'), agent(neighbor), agent(vest)]);
  assert.equal(scene.figures[scene.agentSeats.get(vest)] === figure, true, 'the vest wearer reuses the vacated figure');
  assert.equal(figure.look.key, appearanceKey(appearanceFor(vest)));
  const watchFace = figure.watchFace;
  assert.ok(watchFace instanceof THREE.MeshStandardMaterial);
  watchFace.addEventListener('dispose', () => faceDisposed++);
  scene.setAgents([agent('boss'), agent(neighbor), agent(lanyard)]);
  assert.equal(faceDisposed, 1, 'the departed smart watch face is released exactly once');
  assert.equal(figure.watchFace === undefined, true, 'the departed watch face is no longer referenced');
  assert.equal(trimDisposed, 0, 'a look without layers does not dispose the figure\'s own layer material');
  scene.setAgents([agent('boss'), agent(neighbor), agent(last)]);
  assert.equal(scene.figures[scene.agentSeats.get(last)] === figure, true, 'the last wearer reuses the same figure');
  assert.equal(figure.head === head, true, 'same head'); assert.equal(figure.leftArm === leftArm, true, 'same left arm');
  assert.equal(figure.label === label, true, 'same label'); assert.equal(figure.detail === detail, true, 'same detail group');
  assert.equal(figure.trim === trim, true, 'same layer material');
  assert.equal(sharedDisposed, 0, 'a neighbor wearing the same beanie keeps its geometry');
  assert.equal(trimDisposed, 0);
  assert.equal(faceDisposed, 1);
  for (const part of figure.look.parts) assert.ok([head, leftArm, detail].includes(part.parent), 'look parts stay inside the detail LOD');
  const after = resources();
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'returning to the same look leaves no swapped parts, geometries or materials behind');
  // Released parts may also prune an idle cached source geometry left by batched furniture, but never add entries.
  assert.ok(after[3] <= before[3], `geometry cache grew from ${before[3]} to ${after[3]}`);
});

test('a shrink releases the layer material of a figure whose current look puts it on no mesh exactly once', t => {
  const scene = actualGeometryFixture(t);
  const pick = (prefix, matches) => { for (let i = 0; ; i++) if (matches(appearanceFor(`${prefix}-${i}`))) return `${prefix}-${i}`; };
  const vest = pick('vest', look => look.outfit === 'vest-watch');
  const plain = pick('plain', look => look.outfit === 'plain');
  scene.setAgents([agent('boss'), agent(vest)]);
  const figure = scene.figures[scene.agentSeats.get(vest)];
  let trimDisposed = 0, cuffDisposed = 0;
  figure.trim.addEventListener('dispose', () => trimDisposed++);
  figure.cuff.addEventListener('dispose', () => cuffDisposed++);
  scene.setAgents([agent('boss'), agent(plain)]);
  assert.equal(scene.figures[scene.agentSeats.get(plain)] === figure, true, 'the plain look reuses the vest figure');
  assert.equal(trimDisposed, 0, 'a swap keeps the figure\'s own layer material');
  scene.setAgents([agent('boss')]);
  assert.equal(scene.figures.includes(figure), false, 'the figure left with the shrink');
  assert.equal(trimDisposed, 1, 'the rendered layer material is released once even though no mesh used it');
  assert.equal(cuffDisposed, 1, 'the cuff material is released once');
});

test('live shrink compacts rear survivors and immediately reduces the real floor and desk geometry', (t) => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss')]);
  const small = { ...scene.bounds };
  scene.setAgents([agent('boss'), ...Array.from({ length: 11 }, (_, i) => agent(`shrink-${i}`))]);
  const large = { ...scene.bounds };
  const survivor = scene.figures[scene.agentSeats.get('shrink-10')];
  scene.setAgents([agent('boss'), agent('shrink-10')]);
  assert.ok(scene.bounds.depth < large.depth, `a one-worker room still has depth ${scene.bounds.depth}; the 11-worker depth was ${large.depth}`);
  assert.ok(scene.bounds.width < large.width, 'a room with one worker no longer spans five desk columns');
  assert.equal(scene.agentSeats.get('shrink-10'), 1, 'a rear survivor moves into the first available workstation');
  assert.equal(scene.figures[1] === survivor, true, 'the same employee face, label and animation object survives compaction');
  assert.equal(scene.figures.length, 2);
  assert.equal(scene.fixtureRows.size, 2, 'only the owner and occupied worker row remain');
  const screens = [];
  scene.world.traverse(object => { if (/^screen-\d+$/.test(object.name)) screens.push(object); });
  assert.equal(screens.length, 2, 'unoccupied monitor and desk geometry is removed rather than merely hiding people');
  assert.ok(scene.bounds.depth <= small.depth);
});

test('live shrink preserves the surviving face, moving arms, halo and monitor binding through grow-shrink-grow', (t) => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), ...Array.from({ length: 30 }, (_, i) => agent(`repeat-${i}`))]);
  const survivor = scene.figures[scene.agentSeats.get('repeat-29')];
  const face = survivor.head, arm = survivor.rightArm, label = survivor.label;
  const removedScreen = scene.figures[scene.agentSeats.get('repeat-28')].screen;
  let screenDisposed = 0;
  removedScreen.material.addEventListener('dispose', () => screenDisposed++);
  const retainedGeometry = survivor.head.getObjectByName('employee-eye-left').geometry;
  let liveGeometryDisposed = 0;
  retainedGeometry.addEventListener('dispose', () => liveGeometryDisposed++);
  const smallSnapshots = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    scene.setAgents([agent('boss'), agent('repeat-29')]);
    const worker = scene.figures[scene.agentSeats.get('repeat-29')];
    assert.equal(worker === survivor, true, 'the survivor keeps the same figure');
    assert.equal(worker.head === face, true, 'same face'); assert.equal(worker.rightArm === arm, true, 'same arm');
    assert.equal(worker.label === label, true, 'same label');
    assert.equal(worker.screen === scene.world.getObjectByName('screen-1'), true, 'the survivor is bound to the first monitor');
    assert.deepEqual(worker.origin.toArray(), [seatPosition(1).x, 0, seatPosition(1).z]);
    assert.deepEqual(worker.halo.position.toArray(), [worker.origin.x, .035, worker.origin.z]);
    scene.updateAnimation(.1);
    const before = worker.rightArm.rotation.x;
    scene.updateAnimation(.15);
    assert.notEqual(worker.rightArm.rotation.x, before);
    scene.updateDetailLevels();
    assert.equal(scene.farFigures.count, 2); assert.equal(scene.farDesks.count, 2);
    const resources = { geometries: new Set(), materials: new Set(), meshes: 0 };
    scene.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.meshes++; resources.geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.materials.add(material);
    });
    smallSnapshots.push([resources.meshes, resources.geometries.size, resources.materials.size, scene.geometryCache.size]);
    scene.setAgents([agent('boss'), agent('repeat-29'), ...Array.from({ length: 59 }, (_, i) => agent(`round-${cycle}-${i}`))]);
    assert.equal(scene.figures[scene.agentSeats.get('repeat-29')] === survivor, true, 'regrowth keeps the survivor figure');
    assert.equal(scene.figures.length, 61);
    assert.ok(scene.bounds.depth > 60);
  }
  assert.equal(screenDisposed, 1, 'the removed monitor material is released once');
  assert.equal(liveGeometryDisposed, 0, 'surviving people keep their shared geometry alive');
  assert.deepEqual(smallSnapshots[1], smallSnapshots[0], 'returning to the same small room does not retain the prior large room resources');
  assert.deepEqual(smallSnapshots[2], smallSnapshots[0]);
});

// Floating-placement regressions: measure rendered world bounds against the actual back wall slab.
const worldBox = object => new THREE.Box3().setFromObject(object);
const shownInWorld = object => { for (let node = object; node; node = node.parent) if (!node.visible) return false; return true; };
function backWallFace(scene) {
  scene.world.updateMatrixWorld(true);
  const slab = worldBox(scene.backWall.children[0]);
  assert.ok(Math.abs(slab.max.x - slab.min.x - scene.bounds.width) < .05, 'the first back wall child is the wall slab');
  return slab.max.z;
}
const ownerSignParts = scene => {
  const board = scene.world.getObjectByName('owner-office-sign');
  assert.ok(board instanceof THREE.Mesh, 'the named owner sign survives static batching');
  const lettering = board.children.find(child => child instanceof THREE.Mesh && child.material.map);
  assert.ok(lettering, 'the lettering plane moves and hides with its board');
  return { board, lettering };
};

test('back wall fixtures and the owner sign stay within the actual wall width at every room size', t => {
  const scene = actualGeometryFixture(t, { canvas: true });
  const epsilon = .08;
  for (const capacity of [1, 2, 3, 6, 7, 11, 21, 101]) {
    scene.setAgents([agent('boss'), ...Array.from({ length: capacity - 1 }, (_, i) => agent(`wall-${i}`))]);
    assert.deepEqual(scene.bounds, officeBounds(capacity));
    scene.world.updateMatrixWorld(true);
    const { minX, maxX } = scene.bounds;
    const { board } = ownerSignParts(scene);
    for (const [root, label] of [[scene.backWall, 'back wall'], [scene.wallDecor, 'wall decor'], [board, 'owner sign']]) {
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const box = worldBox(object);
        assert.ok(box.min.x >= minX - epsilon && box.max.x <= maxX + epsilon,
          `capacity ${capacity}: a ${label} mesh spans x ${box.min.x.toFixed(2)}~${box.max.x.toFixed(2)} beyond the wall ${minX}~${maxX}`);
      });
    }
    // With one worker the whiteboard tray (x 3.15) is the only decor that far right, so it must still exist where it fits.
    if (capacity <= 2) assert.ok(worldBox(scene.wallDecor).max.x >= 3.1, 'the whiteboard stays on a wall wide enough for it, including the owner-only minimum room');
    if (maxX < 3.15) assert.ok(worldBox(scene.wallDecor).max.x < maxX, 'an owner-only wall has no whiteboard hanging past its end');
  }
});

test('the owner sign sits flush on the back wall and hides with it, and the glass partition reaches the wall face', t => {
  const scene = actualGeometryFixture(t, { canvas: true });
  scene.setAgents([agent('boss'), agent('worker')]);
  const face = backWallFace(scene);
  // Geometry positions are float32, so compare at vertex precision.
  assert.ok(Math.abs(face - (scene.bounds.minZ + .1)) < 1e-4, `the wall face is at z ${face}`);
  const { board, lettering } = ownerSignParts(scene);
  const boardBox = worldBox(board), letteringBox = worldBox(lettering);
  assert.ok(Math.abs(boardBox.min.z - face) <= .03, `the sign board back is ${(boardBox.min.z - face).toFixed(3)} from the wall face`);
  assert.ok(letteringBox.min.z >= boardBox.max.z && letteringBox.min.z - boardBox.max.z <= .03, 'the lettering lies on the board front');
  for (const [yaw, shown] of [[.6, true], [-Math.PI / 2, true], [Math.PI, false], [-2.4, false], [.6, true]]) {
    scene.yaw = yaw;
    scene.updateCamera(1, 0);
    assert.equal(scene.backWall.visible, shown);
    assert.equal(shownInWorld(board), shown, `yaw ${yaw}: the sign board follows the back wall cutaway`);
    assert.equal(shownInWorld(lettering), shown, `yaw ${yaw}: the lettering follows the back wall cutaway`);
  }
  const glass = scene.world.children.find(object => object instanceof THREE.Mesh && object.material.transparent && object.position.x === -6.15);
  assert.ok(glass, 'the owner wing glass partition exists');
  const glassBox = worldBox(glass);
  assert.ok(Math.abs(glassBox.min.z - face) <= .03, `the glass leaves a ${(glassBox.min.z - face).toFixed(3)} gap at the back wall`);
  assert.ok(glassBox.min.z >= scene.bounds.minZ, 'with the back wall cut away the glass still ends on the floor');
  assert.ok(Math.abs(glassBox.max.z - -2.95) < 1e-4, 'the open front end beside the approval corridor is unchanged');
  const frame = scene.world.children.filter(object => object instanceof THREE.Mesh && object.material === scene.materials.get('#96acb5/0.78/0'));
  assert.ok(frame.length > 0, 'the partition posts and rail are present');
  const frameBox = frame.reduce((box, object) => box.union(worldBox(object)), new THREE.Box3());
  assert.ok(Math.abs(frameBox.min.z - face) <= .03, 'the rear post and top rail touch the wall face');
  assert.ok(frameBox.max.z < -2.9 && frameBox.min.x > -6.25 && frameBox.max.x < -6.05, 'the frame stays on the partition line');
});

test('the owner sign and its lettering texture persist through grow-shrink-grow without new or released resources', t => {
  const scene = actualGeometryFixture(t, { canvas: true });
  scene.setAgents([agent('boss'), agent('keep')]);
  const { board, lettering } = ownerSignParts(scene);
  const texture = lettering.material.map;
  // Decision 26: the owner's desk nameplate is the only other settings texture.
  const nameplate = scene.world.getObjectByName('owner-nameplate-lettering');
  assert.ok(nameplate?.material.map, 'the nameplate lettering survives static batching');
  const nameplateTexture = nameplate.material.map;
  let released = 0;
  for (const resource of [texture, lettering.material, lettering.geometry, board.geometry, nameplateTexture, nameplate.material]) resource.addEventListener('dispose', () => released++);
  const snapshots = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    scene.setAgents([agent('boss'), agent('keep'), ...Array.from({ length: 59 }, (_, i) => agent(`sign-${cycle}-${i}`))]);
    assert.equal(ownerSignParts(scene).board === board, true, 'a larger room keeps the same sign');
    scene.setAgents([agent('boss')]);
    assert.equal(ownerSignParts(scene).board === board, true, 'an owner-only room keeps the same sign');
    scene.setAgents([agent('boss'), agent('keep')]);
    const parts = ownerSignParts(scene);
    assert.equal(parts.board === board, true, 'same sign board'); assert.equal(parts.lettering === lettering, true, 'same lettering');
    assert.equal(parts.lettering.material.map === texture, true, 'same sign texture');
    const resources = { meshes: 0, geometries: new Set(), materials: new Set(), textures: new Set() };
    scene.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.meshes++; resources.geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        resources.materials.add(material);
        if (material.map) resources.textures.add(material.map);
      }
    });
    assert.equal(scene.world.getObjectByName('owner-nameplate-lettering') === nameplate, true, 'the same nameplate lettering stays in the room');
    assert.equal(resources.textures.size, 2, 'the scene holds exactly the original sign and nameplate textures');
    assert.ok(resources.textures.has(texture) && resources.textures.has(nameplateTexture));
    snapshots.push([resources.meshes, resources.geometries.size, resources.materials.size, resources.textures.size, scene.geometryCache.size]);
  }
  assert.equal(released, 0, 'room rebuilds never release the sign that is still displayed');
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
});

test('live shrink cancels obsolete routes, renews a retained approval visit and keeps focus on the same employee', (t) => {
  const scene = actualGeometryFixture(t);
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const many = [agent('boss'), ...Array.from({ length: 30 }, (_, i) => ({ ...agent(`route-${i}`), status: i === 29 ? 'approval' : 'working' }))];
  scene.setAgents(many);
  const worker = scene.figures[scene.agentSeats.get('route-29')];
  scene.focus(worker.id);
  scene.sendPaperPlane('route-28', 'route-29', 'shrink-flight');
  scene.deliver('boss', 'route-1');
  scene.updateAnimation(.2);
  assert.ok(scene.approvalVisits.has(worker.id));
  scene.setAgents([agent('boss'), agent('route-28'), { ...agent('route-29'), status: 'approval' }]);
  assert.equal(scene.paperFlights.length, 0);
  assert.equal(scene.deliveries.length, 0);
  assert.equal(scene.queued.length, 0);
  assert.equal(scene.effects.children.length, 0);
  assert.equal(scene.figures[scene.agentSeats.get(worker.id)] === worker, true, 'the focused worker keeps the same figure');
  assert.equal(scene.focusId, worker.id);
  assert.equal(scene.following, true);
  const visit = scene.approvalVisits.get(worker.id);
  assert.equal(visit.figure === worker, true, 'the renewed visit walks the same figure');
  assert.ok(visit.route[0].equals(worker.origin), 'a restarted visit begins at the compacted seat');
  assert.ok(scene.approvalRequests.has(worker.id));
  scene.updateCamera(.1, 0);
  assert.ok(scene.targetGoal.distanceTo(worker.group.position.clone().add(new THREE.Vector3(0, 1.15, 0))) < 1e-8);
  for (let frame = 0; scene.approvalVisits.get(worker.id)?.stage !== 'waiting' && frame < 600; frame++) scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.get(worker.id)?.stage, 'waiting');
  assert.notEqual(scene.stampPending, true, 'resizing an office cannot invent an approval result');
  scene.resolveApproval(worker.id);
  for (let frame = 0; scene.approvalVisits.has(worker.id) && frame < 600; frame++) scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.has(worker.id), false);
  assert.ok(worker.group.position.equals(worker.origin));
  assert.equal(worker.leftLeg.rotation.x, -Math.PI / 2);
});

test('live small offices use only their current desk columns while all delivery and approval paths remain on the floor', () => {
  // Decision 16: the first desk column is reserved even in an owner-only room, so the first worker does not widen the floor.
  assert.equal(officeBounds(2).width, officeBounds(1).width);
  let previousWidth = officeBounds(1).width;
  for (let workers = 1; workers <= 5; workers++) {
    const bounds = officeBounds(workers + 1);
    if (workers > 1) assert.ok(bounds.width > previousWidth);
    previousWidth = bounds.width;
    for (let index = 1; index <= workers; index++) {
      const route = [...routeBetweenSeats(0, index), ...routeToApproval(index, 8)];
      for (const point of route) {
        assert.ok(point.x > bounds.minX && point.x < bounds.maxX);
        assert.ok(point.z > bounds.minZ && point.z < bounds.maxZ);
      }
    }
  }
  assert.equal(officeBounds(6).width, officeBounds(513).width);
});

test('general messages fly a hand-sized short loop at one real computer and respect retirement and pause', t => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), agent('messenger')]);
  const figure = scene.figures[scene.agentSeats.get('messenger')];
  const origin = figure.screen.getWorldPosition(new THREE.Vector3());
  assert.equal(scene.sendMessagePlane('missing', 'no-sender'), false);
  assert.equal(scene.sendMessagePlane('messenger', 'observed-message'), true);
  assert.equal(scene.sendMessagePlane('messenger', 'observed-message'), false);
  const flight = scene.paperFlights[0];
  assert.equal(flight.plane.name, 'message-paper-plane');
  assert.equal(scene.deliveries.length, 0);
  assert.equal(scene.figures.filter(f => f.group.visible).length, 2);
  assert.ok(flight.curve.getPoint(0).distanceTo(origin) < 1e-8);
  assert.ok(flight.curve.getPoint(1).distanceTo(origin) < 1e-8);
  for (let i = 0; i <= 50; i++) assert.ok(flight.curve.getPoint(i / 50).distanceTo(origin) < 3);
  flight.plane.geometry.computeBoundingBox();
  const size = flight.plane.geometry.boundingBox.getSize(new THREE.Vector3());
  const length = Math.max(...size.toArray()) * flight.plane.scale.x;
  assert.ok(length > .18 && length < .23);
  scene.setPaused(true); scene.updateAnimation(.3);
  assert.ok(flight.plane.position.distanceTo(origin) < 1e-8);
  scene.setPaused(false); scene.updateAnimation(.3);
  assert.ok(flight.plane.position.distanceTo(origin) > .05);
  scene.setAgents([agent('boss')]);
  assert.equal(scene.paperFlights.length, 0);
  assert.equal(flight.plane.parent === null, true, 'a cancelled plane leaves the effects group');
});

// Owner wing, reception and wall decor: geometry, live pieces and settings-driven lettering.
const sceneResources = scene => {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  let meshes = 0;
  scene.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++; geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  return [meshes, geometries.size, materials.size, textures.size, scene.geometryCache.size];
};
const formatBox = box => `x ${box.min.x.toFixed(2)}~${box.max.x.toFixed(2)} y ${box.min.y.toFixed(2)}~${box.max.y.toFixed(2)} z ${box.min.z.toFixed(2)}~${box.max.z.toFixed(2)}`;

test('room decor stands inside the room and never blocks desks, the corridor, walking aisles or approval spots from 0 to 101 workers', t => {
  const scene = actualGeometryFixture(t);
  const meshBoxes = root => {
    root.updateMatrixWorld(true);
    const boxes = [];
    root.traverse(object => { if (object instanceof THREE.Mesh) boxes.push(worldBox(object)); });
    return boxes;
  };
  // Build the decor into loose groups: static batching in the real room merges these meshes away.
  const fixed = new THREE.Group();
  scene.ownerWingDecor(fixed);
  scene.receptionDecor(fixed);
  const overlaps = (box, zone) => box.min.x < zone.maxX && box.max.x > zone.minX && box.min.z < zone.maxZ && box.max.z > zone.minZ;
  const around = (a, b, margin, label) => ({ minX: Math.min(a.x, b.x) - margin, maxX: Math.max(a.x, b.x) + margin,
    minZ: Math.min(a.z, b.z) - margin, maxZ: Math.max(a.z, b.z) + margin, label });
  for (const workers of [0, 1, 2, 6, 21, 101]) {
    const capacity = workers + 1, bounds = officeBounds(capacity);
    const strip = new THREE.Group();
    scene.rightStripDecor(bounds, strip);
    const pieces = [...meshBoxes(fixed), ...meshBoxes(strip)];
    assert.ok(pieces.length > 150);
    for (const box of pieces) {
      // Inside the inner faces of the left and back walls and the open floor edges.
      assert.ok(box.min.x >= bounds.minX + .08 && box.max.x <= bounds.maxX + .02 && box.min.z >= bounds.minZ + .08 && box.max.z <= bounds.maxZ + .02,
        `${workers} workers: decor ${formatBox(box)} leaves the room ${bounds.minX}~${bounds.maxX} / ${bounds.minZ}~${bounds.maxZ}`);
      // Rounded boxes bevel about .45 of their corner radius past the nominal size (the water cooler reaches -.018);
      // the visible floor top is at -.015, so nothing may go deeper than that bevel.
      assert.ok(box.min.y >= -.02, `${workers} workers: decor ${formatBox(box)} sinks below the floor`);
      assert.ok(box.min.y <= .035 || pieces.some(other => other !== box && other.clone().expandByScalar(.02).intersectsBox(box)),
        `${workers} workers: decor ${formatBox(box)} floats without touching the floor or another piece`);
    }
    const zones = [{ minX: -5.525, maxX: -3.875, minZ: bounds.minZ, maxZ: bounds.maxZ, label: 'the corridor' }];
    for (let index = 0; index < capacity; index++) {
      const seat = seatPosition(index), owner = index === 0;
      zones.push({ minX: seat.x - 1.95, maxX: seat.x + 1.95, minZ: seat.z - (owner ? .7 : 2.05), maxZ: seat.z + (owner ? 2.05 : .7), label: `desk ${index}` });
    }
    const walk = (route, label) => { for (let i = 1; i < route.length; i++) zones.push(around(route[i - 1], route[i], .45, label)); };
    for (let index = 1; index < capacity; index++) {
      walk(routeBetweenSeats(index, 0), `the aisle from desk ${index}`);
      for (let slot = 0; slot < 9; slot++) walk(routeToApproval(index, slot), `the approval walk ${index}/${slot}`);
    }
    for (let slot = 0; slot < 9; slot++) zones.push(around(approvalSpot(slot), approvalSpot(slot), .5, `approval spot ${slot}`));
    for (const box of pieces) {
      // Rugs and floor stickers are walked on.
      if (box.max.y <= .07) continue;
      const blocked = zones.find(zone => overlaps(box, zone));
      assert.equal(blocked, undefined, `${workers} workers: decor ${formatBox(box)} blocks ${blocked?.label}`);
    }
  }
});

test('the owner wing gets a low credenza, a walnut high-back chair, a desk pad and a window that clears the sign', t => {
  const scene = actualGeometryFixture(t, { canvas: true });
  scene.setAgents([agent('boss')]);
  scene.world.updateMatrixWorld(true);
  const face = backWallFace(scene);
  const sign = worldBox(scene.world.getObjectByName('owner-office-sign'));
  const panes = [];
  scene.backWall.traverse(object => { if (object instanceof THREE.Mesh && object.material === scene.windowGlass) panes.push(worldBox(object)); });
  assert.equal(panes.length, 2, 'the owner window and the first worker window share the time-of-day glass');
  const ownerPane = panes.find(box => box.max.x < -10);
  assert.ok(ownerPane, 'the owner wing has its own window');
  assert.ok(ownerPane.max.x < sign.min.x - .1 && ownerPane.min.x > scene.bounds.minX, 'the owner window stays beside the sign on the wall');
  assert.ok(ownerPane.min.y < sign.max.y && ownerPane.max.y > sign.min.y, 'window and sign share the same wall height band');
  const nameplate = scene.world.getObjectByName('owner-nameplate-lettering');
  assert.equal(nameplate.userData.lettering, '대표');
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(nameplate.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(normal.z > .99, 'the nameplate lettering faces the reception');
  const wing = new THREE.Group();
  scene.ownerWingDecor(wing);
  const credenza = worldBox(wing);
  assert.ok(credenza.min.z >= face - .01 && credenza.max.z < -6.6, 'the credenza stands against the back wall behind the owner');
  assert.ok(credenza.max.y < 1.8, 'a low credenza stays under the owner window and sign');
  // Furniture names survive only before static batching, so inspect freshly assembled workstations.
  const owner = new THREE.Group(), employee = new THREE.Group();
  scene.workstation(0, 0, 6, employee);
  scene.workstation(0, 0, 0, owner);
  const color = (group, name) => group.getObjectByName(name).material.color.getHexString();
  assert.equal(color(owner, 'chair-seat-0'), '8a6a50');
  assert.equal(color(owner, 'chair-back-0'), '7a5c45');
  assert.equal(color(employee, 'chair-seat-6'), new THREE.Color(seatPosition(6).color).getHexString(), 'employee chairs keep their seat furniture color');
  const flat = group => group.children.filter(mesh => mesh.material?.color?.getHexString() === '78998a' && worldBox(mesh).getSize(new THREE.Vector3()).y < .02);
  assert.equal(flat(owner).length, 1, 'the owner has a green desk pad');
  assert.equal(flat(employee).length, 0);
  assert.equal(owner.getObjectByName('owner-desk-live').children.filter(child => child.name === 'owner-approval-sheet').length, 6);
  assert.equal(employee.getObjectByName('owner-desk-live') === undefined, true, 'employee desks have no approval tray');
});

test('the owner tray shows one sheet per current approval request, clips an overflow and only toggles prepared sheets', t => {
  const scene = actualGeometryFixture(t);
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  scene.setAgents([agent('boss')]);
  const live = scene.world.getObjectByName('owner-desk-live');
  assert.ok(live, 'the live tray group survives static batching');
  const sheets = live.children.filter(child => child.name === 'owner-approval-sheet');
  const clip = live.getObjectByName('owner-approval-clip');
  const shown = () => sheets.filter(sheet => shownInWorld(sheet)).length;
  assert.equal(sheets.length, 6);
  assert.equal(shown(), 0); assert.equal(clip.visible, false);
  const askers = (approvals, total = 8) => Array.from({ length: total }, (_, i) => ({ ...agent(`asker-${i}`), status: i < approvals ? 'approval' : 'idle' }));
  scene.setAgents([agent('boss'), ...askers(2)]);
  assert.equal(scene.approvalRequests.size, 2);
  assert.equal(shown(), 2); assert.equal(clip.visible, false);
  const quiet = sceneResources(scene);
  scene.setAgents([agent('boss'), ...askers(8)]);
  assert.equal(shown(), 6); assert.equal(clip.visible, true, 'more requests than sheets add a clip');
  assert.deepEqual(sceneResources(scene), quiet, 'a changing count builds no geometry, material or texture');
  scene.resolveApproval('asker-7'); scene.resolveApproval('asker-6');
  assert.equal(scene.approvalRequests.size, 6);
  assert.equal(shown(), 6); assert.equal(clip.visible, false);
  scene.setAgents([agent('boss'), ...askers(3)]);
  assert.equal(shown(), 3);
  for (let frame = 0; frame < 20; frame++) scene.updateAnimation(.1);
  assert.equal(shown(), 3, 'time alone does not change the pile');
  scene.setAgents([agent('boss'), ...askers(0)]);
  assert.equal(shown(), 0); assert.equal(clip.visible, false);
  assert.deepEqual(sceneResources(scene), quiet);
});

test('a company-wide approval count sets the owner tray over seated requests and toggles prepared sheets only when it changes', t => {
  const scene = actualGeometryFixture(t);
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const roster = () => [agent('boss'), { ...agent('asker'), status: 'approval' }];
  scene.setAgents(roster());
  const live = scene.world.getObjectByName('owner-desk-live');
  const sheets = live.children.filter(child => child.name === 'owner-approval-sheet');
  const clip = live.getObjectByName('owner-approval-clip');
  const shown = () => sheets.filter(sheet => shownInWorld(sheet)).length;
  assert.equal(shown(), 1, 'without a host count the tray keeps counting seated requests');
  const quiet = sceneResources(scene);
  scene.setApprovalCount(3);
  assert.equal(shown(), 3, 'requests on other floors are filed too');
  assert.equal(scene.approvalRequests.size, 1, 'visits still follow the seated request only');
  scene.updateAnimation(.1); scene.setAgents(roster()); scene.updateAnimation(.1);
  assert.equal(shown(), 3, 'a frame or a new roster keeps the company count');
  let writes = 0;
  for (const target of [...sheets, clip]) {
    let visible = target.visible;
    Object.defineProperty(target, 'visible', { configurable: true, enumerable: true, get: () => visible, set: value => { writes++; visible = value; } });
  }
  scene.setApprovalCount(3);
  for (let frame = 0; frame < 5; frame++) scene.updateAnimation(.1);
  assert.equal(writes, 0, 'an unchanged count writes no visibility');
  scene.setApprovalCount(9);
  assert.equal(shown(), 6); assert.equal(clip.visible, true, 'the overflow clip rule holds');
  scene.setApprovalCount(0);
  assert.equal(shown(), 0); assert.equal(clip.visible, false, 'zero clears the tray even while a seated request remains');
  writes = 0;
  scene.setApprovalCount(Number.NaN); scene.setApprovalCount(-2);
  assert.equal(writes, 0, 'an invalid count is ignored and a negative one clamps to the same zero');
  assert.deepEqual(sceneResources(scene), quiet, 'a changing count builds no geometry, material or texture');
});

test('settings names redraw only a changed sign or nameplate texture, keep the suffix whole and reach the building roof sign', t => {
  const drawn = [];
  const context = () => ({ fillRect() {}, fillText(text) { drawn.push(text); }, measureText: text => ({ width: [...text].length * 40 }) });
  const scene = actualGeometryFixture(t, { canvas: true, context });
  const companies = [];
  scene.building = { setCompanyName: name => companies.push(name) };
  scene.setAgents([agent('boss')]);
  const sign = scene.world.getObjectByName('owner-sign-lettering'), plate = scene.world.getObjectByName('owner-nameplate-lettering');
  assert.equal(sign.parent.name, 'owner-office-sign');
  assert.equal(sign.userData.lettering, '대표실', 'no company name is invented before settings arrive');
  assert.equal(plate.userData.lettering, '대표');
  const disposed = [];
  const watch = (texture, label) => texture.addEventListener('dispose', () => disposed.push(label));
  watch(sign.material.map, 'sign-0'); watch(plate.material.map, 'plate-0');
  const [signMaterial, plateMaterial] = [sign.material, plate.material];
  scene.setOwnerNames({ companyName: '  SampleStudio ', ownerName: 'AB' });
  assert.equal(sign.userData.lettering, 'SampleStudio 대표실');
  assert.equal(plate.userData.lettering, 'AB 대표');
  assert.ok(drawn.includes('SampleStudio 대표실') && drawn.includes('AB 대표'), 'the canvas draws exactly the fitted text');
  assert.deepEqual(disposed.sort(), ['plate-0', 'sign-0'], 'replaced textures are released once');
  assert.equal(sign.material === signMaterial, true, 'the sign keeps its material'); assert.equal(plate.material === plateMaterial, true, 'the nameplate keeps its material');
  assert.deepEqual(companies, ['SampleStudio']);
  const maps = [sign.material.map, plate.material.map];
  watch(maps[0], 'sign-1'); watch(maps[1], 'plate-1');
  scene.setOwnerNames({ companyName: 'SampleStudio', ownerName: 'AB' });
  assert.deepEqual([sign.material.map, plate.material.map], maps, 'unchanged names keep their textures');
  assert.deepEqual(companies, ['SampleStudio']);
  scene.setOwnerNames({ companyName: 'SampleStudio', ownerName: '김하나' });
  assert.equal(sign.material.map === maps[0], true, 'an owner rename leaves the sign alone');
  assert.equal(plate.material.map !== maps[1], true, 'the renamed nameplate gets a new texture');
  assert.equal(plate.userData.lettering, '김하나 대표');
  assert.deepEqual(disposed.sort(), ['plate-0', 'plate-1', 'sign-0']);
  assert.deepEqual(companies, ['SampleStudio']);
  const longName = '아주아주긴회사이름'.repeat(4);
  scene.setOwnerNames({ companyName: longName, ownerName: '김하나' });
  const fitted = sign.userData.lettering;
  assert.ok(fitted.endsWith('… 대표실') && fitted.startsWith('아주아주긴'), `a long company name is shortened at its end: ${fitted}`);
  assert.ok([...fitted].length * 40 <= 768 - 80, 'the fitted sign text stays within the board padding');
  assert.deepEqual(companies, ['SampleStudio', longName], 'the building roof sign receives the full company name');
  assert.equal(sceneResources(scene)[3], 2, 'the scene still holds only the sign and nameplate textures');
});

test('the router LED shows only the reported bridge state, flashes at most twice per second and survives room rebuilds', t => {
  const scene = actualGeometryFixture(t);
  let now = 100;
  scene.clockSeconds = () => now;
  scene.setAgents([agent('boss')]);
  const led = () => scene.backWall.getObjectByName('router-led');
  const material = led().material;
  assert.ok(![...scene.materials.values()].includes(material), 'the LED owns its material instead of a shared palette color');
  const hex = () => material.color.getHexString();
  const flashing = () => material.emissiveIntensity > 1;
  assert.equal(hex(), 'c3c5b7', 'no connection state is shown before the bridge reports one');
  scene.pulseRouter();
  assert.equal(flashing(), false, 'an unreported connection never blinks');
  scene.setBridgeConnected(true);
  assert.equal(hex(), '83b491'); assert.equal(flashing(), false, 'the first report is steady');
  const resources = sceneResources(scene);
  let starts = 0, was = false;
  for (let step = 0; step < 20; step++) {
    now = 100 + step * .05;
    scene.pulseRouter(); scene.updateRouterLed();
    if (flashing() && !was) starts++;
    was = flashing();
  }
  assert.equal(starts, 2, 'events every 50ms flash only twice in one second');
  now = 101.2; scene.updateRouterLed();
  assert.equal(flashing(), false); assert.equal(led().scale.x, 1);
  assert.deepEqual(sceneResources(scene), resources, 'flashing writes values, never new resources');
  now = 102;
  for (const [toggle, label] of [[active => { scene.reducedMotion = active; }, 'reduced motion'], [active => { scene.powerSaving = active; }, 'power saving']]) {
    toggle(true); scene.pulseRouter();
    assert.equal(flashing(), false, `${label} never flashes`);
    toggle(false);
  }
  scene.setBridgeConnected(false);
  assert.equal(hex(), 'f3c97b');
  scene.pulseRouter();
  assert.equal(flashing(), false, 'a disconnected bridge stays amber');
  now = 120;
  scene.setBridgeConnected(true);
  const blinks = [];
  for (const at of [0, .1, .2, .35, .5, .7]) {
    now = 120 + at;
    if (at === .35) scene.pulseRouter();
    scene.updateRouterLed();
    blinks.push(flashing());
  }
  assert.deepEqual(blinks, [true, true, false, true, false, false], 'reconnection blinks green twice and an event cannot interrupt it');
  assert.equal(hex(), '83b491');
  scene.setReducedMotion(true); scene.setBridgeConnected(false); now = 130; scene.setBridgeConnected(true);
  assert.equal(flashing(), false, 'reduced motion reconnects without blinking');
  scene.setReducedMotion(false);
  let materialDisposed = 0;
  material.addEventListener('dispose', () => materialDisposed++);
  const first = led();
  scene.setAgents([agent('boss'), ...Array.from({ length: 12 }, (_, i) => agent(`led-${i}`))]);
  assert.equal(led() !== first, true, 'the wall was rebuilt for the wider room');
  assert.equal(led().material === material, true, 'the rebuilt LED keeps its own material'); assert.equal(materialDisposed, 0);
  assert.equal(hex(), '83b491');
  scene.yaw = Math.PI; scene.updateCamera(1, 0);
  assert.equal(shownInWorld(led()), false, 'the LED hides with the back wall');
});

test('window glass and the floor light patch follow the local hour with ten-minute blends, recolored once per minute', t => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss')]);
  const glass = scene.windowGlass, patchMaterial = scene.windowPatch;
  assert.ok(glass instanceof THREE.MeshStandardMaterial && patchMaterial instanceof THREE.MeshBasicMaterial);
  assert.equal(scene.materials.get('#c2dce9/0.78/0') !== glass, true, 'the water cooler keeps its own pale blue');
  const at = (hour, minute) => new Date(2026, 8, 14, hour, minute);
  const hex = () => glass.color.getHexString();
  const period = name => new THREE.Color(WINDOW_LIGHT[name].glass).getHexString();
  scene.updateWindowLight(at(12, 0));
  assert.equal(hex(), period('day'));
  assert.equal(patchMaterial.opacity, WINDOW_LIGHT.day.patchOpacity);
  scene.updateWindowLight(at(17, 5));
  const halfway = new THREE.Color(WINDOW_LIGHT.day.glass).lerp(new THREE.Color(WINDOW_LIGHT.evening.glass), .5);
  assert.ok(glass.color.equals(halfway), 'five minutes after 17:00 the glass is halfway to evening');
  assert.ok(Math.abs(patchMaterial.opacity - (WINDOW_LIGHT.day.patchOpacity + WINDOW_LIGHT.evening.patchOpacity) / 2) < 1e-9);
  glass.color.set('#000000');
  scene.updateWindowLight(at(17, 5));
  assert.equal(hex(), '000000', 'within the same minute nothing is recolored');
  scene.updateWindowLight(at(17, 10));
  assert.equal(hex(), period('evening'));
  scene.updateWindowLight(at(20, 30));
  assert.equal(hex(), period('night'));
  scene.updateWindowLight(at(5, 59));
  assert.equal(hex(), period('night'));
  scene.setReducedMotion(true);
  scene.updateWindowLight(at(6, 5));
  assert.equal(hex(), period('morning'), 'without ambient motion a boundary switches at once');
  scene.setReducedMotion(false);
  const patch = scene.backWall.getObjectByName('window-light-patch');
  assert.equal(patch.material === patchMaterial, true, 'the light patch uses its dedicated material');
  let disposed = 0;
  for (const material of [glass, patchMaterial]) material.addEventListener('dispose', () => disposed++);
  scene.setAgents([agent('boss'), ...Array.from({ length: 12 }, (_, i) => agent(`window-${i}`))]);
  assert.equal(disposed, 0, 'room rebuilds keep the time-of-day materials');
  assert.equal(hex(), period('morning'));
  const panes = [];
  scene.backWall.traverse(object => { if (object instanceof THREE.Mesh && object.material === glass) panes.push(object); });
  assert.ok(panes.length >= 4, 'every window pane of the wider wall uses the shared glass');
  assert.equal(scene.backWall.getObjectByName('window-light-patch').material === patchMaterial, true, 'the rebuilt patch keeps the same material');
  scene.yaw = Math.PI; scene.updateCamera(1, 0);
  assert.equal(shownInWorld(scene.backWall.getObjectByName('window-light-patch')), false, 'the light patch hides with its window');
});

// Owner character and moments (decisions 15, 18, 19, 28, 29, 31, 32).
const meshesOfLook = figure => figure.look.parts.flatMap(part => {
  const found = [];
  part.traverse(object => { if (object instanceof THREE.Mesh) found.push(object); });
  return found;
});
const colorOf = mesh => mesh.material.color.getHexString();

test('the owner wears the minimal look while seat 2 and seat 4 employees keep their own frames and collars', t => {
  const scene = actualGeometryFixture(t);
  const pick = variation => { for (let i = 0; ; i++) if (appearanceFor(`look-${i}`).variation === variation) return `look-${i}`; };
  const curly = pick(2), vest = pick(4);
  scene.setAgents([{ ...agent('boss'), status: 'idle', color: '#eab65e' }, { ...agent(curly), color: '#80afcb' }, agent(vest)]);
  const boss = scene.figures[0];
  assert.equal(boss.shirt.color.getHexString(), '31495e', 'the navy turtleneck ignores the roster color');
  const bossParts = meshesOfLook(boss);
  assert.equal(bossParts.some(mesh => ['597769', 'edf0e0'].includes(colorOf(mesh))), false, 'no tie or shirt strip');
  assert.equal(bossParts.filter(mesh => mesh.geometry.type === 'TorusGeometry' && mesh.material === boss.cuff).length, 2, 'a two-rib turtleneck collar in the cuff shade');
  const frames = bossParts.filter(mesh => mesh.parent === boss.head && mesh.geometry.type === 'TorusGeometry' && colorOf(mesh) === '31495e');
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => frame.geometry.parameters.tube < .01 && frame.geometry.parameters.tubularSegments === 16), 'thin round frames');
  assert.equal(bossParts.filter(mesh => mesh.parent === boss.head && colorOf(mesh) === '31495e' && mesh.geometry.parameters?.depth > .3).length, 2, 'two temples');
  assert.equal(boss.look.shoes.length, 2);
  assert.ok(boss.look.shoes.every(shoe => shoe.name === 'employee-shoe' && colorOf(shoe) === 'fffdf5'), 'white sneakers keep the shoe mesh name');
  assert.ok(boss.look.soles.length === 2 && boss.look.soles.every(sole => colorOf(sole) === 'd8e0e5'));
  assert.ok(boss.look.pants.length === 5 && boss.look.pants.every(mesh => colorOf(mesh) === '7188a8'), 'jeans from pelvis to shins');
  const hems = [];
  boss.group.traverse(object => { if (object.name === 'owner-jeans-hem') hems.push(object); });
  assert.ok(hems.length === 2 && hems.every(hem => hem.visible && colorOf(hem) === '7c96b9'), 'rolled jeans hems');
  assert.equal(boss.handSheet.visible, false);
  const seat2 = scene.figures[scene.agentSeats.get(curly)], seat4 = scene.figures[scene.agentSeats.get(vest)];
  assert.equal(seat2.shirt.color.getHexString(), '80afcb', 'employees still wear their reported color');
  const seat2Parts = meshesOfLook(seat2);
  const collar = seat2Parts.find(mesh => mesh.geometry.type === 'TorusGeometry' && mesh.geometry.parameters.radius === .19);
  assert.equal(collar?.material === seat2.cuff, true, 'the round collar is the shirt one shade darker, not white');
  const square = seat2Parts.filter(mesh => mesh.parent === seat2.head && mesh.geometry.type === 'TorusGeometry' && mesh.geometry.parameters.tubularSegments === 4);
  assert.ok(square.length === 2 && square.every(frame => colorOf(frame) === '5b6455' && frame.geometry.parameters.tube === .014), 'thick square frames');
  const round = meshesOfLook(seat4).filter(mesh => mesh.parent === seat4.head && mesh.geometry.type === 'TorusGeometry' && colorOf(mesh) === '5b6455');
  assert.ok(round.length === 2 && round.every(frame => frame.geometry.parameters.tubularSegments === 16 && frame.geometry.parameters.tube === .014), 'thick round frames');
  for (const employee of [seat2, seat4]) {
    assert.ok(employee.look.shoes.every(shoe => colorOf(shoe) === 'f7f6e9'));
    assert.ok(employee.look.pants.every(mesh => colorOf(mesh) === '55675b'));
    let hem = false;
    employee.group.traverse(object => { hem ||= object.name === 'owner-jeans-hem'; });
    assert.equal(hem, false);
    assert.equal(employee.handSheet === undefined, true, 'employees never carry the owner hand sheet');
  }
});

test('an idle owner never yawns and only turns the head to look over the office, with identical arm angles every frame', () => {
  for (const reduced of [false, true]) {
    const { scene, figures } = fixture();
    scene.setReducedMotion(reduced);
    scene.setAgents([{ ...agent('boss'), status: 'idle' }, agent('worker')]);
    const boss = figures[scene.agentSeats.get('boss')];
    const arms = () => [boss.leftArm.rotation.x, boss.leftArm.rotation.z, boss.rightArm.rotation.x, boss.rightArm.rotation.z, ...boss.rightArm.position.toArray()];
    scene.updateAnimation(.1);
    const rest = arms();
    const yaws = [], pitches = [];
    for (let frame = 0; frame < 600; frame++) {
      scene.updateAnimation(.1);
      assert.deepEqual(arms(), rest, `frame ${frame}`);
      assert.equal(boss.yawnStartedAt, null, 'the owner has no yawn');
      yaws.push(boss.head.rotation.y); pitches.push(boss.head.rotation.x);
    }
    assert.ok(pitches.includes(.1), 'watching the monitor with a slight downward gaze');
    if (reduced) {
      assert.ok(yaws.every(yaw => yaw === 0) && pitches.every(pitch => pitch === .1), 'reduced motion keeps the owner still');
      assert.equal(boss.surveyStartedAt ?? null, null);
      continue;
    }
    const relative = Math.atan2(scene.bounds.centerX - boss.group.position.x, scene.bounds.centerZ - boss.group.position.z) - boss.group.rotation.y;
    const toward = Math.sign(Math.atan2(Math.sin(relative), Math.cos(relative)));
    assert.ok(Math.max(...yaws.map(yaw => yaw * toward)) > .45, 'the owner looks toward the office floor now and then');
  }
});

test('the owner faces a waiting approval visitor for the whole visit, and neither a click nor an instruction interrupts it', () => {
  const { scene, figures } = fixture();
  let now = 50;
  scene.clockSeconds = () => now;
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('visitor'), status: 'approval' }, agent('worker')]);
  const boss = figures[scene.agentSeats.get('boss')], visitor = figures[scene.agentSeats.get('visitor')];
  for (let frame = 0; scene.approvalVisits.get('visitor')?.stage !== 'waiting' && frame < 500; frame++) scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.get('visitor').stage, 'waiting');
  const expected = () => {
    const yaw = Math.atan2(visitor.group.position.x - boss.group.position.x, visitor.group.position.z - boss.group.position.z) - boss.group.rotation.y;
    return Math.max(-.75, Math.min(.75, Math.atan2(Math.sin(yaw), Math.cos(yaw))));
  };
  for (let frame = 0; frame < 30; frame++) {
    scene.updateAnimation(.1);
    if (frame >= 4) assert.ok(Math.abs(boss.head.rotation.y - expected()) < 1e-9, `frame ${frame}: ${boss.head.rotation.y} vs ${expected()}`);
    assert.deepEqual([boss.leftArm.rotation.x, boss.rightArm.rotation.x], [-.28, -.25]);
  }
  now = 51;
  assert.equal(scene.reactToOwnerClick(), false, 'a click during a visit is ignored');
  assert.equal(scene.sendInstructionPlane('worker', 'during-visit'), true, 'the instruction plane still flies');
  assert.equal(scene.ownerAction ?? null, null, 'but the owner keeps attending instead of reaching out');
  scene.updateAnimation(.1);
  assert.ok(Math.abs(boss.head.rotation.y - expected()) < 1e-9);
  scene.setAgents([]);
});

test('a visit that ends without approval.resolved is filed into the tray with a nod, never a stamp', t => {
  const scene = actualGeometryFixture(t);
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const owner = { ...agent('boss'), status: 'idle' };
  scene.setAgents([owner, { ...agent('visitor'), status: 'approval' }]);
  const boss = scene.figures[0], visitor = scene.figures[scene.agentSeats.get('visitor')];
  const sheets = () => scene.approvalPile.sheets.filter(sheet => sheet.visible).length;
  for (let frame = 0; scene.approvalVisits.get('visitor')?.stage !== 'waiting' && frame < 500; frame++) scene.updateAnimation(.1);
  assert.equal(sheets(), 1);
  scene.setAgents([owner, agent('visitor')]);
  assert.equal(scene.approvalVisits.get('visitor').stage, 'return');
  assert.equal(sheets(), 0, 'the tray counts only current requests');
  let sheetShown = false, filed = 0, nod = 0, frames = 0;
  scene.updateAnimation(.05);
  assert.equal(scene.ownerAction?.kind, 'finish');
  while (scene.ownerAction && frames < 60) {
    frames++;
    sheetShown ||= boss.handSheet.visible;
    filed = Math.min(filed, boss.leftArm.rotation.z);
    nod = Math.max(nod, boss.head.rotation.x);
    assert.equal(boss.approvalStamp.visible, false, 'filing never shows the stamp');
    assert.equal(sheets(), scene.approvalRequests.size, 'the tray already shows the reported request count while the sheet is in hand');
    scene.updateAnimation(.05);
  }
  assert.ok(Math.abs(frames * .05 - OWNER_ACTION_SECONDS.finish) <= .06, `one gesture of ${OWNER_ACTION_SECONDS.finish}s: ${frames * .05}`);
  assert.ok(sheetShown, 'the sheet is in hand');
  assert.ok(filed < -.5, 'the left hand moves out to the tray');
  assert.ok(nod > .15, 'one nod');
  assert.equal(boss.handSheet.visible, false, 'the sheet merges into the pile');
  assert.equal(visitor.label.dataset.confirmed, undefined, 'no confirmation mark is invented');
  assert.deepEqual([boss.leftArm.rotation.x, boss.leftArm.rotation.z], [-.28, 0]);
  for (let frame = 0; scene.approvalVisits.size && frame < 500; frame++) scene.updateAnimation(.1);
  scene.setAgents([owner, agent('visitor'), { ...agent('second'), status: 'approval' }]);
  for (let frame = 0; scene.approvalVisits.get('second')?.stage !== 'waiting' && frame < 500; frame++) scene.updateAnimation(.1);
  scene.resolveApproval('second');
  scene.updateAnimation(.1);
  assert.equal(boss.approvalStamp.visible, true, 'approval.resolved still stamps');
  scene.setAgents([owner, agent('visitor'), agent('second')]);
  for (let frame = 0; frame < 30; frame++) {
    scene.updateAnimation(.1);
    assert.notEqual(scene.ownerAction?.kind, 'finish', 'a resolved visit is not filed a second time');
    assert.equal(boss.handSheet.visible, false);
  }
});

test('filing happens only at the desk and never late: a walking visitor or a second waiting visitor leaves no gesture', () => {
  const { scene } = fixture();
  const owner = { ...agent('boss'), status: 'idle' };
  scene.setAgents([owner, { ...agent('walker'), status: 'approval' }]);
  scene.updateAnimation(.1);
  assert.equal(scene.approvalVisits.get('walker').stage, 'out');
  scene.setAgents([owner, agent('walker')]);
  scene.updateAnimation(.1);
  assert.equal(scene.ownerAction ?? null, null, 'a visit that never reached the desk is not filed');
  for (let frame = 0; scene.approvalVisits.size && frame < 500; frame++) scene.updateAnimation(.1);
  scene.setAgents([owner, agent('walker'), { ...agent('first'), status: 'approval' }, { ...agent('second'), status: 'approval' }]);
  for (let frame = 0; [...scene.approvalVisits.values()].some(visit => visit.stage !== 'waiting') && frame < 500; frame++) scene.updateAnimation(.1);
  assert.equal([...scene.approvalVisits.values()].filter(visit => visit.stage === 'waiting').length, 2);
  scene.setAgents([owner, agent('walker'), agent('first'), { ...agent('second'), status: 'approval' }]);
  for (let frame = 0; frame < 40; frame++) {
    scene.updateAnimation(.1);
    assert.equal(scene.ownerAction ?? null, null, 'attending the second visitor outranks filing the first');
  }
  scene.setAgents([owner, agent('walker'), agent('first'), agent('second')]);
  scene.updateAnimation(.1);
  assert.equal(scene.ownerAction?.kind, 'finish', 'the last visitor leaving is filed');
  scene.setAgents([]);
});

test('instruction planes leave the owner computer only for visible employees, once per second and every four seconds per person', t => {
  const scene = actualGeometryFixture(t);
  let now = 10;
  scene.clockSeconds = () => now;
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, agent('first'), agent('second'), { ...agent('quiet'), status: 'idle', showCharacter: false }]);
  const boss = scene.figures[0], first = scene.figures[scene.agentSeats.get('first')];
  assert.equal(boss.screen.name, 'screen-0');
  const start = boss.screen.getWorldPosition(new THREE.Vector3());
  assert.equal(scene.sendInstructionPlane('first', 'instruction-1'), true);
  const flight = scene.paperFlights[0];
  assert.equal(flight.plane.name, 'instruction-paper-plane');
  assert.ok(flight.plane.position.distanceTo(start) < 1e-8, 'the plane leaves the owner computer');
  assert.ok(flight.curve.getPoint(1).distanceTo(first.screen.getWorldPosition(new THREE.Vector3())) < 1e-8, 'and lands on the employee computer');
  assert.equal(scene.effects.children.length, 2);
  assert.equal(scene.ownerAction?.kind, 'instruct');
  assert.equal(boss.pushUntil, 0, 'the owner reach replaces the generic push');
  const reach = [];
  for (let frame = 0; frame < 9; frame++) { scene.updateAnimation(.1); reach.push(boss.rightArm.rotation.x); }
  assert.ok(Math.min(...reach) < -1.2, 'the owner reaches out');
  assert.equal(reach.at(-1), -.25, 'and returns to the resting arm');
  assert.equal(scene.sendInstructionPlane('first', 'instruction-1'), false, 'a replayed event stays deduplicated');
  assert.equal(scene.sendInstructionPlane('second', 'instruction-2'), false, 'one owner plane per second');
  now = 10.99;
  assert.equal(scene.sendInstructionPlane('second', 'instruction-2'), false);
  now = 11;
  assert.equal(scene.sendInstructionPlane('second', 'instruction-2'), true, 'a refused call did not consume its event id');
  now = 12.5;
  assert.equal(scene.sendInstructionPlane('first', 'instruction-3'), false, 'the same employee waits four seconds');
  now = 14;
  assert.equal(scene.sendInstructionPlane('first', 'instruction-3'), true);
  now = 20;
  for (const target of ['quiet', 'ghost', 'boss']) assert.equal(scene.sendInstructionPlane(target, `to-${target}`), false, target);
  scene.buildingView = true;
  assert.equal(scene.sendInstructionPlane('second', 'building'), false, 'the office is not on screen in the building view');
  scene.buildingView = false;
  scene.setReducedMotion(true);
  assert.equal(scene.sendInstructionPlane('second', 'reduced'), false);
  scene.setReducedMotion(false);
  assert.equal(scene.effects.children.length, scene.paperFlights.length * 2);
  for (let frame = 0; scene.paperFlights.length && frame < 200; frame++) scene.updateAnimation(.1);
  assert.equal(scene.effects.children.length, 0);
  for (let event = 0; event < 32; event++) scene.sendPaperPlane('first', 'second', `burst-${event}`);
  now = 40;
  assert.equal(scene.sendInstructionPlane('second', 'over-capacity'), false, 'the 32-flight limit holds');
  assert.equal(scene.paperFlights.length, 32);
  assert.equal(scene.effects.children.length, 64);
  scene.setAgents([]);
  assert.equal(scene.effects.children.length, 0);
});

test('clicking the owner looks up, straightens the glasses and nods; five quick clicks spin only the seated body once', t => {
  const scene = actualGeometryFixture(t);
  let now = 100;
  scene.clockSeconds = () => now;
  scene.setAgents([{ ...agent('boss'), status: 'idle' }]);
  const boss = scene.figures[0];
  scene.updateAnimation(.1);
  assert.equal(scene.reactToOwnerClick(), true);
  assert.equal(scene.ownerAction?.kind, 'click');
  const bridge = boss.look.parts.find(part => part.parent === boss.head && part.position.z === .42);
  let up = 0, down = 0, nearest = Infinity;
  for (let frame = 0; frame < 16; frame++) {
    scene.updateAnimation(.1);
    scene.world.updateMatrixWorld(true);
    up = Math.min(up, boss.head.rotation.x); down = Math.max(down, boss.head.rotation.x);
    const hand = boss.rightArm.getObjectByName('employee-hand').getWorldPosition(new THREE.Vector3());
    nearest = Math.min(nearest, hand.distanceTo(bridge.getWorldPosition(new THREE.Vector3())));
  }
  assert.ok(up < -.15, 'looks up');
  assert.ok(down > .1, 'then nods');
  assert.ok(nearest < .3, `the right hand reaches the glasses: ${nearest}`);
  assert.equal(scene.ownerAction ?? null, null, `one reaction of ${OWNER_ACTION_SECONDS.click}s`);
  assert.deepEqual(boss.rightArm.position.toArray(), [.34, 1.4, .01]);
  const groupPose = () => [...boss.group.position.toArray(), ...boss.group.rotation.toArray().slice(0, 3)];
  const seated = groupPose();
  now = 200;
  for (const [index, at] of [200, 200.5, 201, 201.5, 202].entries()) {
    now = at;
    const accepted = scene.reactToOwnerClick();
    if (index === 0 || index === 4) assert.equal(accepted, true, `click ${index + 1}`);
    else assert.equal(accepted, false, 'a running reaction is not restarted');
  }
  assert.equal(scene.ownerAction?.kind, 'spin');
  let turned = 0;
  for (let frame = 0; frame < 20; frame++) {
    scene.updateAnimation(.1);
    turned = Math.max(turned, boss.detail.rotation.y);
    assert.deepEqual(groupPose(), seated, 'only the seated body turns');
  }
  assert.ok(turned > 4, `the body turns most of a full circle: ${turned}`);
  assert.ok(Math.abs(boss.detail.rotation.y) < .08, 'and returns to its swivel pose');
  now = 300;
  for (let click = 0; click < 8; click++) {
    now += 1;
    scene.reactToOwnerClick();
    assert.notEqual(scene.ownerAction?.kind, 'spin', 'clicks a second apart never spin');
    for (let frame = 0; frame < 3; frame++) scene.updateAnimation(.1);
  }
  for (let frame = 0; frame < 20; frame++) scene.updateAnimation(.1);
  scene.stampUntil = scene.elapsed + 1;
  now = 400;
  assert.equal(scene.reactToOwnerClick(), false, 'a stamp is never interrupted');
  scene.stampUntil = 0;
  scene.setReducedMotion(true);
  for (let click = 0; click < 5; click++) { now += .1; assert.equal(scene.reactToOwnerClick(), false); }
  scene.updateAnimation(.1);
  assert.equal(Math.abs(boss.detail.rotation.y), 0, 'reduced motion never spins');
  scene.setReducedMotion(false);
  assert.equal(scene.reactToOwnerClick(), true, 'ignored clicks do not count toward a later spin');
  assert.equal(scene.ownerAction?.kind, 'click');
});

test('an open card leaves only the bubble and a selection ring above its employee at detail LOD', () => {
  const { scene, figures } = fixture();
  scene.workMarkers = new WorkMarkers();
  scene.setAgents([{ ...agent('boss'), status: 'idle' }, { ...agent('worker'), activityKind: 'coding' }, { ...agent('other'), status: 'error' }]);
  const worker = figures[scene.agentSeats.get('worker')], other = figures[scene.agentSeats.get('other')];
  const byName = name => scene.workMarkers.group.getObjectByName(name);
  const ring = byName('work-status-ring'), triangle = byName('error-status-triangle'), selection = byName('work-selection-ring');
  // Decision 22 shapes: the working employee has a floor ring, the error employee a triangle above the head.
  const markers = () => { scene.updateDeskWork(); return [ring.count, triangle.count, selection.count]; };
  assert.deepEqual(markers(), [1, 1, 0]);
  assert.equal(worker.label.style.display, 'flex');
  assert.equal(worker.signal.visible, true);
  worker.bubble.style.display = 'block';
  scene.setCardOpen('worker');
  assert.equal(worker.label.style.display, 'none', 'the card already names the employee');
  assert.equal(worker.signal.visible, false, 'and shows the status');
  assert.equal(other.label.style.display, 'flex');
  assert.equal(other.signal.visible, true, 'other employees keep their markers');
  assert.deepEqual(markers(), [0, 1, 1], 'the status ring gives way to a selection ring while the other error mark stays');
  assert.equal(worker.bubble.style.display, 'block', 'the activity bubble stays');
  assert.equal(worker.halo.visible, false, 'the status halo under the person steps aside too');
  assert.equal(other.halo.visible, true, 'other employees keep their halo');
  scene.updateAnimation(.1);
  assert.equal(worker.signal.visible, false, 'frames keep the dots hidden');
  assert.equal(worker.halo.visible, false, 'frames keep the halo hidden');
  assert.equal(scene.showAgentName(worker), false);
  worker.detail = Object.assign(new THREE.Group(), { visible: false });
  assert.equal(scene.showAgentName(worker), true, 'far away, without a detailed body, the markers stay');
  scene.syncSignal(worker);
  assert.equal(worker.signal.visible, true);
  assert.deepEqual(markers(), [1, 1, 0]);
  worker.detail.visible = true;
  scene.setCardOpen(null);
  assert.equal(worker.label.style.display, 'flex');
  assert.equal(worker.signal.visible, true);
  assert.equal(worker.halo.visible, true, 'closing the card brings the halo back');
  assert.deepEqual(markers(), [1, 1, 0]);
  scene.setCardOpen('boss');
  assert.deepEqual(markers(), [1, 1, 0]);
  scene.workMarkers.dispose();
});

test('an open card hides the status halo through real detail levels and gives it back when closed', t => {
  const scene = actualGeometryFixture(t);
  scene.setAgents([agent('boss'), agent('card-a'), agent('card-b')]);
  const [a, b] = ['card-a', 'card-b'].map(id => scene.figures[scene.agentSeats.get(id)]);
  scene.updateDetailLevels();
  assert.equal(a.detail.visible && a.halo.visible && b.halo.visible, true, 'a small room shows detailed bodies with halos');
  const haloY = a.halo.position.y;
  scene.setCardOpen('card-a');
  assert.equal(a.halo.visible, false, 'opening the card hides the halo at once');
  scene.updateDetailLevels();
  assert.equal(a.halo.visible, false, 'detail levels keep it hidden while the card is open');
  assert.equal(b.halo.visible, true, 'other employees keep their halo');
  assert.equal(a.halo.position.y, haloY, 'only visibility changes');
  scene.setCardOpen(null);
  assert.equal(a.halo.visible, true, 'closing the card brings the halo back');
  scene.updateDetailLevels();
  assert.equal(a.halo.visible, true);
  const workers = Array.from({ length: 35 }, (_, index) => agent(`card-far-${index}`));
  scene.setAgents([agent('boss'), ...workers]);
  const far = scene.figures[scene.agentSeats.get('card-far-34')];
  scene.setCardOpen('card-far-34');
  scene.camera.top = 120; scene.camera.bottom = -120; scene.updateDetailLevels();
  const matrix = new THREE.Matrix4();
  scene.farFigures.getMatrixAt(far.seat, matrix);
  assert.equal(far.detail.visible, false);
  assert.equal(far.halo.visible, false, 'a distant body has no halo, card or not');
  assert.equal(matrix.determinant() !== 0, true, 'the distant instance still shows the person');
  scene.focusId = far.id; scene.updateDetailLevels();
  assert.equal(far.detail.visible, true);
  assert.equal(far.halo.visible, false, 'returning to detail with the card still open keeps the halo hidden');
  scene.setCardOpen(null); scene.updateDetailLevels();
  assert.equal(far.halo.visible, true, 'and closing it restores the halo');
});

// External calls: an employee's phone waits on the desk and rises to the ear only while an MCP tool runs (decisions 5-7, 13, 14, 41, 45).
const MCP = 'MCP 도구';
const worldOf = object => { object.updateWorldMatrix(true, false); return object.getWorldPosition(new THREE.Vector3()); };
const phoneWave = figure => figure.phoneBars.map(bar => bar.scale.y);

test('an employee on an MCP call turns about 20°, raises a lit phone to the ear in .6s and puts it down at once for approval or error', t => {
  const scene = actualGeometryFixture(t);
  const boss = { ...agent('boss'), status: 'idle' };
  const caller = { ...agent('caller'), activityKind: 'coding' }, second = { ...agent('second'), activityKind: 'documents' };
  const idler = { ...agent('idler'), status: 'idle' };
  const others = ['v4', 'v5', 'v6'].map(id => ({ ...agent(id), status: 'idle' }));
  const roster = (callerState = caller, secondState = second) => [boss, callerState, secondState, idler, ...others];
  scene.setAgents(roster());
  assert.equal(scene.figures[0].phone === undefined, true, 'the owner never uses a phone');
  const [figure, other, quiet] = ['caller', 'second', 'idler'].map(id => scene.figures[scene.agentSeats.get(id)]);
  for (const employee of scene.figures.slice(1)) {
    assert.equal(employee.phone?.parent === employee.detail, true, 'each phone rides in the detail LOD');
    assert.equal(employee.phoneScreen === undefined, true, 'no lit screen before a reported call');
  }
  scene.updateAnimation(.1);
  scene.world.updateMatrixWorld(true);
  // Every desk variation: the phone body lies on the actual beveled desktop and clears the items standing on it.
  for (const employee of scene.figures.slice(1)) {
    const probe = new THREE.Group();
    const seat = seatPosition(employee.seat);
    scene.workstation(seat.x, seat.z, employee.seat, probe);
    probe.updateMatrixWorld(true);
    const top = worldBox(probe.getObjectByName(`desk-top-${employee.seat}`));
    const body = worldBox(employee.phone.getObjectByName('phone-body')), whole = worldBox(employee.phone);
    assert.ok(Math.abs(body.min.y - top.max.y) < .002, `seat ${employee.seat}: on the desktop (${body.min.y} vs ${top.max.y})`);
    assert.ok(whole.min.x > top.min.x && whole.max.x < top.max.x && whole.min.z > top.min.z && whole.max.z < top.max.z, 'within the desk');
    probe.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object.name === `desk-top-${employee.seat}`) return;
      const item = worldBox(object);
      if (item.max.y <= top.max.y + .001) return;
      assert.equal(whole.intersectsBox(item), false, `seat ${employee.seat}: clears ${object.geometry.type} at ${item.getCenter(new THREE.Vector3()).toArray()}`);
    });
    probe.getObjectByName(`screen-${employee.seat}`).material.dispose();
  }
  const rest = worldOf(quiet.phone), restQuaternion = quiet.phone.getWorldQuaternion(new THREE.Quaternion());
  let swivel = 0;
  for (let frame = 0; frame < 40; frame++) {
    scene.updateAnimation(.1); scene.world.updateMatrixWorld(true);
    swivel = Math.max(swivel, Math.abs(quiet.detail.rotation.y));
    assert.ok(worldOf(quiet.phone).distanceTo(rest) < 1e-9, 'an idle swivel never slides the phone');
    assert.ok(quiet.phone.getWorldQuaternion(new THREE.Quaternion()).angleTo(restQuaternion) < 1e-6);
  }
  assert.ok(swivel > .02, `while the seated body really swivels: ${swivel}`);
  const deskPose = worldOf(figure.phone);
  scene.updateDeskWork();
  const props = figure.deskWork.group.getObjectByName('work-props-coding');
  const elbow = () => props.getObjectByName('robot-elbow').position.toArray();

  scene.setAgents(roster({ ...caller, toolName: MCP }));
  assert.equal(scene.container.dataset.phoneCalls, '1');
  assert.equal(figure.phoneScreen.visible, true, 'the call screen lights at once');
  assert.equal(figure.phoneBars.length, 9);
  assert.equal(figure.deskWork.onHold, true);
  const held = elbow();
  for (let frame = 0; frame < 3; frame++) { scene.updateAnimation(.1); scene.updateDeskWork(); }
  assert.ok(Math.abs(figure.callBlend - .5) < 1e-9, `half way after .3s: ${figure.callBlend}`);
  for (let frame = 0; frame < 4; frame++) { scene.updateAnimation(.1); scene.updateDeskWork(); }
  assert.equal(figure.callBlend, 1, `at the ear after ${CALL_ENTER_SECONDS}s`);
  assert.deepEqual(elbow(), held, 'the desk robot waits where it stopped');
  assert.equal(figure.deskWork.group.getObjectByName('work-props-coding') === props, true, 'the call keeps the same desk props');
  assert.ok(Math.abs(figure.detail.rotation.y - CALL_TURN_RADIANS) < 1e-9, 'the seated body turns about 20°');
  assert.deepEqual(figure.group.position.toArray(), figure.origin.toArray(), 'the person stays on the seat');
  scene.world.updateMatrixWorld(true);
  const hand = worldOf(figure.leftArm.getObjectByName('employee-hand'));
  const head = worldOf(figure.head), ear = figure.head.localToWorld(new THREE.Vector3(-.4, -.01, 0));
  const phone = worldOf(figure.phone);
  assert.ok(phone.distanceTo(ear) < .2, `the phone is at the ear: ${phone.distanceTo(ear)}`);
  assert.ok(hand.distanceTo(phone) < .2, `held by the hand: ${hand.distanceTo(phone)}`);
  assert.ok(phone.distanceTo(head) > .45, 'outside the head');
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(figure.phone.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(facing.dot(head.clone().sub(phone).normalize()) > .6, 'the screen faces the cheek');
  assert.equal(figure.mouthOpen.visible, true, 'talking');

  scene.setAgents(roster({ ...caller, toolName: MCP, status: 'approval' }));
  assert.equal(figure.callBlend, 0, 'approval puts the phone down at once');
  assert.deepEqual(figure.leftArm.position.toArray(), [-.34, 1.4, .01]);
  assert.equal(figure.phoneScreen.visible, false);
  assert.equal(figure.deskWork.onHold, false);
  assert.equal(scene.container.dataset.phoneCalls, '0');
  scene.world.updateMatrixWorld(true);
  assert.ok(worldOf(figure.phone).distanceTo(deskPose) < 1e-9, `back on the desk: ${worldOf(figure.phone).toArray()} vs ${deskPose.toArray()}`);
  let walked = 0;
  for (let frame = 0; frame < 300 && scene.approvalVisits.get('caller')?.stage !== 'waiting'; frame++) {
    scene.updateAnimation(.1); scene.world.updateMatrixWorld(true);
    walked = Math.max(walked, figure.group.position.distanceTo(figure.origin));
    assert.ok(worldOf(figure.phone).distanceTo(deskPose) < 1e-6, 'the phone stays on the desk while its owner walks');
  }
  assert.equal(scene.approvalVisits.get('caller')?.stage, 'waiting');
  assert.ok(walked > 2, `the visitor really left the desk: ${walked}`);

  const waitingCaller = { ...caller, toolName: MCP, status: 'approval' };
  scene.setAgents(roster(waitingCaller, { ...second, toolName: MCP }));
  for (let frame = 0; frame < 7; frame++) scene.updateAnimation(.1);
  assert.equal(other.callBlend, 1);
  scene.setAgents(roster(waitingCaller, { ...second, toolName: MCP, status: 'error' }));
  assert.equal(other.callBlend, 0, 'an error puts the phone down at once');
  assert.equal(other.phoneScreen.visible, false);
  scene.updateAnimation(.1);
  assert.equal(other.rightArm.rotation.x, -2.35, 'and the error pose takes over');
  assert.deepEqual(other.leftArm.position.toArray(), [-.34, 1.4, .01]);
  assert.equal(other.detail.rotation.y, 0);
  scene.setAgents([]);
});

test('reduced motion keeps a lit phone still on the desk, pause freezes a call, and waveforms step only at budgeted close-up desks', t => {
  const scene = actualGeometryFixture(t);
  const boss = { ...agent('boss'), status: 'idle' };
  const callers = Array.from({ length: 20 }, (_, i) => ({ ...agent(`caller-${i}`), activityKind: 'coding', toolName: MCP }));
  scene.setReducedMotion(true);
  scene.setAgents([boss, ...callers]);
  const figures = callers.map(entry => scene.figures[scene.agentSeats.get(entry.id)]);
  const first = figures[0];
  scene.updateAnimation(.1); scene.updateDeskWork(); scene.world.updateMatrixWorld(true);
  const desk = worldOf(first.phone);
  const pose = () => [...first.leftArm.position.toArray(), first.leftArm.rotation.x, first.leftArm.rotation.z, first.detail.rotation.y];
  const still = pose();
  for (let frame = 0; frame < 20; frame++) {
    scene.updateAnimation(.1); scene.updateDeskWork(); scene.world.updateMatrixWorld(true);
    assert.equal(first.callBlend, 0, 'no posture change with reduced motion');
    assert.deepEqual(pose(), still);
    assert.ok(worldOf(first.phone).distanceTo(desk) < 1e-9, 'the phone stays on the desk');
  }
  assert.ok(figures.every(figure => figure.phoneScreen.visible), 'its screen still shows the call');
  assert.deepEqual(phoneWave(first), CALL_WAVE_BARS, 'with a still waveform');
  assert.equal(scene.container.dataset.phoneCalls, '20');

  scene.setReducedMotion(false);
  for (let frame = 0; frame < 3; frame++) scene.updateAnimation(.1);
  assert.ok(Math.abs(first.callBlend - .5) < 1e-9);
  scene.setPaused(true);
  const paused = [first.callBlend, ...pose(), ...phoneWave(first)];
  for (let frame = 0; frame < 10; frame++) { scene.updateAnimation(.1); scene.updateDeskWork(); }
  assert.deepEqual([first.callBlend, ...pose(), ...phoneWave(first)], paused, 'pause freezes the call and its waveform');
  scene.setPaused(false);

  const initial = new Map(figures.map(figure => [figure, phoneWave(figure).join()]));
  const changed = new Set();
  for (let frame = 0; frame < 20; frame++) {
    scene.updateAnimation(.1); scene.updateDeskWork();
    for (const figure of figures) if (phoneWave(figure).join() !== initial.get(figure)) changed.add(figure.id);
  }
  assert.ok(figures.every(figure => figure.callBlend === 1), 'every detailed caller holds the phone');
  assert.ok(changed.size > 0 && changed.size <= 12, `waveforms step only within the twelve-desk budget: ${changed.size}`);
  assert.ok([...changed].every(id => scene.detailedWorkIds.has(id)));
  assert.ok(Number(scene.container.dataset.workProps) <= 12);
  const animated = figures.find(figure => changed.has(figure.id));
  scene.detailedWorkIds.clear();
  scene.updateAnimation(.1);
  assert.deepEqual(phoneWave(animated), CALL_WAVE_BARS, 'outside the budget the waveform is still again');
  scene.setAgents([]);
});

test('a phone and its call screen are built once per employee and reused through repeated calls and a new occupant', t => {
  const scene = actualGeometryFixture(t);
  const boss = { ...agent('boss'), status: 'idle' };
  const worker = { ...agent('caller'), activityKind: 'coding' }, call = { ...worker, toolName: MCP };
  scene.setAgents([boss, worker]);
  const figure = scene.figures[scene.agentSeats.get('caller')];
  const { phone } = figure;
  const resources = () => {
    const geometries = new Set(), materials = new Set();
    let meshes = 0;
    scene.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++; geometries.add(object.geometry);
      for (const material of [object.material].flat()) materials.add(material);
    });
    return [meshes, geometries.size, materials.size, scene.geometryCache.size];
  };
  const before = resources();
  scene.setAgents([boss, call]);
  const screen = figure.phoneScreen;
  const lit = resources();
  assert.equal(lit[0] - before[0], 13, 'the lit screen adds its glass, camera pill, icon, handset and nine bars once');
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let frame = 0; frame < 8; frame++) scene.updateAnimation(.1);
    assert.equal(figure.callBlend, 1);
    scene.setAgents([boss, worker]);
    for (let frame = 0; frame < 8; frame++) scene.updateAnimation(.1);
    assert.equal(figure.callBlend, 0);
    assert.deepEqual(figure.leftArm.position.toArray(), [-.34, 1.4, .14], 'the seated typing pivot returns exactly');
    scene.setAgents([boss, call]);
    assert.equal(figure.phone === phone, true, 'the same phone is reused'); assert.equal(figure.phoneScreen === screen, true, 'the same call screen is reused');
    assert.deepEqual(resources(), lit, `cycle ${cycle}: no new meshes, geometry or materials`);
  }
  for (let frame = 0; frame < 8; frame++) scene.updateAnimation(.1);
  scene.setAgents([boss, { ...agent('successor'), activityKind: 'coding', toolName: MCP }]);
  assert.equal(scene.figures[scene.agentSeats.get('successor')] === figure, true, 'the departed caller\'s figure is reused');
  assert.equal(figure.callBlend, 0, 'a new person starts from the desk');
  assert.deepEqual(figure.leftArm.position.toArray(), [-.34, 1.4, .01]);
  assert.equal(figure.phone === phone, true, 'the successor uses the same phone'); assert.equal(figure.phoneScreen === screen, true, 'and the same call screen');
  assert.equal(screen.visible, true);
  for (let frame = 0; frame < 7; frame++) scene.updateAnimation(.1);
  assert.equal(figure.callBlend, 1);
  scene.setAgents([]);
});
