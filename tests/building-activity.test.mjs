import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { BuildingOverview } from '../src/building-overview.ts';
import { MAX_OFFICE_AGENTS } from '../src/office-layout.ts';

const kinds = ['coding', 'documents', 'research', 'testing', 'reviewing', 'planning', 'design', 'delivery', 'shipping', 'general'];
function fixture(t) {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  const overview = new BuildingOverview(window.document.createElement('div'), () => {});
  t.after(() => { overview.dispose(); window.close(); globalThis.document = previous; });
  const set = (agents) => {
    overview.setFloors([{ id: 'project', name: '사무실', agents }]);
    return overview.floors.get('project');
  };
  return { overview, set };
}
const employee = (activityKind, status = 'working', id = 'worker') => ({ id, activityKind, status });
const matrices = mesh => Array.from(mesh.instanceMatrix.array);
const rigs = floor => [floor.workBoxes, floor.workSpheres, floor.workHoops];
const characterMeshes = floor => [floor.bodies, floor.heads, floor.hair, floor.knees, floor.arms];
const snapshot = floor => floor.activityMeshes.map(matrices);
function visibleCount(mesh) {
  const matrix = new THREE.Matrix4();
  let result = 0;
  for (let index = 0; index < mesh.count; index++) { mesh.getMatrixAt(index, matrix); if (Math.abs(matrix.determinant()) > 1e-10) result++; }
  return result;
}
function color(mesh, index = 0) { return mesh.getColorAt(index, new THREE.Color()).getHexString(); }

test('all ten observed work kinds have distinct desk rigs without rebuilding an employee or floor', t => {
  const { overview, set } = fixture(t);
  const signatures = new Set();
  const floor = set([employee('coding')]);
  const originalMeshes = floor.activityMeshes.slice();
  for (const kind of kinds) {
    assert.equal(set([employee(kind)]) === floor, true, `${kind}: the floor is reused`);
    overview.update(0, false, true);
    assert.equal(floor.activityMeshes.length === originalMeshes.length && floor.activityMeshes.every((mesh, i) => mesh === originalMeshes[i]), true,
      `${kind}: the activity meshes are reused`);
    assert.ok(rigs(floor).reduce((count, mesh) => count + visibleCount(mesh), 0) >= 3, kind);
    signatures.add(JSON.stringify(rigs(floor).map(mesh => ({ transforms: matrices(mesh), colors: Array.from(mesh.instanceColor.array) }))));
  }
  assert.equal(signatures.size, kinds.length, 'coding, documents, and other work remain different even with motion reduced');
});

test('bright coral work rings, dashed rings for thinking and reviewing, dark red error pins and amber approval diamonds appear on the correct employee only', t => {
  const { set } = fixture(t);
  const statuses = ['working', 'thinking', 'reviewing', 'error', 'approval', 'idle', 'waiting', 'done'];
  const floor = set(statuses.map((status, i) => employee('documents', status, `worker-${i}`)));
  // Decision 22: color is never the only cue, so each status shape in the status table owns exactly one marker mesh.
  const shapes = [[floor.activityRings, [0], 'ff5b54'], [floor.activityDashes, [1, 2], 'ff5b54'], [floor.activityHeads, [4], 'e6bd61'],
    [floor.activityPins, [3], 'ffffff']];
  for (const [mesh, owners, hex] of shapes) {
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
    for (let i = 0; i < statuses.length; i++) {
      mesh.getMatrixAt(i, matrix);
      if (owners.includes(i)) {
        assert.ok(matrix.determinant() > 0, `${mesh.name}: ${statuses[i]}`);
        position.setFromMatrixPosition(matrix);
        assert.ok(Math.abs(position.x - floor.points[i].x) < 1e-5, 'a highlight belongs to its own seat');
        assert.equal(color(mesh, i), hex);
      } else assert.equal(matrix.determinant(), 0, `${mesh.name}: ${statuses[i]}`);
    }
  }
  const pinColors = floor.activityPins.geometry.getAttribute('color');
  assert.equal(new THREE.Color(pinColors.getX(0), pinColors.getY(0), pinColors.getZ(0)).getHexString(), 'ba3344', 'the pin body is the error red');
  // The dashed ring shares the solid ring's radii but leaves gaps around the circle.
  const dashes = floor.activityDashes.geometry.getAttribute('position');
  const angles = [], radii = [];
  for (let i = 0; i < dashes.count; i++) {
    angles.push((Math.atan2(dashes.getY(i), dashes.getX(i)) + Math.PI * 2) % (Math.PI * 2));
    radii.push(Math.hypot(dashes.getX(i), dashes.getY(i)));
  }
  assert.ok(radii.every(radius => radius > .72 - 1e-5 && radius < 1 + 1e-5), 'dashes stay inside the ring band');
  const sorted = [...new Set(angles.map(angle => angle.toFixed(5)))].map(Number).sort((a, b) => a - b);
  const gaps = sorted.map((angle, i) => (sorted[i + 1] ?? sorted[0] + Math.PI * 2) - angle);
  assert.ok(gaps.filter(gap => gap > .15).length >= 8, 'the ring is broken into separate dashes');
});

