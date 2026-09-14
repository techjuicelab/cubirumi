import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { BuildingOverview, BUILDING_VIEW, CEILING_OPACITY, SIDE_WALL_HEIGHT, STORY_LIMITS, WINDOW_CELLS, LARGE_BUILDING_AGENTS, PLATE,
  PLATE_WALL_OUTSET, floorCounts, floorSummary, storyHeight, windowBand, windowCells } from '../src/building-overview.ts';
import { officeBounds } from '../src/office-layout.ts';
import { appearanceFor } from '../src/appearance.ts';
import { STATUS_STYLE } from '../src/status-style.ts';

function fixture(t, { canvas = false } = {}) {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  const drawn = [];
  let restoreCanvas;
  if (canvas) {
    const context = {
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect() { drawn.push(['fillRect', this.fillStyle]); },
      fillText(text) { drawn.push(['fillText', text, this.font]); },
      measureText(text) { return { width: [...text].length * 40 }; },
    };
    // happy-dom shares element prototypes between Window instances: restore getContext so later tests see no canvas.
    const prototype = window.HTMLCanvasElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
    prototype.getContext = () => context;
    restoreCanvas = () => { if (descriptor) Object.defineProperty(prototype, 'getContext', descriptor); else delete prototype.getContext; };
  }
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const selected = [];
  const overview = new BuildingOverview(container, id => selected.push(id));
  t.after(() => { overview.dispose(); window.close(); globalThis.document = previous; restoreCanvas?.(); });
  return { overview, container, drawn, selected, document: window.document };
}
const person = (id, status = 'working', extra = {}) => ({ id, name: id, status, ...extra });
const roster = (prefix, count, status = 'working') => Array.from({ length: count }, (_, i) => person(`${prefix}-${i}`, status));
const project = (id, count, extra = {}) => ({ id, name: id, agents: roster(id, count), ...extra });
const byName = (overview, name) => overview.shell.children.find(object => object.name === name);
const hex = (mesh, index) => mesh.getColorAt(index, new THREE.Color()).getHexString();
const matrices = mesh => Array.from(mesh.instanceMatrix.array);
function instanceBox(mesh, index) {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
  return new THREE.Box3(new THREE.Vector3(-.5, -.5, -.5), new THREE.Vector3(.5, .5, .5)).applyMatrix4(matrix);
}
function instanceScale(mesh, index) {
  const matrix = new THREE.Matrix4(), scale = new THREE.Vector3(); mesh.getMatrixAt(index, matrix);
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale); return scale;
}
const near = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

test('the cutaway shell lives beside the floor group, follows its parent and visibility, and releases its own resources once', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('a', 1), project('b', 2)]);
  assert.equal(overview.group.children.length, 2, 'floors remain the only children of the overview group');
  assert.equal(overview.shell.parent === null, true, 'the shell has no parent before the group is added');
  const scene = new THREE.Scene();
  scene.add(overview.group);
  assert.equal(overview.shell.parent === scene, true, 'the shell renders wherever the overview group is added');
  assert.deepEqual(overview.shell.children.map(object => object.name).sort(),
    ['building-bushes', 'building-ceilings', 'building-company-sign', 'building-focus-edge', 'building-glass', 'building-ground', 'building-structure', 'building-windows']);
  assert.equal(overview.shell.visible, false);
  overview.show(true); assert.equal(overview.shell.visible, true);
  overview.show(false); assert.equal(overview.shell.visible, false);
  scene.remove(overview.group);
  assert.equal(overview.shell.parent === null, true, 'the shell leaves with the overview group');
  scene.add(overview.group);

  const resources = new Set(), instances = [];
  overview.shell.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of object.material ? [object.material].flat() : []) resources.add(material);
    if (object.isInstancedMesh) instances.push(object);
  });
  const disposed = new Map();
  for (const resource of [...resources, ...instances]) resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) ?? 0) + 1));
  overview.dispose();
  overview.dispose();
  assert.equal(overview.shell.parent === null, true, 'dispose detaches the shell');
  assert.equal(scene.children.length, 0);
  for (const resource of [...resources, ...instances]) assert.equal(disposed.get(resource), 1, `${resource.type ?? resource.name} is released exactly once`);
});

test('the shell keeps a fixed set of draw objects from one small floor to twelve large floors and never reallocates per frame', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('only', 1)]);
  const drawObjects = overview.shell.children.length;
  const first = byName(overview, 'building-structure'), firstCount = first.count;
  const large = (status = 'working') => Array.from({ length: 12 }, (_, i) => ({ ...project(`floor-${i}`, 30), agents: roster(`floor-${i}`, 30, status) }));
  overview.setFloors(large());
  assert.equal(overview.shell.children.length, drawObjects, 'more floors and people add instances, not draw objects');
  const structure = byName(overview, 'building-structure');
  assert.ok(structure.count > firstCount);
  assert.equal(byName(overview, 'building-windows').count, 12 * WINDOW_CELLS);

  const buffer = structure.instanceMatrix.array, version = structure.instanceMatrix.version;
  overview.setFloors(large('idle'));
  assert.equal(byName(overview, 'building-structure') === structure, true, 'the structure mesh is reused');
  assert.equal(structure.instanceMatrix.array === buffer, true, 'the structure buffer is reused');
  assert.equal(structure.instanceMatrix.version, version, 'a status-only change repaints windows without laying out the shell again');

  const statics = overview.shell.children.filter(object => object.isInstancedMesh)
    .map(mesh => [mesh, mesh.instanceMatrix.array, mesh.instanceMatrix.version, mesh.instanceColor.version]);
  for (let frame = 0; frame < 30; frame++) overview.update(1 / 30, false, false, .08);
  for (const [mesh, array, matrixVersion, colorVersion] of statics) {
    assert.equal(mesh.instanceMatrix.array === array, true, `${mesh.name} keeps its instance buffer`);
    assert.equal(mesh.instanceMatrix.version, matrixVersion, `${mesh.name} is not rewritten between frames`);
    assert.equal(mesh.instanceColor.version, colorVersion, `${mesh.name} colors are not rewritten between frames`);
  }
  overview.setFloors([project('only', 1)]);
  assert.equal(byName(overview, 'building-structure') === structure, true, 'shrinking keeps the grown buffer');
  assert.equal(structure.count, firstCount);
});

test('storey heights follow each floor depth so every deepest seat ring stays visible under the slab above from the default camera', t => {
  const { overview } = fixture(t);
  const sizes = [0, 1, 5, 11, 16, 21, 100];
  overview.setFloors(sizes.map(count => project(`p${count}`, count)));
  const floors = sizes.map(count => overview.floors.get(`p${count}`));
  const rise = Math.tan(BUILDING_VIEW.elevation), toward = new THREE.Vector2(Math.sin(BUILDING_VIEW.yaw), Math.cos(BUILDING_VIEW.yaw));
  floors.forEach((floor, index) => {
    assert.equal(floor.gap, storyHeight(officeBounds(sizes[index] + 1)));
    if (index) near(floor.group.position.y, floors[index - 1].group.position.y + floors[index - 1].gap, 'each floor stands on the one below');
    if (!floor.points.length || floor.gap >= STORY_LIMITS.max) return;
    const deepest = Math.min(...floor.points.map(point => point.z));
    for (const point of floor.points.filter(candidate => Math.abs(candidate.z - deepest) < 1e-9)) {
      const toFront = (floor.depth / 2 - point.z) / toward.y, toSide = (floor.width / 2 - point.x) / toward.x;
      const height = .095 + Math.min(toFront, toSide) * rise;
      assert.ok(height <= floor.gap - .68 + 1e-9, `${sizes[index]} people: the ring passes under the slab above`);
      if (toSide < toFront) assert.ok(height > SIDE_WALL_HEIGHT, `${sizes[index]} people: a ring seen through the side clears the solid wall`);
    }
  });
  assert.equal(floors[0].gap, floors[1].gap, 'an empty project keeps the one-row storey');
  assert.ok(floors[1].gap > 7 && floors[1].gap < 8.5, 'a one-row floor is much tighter than the old fixed ten-unit gap');
  assert.ok(floors[3].gap > floors[2].gap && floors[4].gap > floors[3].gap);
  assert.equal(floors[6].gap, STORY_LIMITS.max);

  const columns = byName(overview, 'building-structure');
  let found = 0;
  for (let i = 0; i < columns.count; i++) {
    const box = instanceBox(columns, i);
    if (hex(columns, i) !== 'eef5fa' || Math.abs(box.max.x - box.min.x - .42) > 1e-6) continue;
    const owner = floors.find(floor => Math.abs(box.min.y - (floor.group.position.y - .08)) < 1e-6);
    if (!owner) continue;
    found++;
    near(box.max.y, owner.group.position.y + owner.gap - .68, 'a column reaches the slab underside above its floor');
  }
  assert.ok(found >= floors.length * 4, 'every storey has at least its four corner columns');
});

