import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { BuildingOverview, BUILDING_VIEW, DETAIL_RADIUS, HAZE_INTENSITY, RAIL_MIN_FLOORS, floorKeyStep, floorSummary } from '../src/building-overview.ts';

function fixture(t) {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const opened = [], focused = [];
  const overview = new BuildingOverview(container, id => opened.push(id), id => focused.push(id));
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; overview.dispose(); } };
  t.after(() => { dispose(); window.close(); globalThis.document = previous; });
  return { overview, container, opened, focused, dispose, window, document: window.document };
}
const person = (id, status = 'working', extra = {}) => ({ id, name: id, status, ...extra });
const crowd = (prefix, count, status = 'working') => Array.from({ length: count }, (_, i) => person(`${prefix}-${i}`, status));
const project = (id, agents, extra = {}) => ({ id, name: id, agents, ...extra });
const hex = (mesh, index) => mesh.getColorAt(index, new THREE.Color()).getHexString();
function visibleCount(mesh) {
  const matrix = new THREE.Matrix4();
  let result = 0;
  for (let index = 0; index < mesh.count; index++) { mesh.getMatrixAt(index, matrix); if (Math.abs(matrix.determinant()) > 1e-10) result++; }
  return result;
}
const toward = (() => {
  const { yaw, elevation } = BUILDING_VIEW;
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
})();
/** A pointer ray from the default building camera direction (optionally turned with the model) through a world point. */
function viewRay(target, direction = toward) {
  const raycaster = new THREE.Raycaster();
  raycaster.set(target.clone().addScaledVector(direction, 300), direction.clone().negate());
  return raycaster;
}
/** Horizontal offset across the view, so a shifted ray never slides back onto the target further down. */
const across = new THREE.Vector3(Math.cos(BUILDING_VIEW.yaw), 0, -Math.sin(BUILDING_VIEW.yaw));
function worldPoint(floor, x, y, z) {
  floor.group.updateWorldMatrix(true, false);
  return floor.group.localToWorld(new THREE.Vector3(x, y, z));
}
const materialsOf = floor => new Map(floor.group.children.filter(child => child.isMesh).map(child => [child, child.material]));
const rail = container => container.querySelector('.building-floor-rail');
const railItems = container => [...container.querySelectorAll('.building-rail-floor')];
const railItem = (container, id) => railItems(container).find(item => item.dataset.projectId === id);

test('pickFloor returns the storey a view ray enters first, through any parent transform, and nothing when hidden or missed', t => {
  const { overview } = fixture(t);
  overview.setFloors(['low', 'mid', 'top'].map(id => project(id, crowd(id, 4))));
  const holder = new THREE.Group(); holder.position.set(12, 3, -7); holder.rotation.y = .4;
  holder.add(overview.group);
  const turned = toward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), .4);
  const pick = (floor, x, y, z) => overview.pickFloor(viewRay(worldPoint(floor, x, y, z), turned));
  const low = overview.floors.get('low');
  assert.equal(pick(low, 0, .1, low.depth / 2 - 1), null, 'a hidden building picks nothing');
  overview.show(true);
  for (const id of ['low', 'mid', 'top']) {
    const floor = overview.floors.get(id);
    for (const point of floor.points) {
      assert.equal(pick(floor, point.x, .1, floor.depth / 2 - 1), id, `${id}: the open front of the floor under x=${point.x}`);
      assert.equal(pick(floor, point.x, 2, floor.depth / 2 - .3), id, `${id}: the open space of the storey under x=${point.x}`);
    }
    assert.equal(pick(floor, floor.width / 2 - .5, 1.2, 0), id, `${id}: the right side of the storey`);
  }
  // From the default camera the back-row heads of a one-row floor sit behind the slab of the floor above.
  for (const point of low.points.slice(0, 3)) assert.equal(pick(low, point.x, 1.9, point.z), 'mid', 'the storey whose slab hides the point wins');
  assert.equal(pick(overview.floors.get('mid'), -3.3, 1.9, -2.8), 'top');
  assert.equal(overview.pickFloor(viewRay(new THREE.Vector3(900, 0, -900), turned)), null, 'a ray past the building picks nothing');
  overview.show(false);
  assert.equal(pick(low, 0, .1, low.depth / 2 - 1), null);
});