test('paused and reduced motion freeze work rigs while preserving readable static work and status', t => {
  const { overview, set } = fixture(t);
  for (const kind of kinds) {
    const floor = set([employee(kind)]);
    overview.update(.19, false, false);
    const before = snapshot(floor);
    overview.update(.31, false, false);
    const moving = snapshot(floor);
    assert.notDeepEqual(moving.slice(0, 3), before.slice(0, 3), kind);
    overview.update(9, true, false);
    assert.deepEqual(snapshot(floor), moving, `${kind}: pause preserves the exact pose`);
    overview.update(.1, false, true);
    const reduced = snapshot(floor);
    overview.update(9, false, true);
    assert.deepEqual(snapshot(floor), reduced, `${kind}: reduced motion is static`);
    assert.equal(visibleCount(floor.activityRings), 1);
    assert.ok(rigs(floor).some(mesh => visibleCount(mesh) > 0));
  }
});

test('ended or waiting tasks remove every work prop; error and approval retain static evidence without work motion', t => {
  const { overview, set } = fixture(t);
  const floor = set([employee('research')]);
  for (const status of ['error', 'approval']) {
    set([employee('research', status)]);
    const before = snapshot(floor);
    const arms = matrices(floor.arms);
    overview.update(3, false, false);
    assert.deepEqual(snapshot(floor), before, status);
    assert.deepEqual(matrices(floor.arms), arms, `${status}: a waiting employee does not keep typing`);
    assert.ok(rigs(floor).some(mesh => visibleCount(mesh) > 0));
  }
  for (const status of ['idle', 'done', 'waiting']) {
    set([employee('research', status)]);
    for (const mesh of floor.activityMeshes) assert.equal(visibleCount(mesh), 0, `${status}: ${mesh.name}`);
  }
  set([employee(undefined)]);
  assert.ok(visibleCount(floor.workBoxes) > 0, 'unknown active work uses the general rig');
  assert.equal(visibleCount(floor.workHoops), 0, 'an old research drone does not survive an unknown-kind change');
});

test('building nameplates separate working employees from approvals and errors with exact non-zero counts', t => {
  const { set } = fixture(t);
  const floor = set([employee('coding'), employee('research', 'approval', 'approval'), employee('testing', 'error', 'error')]);
  // Decision 35: approvals and errors are counted separately and zero states are omitted.
  assert.equal(floor.labelCounts.textContent, '작업 1 · 확인 요청 1 · 오류 1');
  assert.match(floor.label.getAttribute('aria-label'), /작업 중 1명, 확인 요청 1명, 오류 1명$/);
});

test('large floors keep a fixed seven activity draw objects and reuse transforms and colors every frame', t => {
  const { overview, set } = fixture(t);
  const small = set([employee('coding')]);
  const drawObjects = small.group.children.length;
  const floor = set(Array.from({ length: MAX_OFFICE_AGENTS }, (_, i) => employee(kinds[i % kinds.length], 'working', `worker-${i}`)));
  assert.equal(floor.group.children.length, drawObjects);
  // Three rigs plus one marker mesh per status shape (ring, dashed ring, diamond, pin), independent of roster size.
  assert.equal(floor.activityMeshes.length, 7);
  assert.equal(floor.activityRings.count, MAX_OFFICE_AGENTS);
  const buffers = floor.activityMeshes.map(mesh => [mesh.instanceMatrix.array, mesh.instanceColor.array]);
  for (let i = 0; i < 20; i++) overview.update(1 / 30, false, false);
  floor.activityMeshes.forEach((mesh, i) => {
    assert.equal(mesh.instanceMatrix.array === buffers[i][0], true, `${mesh.name} keeps its matrix buffer`);
    assert.equal(mesh.instanceColor.array === buffers[i][1], true, `${mesh.name} keeps its color buffer`);
    assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
  });
});