test('window cells show reported proportions in state order with one lit window for every present state', () => {
  const zero = { working: 0, approval: 0, error: 0, quiet: 0 };
  const order = ['working', 'approval', 'error', 'quiet'];
  assert.deepEqual(windowCells(zero), Array(12).fill('dark'));
  assert.deepEqual(windowCells({ ...zero, working: 1 }), Array(12).fill('working'));
  assert.deepEqual(windowCells({ ...zero, working: 6, quiet: 6 }), [...Array(6).fill('working'), ...Array(6).fill('quiet')]);
  const mixed = windowCells({ working: 1, approval: 1, error: 1, quiet: 97 });
  assert.deepEqual(mixed, ['working', 'approval', 'error', ...Array(9).fill('quiet')]);
  assert.deepEqual(windowCells({ working: -3, approval: Number.NaN, error: Infinity, quiet: 2.9 }), Array(12).fill('quiet'), 'invalid counts read as zero');
  for (const working of [0, 1, 2, 5, 13]) for (const approval of [0, 1, 2, 7]) for (const error of [0, 1, 5]) for (const quiet of [0, 1, 3, 12, 40]) {
    const counts = { working, approval, error, quiet }, total = working + approval + error + quiet;
    const cells = windowCells(counts);
    assert.equal(cells.length, 12);
    if (!total) { assert.ok(cells.every(cell => cell === 'dark')); continue; }
    assert.deepEqual(cells, [...cells].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'work, approval, error, quiet fill in that order');
    for (const key of order) {
      const lit = cells.filter(cell => cell === key).length;
      if (!counts[key]) assert.equal(lit, 0, `${key} without people stays unlit`);
      else {
        assert.ok(lit >= 1, `${JSON.stringify(counts)}: ${key} keeps at least one window`);
        assert.ok(Math.abs(lit - counts[key] / total * 12) < 3, `${JSON.stringify(counts)}: ${key} stays proportional`);
      }
    }
  }
});

test('nameplate counts use reported counts, fall back to the roster with done as quiet, and omit zero states', () => {
  const agents = ['working', 'thinking', 'approval', 'error', 'done', 'idle', 'waiting'].map((status, i) => person(`p-${i}`, status));
  assert.deepEqual(floorCounts({ agents }), { working: 2, approval: 1, error: 1, quiet: 3 });
  assert.deepEqual(floorCounts({ agents, counts: { working: 0, approval: 2, error: 0, quiet: 12 } }), { working: 0, approval: 2, error: 0, quiet: 12 },
    'the connected counts reported for the floor win over the shown roster');
  assert.deepEqual(floorCounts({ agents: [], counts: { working: 1.8, approval: -1, error: Number.NaN, quiet: '3' } }), { working: 1, approval: 0, error: 0, quiet: 0 });
  assert.equal(floorSummary({ working: 1, approval: 1, error: 1, quiet: 12 }), '작업 1 · 확인 요청 1 · 오류 1 · 대기 12');
  assert.equal(floorSummary({ working: 0, approval: 0, error: 2, quiet: 0 }), '오류 2');
  assert.equal(floorSummary({ working: 0, approval: 0, error: 0, quiet: 0 }), '활동 없음');
});

test('each floor paints twelve side-wall windows from its counts and repaints only when those counts change', t => {
  const { overview } = fixture(t);
  const quiet = { id: 'quiet', name: 'sample-notes', agents: [], counts: { working: 0, approval: 0, error: 0, quiet: 12 } };
  const inputs = [quiet, { id: 'busy', name: 'agent-office', agents: [person('w')] }, { id: 'empty', name: 'nobody', agents: [] }];
  overview.setFloors(inputs);
  const windows = byName(overview, 'building-windows');
  assert.equal(windows.count, 36);
  const expected = [STATUS_STYLE.idle.color, STATUS_STYLE.working.color, '#aebfcb'];
  inputs.forEach(({ id }, floorIndex) => {
    const floor = overview.floors.get(id), band = windowBand(floor.depth);
    for (let cell = 0; cell < 12; cell++) {
      const index = floorIndex * 12 + cell;
      assert.equal(`#${hex(windows, index)}`, expected[floorIndex], `${id} window ${cell}`);
      const box = instanceBox(windows, index);
      assert.ok(box.min.x > floor.width / 2, 'windows sit on the outside face of the right wall');
      assert.ok(box.min.y > floor.group.position.y && box.max.y < floor.group.position.y + SIDE_WALL_HEIGHT, 'windows use the solid part of the wall');
      assert.ok(box.min.z >= band.center - band.width / 2 - 1e-9 && box.max.z <= band.center + band.width / 2 + 1e-9);
    }
  });
  const version = windows.instanceColor.version;
  overview.setFloors(inputs);
  assert.equal(windows.instanceColor.version, version, 'unchanged counts do not repaint');
  overview.setFloors([quiet, { id: 'busy', name: 'agent-office', agents: [person('w', 'approval')] }, inputs[2]]);
  assert.ok(windows.instanceColor.version > version);
  assert.equal(hex(windows, 12), STATUS_STYLE.approval.color.slice(1));
});

test('floor nameplates show a small floor number, the large project name and exact counts in DOM order, and pick a floor before opening it', t => {
  const { overview, container, selected, document } = fixture(t);
  const second = project('second', 0, { counts: { working: 0, approval: 1, error: 0, quiet: 4 } });
  overview.setFloors([project('first', 1), second, project('third', 0)]);
  const plates = () => [...container.querySelectorAll('.building-floor-label')];
  const text = (plate, part) => plate.querySelector(`.building-floor-${part}`).textContent;
  assert.deepEqual(plates().map(plate => text(plate, 'number')), ['1F', '2F', '3F']);
  assert.deepEqual(plates().map(plate => text(plate, 'name')), ['first', 'second', 'third']);
  assert.deepEqual(plates().map(plate => text(plate, 'counts')), ['작업 1', '확인 요청 1 · 대기 4', '활동 없음']);
  assert.equal(plates()[1].getAttribute('aria-label'), '2층 second 층 선택 · 확인 요청 1명, 대기 4명');
  const [a, b, c] = plates();
  b.focus();
  overview.setFloors([project('third', 0), project('first', 1), second]);
  assert.equal(plates().length === 3 && plates().every((plate, i) => plate === [c, a, b][i]), true, 'the same plates move into the new floor order');
  assert.deepEqual(plates().map(plate => text(plate, 'number')), ['1F', '2F', '3F']);
  assert.equal(document.activeElement === b, true, 'reordering keeps keyboard focus on the same floor');
  // Decision 34 / Building.dc.html: step one picks the floor, a click on the focus floor opens its office.
  b.click();
  assert.deepEqual(selected, [], 'the first plate click only focuses the floor');
  assert.equal(overview.focusedFloor, 'second');
  assert.equal(b.getAttribute('aria-label'), '3층 second 사무실 보기 · 확인 요청 1명, 대기 4명', 'the focus plate names the office it opens');
  b.click();
  assert.deepEqual(selected, ['second'], 'a click on the focus floor opens its office');
});

