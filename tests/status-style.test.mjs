import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { STATUS_STYLE, statusStyleFor, isExternalCall, EXTERNAL_TOOL_NAME, EXTERNAL_CALL_LABEL, UNCONFIRMED_STYLE, presentedStatusStyle } from '../src/status-style.ts';
import { statusShapeSVG } from '../src/portrait.ts';
import { statusNames } from '../src/protocol.ts';
import { activityMessage } from '../src/activity-bubble.ts';
import { WorkMarkers, STATUS_MARKER_NAMES } from '../src/work-markers.ts';

const STATUSES = ['working', 'thinking', 'waiting', 'reviewing', 'approval', 'done', 'error', 'idle'];

test('every reported status has exactly one label, color and shape in the shared table', () => {
  assert.deepEqual(Object.keys(STATUS_STYLE).sort(), [...STATUSES].sort());
  assert.deepEqual(STATUS_STYLE, {
    working: { label: '작업 중', color: '#ff5b54', shape: 'ring' },
    thinking: { label: '처리 중', color: '#ff5b54', shape: 'dashed-ring' },
    reviewing: { label: '검토 중', color: '#ff5b54', shape: 'dashed-ring' },
    approval: { label: '확인 요청', color: '#e6bd61', shape: 'diamond' },
    error: { label: '오류', color: '#ba3344', shape: 'triangle' },
    done: { label: '응답 종료', color: '#83b491', shape: 'check' },
    idle: { label: '대기 중', color: '#c3c5b7', shape: 'bar' },
    waiting: { label: '대기 중', color: '#c3c5b7', shape: 'bar' },
  });
  assert.deepEqual(Object.keys(statusNames).sort(), [...STATUSES].sort());
  for (const status of STATUSES) assert.equal(statusNames[status], STATUS_STYLE[status].label, status);
});

test('bubbles, markers and unknown scene inputs read the same table', () => {
  for (const status of ['working', 'thinking', 'reviewing', 'approval', 'error', 'done']) {
    assert.equal(activityMessage({ status }).text, STATUS_STYLE[status].label, status);
  }
  assert.equal(activityMessage({ status: 'approval', activityKind: 'coding' }).text, `코드 작업 · ${STATUS_STYLE.approval.label}`);
  assert.equal(activityMessage({ status: 'error', activityKind: 'coding' }).text, `코드 작업 · ${STATUS_STYLE.error.label}`);
  for (const status of ['unknown', '', '__proto__', 'toString', 'constructor']) assert.equal(statusStyleFor(status), STATUS_STYLE.idle, status);
  for (const status of STATUSES) assert.equal(statusStyleFor(status), STATUS_STYLE[status]);
  const markers = new WorkMarkers();
  const byShape = shape => markers.group.getObjectByName(STATUS_MARKER_NAMES[shape]);
  const colorOf = mesh => mesh.material.vertexColors
    ? `#${new THREE.Color().fromBufferAttribute(mesh.geometry.getAttribute('color'), 0).getHexString()}`
    : `#${mesh.material.color.getHexString()}`;
  for (const status of ['working', 'thinking', 'reviewing', 'approval', 'error']) {
    assert.equal(colorOf(byShape(STATUS_STYLE[status].shape)), STATUS_STYLE[status].color, `${status} marker colour`);
  }
  markers.dispose();
});

test('the 3D office markers take the table shape of each status, so colour is never the only cue', () => {
  const markers = new WorkMarkers();
  const shapes = Object.keys(STATUS_MARKER_NAMES);
  const meshes = shapes.map(shape => markers.group.getObjectByName(STATUS_MARKER_NAMES[shape]));
  assert.equal(meshes.every(mesh => mesh?.isInstancedMesh === true), true, 'one instanced mesh per shape');
  assert.equal(new Set(meshes.map(mesh => mesh.geometry)).size, shapes.length, 'every shape has its own geometry');
  const drawn = () => Object.fromEntries(shapes.map((shape, i) => [shape, meshes[i].count]));
  const children = markers.group.children.length;
  for (const status of [...STATUSES, 'unknown']) {
    markers.update([{ id: 'worker', status, activityKind: 'coding', origin: new THREE.Vector3(), group: new THREE.Group() }], 1, null, false, new Set(), null, .7);
    const expected = Object.fromEntries(shapes.map(shape => [shape, statusStyleFor(status).shape === shape ? 1 : 0]));
    assert.deepEqual(drawn(), expected, `${status} draws only its ${statusStyleFor(status).shape} marker`);
    assert.equal(markers.group.children.length, children, `${status}: no draw objects are added`);
  }
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  markers.update([{ id: 'worker', status: 'error', origin: new THREE.Vector3(), group: new THREE.Group() }], 1, null, true, new Set(), null, .7);
  meshes[shapes.indexOf('triangle')].getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
  assert.equal(Math.abs(normal.x - Math.sin(.7)) < 1e-6 && Math.abs(normal.z - Math.cos(.7)) < 1e-6, true, 'the flat error triangle faces the camera yaw');
  assert.equal(position.y > 2, true, 'approval and error marks sit above the head, not on the floor');
  markers.dispose();
});

test('only working-family statuses that use the external tool count as a phone call', () => {
  assert.equal(EXTERNAL_TOOL_NAME, 'MCP 도구');
  for (const status of ['working', 'thinking', 'reviewing']) {
    assert.equal(isExternalCall({ status, toolName: EXTERNAL_TOOL_NAME }), true, status);
    assert.equal(isExternalCall({ status, toolName: 'Read' }), false, status);
    assert.equal(isExternalCall({ status }), false, status);
  }
  // Approval and errors take priority over a call; quiet or finished work never shows a phone.
  for (const status of ['approval', 'error', 'done', 'idle', 'waiting']) {
    assert.equal(isExternalCall({ status, toolName: EXTERNAL_TOOL_NAME }), false, status);
  }
  assert.equal(isExternalCall({ status: 'working', toolName: 'mcp 도구' }), false, 'the reported name is matched exactly');
});

test('an unconfirmed presentation has one label, colour and shape beside the table, and a call reads the same in cards and bubbles', () => {
  assert.deepEqual(UNCONFIRMED_STYLE, { label: '현재 상태 미확인', color: '#95a9b8', shape: 'unknown' });
  assert.equal(Object.values(STATUS_STYLE).some(style => style.shape === 'unknown' || style.color === UNCONFIRMED_STYLE.color), false,
    'no reported status looks unconfirmed');
  assert.equal(EXTERNAL_CALL_LABEL, '외부 서비스 연동 중');
  for (const status of STATUSES) {
    assert.equal(presentedStatusStyle({ status }) === STATUS_STYLE[status], true, `${status} reads the table`);
    assert.equal(presentedStatusStyle({ status: 'idle', unconfirmedStatus: status }) === UNCONFIRMED_STYLE, true, `unconfirmed ${status}`);
    assert.equal(activityMessage({ status, toolName: EXTERNAL_TOOL_NAME }).text === EXTERNAL_CALL_LABEL, isExternalCall({ status, toolName: EXTERNAL_TOOL_NAME }),
      `${status}: the bubble says a call exactly when the phone rings`);
  }
  const svg = statusShapeSVG(UNCONFIRMED_STYLE, 12);
  assert.match(svg, /data-shape="unknown"/u);
  assert.match(svg, /#95a9b8/u);
  assert.match(statusShapeSVG('idle'), /data-shape="bar"/u, 'a reported status string still reads the table');
});