test('pickAgent picks only drawn people on the given detailed floor, and its target widens with the camera distance', t => {
  const { overview } = fixture(t);
  const agents = [person('a'), person('b', 'approval'), person('ghost', 'working', { showCharacter: false }), person('d', 'error')];
  overview.setFloors([project('lab', agents), project('other', crowd('other', 2))]);
  overview.show(true);
  const floor = overview.floors.get('lab');
  const head = i => worldPoint(floor, floor.points[i].x, 1.96, floor.points[i].z);
  assert.equal(overview.pickAgent(viewRay(head(0)), 'lab'), 'a');
  assert.equal(overview.pickAgent(viewRay(head(1)), 'lab'), 'b');
  assert.equal(overview.pickAgent(viewRay(head(3)), 'lab'), 'd');
  assert.notEqual(overview.pickAgent(viewRay(head(2)), 'lab'), 'ghost', 'a person who is not drawn cannot be picked');
  assert.equal(overview.pickAgent(viewRay(head(0)), 'other'), null, 'another floor does not answer for this floor');
  assert.equal(overview.pickAgent(viewRay(head(0)), 'missing'), null);
  assert.equal(overview.pickAgent(viewRay(new THREE.Vector3(900, 0, -900)), 'lab'), null);

  const beside = head(0).addScaledVector(across, .9);
  overview.update(0, true, false, .05);
  assert.equal(overview.pickAgent(viewRay(beside), 'lab'), null, 'close up the target hugs the body');
  overview.update(0, true, false, .2);
  assert.equal(overview.pickAgent(viewRay(beside), 'lab'), 'a', 'from far away the target stays about fourteen pixels wide');
  overview.show(false);
  assert.equal(overview.pickAgent(viewRay(head(0)), 'lab'), null, 'a hidden building picks nobody');
});