test('nameplates stand just right of the side wall, keep full plates until they would really overlap, and show only the number where no room is left', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('low', 1), project('high', 1)]);
  overview.show(true, 'high');
  const floors = [overview.floors.get('low'), overview.floors.get('high')];
  for (const floor of floors) {
    assert.ok(floor.anchor.x > floor.width / 2);
    assert.ok(floor.anchor.y > floor.group.position.y && floor.anchor.y < floor.group.position.y + SIDE_WALL_HEIGHT);
  }
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 1000);
  const aim = (zoom, area) => {
    const { yaw, elevation } = BUILDING_VIEW;
    camera.zoom = zoom; camera.updateProjectionMatrix();
    camera.position.set(overview.center.x + Math.sin(yaw) * Math.cos(elevation) * 200, overview.center.y + Math.sin(elevation) * 200,
      overview.center.z + Math.cos(yaw) * Math.cos(elevation) * 200);
    camera.lookAt(overview.center); camera.updateMatrixWorld(true);
    overview.updateLabels(camera, 1000, 800, area);
    return floors.map(floor => floor.label);
  };
  let plates = aim(1);
  assert.ok(plates.every(plate => !plate.hidden));
  assert.deepEqual(plates.map(plate => plate.dataset.compact), ['false', 'false'], 'storeys far apart on screen keep full plates');
  assert.deepEqual(plates.map(plate => plate.dataset.selected), ['false', 'true']);
  assert.ok(plates.every(plate => plate.style.transform.includes('translate(0, -50%)') && !plate.style.transform.includes('NaN')));
  // The plate column starts right of every footprint corner's outer wall face; a plate with room sits level with its floor.
  const screenX = point => (point.project(camera).x * .5 + .5) * 1000;
  const wall = Math.max(...[-1, 1].flatMap(sx => [-1, 1].map(sz =>
    screenX(new THREE.Vector3(sx * (overview.bounds.max.x + PLATE_WALL_OUTSET), overview.center.y, sz * overview.bounds.max.z)))));
  for (const floor of floors) {
    assert.ok(floor.labelX >= wall + PLATE.gap - .1, `plate ${floor.labelX} is right of the side wall ${wall}`);
    near(floor.labelY, (-floor.anchor.clone().project(camera).y * .5 + .5) * 800, 'plate level with its floor', .06);
  }
  plates = aim(.1);
  assert.ok(plates.every(plate => !plate.hidden));
  assert.deepEqual(plates.map(plate => plate.dataset.compact), ['true', 'true'], 'crowded plates compact together');
  assert.ok(floors[0].labelY - floors[1].labelY >= PLATE.compactHeight, 'and are pushed apart instead of overlapping');
  plates = aim(1);
  assert.deepEqual(plates.map(plate => plate.dataset.compact), ['false', 'false']);
  // A side HUD that leaves room for compact plates only turns them compact; with no room for a name only the number shows.
  const x = floors[0].labelX, forms = () => plates.map(plate => [plate.dataset.compact, plate.dataset.tight]);
  plates = aim(1, { top: 0, right: 1000 - x - 72, bottom: 0, left: 0 });
  assert.deepEqual(forms(), [['true', 'false'], ['true', 'false']], 'a full plate past the side HUD turns compact');
  plates = aim(1, { top: 0, right: 1000 - x - 40, bottom: 0, left: 0 });
  assert.deepEqual(forms(), [['true', 'true'], ['true', 'true']], 'without room for the name only the floor number shows');
  assert.ok(floors.every(floor => floor.labelX === x), 'plates never move left over the storey');
  plates = aim(1, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(forms(), [['false', 'false'], ['false', 'false']], 'room again brings the full plates back');
});

test('crowded plates are thinned below eight floors too, and a thinned stack keeps its stride through small zoom changes', t => {
  const { overview } = fixture(t);
  overview.setFloors(Array.from({ length: 5 }, (_, index) => project(`floor-${index}`, 1)));
  overview.show(true);
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 1000);
  const layout = zoom => {
    const { yaw, elevation } = BUILDING_VIEW;
    camera.zoom = zoom; camera.updateProjectionMatrix();
    camera.position.set(overview.center.x + Math.sin(yaw) * Math.cos(elevation) * 200, overview.center.y + Math.sin(elevation) * 200,
      overview.center.z + Math.cos(yaw) * Math.cos(elevation) * 200);
    camera.lookAt(overview.center); camera.updateMatrixWorld(true);
    overview.updateLabels(camera, 1000, 800);
    return overview.order.map(floor => floor.label.hidden ? 'h' : 'p').join('');
  };
  // From a zoom where all five storeys are drawn with room, zoom out until the stack shows every third plate.
  let zoom = .5, pattern = layout(zoom);
  assert.equal(pattern, 'ppppp', 'uncrowded storeys name every floor');
  while (overview.plateStride < 3 && zoom > .02) pattern = layout(zoom *= .98);
  assert.equal(overview.plateStride, 3, `five crowded storeys are thinned (${pattern} at zoom ${zoom.toFixed(3)})`);
  assert.ok(pattern.includes('h') && pattern.includes('p'));
  // Nudging the zoom 5% either way around that boundary switches no plate on or off.
  for (const factor of [1.05, .95, 1.05, 1, 1.05]) {
    assert.equal(layout(zoom * factor), pattern, `zoom ${(zoom * factor).toFixed(3)} keeps the thinned plates`);
    assert.equal(overview.plateStride, 3);
  }
  // Loosening waits until the smaller stride fits with room to spare, then every plate returns once none crowd.
  while (overview.plateStride === 3 && zoom < .5) layout(zoom *= 1.02);
  assert.ok(overview.plateStride < 3, 'room brings plates back');
  assert.equal(layout(.5), 'ppppp', 'every plate returns once none crowd');
});

/** Aims an orthographic camera at the building from the design view and lays out the plates; returns each floor's plate as p or h. */
function plateLayout(overview, camera, zoom, area, width = 1000, height = 800) {
  const { yaw, elevation } = BUILDING_VIEW;
  camera.zoom = zoom; camera.updateProjectionMatrix();
  camera.position.set(overview.center.x + Math.sin(yaw) * Math.cos(elevation) * 200, overview.center.y + Math.sin(elevation) * 200,
    overview.center.z + Math.cos(yaw) * Math.cos(elevation) * 200);
  camera.lookAt(overview.center); camera.updateMatrixWorld(true);
  overview.updateLabels(camera, width, height, area);
  return overview.order.map(floor => floor.label.hidden ? 'h' : 'p').join('');
}

