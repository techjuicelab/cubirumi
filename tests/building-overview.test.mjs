import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { BuildingOverview, floorCounts, floorSummary, windowCells } from '../src/building-overview.ts';
import { officeBounds, MAX_OFFICE_AGENTS } from '../src/office-layout.ts';

function fixture(t) {
  const window = new Window({ url: 'http://127.0.0.1:4780/' });
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const selected = [];
  const overview = new BuildingOverview(container, id => selected.push(id));
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; overview.dispose(); } };
  t.after(() => { dispose(); window.close(); globalThis.document = previousDocument; });
  return { overview, container, selected, dispose };
}
const agent = (id, status = 'working') => ({ id, name: id, status, color: '#91b9ce' });
const floor = (id, count, name = id) => ({ id, name, agents: Array.from({ length: count }, (_, i) => agent(`${id}-${i}`)) });
function armMatrix(entry, index = 0) {
  const matrix = new THREE.Matrix4(); entry.arms.getMatrixAt(index, matrix); return matrix.toArray();
}
function watchFlightResources(flight) {
  const resources = new Set();
  for (const root of [flight.plane, flight.trail]) root.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) resources.add(material);
  });
  const disposed = new Map();
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) ?? 0) + 1));
  return { resources, disposed };
}

test('building floors grow and shrink independently using the real current roster geometry', t => {
  const { overview, container } = fixture(t);
  overview.setFloors([floor('small', 1), floor('medium', 6), floor('large', 30)]);
  const small = overview.floors.get('small'), medium = overview.floors.get('medium'), large = overview.floors.get('large');
  assert.ok(small.width < medium.width);
  assert.ok(medium.depth < large.depth);
  assert.equal(large.width, officeBounds(31).width);
  assert.equal(large.depth, officeBounds(31).depth);
  assert.equal(container.querySelectorAll('.building-floor-label').length, 3);
  assert.ok(small.group.position.y < medium.group.position.y && medium.group.position.y < large.group.position.y);
  const retained = agent('large-29');
  overview.setFloors([floor('small', 1), floor('medium', 6), { id: 'large', name: 'large', agents: [retained] }]);
  const shrunk = overview.floors.get('large');
  assert.equal(overview.floors.get('small') === small, true, 'another floor keeps its geometry when only the large roster shrinks');
  assert.equal(overview.floors.get('medium') === medium, true, 'the medium floor is kept too');
  assert.ok(shrunk.width < large.width && shrunk.depth < large.depth);
  assert.equal(large.group.parent === null, true, 'the rebuilt floor group leaves the building');
  assert.equal(large.label.isConnected, false);
  assert.equal(shrunk.arms.count, 2); assert.equal(shrunk.screens.count, 1);
  assert.equal(shrunk.points.length, 1);
  assert.equal(overview.hasAgent('large-0'), false);
  assert.equal(overview.hasAgent('large-29'), true);
  overview.setFloors([floor('small', 1), floor('medium', 6), floor('large', 60)]);
  assert.equal(overview.floors.get('large').screens.count, 60);
  assert.ok(overview.floors.get('large').depth > 60);
  assert.equal(container.querySelectorAll('.building-floor-label').length, 3);
});

test('an empty project keeps its floor and reception without inventing employees, while removed projects leave no labels', t => {
  const { overview, container } = fixture(t);
  overview.setFloors([floor('empty', 0)]);
  assert.equal(overview.floors.size, 1);
  assert.equal(overview.group.children.length, 1);
  assert.equal(overview.floors.get('empty').screens.count, 0);
  assert.equal(overview.floors.get('empty').width, officeBounds(1).width);
  assert.equal(overview.floors.get('empty').depth, officeBounds(1).depth);
  const emptyPlate = overview.floors.get('empty');
  assert.deepEqual([emptyPlate.labelNumber.textContent, emptyPlate.labelName.textContent, emptyPlate.labelCounts.textContent], ['1F', 'empty', '활동 없음']);
  assert.equal(overview.hasAgent('boss'), false);
  overview.setFloors([floor('present', 2), floor('empty', 0)]);
  const present = overview.floors.get('present');
  assert.equal(overview.floors.size, 2);
  assert.deepEqual([...overview.anchors.keys()], ['present-0', 'present-1']);
  // Heads are tinted per person now (appearanceFor), so address the head instances directly.
  const heads = present.group.children.find(object => object === present.heads);
  assert.equal(heads.count, 2, 'reception furniture does not invent an owner employee');
  assert.equal(overview.sendPaperPlane('present-0', 'missing', 'missing-agent'), false);
  overview.setFloors([]);
  assert.equal(present.group.parent === null, true, 'a removed floor group leaves the building'); assert.equal(present.label.isConnected, false);
  assert.equal(overview.anchors.size, 0); assert.equal(overview.floors.size, 0);
  assert.equal(container.children.length, 0);
});