test('focusFloor paints a navy slab edge on its floor and hazes the other floors and their shell storeys without touching status markers or making per-frame materials', t => {
  const { overview, dispose } = fixture(t);
  const roster = id => [person(`${id}-work`), person(`${id}-ask`, 'approval'), person(`${id}-bug`, 'error')];
  overview.setFloors(['low', 'mid', 'top'].map(id => project(id, roster(id))));
  overview.show(true);
  const shellMesh = name => overview.shell.children.find(object => object.name === name);
  const structure = shellMesh('building-structure'), ceilings = shellMesh('building-ceilings'), focusEdge = shellMesh('building-focus-edge');
  const floors = () => ['low', 'mid', 'top'].map(id => overview.floors.get(id));
  const before = new Map(floors().map(floor => [floor.id, materialsOf(floor)]));
  const haze = new THREE.Color('#f2f7fa');
  const sameColor = (a, b) => Math.abs(a.r - b.r) < 1e-5 && Math.abs(a.g - b.g) < 1e-5 && Math.abs(a.b - b.b) < 1e-5;
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  const instanceBox = (mesh, index) => {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
    return new THREE.Box3(new THREE.Vector3(-.5, -.5, -.5), new THREE.Vector3(.5, .5, .5)).applyMatrix4(matrix);
  };
  // Decision 48: above the ground floor the slab edge bands are see-through ceilings, so the navy focus band is its own opaque
  // two-instance mesh laid just around the focus floor's front and side bands.
  const assertEdge = id => {
    if (!id) { assert.equal(focusEdge.count, 0, 'no navy band without a focus'); return; }
    const floor = overview.floors.get(id), [front, side] = [0, 1].map(index => instanceBox(focusEdge, index));
    assert.equal(focusEdge.count, 2, `${id}: a front and a side band`);
    assert.equal(close(front.max.y, floor.level + .03) && close(front.min.y, floor.level - .79) && close(side.max.y, front.max.y), true,
      `${id}: the navy band hangs from the focus floor, just proud of its slab band`);
    assert.equal(front.min.z < floor.depth / 2 && front.max.z > floor.depth / 2 + .26 && close(front.max.x - front.min.x, floor.width + .38)
      && side.min.x < floor.width / 2 && side.max.x > floor.width / 2 + .26 && close(side.max.z - side.min.z, floor.depth + .38), true, `${id}: along the open front and the right side`);
    assert.equal(hex(focusEdge, 0) === '3f5d78' && hex(focusEdge, 1) === '3f5d78', true, 'the design navy');
    assert.equal(focusEdge.material.transparent, false, 'the focus band stays opaque through see-through ceilings');
  };
  // Every storey part fades except on the focus floor, in the solid structure and the see-through ceilings; roof, core and entrance never fade.
  const assertShell = focus => {
    const parts = [
      { name: 'structure', mesh: structure, base: overview.structureBase, starts: overview.storeySlots, roof: overview.roofSlot },
      { name: 'ceiling', mesh: ceilings, base: overview.ceilingBase, starts: overview.ceilingSlots, roof: overview.ceilingRoofSlot },
    ];
    for (const { name, mesh, base, starts, roof } of parts) {
      const colorAt = slot => mesh.getColorAt(slot, new THREE.Color()), plainAt = slot => new THREE.Color().fromArray(base, slot * 3);
      assert.equal(starts.length, 3);
      for (let index = 0; index < starts.length; index++) {
        const start = starts[index], end = starts[index + 1] ?? roof;
        if (mesh === structure) assert.ok(end - start >= 10, 'each storey owns its columns, walls and stair');
        else assert.equal(end - start, index ? 4 : 2, 'each storey owns two beams, and above the ground floor two see-through edge bands');
        for (let slot = start; slot < end; slot++) {
          const expected = focus >= 0 && index !== focus ? plainAt(slot).lerp(haze, HAZE_INTENSITY) : plainAt(slot);
          assert.equal(sameColor(colorAt(slot), expected), true, `focus ${focus}: ${name} storey ${index}, part ${slot - start}`);
        }
      }
      assert.ok(mesh.count - roof >= 4, `${name}: the roof keeps its own parts`);
      for (let slot = roof; slot < mesh.count; slot++) assert.equal(sameColor(colorAt(slot), plainAt(slot)), true, `${name} roof part ${slot} never fades`);
    }
  };
  const markers = floor => [floor.activityRings, floor.activityDashes, floor.activityHeads, floor.activityPins];
  const assertClear = floor => {
    const known = before.get(floor.id), twins = new Set(overview.hazedMaterials.values());
    for (const child of floor.group.children.filter(object => object.isMesh)) {
      if (known?.has(child)) assert.equal(child.material === known.get(child), true, `${floor.id}: original material`);
      assert.equal(twins.has(child.material), false, `${floor.id}: no hazed twin left behind`);
      if (child.material.isMeshStandardMaterial) {
        assert.equal(child.material.emissive.getHexString(), '000000'); assert.equal(child.material.emissiveIntensity, 1);
      }
    }
    assert.equal(floor.label.dataset.dimmed, 'false');
  };
  const assertHazed = floor => {
    for (const child of floor.group.children.filter(object => object.isMesh)) {
      if (markers(floor).includes(child)) { assert.equal(child.material.isMeshBasicMaterial, true, 'status markers keep their basic material'); continue; }
      assert.equal(child.material.emissive.getHexString(), 'f2f7fa', `${floor.id}: hazed`);
      assert.equal(child.material.emissiveIntensity, HAZE_INTENSITY);
    }
    assert.equal(floor.label.dataset.dimmed, 'true');
  };
  assertEdge(null);
  assertShell(-1);
  const markerMaterials = floors().flatMap(floor => markers(floor).map(mesh => mesh.material));
  const sameMarkers = () => floors().flatMap(floor => markers(floor).map(mesh => mesh.material)).every((material, i) => material === markerMaterials[i]);

  overview.focusFloor('mid');
  assert.equal(overview.focusedFloor, 'mid');
  let [low, mid, top] = floors();
  assertClear(mid); assertHazed(low); assertHazed(top);
  assert.equal(mid.label.dataset.focused, 'true'); assert.equal(low.label.dataset.focused, 'false');
  assertEdge('mid');
  assertShell(1);
  // The ground floor slab is solid and upper slabs are see-through ceilings (decision 48), so the shared desk-top colour is compared.
  assert.equal(low.group.children[2].material === top.group.children[2].material, true, 'floors share one hazed twin per shared colour');
  assert.equal(low.group.children[0].material !== top.group.children[0].material && top.group.children[0].material.transparent, true,
    'a solid slab and a see-through ceiling slab keep separate hazed twins');
  assert.equal(sameMarkers(), true, 'status marker materials never change');
  const twins = overview.hazedMaterials.size;

  overview.focusFloor('top');
  assertClear(top); assertHazed(mid); assertHazed(low);
  assertEdge('top');
  assertShell(2);
  assert.equal(overview.hazedMaterials.size, twins, 'moving the focus reuses the hazed twins');
  const versions = () => [structure.instanceColor.version, ceilings.instanceColor.version, focusEdge.instanceMatrix.version];
  const painted = versions(), materialCount = overview.materials.size;
  for (let frame = 0; frame < 20; frame++) overview.update(1 / 30, false, false);
  assert.deepEqual(versions(), painted, 'frames do not repaint the haze or the focus edge');
  assert.equal(overview.hazedMaterials.size, twins); assert.equal(overview.materials.size, materialCount);
  overview.focusFloor('top');
  assert.deepEqual(versions(), painted, 'focusing the same floor again changes nothing');

  // A roster change that lays the shell out again keeps the focus edge, and a rebuilt floor is hazed straight away.
  overview.setFloors([project('low', roster('low')), project('mid', [...roster('mid'), ...crowd('mid-more', 12)]), project('top', roster('top'))]);
  [low, mid, top] = floors();
  assertHazed(mid);
  assertEdge('top');
  assertShell(2);

  overview.focusFloor(null);
  assert.equal(overview.focusedFloor, null);
  for (const floor of floors()) assertClear(floor);
  assertEdge(null);
  assertShell(-1);

  overview.focusFloor('missing');
  assert.equal(overview.focusedFloor, null, 'an unknown floor clears the focus');
  overview.focusFloor('top');
  overview.setFloors([project('low', roster('low')), project('mid', roster('mid'))]);
  assert.equal(overview.focusedFloor, null, 'removing the focus floor clears the focus');
  for (const floor of [overview.floors.get('low'), overview.floors.get('mid')]) assert.equal(floor.dimmed, false);

  const released = new Map();
  for (const twin of overview.hazedMaterials.values()) twin.addEventListener('dispose', () => released.set(twin, (released.get(twin) ?? 0) + 1));
  const count = overview.hazedMaterials.size;
  assert.ok(count > 0);
  dispose();
  assert.equal(released.size, count);
  assert.ok([...released.values()].every(times => times === 1), 'each hazed twin is released exactly once');
});