test('work objects remain in their own desktop footprint and do not enlarge the office or camera bounds', t => {
  const { overview, set } = fixture(t);
  const floor = set(kinds.map((kind, i) => employee(kind, 'working', `worker-${i}`)));
  const originalRadius = overview.radius;
  const matrix = new THREE.Matrix4(), bounds = new THREE.Box3();
  for (let frame = 0; frame < 12; frame++) {
    overview.update(.15, false, false);
    for (const mesh of rigs(floor)) {
      mesh.geometry.computeBoundingBox();
      const slots = mesh.count / floor.agents.length;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        if (matrix.determinant() === 0) continue;
        bounds.copy(mesh.geometry.boundingBox).applyMatrix4(matrix);
        const seat = floor.points[Math.floor(i / slots)];
        assert.ok(bounds.min.x >= seat.x - 1.825 && bounds.max.x <= seat.x + 1.825, mesh.name);
        assert.ok(bounds.min.z >= seat.z - 1.875 && bounds.max.z <= seat.z - .225, mesh.name);
        assert.ok(bounds.min.y >= 1.2 && bounds.max.y < 2.65, mesh.name);
      }
    }
  }
  assert.equal(overview.radius, originalRadius);
});

test('a hidden employee keeps their desk, floor, camera bounds and observed message endpoints, then returns to the same seat', t => {
  const { overview, set } = fixture(t);
  const worker = { ...employee('coding'), showCharacter: true };
  const floor = set([worker]);
  overview.show(true, 'project');
  overview.update(0, true, true);
  const characters = characterMeshes(floor);
  const originalCharacters = characters.map(matrices);
  const furniture = floor.group.children.filter(mesh => mesh instanceof THREE.InstancedMesh
    && !characters.includes(mesh) && !floor.activityMeshes.includes(mesh));
  const originalFurniture = furniture.map(matrices);
  const points = floor.points;
  const anchor = overview.anchors.get(worker.id).clone();
  const radius = overview.radius;
  const center = overview.center.clone();
  const focus = overview.focusPoint('project');
  assert.equal(overview.sendMessagePlane(worker.id, 'before-hiding'), true);

  for (const status of ['idle', 'waiting', 'done']) {
    assert.equal(set([{ ...worker, status, showCharacter: false }]) === floor, true, `${status}: hiding keeps the floor`);
    overview.update(.1, true, false);
    assert.equal(floor.points, points);
    assert.equal(overview.radius, radius);
    assert.deepEqual(overview.center, center);
    assert.deepEqual(overview.focusPoint('project'), focus);
    assert.deepEqual(overview.anchors.get(worker.id), anchor);
    assert.equal(overview.selected, 'project');
    assert.equal(overview.hasAgent(worker.id), true);
    assert.equal(overview.activeFlightCount, 1, 'an in-flight observed message survives hiding');
    assert.ok(characters.every(mesh => visibleCount(mesh) === 0), status);
    assert.ok(floor.activityMeshes.every(mesh => visibleCount(mesh) === 0), status);
    assert.deepEqual(furniture.map(matrices), originalFurniture);
  }
  assert.equal(overview.sendMessagePlane(worker.id, 'after-hiding'), true);
  assert.equal(overview.sendMessagePlane(worker.id, 'after-hiding'), false, 'message identity stays deduplicated');
  assert.equal(overview.activeFlightCount, 2);

  assert.equal(set([worker]) === floor, true, 'showing again keeps the floor');
  overview.update(0, true, true);
  assert.deepEqual(characters.map(matrices), originalCharacters);
  assert.deepEqual(furniture.map(matrices), originalFurniture);
  assert.equal(floor.points, points);
  assert.equal(overview.radius, radius);
  assert.deepEqual(overview.anchors.get(worker.id), anchor);
});

test('explicit character visibility preserves active and attention states and the legacy default remains visible', t => {
  const { overview, set } = fixture(t);
  const statuses = ['working', 'thinking', 'reviewing', 'approval', 'error'];
  for (const status of statuses) {
    const floor = set([{ ...employee('general', status), showCharacter: true }]);
    assert.ok(characterMeshes(floor).every(mesh => visibleCount(mesh) === mesh.count), status);
    const markers = [floor.activityRings, floor.activityDashes, floor.activityHeads, floor.activityPins];
    assert.equal(markers.reduce((count, mesh) => count + visibleCount(mesh), 0), 1, `${status}: exactly one status marker`);
  }
  const legacy = set([employee(undefined, 'idle')]);
  assert.ok(characterMeshes(legacy).every(mesh => visibleCount(mesh) === mesh.count), 'omitting the option preserves existing callers');
  const hidden = set([{ ...employee('coding'), showCharacter: false }]);
  overview.update(.3, false, false);
  assert.ok(characterMeshes(hidden).every(mesh => visibleCount(mesh) === 0));
  assert.ok(hidden.activityMeshes.every(mesh => visibleCount(mesh) === 0));
});