test('a thinned stack keeps the focus, selected, error and approval floors before the top and ground storeys, and keeps its choice through jitter', t => {
  const { overview } = fixture(t);
  const stackOf = states => Array.from({ length: 8 }, (_, index) => {
    const id = `floor-${index}`;
    return { id, name: id, agents: [person(`${id}-0`, states[id] ?? 'working')] };
  });
  overview.setFloors(stackOf({ 'floor-3': 'error', 'floor-5': 'approval' }));
  overview.show(true, 'floor-0');
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 1000);
  let zoom = .5, pattern = plateLayout(overview, camera, zoom);
  assert.equal(pattern, 'pppppppp', 'uncrowded storeys name every floor');
  while (overview.plateStride < 2 && zoom > .02) pattern = plateLayout(overview, camera, zoom *= .98);
  assert.equal(overview.plateStride, 2, `eight crowded storeys are thinned to every other floor (zoom ${zoom.toFixed(3)})`);
  // The old stride rule from the selected 1F showed 1F, 3F, 5F and 7F and hid the error on 4F and the approval on 6F.
  assert.equal(pattern, 'phhphphp', 'selected 1F, error 4F and approval 6F stay, and the top floor fits two storeys above');
  const checkSpacing = label => {
    const drawn = overview.order.filter(floor => floor.onScreen), shown = drawn.filter(floor => !floor.label.hidden);
    const gap = Math.min(...drawn.slice(1).map((floor, index) => Math.abs(floor.screenY - drawn[index].screenY)));
    for (const floor of shown) {
      const away = Math.abs(floor.plateY - floor.screenY);
      assert.ok(away <= PLATE.shiftShare * gap + 1e-6, `${label}: ${floor.id} plate sits ${away.toFixed(1)}px from its storey (gap ${gap.toFixed(1)})`);
    }
    for (let i = 1; i < shown.length; i++) {
      const apart = shown[i - 1].plateY - shown[i].plateY;
      assert.ok(apart >= PLATE.compactHeight + PLATE.spacing - 1e-6, `${label}: ${shown[i].id} stays ${apart.toFixed(1)}px above ${shown[i - 1].id}`);
    }
  };
  checkSpacing('priority plates');
  // Thinning only lifts once the stack fits with returnShare to spare, so a 1% nudge at the boundary keeps it; well inside the
  // stride, 5% of zoom jitter either way keeps the same plates.
  for (const factor of [1.01, .99, 1.01, 1, .8, .84, .76, .84, .8]) {
    assert.equal(plateLayout(overview, camera, zoom * factor), pattern, `zoom ${(zoom * factor).toFixed(3)} keeps the chosen plates`);
    assert.equal(overview.plateStride, 2);
    checkSpacing(`zoom ${(zoom * factor).toFixed(3)}`);
  }
  // A cleared error does not reshuffle the stack: plates already shown stay while they still fit.
  overview.setFloors(stackOf({ 'floor-5': 'approval' }));
  assert.equal(plateLayout(overview, camera, zoom), pattern, 'clearing the 4F error keeps the same plates');
  // The focus floor outranks the approval and the top floor next to it.
  overview.focusFloor('floor-6');
  assert.equal(plateLayout(overview, camera, zoom), 'phphphph',
    'focus 7F and selected 1F; keeping the 4F plate already shown would leave room for fewer plates, so 3F and 5F fill the stack');
  checkSpacing('focus plate');
});

test('a thinned stack settles neighbouring priority floors by rank, keyboard focus first, and a hidden long name never turns the shown plates to numbers', t => {
  const { overview } = fixture(t);
  const long = '아주 긴 프로젝트 이름을 가진 층';
  const stackOf = (states, names = {}) => Array.from({ length: 8 }, (_, index) => {
    const id = `floor-${index}`;
    return { id, name: names[id] ?? id, agents: [person(`${id}-0`, states[id] ?? 'working')] };
  });
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 1000);
  // Each case zooms in from uncrowded storeys, so no plate shown before carries over into the choice.
  let zoom = .5;
  const thinned = (states, names) => {
    overview.setFloors(stackOf(states, names)); overview.show(true, 'floor-0');
    zoom = .5;
    assert.equal(plateLayout(overview, camera, zoom), 'pppppppp', 'uncrowded storeys name every floor');
    while (overview.plateStride < 2 && zoom > .02) plateLayout(overview, camera, zoom *= .98);
    assert.equal(overview.plateStride, 2);
    return plateLayout(overview, camera, zoom);
  };
  assert.equal(thinned({ 'floor-1': 'error', 'floor-3': 'error', 'floor-4': 'approval' }), 'phhphphp',
    'selected 1F hides the error on 2F beside it, the error on 4F hides the approval on 5F beside it, and the top floor stays');
  assert.equal(thinned({ 'floor-6': 'approval' }), 'phphphph', 'an approval on 7F hides the top floor beside it');
  // The plate holding keyboard focus outranks the error beside it.
  overview.setFloors(stackOf({ 'floor-5': 'error' })); overview.show(true, 'floor-0');
  plateLayout(overview, camera, .5);
  overview.floors.get('floor-4').label.focus();
  assert.equal(thinned({ 'floor-5': 'error' }), 'phphphhp', 'focused 5F hides the error on 6F beside it');
  overview.floors.get('floor-4').label.blur();

  // Forms: a long name on a hidden plate does not count, so the shown plates keep their names where they fit whole.
  const forms = () => overview.order.filter(floor => !floor.label.hidden).map(floor => `${floor.label.dataset.compact}/${floor.label.dataset.tight}`);
  const room = px => ({ top: 0, right: 1000 - overview.order[0].labelX - px, bottom: 0, left: 0 });
  assert.equal(thinned({}, { 'floor-1': long }), 'phhphphp', 'selected 1F, the top floor, then every other floor from the top');
  const hiddenLong = overview.floors.get('floor-1'), shownShort = overview.floors.get('floor-3');
  assert.equal(hiddenLong.label.hidden, true);
  assert.ok(120 > shownShort.plateCompactWidth + PLATE.returnMargin && 120 < hiddenLong.plateCompactWidth);
  assert.equal(plateLayout(overview, camera, zoom, room(120)), 'phhphphp');
  assert.deepEqual([...new Set(forms())], ['true/false'], 'every shown plate keeps its whole name beside a hidden long name');
  assert.ok(overview.order.every(floor => floor.label.style.maxWidth === ''), 'no shown name needs a cut');
  // The same long name on a shown plate turns every shown plate to its number on this narrow stage (decision 57).
  assert.equal(thinned({}, { 'floor-3': long }), 'phhphphp');
  assert.equal(plateLayout(overview, camera, zoom, room(120)), 'phhphphp');
  assert.deepEqual([...new Set(forms())], ['true/true'], 'one shown long name turns every shown plate to its number');
});