test('unconfirmed observations are counted separately from work, errors and quiet employees', () => {
  const agents = [agent('active'), agent('waiting', 'idle'),
    { ...agent('stale-work', 'idle'), unconfirmedStatus: 'working' },
    { ...agent('stale-error', 'idle'), unconfirmedStatus: 'error' }];
  const counts = floorCounts({ agents });
  assert.deepEqual(counts, { working: 1, approval: 0, error: 0, quiet: 1, unconfirmed: 2 });
  assert.equal(floorSummary(counts), '작업 1 · 대기 1 · 미확인 2');
  assert.deepEqual(windowCells(counts), [...Array(3).fill('working'), ...Array(3).fill('quiet'), ...Array(6).fill('unconfirmed')]);
  assert.deepEqual(floorCounts({ agents, counts: { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 3.9 } }),
    { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 3 });
});

test('unconfirmed history paints neutral windows and exact accessible counts without allocating desks', t => {
  const { overview, container } = fixture(t);
  const counts = { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 60 };
  overview.setFloors([{ id: 'history', name: '이전 기록', agents: [], counts }]);
  const entry = overview.floors.get('history');
  assert.equal(entry.labelCounts.textContent, '미확인 60');
  assert.equal(entry.label.getAttribute('aria-label'), '1층 이전 기록 층 선택 · 현재 상태 미확인 60명');
  assert.equal(entry.screens.count, 0); assert.equal(entry.heads.count, 0);
  assert.equal(entry.points.length, 0); assert.equal(overview.anchors.size, 0);
  assert.equal(entry.width, officeBounds(1).width); assert.equal(entry.depth, officeBounds(1).depth);
  assert.deepEqual(entry.cells.split(','), Array(12).fill('unconfirmed'));
  const neutral = new THREE.Color('#95a9b8'), actual = new THREE.Color();
  for (let i = 0; i < overview.windows.count; i++) {
    overview.windows.getColorAt(i, actual);
    assert.ok(Math.abs(actual.r - neutral.r) + Math.abs(actual.g - neutral.g) + Math.abs(actual.b - neutral.b) < .00001);
  }
  assert.equal(container.querySelectorAll('.building-floor-label').length, 1);
  overview.setFloors([{ id: 'history', name: '이전 기록', agents: [] }]);
  assert.equal(overview.floors.get('history').counts.unconfirmed, 0, 'missing optional counts normalize to zero internally');
});

test('the tall building rail exposes unconfirmed counts without an active error alert', t => {
  const { overview, container } = fixture(t);
  const inputs = Array.from({ length: 9 }, (_, i) => floor(`floor-${i}`, 0));
  inputs[0].counts = { working: 0, approval: 0, error: 0, quiet: 0, unconfirmed: 3 };
  overview.setFloors(inputs);
  overview.focusFloor('floor-0');
  const rail = container.querySelector('.building-rail-floor[data-project-id="floor-0"]');
  assert.ok(rail);
  assert.equal(rail.querySelector('.building-rail-counts').textContent, '미확인 3');
  assert.match(rail.querySelector('button').getAttribute('aria-label'), /현재 상태 미확인 3명/);
  assert.equal(rail.querySelector('[data-state="error"]').hidden, true);
  assert.equal(rail.querySelector('[data-state="approval"]').hidden, true);
});