test('tall buildings list every floor on an elevator rail, detail only the focus floor and keep approval and error marks on compressed floors', t => {
  const { overview, container, focused, opened, document, window } = fixture(t);
  const agentsFor = i => [person(`f${i}-work`), ...(i === 0 || i === 10 ? [person(`f${i}-ask`, 'approval')] : []), ...(i === 11 ? [person(`f${i}-bug`, 'error')] : [])];
  const building = count => Array.from({ length: count }, (_, i) => project(`f${i}`, agentsFor(i)));

  overview.setFloors(building(RAIL_MIN_FLOORS - 1));
  overview.show(true);
  assert.equal(overview.railActive, false);
  assert.equal(rail(container) === null, true, 'eight floors keep the plain building without a rail');
  overview.focusFloor('f3');
  assert.ok([...overview.floors.values()].every(floor => floor.detailed && floor.detailMeshes.every(mesh => mesh.visible)), 'a short building never compresses floors');
  overview.focusFloor(null);

  overview.setFloors(building(12));
  assert.equal(overview.railActive, true);
  const list = rail(container);
  assert.equal(list?.tagName, 'OL');
  assert.equal(list.hasAttribute('reversed'), true);
  assert.equal(list.hidden, false);
  assert.deepEqual(railItems(container).map(item => item.dataset.projectId), Array.from({ length: 12 }, (_, i) => `f${11 - i}`), 'top floor first');
  assert.deepEqual(railItems(container).map(item => item.querySelector('.building-rail-number').textContent), Array.from({ length: 12 }, (_, i) => `${12 - i}F`));
  // Without a focus or a camera floor every storey is compressed.
  for (const floor of overview.floors.values()) {
    assert.equal(floor.detailed, false);
    assert.ok(floor.detailMeshes.every(mesh => !mesh.visible), `${floor.id}: furniture and people hidden`);
    assert.equal(floor.activityHeads.visible && floor.activityPins.visible, true, `${floor.id}: attention markers stay`);
  }
  for (const item of railItems(container)) {
    const id = item.dataset.projectId;
    assert.equal(item.dataset.detail, 'false');
    assert.equal(item.querySelector('.building-rail-counts').hidden, true);
    const [approval, error] = item.querySelectorAll('.building-rail-alert');
    assert.deepEqual([approval.dataset.state, approval.dataset.shape, error.dataset.state, error.dataset.shape], ['approval', 'diamond', 'error', 'triangle']);
    assert.equal(approval.hidden, !(id === 'f0' || id === 'f10'), `${id}: approval mark only where a request waits`);
    assert.equal(error.hidden, id !== 'f11', `${id}: error mark only where an error is reported`);
    if (!approval.hidden) assert.equal(approval.textContent, '1');
  }
  assert.equal(railItem(container, 'f10').querySelector('button').getAttribute('aria-label'), '11층 f10 · 작업 중 1명, 확인 요청 1명');
  const tabStops = () => railItems(container).filter(item => item.querySelector('button').getAttribute('tabindex') === '0').map(item => item.dataset.projectId);
  assert.deepEqual(tabStops(), ['f11'], 'roving tab stop: without a focus or camera floor only the top floor button is tabbable');
  assert.ok(railItems(container).every(item => ['0', '-1'].includes(item.querySelector('button').getAttribute('tabindex'))));
  const compressed = overview.floors.get('f10'), armsVersion = compressed.arms.instanceMatrix.version;
  for (let frame = 0; frame < 10; frame++) overview.update(1 / 30, false, false, .3);
  assert.equal(compressed.arms.instanceMatrix.version, armsVersion, 'compressed floors do not rewrite hidden people every frame');
  assert.equal(visibleCount(compressed.activityHeads), 1, 'the approval diamond remains on a compressed floor');
  assert.equal(visibleCount(overview.floors.get('f11').activityPins), 1, 'the error pin remains on a compressed floor');

  overview.focusFloor('f5');
  // Building.dc.html and Main.dc.html: above eight floors only the focus floor keeps furniture and characters.
  assert.equal(DETAIL_RADIUS, 0);
  const band = id => id === 'f5';
  for (const floor of overview.floors.values()) {
    assert.equal(floor.detailed, band(floor.id), floor.id);
    assert.ok(floor.detailMeshes.every(mesh => mesh.visible === band(floor.id)));
    assert.equal(floor.label.dataset.detail, String(band(floor.id)));
  }
  const f5 = overview.floors.get('f5');
  assert.equal(visibleCount(f5.activityRings), 1, 'a floor entering the detail band places its work ring at once');
  for (const item of railItems(container)) {
    const detailed = band(item.dataset.projectId), counts = item.querySelector('.building-rail-counts');
    assert.equal(item.dataset.detail, String(detailed));
    assert.equal(counts.hidden, !detailed);
    if (detailed) assert.equal(counts.textContent, floorSummary(overview.floors.get(item.dataset.projectId).counts));
    assert.equal(item.dataset.focused, String(item.dataset.projectId === 'f5'));
    assert.equal(item.querySelector('button').getAttribute('aria-current'), item.dataset.projectId === 'f5' ? 'true' : null);
  }
  assert.deepEqual(tabStops(), ['f5'], 'the focus floor button becomes the only rail tab stop');

  const camera = new THREE.OrthographicCamera(-120, 120, 120, -120, .1, 3000);
  camera.position.copy(overview.center).addScaledVector(toward, 800); camera.lookAt(overview.center); camera.updateMatrixWorld(true);
  overview.updateLabels(camera, 1200, 1200);
  for (const floor of overview.floors.values()) {
    if (!floor.detailed) assert.equal(floor.label.hidden, true, `${floor.id}: compressed floors carry no floating plate`);
    else assert.equal(floor.label.hidden, false, `${floor.id}: detailed floors keep their plate`);
  }
  const f5Plate = overview.floors.get('f5').label;
  f5Plate.focus();
  overview.focusFloor('f6');
  overview.updateLabels(camera, 1200, 1200);
  assert.equal(f5Plate.hidden, true, 'the plate of a floor leaving the detail band hides');
  assert.equal(document.activeElement === railItem(container, 'f5').querySelector('button'), true,
    'a plate holding keyboard focus hands it to the rail button of the same floor');

  railItem(container, 'f9').querySelector('button').click();
  assert.equal(overview.focusedFloor, 'f9');
  assert.deepEqual(focused, ['f9'], 'a rail click reports the new focus');
  assert.deepEqual(opened, [], 'a rail click only focuses; it does not open the office');
  const key = (id, name) => railItem(container, id).querySelector('button')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  assert.equal(key('f9', 'PageUp'), false, 'the rail consumes PageUp');
  assert.equal(overview.focusedFloor, 'f10');
  assert.equal(document.activeElement === railItem(container, 'f10').querySelector('button'), true, 'keyboard focus follows the building focus');
  key('f10', 'PageDown'); key('f9', 'PageDown');
  assert.equal(overview.focusedFloor, 'f8');
  key('f8', 'ArrowUp');
  assert.equal(overview.focusedFloor, 'f9');
  assert.equal(key('f9', 'Enter'), true, 'other keys pass through');
  assert.deepEqual(focused, ['f9', 'f10', 'f9', 'f8', 'f9']);
  overview.focusFloor('f9');
  key('f2', 'ArrowUp');
  assert.equal(overview.focusedFloor, 'f3', 'keys step from the rail button that holds keyboard focus, not from the focus floor');
  assert.equal(document.activeElement === railItem(container, 'f3').querySelector('button'), true, 'and keyboard focus moves with them');
  overview.focusFloor('f11'); key('f11', 'PageUp');
  assert.equal(overview.focusedFloor, 'f11', 'the top floor stays focused at the top of the stack');

  const activeButton = railItem(container, 'f11').querySelector('button');
  activeButton.focus();
  overview.setFloors([...building(12)].reverse());
  assert.equal(railItems(container)[0].dataset.projectId, 'f0', 'the rail follows the new floor order');
  assert.equal(railItem(container, 'f11').querySelector('button') === activeButton, true, 'rail buttons survive a reorder');
  assert.equal(document.activeElement === activeButton, true, 'reordering keeps keyboard focus on the same floor');

  overview.show(false);
  assert.equal(list.hidden, true);
  overview.show(true);
  assert.equal(list.hidden, false);
  overview.setFloors(building(10));
  assert.equal(railItems(container).length, 10, 'removed floors leave the rail');
  overview.setFloors(building(8));
  assert.equal(rail(container) === null, true, 'the rail leaves once the building is short again');
  assert.ok([...overview.floors.values()].every(floor => floor.detailed && floor.detailMeshes.every(mesh => mesh.visible)));
});