test('shown plates share one form: long compact names are cut with an ellipsis to the free area, and past the shortest cut or on a narrow stage every plate shows its number', t => {
  const { overview } = fixture(t);
  const long = '아주 긴 프로젝트 이름을 가진 층';
  overview.setFloors([project('low', 1, { name: 'a' }), project('high', 1, { name: long })]);
  overview.show(true);
  const low = overview.floors.get('low'), high = overview.floors.get('high');
  assert.equal(low.plateLeastWidth, low.plateCompactWidth, 'a short name needs no cut');
  assert.equal(high.plateCompactWidth, PLATE.compactMaxWidth);
  assert.equal(high.plateLeastWidth, Math.ceil(18 + 2 * 6.2 + 7 + PLATE.nameMinWidth), 'the shortest cut keeps the number and a few name glyphs');
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 1000);
  // Names are cut on a stage wide enough for the layout without the project selector.
  const WIDE = 1280;
  plateLayout(overview, camera, 1, undefined, WIDE);
  const x = low.labelX, forms = () => [low, high].map(floor => `${floor.label.dataset.compact}/${floor.label.dataset.tight}`);
  const widths = () => [low, high].map(floor => floor.label.style.maxWidth);
  const room = px => ({ top: 0, right: WIDE - x - px, bottom: 0, left: 0 });
  assert.equal(new Set(forms()).size, 1, `one form without a side HUD (${forms()})`);

  assert.equal(plateLayout(overview, camera, 1, room(120.5), WIDE), 'pp');
  assert.deepEqual(forms(), ['true/false', 'true/false'], 'a long name past the side HUD keeps the compact form');
  assert.deepEqual(widths(), ['120px', '120px'], 'names are cut with an ellipsis at the free area\'s right edge');
  assert.ok(120 >= high.plateLeastWidth && 120 < high.plateCompactWidth);
  // Room for the short plate but not for the long plate's shortest cut: both show only their numbers instead of mixing forms.
  assert.ok(60.5 >= low.plateCompactWidth && 60.5 < high.plateLeastWidth);
  plateLayout(overview, camera, 1, room(60.5), WIDE);
  assert.deepEqual(forms(), ['true/true', 'true/true'], 'every plate shows only its number');
  assert.deepEqual(widths(), ['', ''], 'number plates carry no cut width');
  // Names come back only with returnMargin to spare, so drift at the boundary does not flip the form.
  plateLayout(overview, camera, 1, room(high.plateLeastWidth + PLATE.returnMargin / 2), WIDE);
  assert.deepEqual(forms(), ['true/true', 'true/true'], 'just past the shortest cut the numbers stay');
  plateLayout(overview, camera, 1, room(high.plateLeastWidth + PLATE.returnMargin + .5), WIDE);
  assert.deepEqual(forms(), ['true/false', 'true/false'], 'room to spare brings the cut names back');
  const cut = `${Math.floor(high.plateLeastWidth + PLATE.returnMargin + .5)}px`;
  assert.deepEqual(widths(), [cut, cut]);
  assert.ok([low, high].every(floor => floor.labelX === x), 'plates never move left over the storey');
  assert.equal(high.label.title, long, 'the title keeps the whole name');
  assert.ok(high.label.getAttribute('aria-label').includes(long), 'the accessible name keeps the whole name');
  // Decision 57: a narrow stage names the floor in its project selector, so where a name would be cut every plate shows its number,
  // and names return only once every shown name fits whole with returnMargin to spare.
  // Zoomed out a little, so the narrow stage leaves the plate column room for a whole name and its return margin.
  const NARROW = PLATE.nameCutMinWidth - 1, narrowZoom = .9;
  plateLayout(overview, camera, narrowZoom, undefined, NARROW);
  assert.ok(NARROW - low.labelX > high.plateCompactWidth + PLATE.returnMargin + .5, `the narrow stage leaves ${(NARROW - low.labelX).toFixed(1)}px right of the plates`);
  const narrowRoom = px => ({ top: 0, right: NARROW - low.labelX - px, bottom: 0, left: 0 });
  plateLayout(overview, camera, narrowZoom, narrowRoom(120.5), NARROW);
  assert.deepEqual(forms(), ['true/true', 'true/true'], 'a narrow stage shows numbers where a wide one cuts names');
  assert.deepEqual(widths(), ['', '']);
  plateLayout(overview, camera, narrowZoom, narrowRoom(high.plateCompactWidth + PLATE.returnMargin / 2), NARROW);
  assert.deepEqual(forms(), ['true/true', 'true/true'], 'just past the whole name the numbers stay');
  plateLayout(overview, camera, narrowZoom, narrowRoom(high.plateCompactWidth + PLATE.returnMargin + .5), NARROW);
  assert.deepEqual(forms(), ['true/false', 'true/false'], `whole names with room to spare come back (${forms()})`);
  assert.equal(high.label.title, long);
  plateLayout(overview, camera, 1, room(400), WIDE);
  assert.deepEqual(widths(), ['', ''], 'with room for the stylesheet width no cut is written');
  assert.equal(new Set(forms()).size, 1);
});

test('the rooftop sign letters the company setting on one canvas texture, repainting only on change', t => {
  const { overview, drawn } = fixture(t, { canvas: true });
  overview.setFloors([project('only', 1)]);
  const sign = byName(overview, 'building-company-sign');
  const texture = sign.material.map;
  assert.ok(texture instanceof THREE.CanvasTexture);
  const letters = () => drawn.filter(([kind]) => kind === 'fillText').map(([, value]) => value);
  assert.deepEqual(letters(), [], 'no lettering before the setting arrives');
  const version = texture.version;
  overview.setCompanyName('  SampleStudio  ');
  assert.equal(overview.companyName, 'SampleStudio');
  assert.deepEqual(letters(), ['SampleStudio']);
  assert.ok(texture.version > version);
  const calls = drawn.length, repainted = texture.version;
  overview.setCompanyName('SampleStudio');
  assert.equal(drawn.length, calls); assert.equal(texture.version, repainted, 'the same name does not repaint');
  overview.setCompanyName('아주 긴 회사 이름이 간판 폭을 넘는 경우'.repeat(3));
  const long = letters().at(-1);
  assert.ok(long.endsWith('…') && [...long].length * 40 <= 1024 - 96, 'long names are cut with an ellipsis');
  assert.equal(sign.material.map === texture, true, 'still one texture');

  const top = overview.floors.get('only');
  assert.ok(sign.visible);
  assert.ok(sign.position.y - sign.scale.y / 2 > top.group.position.y + top.gap, 'the sign stands above the roof');
  assert.ok(Math.abs(sign.position.x) + sign.scale.x / 2 < top.width / 2 && sign.position.z < top.depth / 2);
  assert.ok(overview.bounds.max.y >= sign.position.y + sign.scale.y / 2, 'camera bounds include the sign');
  let released = 0;
  texture.addEventListener('dispose', () => released++);
  overview.dispose();
  assert.equal(released, 1);
});

test('without a canvas context the sign keeps the setting but draws nothing', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('only', 0)]);
  overview.setCompanyName('회사');
  const sign = byName(overview, 'building-company-sign');
  assert.equal(overview.companyName, '회사');
  assert.equal(sign.userData.companyName, '회사');
  assert.equal(sign.material.map === null, true, 'no texture without a canvas context');
});

test('building bodies wear the same skin and hair as the 3D office for each agent id, while a reported color paints the shirt', t => {
  const { overview } = fixture(t);
  const ids = ['planner', 'designer', 'developer', 'reviewer', 'worker-live', 'claude:abc'];
  overview.setFloors([{ id: 'p', name: 'p', agents: ids.map(id => person(id)) }]);
  const floor = overview.floors.get('p');
  ids.forEach((id, i) => {
    const look = appearanceFor(id);
    assert.equal(`#${hex(floor.heads, i)}`, look.skin, id);
    assert.equal(`#${hex(floor.arms, i * 2)}`, look.skin, id);
    assert.equal(`#${hex(floor.arms, i * 2 + 1)}`, look.skin, id);
    assert.equal(`#${hex(floor.hair, i)}`, look.hair, id);
    assert.equal(`#${hex(floor.bodies, i)}`, look.seatShirt, `${id}: the default shirt without a reported color`);
  });
  const reversed = [...ids].reverse();
  overview.setFloors([{ id: 'p', name: 'p', agents: reversed.map(id => person(id, 'working', { color: '#123456' })) }]);
  const again = overview.floors.get('p');
  reversed.forEach((id, i) => {
    assert.equal(`#${hex(again.heads, i)}`, appearanceFor(id).skin, `${id} keeps their look on another desk`);
    assert.equal(hex(again.bodies, i), '123456');
  });
});