test('100 building employees shrink to two and then zero desks while the project floor and reception remain', t => {
  const { overview, container } = fixture(t);
  const roster = floor('current', 100);
  let previous;
  for (const agents of [roster.agents, roster.agents.slice(-2), []]) {
    overview.setFloors([{ ...roster, agents }]);
    const entry = overview.floors.get('current');
    assert.ok(entry, 'zero employees must retain the project floor');
    assert.equal(overview.floors.size, 1);
    assert.equal(entry.agents.length, agents.length);
    assert.equal(entry.screens.count, agents.length);
    assert.equal(entry.heads.count, agents.length);
    assert.equal(entry.arms.count, agents.length * 2);
    assert.equal(entry.points.length, agents.length);
    assert.equal(overview.anchors.size, agents.length);
    const bounds = officeBounds(agents.length + 1);
    assert.equal(entry.width, bounds.width); assert.equal(entry.depth, bounds.depth);
    const slab = entry.group.children[0];
    assert.deepEqual(slab.scale.toArray(), [bounds.width, .6, bounds.depth]);
    const reception = entry.group.children.at(-1);
    assert.deepEqual(reception.scale.toArray(), [3.65, .2, 1.8], 'the reception desk is preserved separately from employee desks');
    for (const point of entry.points) {
      assert.ok(Math.abs(point.x) + 1.825 < bounds.width / 2);
      assert.ok(point.z - 1.875 > -bounds.depth / 2 && point.z + .64 < bounds.depth / 2);
    }
    if (previous) {
      assert.ok(entry.width < previous.width);
      assert.ok(entry.depth <= previous.depth);
      assert.equal(previous.group.parent === null, true, 'the previous floor group leaves the building');
      assert.equal(previous.label.isConnected, false);
    }
    assert.equal(container.querySelectorAll('.building-floor-label').length, 1);
    previous = entry;
  }
  overview.setFloors([{ ...roster, agents: roster.agents.slice(-2) }]);
  assert.equal(overview.floors.get('current').screens.count, 2);
  assert.equal(overview.hasAgent('current-99'), true);
});

test('the reception owner desk top stands on legs that reach the floor instead of floating', t => {
  const { overview } = fixture(t);
  for (const count of [0, 1, 6, 30]) {
    overview.setFloors([floor('owner-desk', count)]);
    const entry = overview.floors.get('owner-desk');
    const top = entry.group.children.at(-1);
    assert.deepEqual(top.scale.toArray(), [3.65, .2, 1.8], 'the reception desk top stays the last floor child');
    const topBox = new THREE.Box3().setFromObject(top);
    const floorTop = new THREE.Box3().setFromObject(entry.group.children[1]).max.y;
    const supports = entry.group.children
      .filter(object => object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh) && object !== top)
      .map(object => new THREE.Box3().setFromObject(object))
      .filter(box => box.min.y <= floorTop + .01 && box.max.y >= topBox.min.y - .01 && box.max.y <= topBox.max.y
        && box.min.x >= topBox.min.x && box.max.x <= topBox.max.x && box.min.z >= topBox.min.z && box.max.z <= topBox.max.z);
    assert.ok(supports.length >= 2, `${count} employees: the owner desk top needs supports from the floor up to its underside`);
    assert.ok(supports.some(box => box.max.x < (topBox.min.x + topBox.max.x) / 2)
      && supports.some(box => box.min.x > (topBox.min.x + topBox.max.x) / 2), 'both desk ends are supported');
  }
});

test('the observed capacity bound does not allocate or communicate with overflow employees', t => {
  const { overview } = fixture(t);
  overview.setFloors([floor('capacity', MAX_OFFICE_AGENTS + 3)]);
  const entry = overview.floors.get('capacity');
  assert.equal(entry.agents.length, MAX_OFFICE_AGENTS);
  assert.equal(entry.screens.count, MAX_OFFICE_AGENTS);
  assert.equal(entry.arms.count, MAX_OFFICE_AGENTS * 2);
  assert.equal(overview.anchors.size, MAX_OFFICE_AGENTS);
  assert.equal(overview.hasAgent(`capacity-${MAX_OFFICE_AGENTS}`), false);
});

test('observed work animates arm instance transforms while idle, pause and reduced motion stay still', t => {
  const { overview } = fixture(t);
  for (const status of ['working', 'thinking', 'reviewing']) {
    overview.setFloors([{ id: 'work', name: 'work', agents: [agent('worker', status)] }]);
    const entry = overview.floors.get('work');
    overview.update(.11, false, false);
    const before = armMatrix(entry);
    overview.update(.13, false, false);
    assert.notDeepEqual(armMatrix(entry), before, status);
    const moving = armMatrix(entry);
    overview.update(1, true, false);
    assert.deepEqual(armMatrix(entry), moving, 'pausing freezes the actual matrices');
    overview.update(.1, false, true);
    const reduced = armMatrix(entry);
    overview.update(.4, false, true);
    assert.deepEqual(armMatrix(entry), reduced);
  }
  for (const status of ['idle', 'waiting', 'done', 'approval', 'error']) {
    overview.setFloors([{ id: 'work', name: 'work', agents: [agent('worker', status)] }]);
    const entry = overview.floors.get('work');
    const idle = armMatrix(entry);
    overview.update(.3, false, false);
    assert.deepEqual(armMatrix(entry), idle, status);
  }
  const entry = overview.floors.get('work');
  const idleColor = new THREE.Color(); entry.screens.getColorAt(0, idleColor);
  overview.setFloors([{ id: 'work', name: 'work', agents: [agent('worker', 'working')] }]);
  const workingColor = new THREE.Color(); entry.screens.getColorAt(0, workingColor);
  assert.equal(overview.floors.get('work') === entry, true, 'a status change keeps the floor');
  assert.ok(!workingColor.equals(idleColor), 'the current status also updates the existing monitor instance');
});

