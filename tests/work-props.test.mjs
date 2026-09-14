import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorkProps } from '../src/work-props.ts';

const kinds = ['coding', 'documents', 'research', 'testing', 'reviewing', 'planning', 'design', 'delivery', 'shipping', 'general'];

function objects(props) {
  const nodes = [];
  props.group.traverse(node => nodes.push(node));
  return nodes;
}

function pose(props) {
  return objects(props).filter(node => !node.name.startsWith('work-') && node.name !== 'pause-bar').map(node => [
    node.name, ...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray(), node.visible,
  ]);
}

test('all ten distinct desk scenes stay within their own monitor space across complete motion cycles', () => {
  const silhouettes = new Set();
  for (const kind of kinds) {
    const props = new WorkProps(kind, 3);
    const meshes = objects(props).filter(node => node.isMesh);
    assert.ok(meshes.length >= 5 && meshes.length <= 50, `${kind}: ${meshes.length} meshes`);
    silhouettes.add(meshes.map(node => node.name).join(','));
    for (let frame = 0; frame <= 240; frame++) {
      props.update(frame / 10);
      const box = new THREE.Box3().setFromObject(props.group);
      assert.ok([...box.min, ...box.max].every(Number.isFinite), `${kind}: finite geometry`);
      assert.ok(box.min.x >= -.85 && box.max.x <= .85, `${kind}: x bounds ${box.min.x}–${box.max.x}`);
      assert.ok(box.min.y >= -.4 && box.max.y <= .8, `${kind}: y bounds ${box.min.y}–${box.max.y}`);
      assert.ok(box.min.z >= .04 && box.max.z <= .8, `${kind}: z bounds ${box.min.z}–${box.max.z}`);
    }
    props.dispose();
  }
  assert.equal(silhouettes.size, kinds.length, 'each activity has its own recognisable objects');
});

test('robot links remain attached to monitor shoulders, elbows and wrists while the machine is assembled', () => {
  const props = new WorkProps('coding');
  props.update(0);
  const before = pose(props);
  const axis = new THREE.Vector3(0, 1, 0);
  for (let frame = 1; frame <= 30; frame++) {
    props.update(frame / 10);
    for (const armName of ['left-robot-arm', 'right-robot-arm']) {
      const arm = props.group.getObjectByName(armName);
      for (const [linkName, startName, endName] of [
        ['robot-upper-link', 'robot-shoulder', 'robot-elbow'], ['robot-fore-link', 'robot-elbow', 'robot-wrist'],
      ]) {
        const link = arm.getObjectByName(linkName), start = arm.getObjectByName(startName), end = arm.getObjectByName(endName);
        const half = axis.clone().applyQuaternion(link.quaternion).multiplyScalar(link.scale.y / 2);
        assert.ok(link.position.clone().sub(half).distanceTo(start.position) < 1e-8);
        assert.ok(link.position.clone().add(half).distanceTo(end.position) < 1e-8);
      }
    }
  }
  assert.notDeepEqual(pose(props), before);
  props.dispose();
});

test('the coding workbench clears the monitor top and both grippers follow their visible assembly blocks', () => {
  const props = new WorkProps('coding');
  const platform = props.group.getObjectByName('assembly-pedestal');
  assert.ok(platform.position.y - platform.scale.y / 2 > .34, 'the platform is above the screen, clear of the seated head');
  const machine = props.group.getObjectByName('code-block-machine');
  assert.ok(machine.position.x > .15 && machine.position.y > .45, 'assembly is offset to the upper right of the monitor');
  for (let frame = 0; frame < 100; frame++) {
    props.update(frame / 10);
    for (const [side, blockIndex] of [['left', 2], ['right', 3]]) {
      const wrist = props.group.getObjectByName(`${side}-robot-arm`).getObjectByName('robot-wrist');
      const block = machine.getObjectByName(`code-block-${blockIndex}`);
      const blockPosition = block.position.clone().add(machine.position);
      assert.ok(Math.abs(wrist.position.x - blockPosition.x) < 1e-8, `${side}: gripper follows its block horizontally`);
      assert.ok(Math.abs(wrist.position.y - .055 - blockPosition.y) < 1e-8, `${side}: gripper holds the moving block`);
      assert.equal(wrist.position.z, blockPosition.z);
    }
  }
  props.dispose();
});