test('status markers stay at least ten pixels, approval and error marks hold still, and reduced motion, power saving or a crowd freeze the work ring', t => {
  const { overview } = fixture(t);
  overview.setFloors([{ id: 'p', name: 'p', agents: [person('w'), person('a', 'approval'), person('e', 'error'), person('t', 'thinking')] }]);
  const floor = overview.floors.get('p');
  for (const unitsPerPixel of [.02, .05, 1, 3]) {
    overview.update(0, true, true, unitsPerPixel);
    const minimum = 10 * unitsPerPixel - 1e-9;
    assert.ok(instanceScale(floor.activityRings, 0).y * 2 >= minimum, `ring at ${unitsPerPixel}`);
    assert.ok(instanceScale(floor.activityDashes, 3).y * 2 >= minimum, `dashed ring at ${unitsPerPixel}`);
    assert.ok(instanceScale(floor.activityHeads, 1).x * 2 >= minimum, `diamond at ${unitsPerPixel}`);
    assert.ok(instanceScale(floor.activityPins, 2).x >= minimum, `pin at ${unitsPerPixel}`);
  }
  assert.equal(floor.activityHeads.material.depthTest, false, 'approval stays visible behind slabs');
  assert.equal(floor.activityPins.material.depthTest, false, 'errors stay visible behind slabs');

  overview.update(0, false, false, .05);
  const ring = [], diamond = [], pin = [];
  for (let step = 0; step < 400; step++) {
    overview.update(.02, false, false, .05);
    ring.push(instanceScale(floor.activityRings, 0).y);
    diamond.push(matrices(floor.activityHeads).join());
    pin.push(matrices(floor.activityPins).join());
  }
  // The design gives approval and error marks a shape and colour only; the pre-existing work ring pulse stays slow.
  assert.equal(new Set(diamond).size, 1, 'the approval diamond is static');
  assert.equal(new Set(pin).size, 1, 'the error pin is static');
  const peaks = ring.flatMap((value, i) => i > 0 && i < ring.length - 1 && ring[i - 1] < value && value >= ring[i + 1] ? [i] : []);
  assert.ok(peaks.length >= 2);
  const period = (peaks[1] - peaks[0]) * .02;
  assert.ok(period >= 2 && period <= 4, `a slow work ring pulse, not a flicker (${period}s)`);

  for (const freeze of [() => overview.update(1, false, true), () => { overview.setPowerSaving(true); overview.update(1, false, false); }]) {
    freeze();
    const heads = matrices(floor.activityHeads), rings = matrices(floor.activityRings), arms = matrices(floor.arms);
    overview.update(.7, false, overview.powerSaving ? false : true);
    assert.deepEqual(matrices(floor.activityHeads), heads);
    assert.deepEqual(matrices(floor.activityRings), rings);
    assert.deepEqual(matrices(floor.arms), arms, 'no typing motion either');
  }
  overview.setPowerSaving(false);

  const crowd = [person('crowd-worker'), ...roster('crowd', LARGE_BUILDING_AGENTS)];
  overview.setFloors([{ id: 'crowd', name: 'crowd', agents: crowd }]);
  const crowded = overview.floors.get('crowd');
  const before = matrices(crowded.activityRings);
  overview.update(.8, false, false);
  assert.deepEqual(matrices(crowded.activityRings), before, 'the work ring pulse stops in a very large building');
  assert.ok(instanceScale(crowded.activityRings, 0).x > 0, 'the marker itself remains');
});

test('flight trails rewrite one position buffer in place instead of allocating geometry every frame', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('lower', 1), project('upper', 1)]);
  assert.equal(overview.sendPaperPlane('lower-0', 'upper-0', 'trail'), true);
  const flight = overview.flights[0], geometry = flight.trail.geometry, positions = geometry.getAttribute('position');
  const start = Array.from(positions.array);
  for (let frame = 0; frame < 10; frame++) overview.update(.2, false, false);
  assert.equal(flight.trail.geometry === geometry, true, 'the trail keeps its geometry');
  assert.equal(geometry.getAttribute('position') === positions, true, 'the trail keeps its position buffer');
  assert.notDeepEqual(Array.from(positions.array), start);
  const last = new THREE.Vector3().fromBufferAttribute(positions, positions.count - 1);
  // The trail buffer is Float32 while the plane position is a double, so compare at single precision.
  assert.ok(last.distanceTo(flight.plane.position) < 1e-5, 'the trail ends at the plane');
});

test('the model stands on a rounded ground plate with a glass core beside the widest floor and a roof over the top storey', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('wide', 6), project('narrow', 1)]);
  const wide = overview.floors.get('wide'), narrow = overview.floors.get('narrow');
  const ground = byName(overview, 'building-ground');
  assert.ok(ground.visible);
  assert.deepEqual(ground.material.map(material => material.color.getHexString()), ['b9d9bf', '9dbdaa']);
  ground.geometry.computeBoundingBox();
  const plate = ground.geometry.boundingBox;
  near(plate.max.y, -.68, 'the ground top meets the lowest slab underside');
  assert.ok(plate.min.x < -wide.width / 2 && plate.max.x > wide.width / 2 + 5 && plate.min.z < -wide.depth / 2 && plate.max.z > wide.depth / 2);
  const outline = ground.geometry.getAttribute('position');
  for (let i = 0; i < outline.count; i++) {
    assert.ok(!(Math.abs(outline.getX(i) - plate.min.x) < 1e-6 && Math.abs(outline.getZ(i) - plate.min.z) < 1e-6), 'corners are rounded');
  }

  const glass = byName(overview, 'building-glass');
  const panes = Array.from({ length: glass.count }, (_, i) => instanceBox(glass, i));
  const core = panes.reduce((tallest, box) => box.max.y - box.min.y > tallest.max.y - tallest.min.y ? box : tallest);
  assert.ok(core.min.x > wide.width / 2, 'the core stands beside the widest floor');
  assert.ok(core.max.y > narrow.group.position.y + narrow.gap, 'the core rises past the roof');
  for (const floor of [wide, narrow]) {
    assert.ok(panes.some(box => Math.abs(box.min.y - (floor.group.position.y + SIDE_WALL_HEIGHT)) < 1e-6 && box.min.x > floor.width / 2 - .2),
      'side glass starts above the solid wall of each storey');
  }
  // Decision 48: the roof slab is a see-through ceiling, drawn with the ceiling beams.
  const ceilings = byName(overview, 'building-ceilings');
  const roofY = narrow.group.position.y + narrow.gap;
  assert.ok(Array.from({ length: ceilings.count }, (_, i) => instanceBox(ceilings, i))
    .some(box => Math.abs(box.max.y - (roofY - .08)) < 1e-6 && Math.abs(box.max.x - box.min.x - narrow.width) < 1e-6), 'a roof slab covers the top storey');

  let released = 0;
  const previous = ground.geometry;
  previous.addEventListener('dispose', () => released++);
  overview.setFloors([project('wide', 30)]);
  assert.equal(released, 1, 'a new footprint releases the previous ground geometry');
  assert.equal(ground.geometry !== previous, true, 'a new ground geometry replaces the previous one');
  overview.setFloors([]);
  assert.equal(ground.visible, false);
  assert.equal(byName(overview, 'building-company-sign').visible, false);
  for (const name of ['building-structure', 'building-windows', 'building-glass', 'building-bushes']) assert.equal(byName(overview, name).count, 0, name);
});

test('each storey carries a thick front slab band and a half-height back wall, and the roof, core and entrance are complete', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('base', 11), project('mid', 3), project('top', 1)]);
  const floors = ['base', 'mid', 'top'].map(id => overview.floors.get(id));
  const structure = byName(overview, 'building-structure'), ceilings = byName(overview, 'building-ceilings');
  const boxes = Array.from({ length: structure.count }, (_, i) => ({ box: instanceBox(structure, i), color: hex(structure, i) }));
  const close = (a, b) => Math.abs(a - b) < 1e-4;
  const size = box => box.getSize(new THREE.Vector3());
  // Decision 48: the ground floor's band is solid structure; the bands above it are see-through ceiling edges.
  const lids = Array.from({ length: ceilings.count }, (_, i) => ({ box: instanceBox(ceilings, i), color: hex(ceilings, i) }));
  floors.forEach((floor, index) => {
    const y = floor.group.position.y, front = floor.depth / 2, back = -floor.depth / 2;
    const frontBand = ({ box }) => close(size(box).x, floor.width + .36) && close(size(box).y, .8) && box.max.z > front && box.min.z < front && close(box.max.y, y + .02);
    assert.equal((index ? lids : boxes).some(frontBand), true, 'a thick slab band edges the open front of every storey');
    assert.equal((index ? boxes : lids).some(frontBand), false, index ? 'an upper band is not opaque structure' : 'the ground floor band is not a ceiling');
    const wall = boxes.find(({ box }) => close(box.min.y, y - .08) && close(size(box).x, floor.width) && box.min.z <= back + 1e-4 && box.max.z < back + .5);
    assert.ok(wall, 'a clay wall closes the back of every storey');
    const wallHeight = size(wall.box).y, clearHeight = floor.gap - .68 - (-.08);
    assert.ok(wallHeight > 1.5 && wallHeight < clearHeight / 2, `the back wall stays at most half the storey (${wallHeight} of ${clearHeight})`);
  });

  const top = floors.at(-1), roofY = top.group.position.y + top.gap;
  const parapets = boxes.filter(({ box }) => close(box.min.y, roofY - .08) && close(box.max.y, roofY + .72)
    && (close(size(box).x, top.width) || close(size(box).z, top.depth)));
  assert.ok(parapets.length >= 4, 'a parapet runs around all four roof edges');

  const glass = byName(overview, 'building-glass');
  const core = Array.from({ length: glass.count }, (_, i) => instanceBox(glass, i))
    .reduce((tallest, box) => size(box).y > size(tallest).y ? box : tallest);
  const inCore = box => box.min.x >= core.min.x - 1e-4 && box.max.x <= core.max.x + 1e-4 && box.min.z >= core.min.z - 1e-4 && box.max.z <= core.max.z + 1e-4;
  assert.ok(boxes.some(({ box, color }) => color === 'fffdf5' && inCore(box) && box.min.y >= -.68 - 1e-4), 'a parked elevator car stands inside the core');
  for (const floor of floors) {
    const y = floor.group.position.y;
    const flights = boxes.filter(({ box, color }) => color === 'c6d4de' && inCore(box) && box.min.y >= y - .2 && box.max.y <= y + floor.gap + .2
      && size(box).y > .5);
    assert.ok(flights.length >= 2, 'a two-flight stair climbs through the core on every storey');
  }

  const canopy = boxes.find(({ box, color }) => color === 'eef5fa' && close(size(box).y, .18) && box.min.z >= core.max.z - 1e-4);
  assert.ok(canopy, 'an entrance canopy projects in front of the core');
  assert.ok(canopy.box.min.y > 2 && canopy.box.max.y < floors[0].gap, 'the canopy sits at door height on the ground storey');
  const posts = boxes.filter(({ box }) => close(box.min.y, -.68) && box.max.y >= canopy.box.min.y - 1e-4 && box.max.y <= canopy.box.max.y + 1e-4
    && box.min.x >= canopy.box.min.x - 1e-4 && box.max.x <= canopy.box.max.x + 1e-4);
  assert.equal(posts.length, 2, 'two posts carry the canopy down to the ground plate');
});