test('project labels update names and current activity as inert text without rebuilding unchanged employees', t => {
  const { overview, container, selected } = fixture(t);
  overview.setFloors([floor('project-id', 2, '처음 이름')]);
  const entry = overview.floors.get('project-id');
  const markup = '<img src=x onerror="alert(1)">';
  overview.setFloors([{ id: 'project-id', name: markup, agents: [agent('project-id-0', 'idle'), agent('project-id-1')] }]);
  assert.equal(overview.floors.get('project-id') === entry, true, 'a rename keeps the floor');
  assert.equal(entry.labelName.textContent, markup);
  assert.equal(entry.labelCounts.textContent, '작업 1 · 대기 1');
  assert.equal(entry.label.getAttribute('aria-label'), `1층 ${markup} 층 선택 · 작업 중 1명, 대기 1명`);
  assert.equal(container.querySelector('img') === null, true, 'names never become markup');
  // Decision 34: the first plate click picks the floor, a click on the focus floor opens its office.
  entry.label.click();
  assert.deepEqual(selected, []);
  assert.equal(entry.label.getAttribute('aria-label'), `1층 ${markup} 사무실 보기 · 작업 중 1명, 대기 1명`);
  entry.label.click();
  assert.deepEqual(selected, ['project-id']);
  overview.show(true, 'project-id');
  const camera = new THREE.OrthographicCamera(-40, 40, 40, -40, .1, 300);
  camera.position.set(30, 30, 60); camera.lookAt(overview.center); camera.updateMatrixWorld(true);
  overview.updateLabels(camera, 1000, 700);
  assert.equal(entry.label.hidden, false);
  assert.equal(entry.label.dataset.selected, 'true');
  assert.ok(!entry.label.style.transform.includes('NaN'));
  camera.lookAt(1000, 0, 1000); camera.updateMatrixWorld(true);
  overview.updateLabels(camera, 1000, 700);
  assert.equal(entry.label.hidden, true, 'camera-excluded floors do not leave floating labels');
  overview.show(false);
  assert.equal(entry.label.hidden, true);
});

test('real cross-floor flights use the corresponding monitor anchors and deduplicate observed events', t => {
  const { overview } = fixture(t);
  overview.setFloors([floor('lower', 1), floor('upper', 2)]);
  assert.equal(overview.sendPaperPlane('lower-0', 'upper-1', 'observed'), true);
  const flight = overview.flights[0];
  assert.ok(flight.curve.getPoint(0).equals(overview.anchors.get('lower-0')));
  assert.ok(flight.curve.getPoint(1).equals(overview.anchors.get('upper-1')));
  assert.ok(flight.curve.getPoint(1).y > flight.curve.getPoint(0).y);
  assert.equal(overview.sendPaperPlane('lower-0', 'upper-1', 'observed'), false);
  const position = flight.plane.position.clone();
  overview.update(.2, true, false);
  assert.ok(flight.plane.position.equals(position));
  overview.update(.2, false, false);
  assert.ok(flight.plane.position.distanceTo(position) > .01);
  const direction = flight.plane.getWorldDirection(new THREE.Vector3());
  assert.ok(direction.dot(flight.curve.getTangent(flight.elapsed / flight.duration)) > .999);
});

test('completed, canceled and reduced-motion flights release every folded-plane and trail resource', t => {
  const { overview } = fixture(t);
  for (const ending of ['complete', 'roster', 'reduced']) {
    overview.setFloors([floor('lower', 1), floor('upper', 1)]);
    overview.sendPaperPlane('lower-0', 'upper-0', `cleanup-${ending}`);
    const flight = overview.flights[0];
    const watched = watchFlightResources(flight);
    if (ending === 'complete') overview.update(flight.duration + .1, false, false);
    else if (ending === 'roster') overview.setFloors([floor('lower', 1)]);
    else overview.update(.1, false, true);
    assert.equal(overview.flights.length, 0, ending);
    assert.equal(flight.plane.parent === null, true, `${ending}: the plane leaves`); assert.equal(flight.trail.parent === null, true, `${ending}: the trail leaves`);
    for (const resource of watched.resources) assert.equal(watched.disposed.get(resource), 1, `${ending}: ${resource.type} must be released exactly once`);
  }
});