test('the camera floor is the detailed floor until a floor is focused, and PageUp/PageDown step the focus by storeys', t => {
  const { overview, focused } = fixture(t);
  assert.deepEqual(['PageUp', 'PageDown', 'ArrowUp', 'Enter'].map(floorKeyStep), [1, -1, 0, 0]);
  assert.equal(overview.stepFocus(1), null, 'an empty building has nothing to focus');

  overview.setFloors(Array.from({ length: 12 }, (_, i) => project(`f${i}`, crowd(`f${i}`, 1))));
  overview.show(true, 'f2');
  assert.deepEqual([...overview.floors.values()].filter(floor => floor.detailed).map(floor => floor.id), ['f2'],
    'the floor the camera approaches is the detailed floor');
  assert.equal(overview.focusedFloor, null);
  assert.equal(overview.stepFocus(-1), 'f1', 'stepping starts from the camera floor');
  overview.focusFloor(null); overview.show(true, '');
  assert.equal(overview.stepFocus(1), 'f0', 'PageUp without any floor starts at the bottom');
  assert.equal(overview.stepFocus(1), 'f1');
  assert.equal(overview.stepFocus(40), 'f11', 'a long step clamps to the top');
  assert.equal(overview.stepFocus(0), 'f11');
  assert.equal(overview.stepFocus(Number.NaN), 'f11');
  assert.equal(overview.stepFocus(-2), 'f9');
  overview.focusFloor(null);
  assert.equal(overview.stepFocus(-1), 'f11', 'PageDown without any floor starts at the top');
  assert.deepEqual([...overview.floors.values()].filter(floor => floor.detailed).map(floor => floor.id), ['f11']);
  assert.deepEqual(focused, [], 'API focus changes do not echo back through the rail callback');
});