test('floor instances are rewritten and uploaded only when zoom, the roster or motion change, on detailed and compressed floors', t => {
  const { overview } = fixture(t);
  const versions = floor => [floor.activityRings, floor.activityDashes, floor.activityHeads, floor.activityPins, floor.arms, floor.workBoxes]
    .flatMap(mesh => [mesh.instanceMatrix.version, mesh.instanceColor ? mesh.instanceColor.version : 0]);
  const quietRoster = status => [person('a', status), person('e', 'error'), person('i', 'idle')];
  overview.setFloors([{ id: 'quiet', name: 'quiet', agents: quietRoster('approval') }, { id: 'busy', name: 'busy', agents: [person('w')] }]);
  const quiet = overview.floors.get('quiet'), busy = overview.floors.get('busy');
  overview.update(0, false, false, .05);
  let still = versions(quiet), moving = versions(busy);
  for (let frame = 0; frame < 30; frame++) overview.update(1 / 30, false, false, .05);
  assert.deepEqual(versions(quiet), still, 'a floor without work motion is not re-uploaded while nothing changes');
  assert.notDeepEqual(versions(busy), moving, 'a working floor keeps moving');
  const diamond = instanceScale(quiet.activityHeads, 0).x;
  overview.update(0, false, false, .5);
  assert.notDeepEqual(versions(quiet), still, 'a zoom change rewrites the markers');
  assert.ok(instanceScale(quiet.activityHeads, 0).x > diamond, 'so they stay at least ten pixels');
  still = versions(quiet);
  overview.update(1 / 30, false, false, .5);
  assert.deepEqual(versions(quiet), still, 'once per zoom change');

  moving = versions(busy);
  overview.update(1 / 30, true, false, .5);
  assert.deepEqual(versions(busy), moving, 'a paused frame uploads nothing');
  overview.update(1 / 30, false, true, .5);
  assert.notDeepEqual(versions(busy), moving, 'reduced motion settles the pose once');
  moving = versions(busy);
  for (let frame = 0; frame < 10; frame++) overview.update(1 / 30, false, true, .5);
  assert.deepEqual(versions(busy), moving, 'and uploads nothing afterwards');
  overview.setPowerSaving(true);
  overview.update(1 / 30, false, false, .5);
  moving = versions(busy);
  for (let frame = 0; frame < 10; frame++) overview.update(1 / 30, false, false, .5);
  assert.deepEqual(versions(busy), moving, 'power saving uploads nothing either');
  overview.setPowerSaving(false);

  still = versions(quiet);
  overview.setFloors([{ id: 'quiet', name: 'quiet', agents: quietRoster('error') }, { id: 'busy', name: 'busy', agents: [person('w')] }]);
  assert.equal(overview.floors.get('quiet') === quiet, true, 'a status change keeps the floor');
  assert.notDeepEqual(versions(quiet), still, 'a reported status change rewrites the markers');
  // Matrix4.decompose reports unit scale for a degenerate matrix, so read the drawn width straight from the matrix column.
  const drawnWidth = (mesh, index) => { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix); return new THREE.Vector3().setFromMatrixColumn(matrix, 0).length(); };
  assert.equal(drawnWidth(quiet.activityHeads, 0) < 1e-9, true, 'the resolved approval diamond is gone');
  assert.ok(instanceScale(quiet.activityPins, 0).x > 0, 'the new error pin is drawn');

  overview.setFloors(Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, agents: [person(`f${i}-a`, 'approval'), person(`f${i}-w`)] })));
  const compressed = overview.floors.get('f4');
  assert.equal(compressed.detailed, false);
  overview.update(0, false, false, .05);
  const marks = versions(compressed);
  for (let frame = 0; frame < 30; frame++) overview.update(1 / 30, false, false, .05);
  assert.deepEqual(versions(compressed), marks, 'compressed floors keep their static marks without re-uploading');
  overview.update(0, false, false, .3);
  assert.notDeepEqual(versions(compressed), marks, 'a zoom change still resizes their marks');
});

test('ceilings between storeys are see-through without depth writes or shadows, and the role follows the storey order (decision 48)', t => {
  const { overview } = fixture(t);
  overview.setFloors([project('base', 3), project('mid', 2), project('top', 1)]);
  const ceilings = byName(overview, 'building-ceilings');
  const seeThrough = material => material.transparent === true && Math.abs(material.opacity - CEILING_OPACITY) < 1e-9 && material.depthWrite === false;
  const opaque = material => material.transparent === false && material.opacity === 1 && material.depthWrite === true;
  const slabs = id => overview.floors.get(id).group.children.slice(0, 2);
  assert.equal(CEILING_OPACITY, .2);
  assert.equal(seeThrough(ceilings.material), true, 'ceiling beams, the edge bands above the ground floor and the roof use the see-through material');
  assert.equal(ceilings.castShadow === false && ceilings.renderOrder >= 1, true, 'see-through ceilings cast no shadow and draw after the opaque interior');
  assert.equal(ceilings.count, 3 * 2 + 2 * 2 + 4, 'two beams per storey, two edge bands per upper storey, the roof slab, finish and two bands');
  for (const name of ['building-structure', 'building-windows', 'building-focus-edge']) {
    assert.equal(opaque(byName(overview, name).material), true, `${name}: columns, walls, the core, the ground floor band, windows and the focus band stay opaque`);
  }
  for (const slab of slabs('base')) assert.equal(opaque(slab.material) && slab.renderOrder === 0, true, 'the ground floor slab is not a ceiling');
  for (const id of ['mid', 'top']) {
    for (const slab of slabs(id)) {
      assert.equal(seeThrough(slab.material), true, `${id}: its slab is the ceiling of the storey below`);
      assert.equal(slab.castShadow === false && slab.renderOrder === ceilings.renderOrder, true, `${id}: the see-through slab casts no shadow and draws with the ceilings`);
    }
  }
  // Desks, people, work rigs and the reception stay solid, and the shared colour cache never lends them a see-through material.
  for (const floor of overview.floors.values()) {
    for (const child of floor.group.children.slice(2)) {
      if (child.material.isMeshStandardMaterial) assert.equal(opaque(child.material), true, `${floor.id}: ${child.name || child.type} stays opaque`);
    }
  }
  assert.equal([...overview.materials.values()].every(opaque), true, 'the shared colour cache holds only opaque materials');
  assert.equal(overview.ceilingSlabMaterials.size === 2 && [...overview.ceilingSlabMaterials.values()].every(seeThrough), true,
    'the slab and floor finish have see-through materials of their own');

  overview.focusFloor('top');
  overview.setFloors([project('top', 1), project('base', 3), project('mid', 2)]);
  for (const slab of slabs('top')) assert.equal(slab.material.transparent === false && slab.renderOrder === 0, true, 'the storey that became the ground floor is solid');
  for (const slab of slabs('base')) {
    assert.equal(seeThrough(slab.material), true, 'a storey that moved up becomes see-through');
    assert.equal(slab.material.emissive.getHexString(), 'f2f7fa', 'and keeps the haze while another floor is focused');
  }
  overview.focusFloor(null);
  for (const slab of slabs('base')) {
    assert.equal(seeThrough(slab.material) && slab.material.emissive.getHexString() === '000000', true, 'lifting the haze keeps the see-through slab');
  }
  const materials = [overview.materials.size, overview.ceilingSlabMaterials.size, overview.hazedMaterials.size];
  for (let frame = 0; frame < 10; frame++) overview.update(1 / 30, false, false);
  assert.deepEqual([overview.materials.size, overview.ceilingSlabMaterials.size, overview.hazedMaterials.size], materials, 'frames create no materials');
  overview.setFloors([]);
  assert.equal(ceilings.count === 0 && byName(overview, 'building-focus-edge').count === 0, true, 'an empty building draws no ceilings');
});