test('floor reordering cannot leave a flight aimed at the old vertical monitor positions', t => {
  const { overview } = fixture(t);
  overview.setFloors([floor('lower', 1), floor('upper', 1)]);
  overview.sendPaperPlane('lower-0', 'upper-0', 'reorder');
  overview.update(.3, false, false);
  overview.setFloors([floor('upper', 1), floor('lower', 1)]);
  for (const flight of overview.flights) {
    assert.ok(flight.curve.getPoint(0).equals(overview.anchors.get(flight.from)), 'the retained origin must match its actual monitor after restacking');
    assert.ok(flight.curve.getPoint(1).equals(overview.anchors.get(flight.to)), 'the retained destination must match its actual monitor after restacking');
  }
});

test('removing a floor disposes its own instances and materials while shared building geometry survives until teardown', t => {
  const { overview, container, dispose } = fixture(t);
  overview.setFloors([floor('keep', 1), floor('remove', 6)]);
  const removed = overview.floors.get('remove');
  const instances = removed.group.children.filter(object => object instanceof THREE.InstancedMesh);
  let instanceDisposals = 0, materialDisposals = 0, sharedDisposals = 0;
  for (const instance of instances) instance.addEventListener('dispose', () => instanceDisposals++);
  for (const material of removed.materials) material.addEventListener('dispose', () => materialDisposals++);
  overview.box.addEventListener('dispose', () => sharedDisposals++);
  overview.setFloors([floor('keep', 1)]);
  assert.equal(instanceDisposals, instances.length);
  assert.equal(materialDisposals, removed.materials.length);
  assert.equal(sharedDisposals, 0);
  assert.equal(container.children.length, 1);
  dispose();
  assert.equal(sharedDisposals, 1);
  assert.equal(container.children.length, 0);
  assert.equal(overview.floors.size, 0); assert.equal(overview.anchors.size, 0);
});

test('building disposal releases active flight resources and all project labels', t => {
  const { overview, container, dispose } = fixture(t);
  overview.setFloors([floor('lower', 1), floor('upper', 1)]);
  overview.sendPaperPlane('lower-0', 'upper-0', 'dispose-active');
  const flight = overview.flights[0];
  const watched = watchFlightResources(flight);
  dispose();
  assert.equal(overview.flights.length, 0);
  assert.equal(overview.group.children.length, 0);
  assert.equal(container.children.length, 0);
  for (const resource of watched.resources) assert.equal(watched.disposed.get(resource), 1, resource.type);
});

test('message flights stay hand-sized near their own computer without a recipient or a camera-size multiplier', t => {
  const { overview } = fixture(t);
  overview.setFloors([floor('messages', 2)]);
  const roster = [...overview.anchors.keys()];
  assert.equal(overview.sendMessagePlane('missing', 'missing-message'), false);
  assert.equal(overview.sendMessagePlane('messages-0', 'real-message'), true);
  assert.equal(overview.sendMessagePlane('messages-0', 'real-message'), false);
  const flight = overview.flights[0], origin = overview.anchors.get('messages-0');
  assert.equal(flight.plane.name, 'message-paper-plane');
  assert.ok(flight.duration <= 3);
  assert.ok(flight.curve.getPoint(0).equals(origin));
  assert.ok(flight.curve.getPoint(1).distanceTo(origin) < 1e-8);
  for (let i = 0; i <= 50; i++) assert.ok(flight.curve.getPoint(i / 50).distanceTo(origin) < 3, 'a general message stays near its own monitor');
  flight.plane.geometry.computeBoundingBox();
  const dimensions = flight.plane.geometry.boundingBox.getSize(new THREE.Vector3());
  const length = Math.max(...dimensions.toArray()) * flight.plane.scale.x;
  assert.ok(length > .18 && length < .23, 'plane length matches an employee hand diameter');
  const originalScale = flight.plane.scale.clone();
  overview.update(.4, false, false, 10);
  assert.ok(flight.plane.scale.equals(originalScale), 'a wide building view cannot enlarge the plane');
  assert.ok(flight.plane.position.distanceTo(origin) > .05);
  assert.deepEqual([...overview.anchors.keys()], roster);
  overview.update(3, false, false);
  assert.equal(overview.activeFlightCount, 0);
});