test('documents visibly acquire decorative lines, leave the screen and shrink into their filing folder', () => {
  const props = new WorkProps('documents');
  const page = props.group.getObjectByName('document-page-0');
  const lines = page.children.slice(1);
  props.update(0);
  assert.ok(lines.every(line => !line.visible), 'the writing loop starts with blank paper');
  props.update(1);
  assert.ok(lines.some(line => line.visible));
  assert.ok(lines.some(line => !line.visible), 'lines are written progressively');
  props.update(3.5);
  assert.ok(lines.every(line => line.visible));
  assert.ok(page.position.z > .2, 'the printed page leaves the monitor');
  props.update(5.5);
  assert.ok(Math.abs(page.position.x - .4) < .001, 'the page aligns with the folder');
  props.update(6.9);
  assert.ok(page.scale.x < .25, 'filing removes the document rather than accumulating objects');
  props.update(7.2);
  assert.equal(page.scale.x, 1);
  assert.ok(lines.every(line => !line.visible), 'the next cycle creates another blank document');
  props.dispose();
});

test('reduced motion and zero intensity preserve readable static props without changing scene entrance scale', () => {
  for (const kind of kinds) {
    const props = new WorkProps(kind, 47);
    props.group.scale.setScalar(.37);
    for (const options of [{ reducedMotion: true }, { intensity: 0 }]) {
      props.update(0, options);
      const before = pose(props);
      props.update(3, options); props.update(200, options);
      assert.deepEqual(pose(props), before, `${kind}: static pose`);
      assert.deepEqual(props.group.scale.toArray(), [.37, .37, .37]);
      assert.ok(objects(props).some(node => node.isMesh && node.visible));
    }
    props.dispose();
  }
});

test('waiting and errors freeze equipment, display distinct pause marks and resume without a time jump', () => {
  for (const kind of kinds) {
    const props = new WorkProps(kind), continuous = new WorkProps(kind);
    props.update(0); props.update(2); continuous.update(0); continuous.update(2);
    const before = pose(props);
    props.update(20, { waiting: true }); props.update(30, { waiting: true });
    assert.deepEqual(pose(props), before, `${kind}: waiting freezes work`);
    assert.equal(props.group.getObjectByName('work-pause-indicator').visible, true);
    props.update(40, { error: true });
    assert.deepEqual(pose(props), before, `${kind}: errors freeze work`);
    assert.equal(props.group.getObjectByName('work-error-indicator').visible, true);
    props.update(40.5); continuous.update(2.5);
    assert.deepEqual(pose(props), pose(continuous), `${kind}: no catch-up after waiting`);
    assert.equal(props.group.getObjectByName('work-pause-indicator').visible, false);
    props.dispose(); continuous.dispose();
  }
});

test('each prop reuses frame resources and disposes every owned geometry and material exactly once', () => {
  for (const kind of kinds) {
    const props = new WorkProps(kind), parent = new THREE.Group(); parent.add(props.group);
    const meshes = objects(props).filter(node => node.isMesh);
    const resources = new Set(meshes.flatMap(node => [node.geometry, node.material]));
    const disposed = [];
    for (const resource of resources) resource.addEventListener('dispose', () => disposed.push(resource));
    for (let frame = 0; frame < 120; frame++) props.update(frame / 30);
    assert.deepEqual(new Set(objects(props).filter(node => node.isMesh).flatMap(node => [node.geometry, node.material])), resources);
    props.dispose(); props.dispose(); props.update(100);
    assert.equal(parent.children.length, 0);
    assert.equal(props.group.children.length, 0);
    assert.equal(disposed.length, resources.size, `${kind}: all unique resources disposed once`);
    assert.deepEqual(new Set(disposed), resources);
  }
});

test('seeded timing varies agents deterministically and exceptional inputs remain finite', () => {
  const first = new WorkProps('coding', 4), same = new WorkProps('coding', 4), other = new WorkProps('coding', 19);
  assert.deepEqual(pose(first), pose(same));
  assert.notDeepEqual(pose(first), pose(other));
  for (const time of [NaN, Infinity, -1, 1e8]) {
    first.update(time, { intensity: NaN });
    for (const node of objects(first)) assert.ok([...node.position, ...node.quaternion, ...node.scale].every(Number.isFinite));
  }
  first.dispose(); same.dispose(); other.dispose();
});