test('see-through ceilings keep a bounded set of resources through grow, shrink and grow, on compressed floors too, and release each once (decision 48)', t => {
  const { overview } = fixture(t);
  const released = new Map(), watched = new Set();
  const watch = resource => {
    if (watched.has(resource)) return;
    watched.add(resource);
    resource.addEventListener('dispose', () => released.set(resource, (released.get(resource) ?? 0) + 1));
  };
  const watchAll = () => {
    for (const name of ['building-ceilings', 'building-focus-edge']) { const mesh = byName(overview, name); watch(mesh); watch(mesh.material); }
    for (const material of [...overview.ceilingSlabMaterials.values(), ...overview.hazedMaterials.values()]) watch(material);
  };
  const stack = count => Array.from({ length: count }, (_, i) => project(`f${i}`, 2));
  const sizes = [];
  for (const [step, count] of [2, 12, 1, 12].entries()) {
    const inputs = stack(count);
    overview.setFloors(inputs); overview.show(true); overview.focusFloor(inputs.at(-1).id);
    watchAll();
    inputs.forEach(({ id }, index) => {
      const floor = overview.floors.get(id);
      for (const slab of floor.group.children.slice(0, 2)) assert.equal(slab.material.transparent, index > 0, `step ${step}: storey ${index} ${floor.detailed ? 'detailed' : 'compressed'}`);
    });
    assert.equal(byName(overview, 'building-ceilings').count, 2 * count + 2 * (count - 1) + 4, `step ${step}: beams, upper edge bands and the roof`);
    assert.equal(byName(overview, 'building-focus-edge').count, 2, `step ${step}: the focus band`);
    sizes.push([overview.shell.children.length, overview.ceilingSlabMaterials.size, overview.hazedMaterials.size]);
  }
  assert.equal(overview.floors.get('f4').detailed, false, 'twelve floors compress the floors away from the focus');
  assert.deepEqual(sizes[3], sizes[1], 'growing again reuses the same draw objects and materials');
  assert.equal(sizes.every(([objects]) => objects === sizes[0][0]) && sizes[3][1] <= 2, true, 'a fixed set of draw objects and at most two see-through slab materials');
  const replaced = [...watched].filter(resource => resource.isInstancedMesh && !overview.shell.children.includes(resource));
  assert.ok(replaced.length >= 1, 'growing past the first capacity replaced the ceiling buffer');
  assert.equal(replaced.every(mesh => released.get(mesh) === 1), true, 'a replaced ceiling buffer is released exactly once');
  assert.equal([...watched].filter(resource => !replaced.includes(resource)).every(resource => !released.has(resource)), true, 'nothing in use is released early');
  overview.dispose(); overview.dispose();
  assert.equal([...watched].every(resource => released.get(resource) === 1), true, 'dispose releases every ceiling mesh and material exactly once');
  assert.equal(overview.ceilingSlabMaterials.size, 0);
});

test('from the default building camera no opaque slab, ceiling or edge band stands between the camera and a desk top or a head (decision 48)', t => {
  const { overview } = fixture(t);
  // Deep floors under shallow ones: with an opaque slab above and its opaque edge band, their back rows were hidden.
  const sizes = [16, 12, 8, 5, 2, 1];
  overview.setFloors(sizes.map((count, index) => project(`p${index}`, count)));
  overview.show(true);
  const scene = new THREE.Scene(); scene.add(overview.group);
  const floors = sizes.map((_, index) => overview.floors.get(`p${index}`));
  const { yaw, elevation } = BUILDING_VIEW;
  const toCamera = new THREE.Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
  const raycaster = new THREE.Raycaster(), matrix = new THREE.Matrix4();
  const visible = object => { for (let node = object; node; node = node.parent) if (!node.visible) return false; return true; };
  const clear = object => [object.material].flat().every(material => material.transparent);
  // A storey divider is a floor's slab or finish, or any shell part lying in the layer around a floor or roof level (beams, edge bands, roof slab).
  const divider = hit => {
    const object = hit.object;
    if (object.parent?.name === 'project-floor') return object.parent.children.indexOf(object) < 2;
    if (!object.isInstancedMesh) return false;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    object.getMatrixAt(hit.instanceId, matrix);
    const box = object.geometry.boundingBox.clone().applyMatrix4(matrix).applyMatrix4(object.matrixWorld);
    const top = floors.at(-1), levels = [...floors.map(floor => floor.group.position.y), top.group.position.y + top.gap];
    return levels.some(level => box.min.y >= level - 1.05 && box.max.y <= level + .15);
  };
  const sightlines = list => {
    scene.updateMatrixWorld(true);
    for (const root of [overview.group, overview.shell]) root.traverse(object => { if (object.isInstancedMesh) object.boundingSphere = null; });
    let targets = 0, through = 0;
    const blocked = [];
    for (const floor of list) {
      floor.points.forEach((point, index) => {
        for (const [part, local, radius] of [['desk top', new THREE.Vector3(point.x, 1.24, point.z - 1.05), .02], ['head', new THREE.Vector3(point.x, 1.96, point.z - .04), .45]]) {
          const target = floor.group.localToWorld(local);
          raycaster.set(target.clone().addScaledVector(toCamera, 300), toCamera.clone().negate());
          const dividers = raycaster.intersectObjects([overview.group, overview.shell], true)
            .filter(hit => hit.distance < 300 - radius && visible(hit.object) && divider(hit));
          targets++;
          if (dividers.some(hit => clear(hit.object))) through++;
          if (dividers.some(hit => !clear(hit.object))) blocked.push(`${floor.id} seat ${index} ${part}`);
        }
      });
    }
    return { targets, through, blocked };
  };
  const all = sightlines(floors);
  assert.equal(all.targets, 2 * sizes.reduce((sum, count) => sum + count, 0));
  assert.ok(all.through > all.targets / 3, `most sightlines pass through see-through ceilings (${all.through} of ${all.targets})`);
  assert.deepEqual(all.blocked, [], 'no opaque storey divider hides a desk top or a head');
  // The opaque navy focus band hangs below the focus floor, so the focus floor itself stays fully in view.
  overview.focusFloor('p2');
  assert.deepEqual(sightlines([overview.floors.get('p2')]).blocked, [], 'the focus band never hides its own floor');
});
