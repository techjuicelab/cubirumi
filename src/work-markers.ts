import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_OFFICE_AGENTS } from './office-layout.ts';
import { isWorkingStatus } from './work-activity.ts';
import type { ActivityKind } from './protocol.ts';
import { STATUS_STYLE, statusStyleFor } from './status-style.ts';

type MarkerFigure = { id: string; status: string; group: THREE.Group; origin: THREE.Vector3; activityKind?: ActivityKind };
const accents: Record<ActivityKind, string> = { coding: '#8fbbd2', documents: '#eed58e', research: '#9dbdaa',
  testing: '#b8acd8', reviewing: '#e7af96', planning: '#9dbdaa', design: '#b8acd8', delivery: '#fffdf5', shipping: '#d4b08a', general: '#8fbbd2' };

/** Mesh names of the status shapes (decision 22): colour is never the only cue. */
export const STATUS_MARKER_NAMES = {
  ring: 'work-status-ring',
  'dashed-ring': 'work-status-dashed-ring',
  diamond: 'approval-status-diamond',
  triangle: 'error-status-triangle',
} as const;
const RING_INNER = .82, RING_OUTER = 1.04, OVERHEAD_Y = 2.8;

/** The floor ring broken into short arcs, in the same plane and radii as the solid ring. */
function dashedRingGeometry(dashes = 12, fill = .62, steps = 3) {
  const positions: number[] = [];
  const slot = Math.PI * 2 / dashes, arc = slot * fill / steps;
  for (let dash = 0; dash < dashes; dash++) {
    for (let step = 0; step < steps; step++) {
      const a0 = dash * slot + step * arc, a1 = a0 + arc;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      positions.push(RING_INNER * c0, RING_INNER * s0, 0, RING_OUTER * c0, RING_OUTER * s0, 0, RING_OUTER * c1, RING_OUTER * s1, 0,
        RING_INNER * c0, RING_INNER * s0, 0, RING_OUTER * c1, RING_OUTER * s1, 0, RING_INNER * c1, RING_INNER * s1, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry.rotateX(-Math.PI / 2);
}

/** A flat warning triangle (error colour) with a light exclamation mark on both faces; it is turned toward the camera. */
function warningTriangleGeometry() {
  const positions: number[] = [], colors: number[] = [];
  const red = new THREE.Color(STATUS_STYLE.error.color), mark = new THREE.Color('#fffdf5');
  const triangle = (a: number[], b: number[], c: number[], color: THREE.Color) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  };
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    triangle([x0, y0, z], [x1, y0, z], [x1, y1, z], mark); triangle([x0, y0, z], [x1, y1, z], [x0, y1, z], mark);
  };
  triangle([-.27, -.2, 0], [.27, -.2, 0], [0, .27, 0], red);
  for (const z of [.006, -.006]) { quad(-.024, -.03, .024, .14, z); quad(-.024, -.13, .024, -.08, z); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Constant draw-call markers stay legible even when staff use distant instanced figures. */
export class WorkMarkers {
  readonly group = new THREE.Group();
  /** working: solid floor ring. */
  private readonly ring: THREE.InstancedMesh;
  /** thinking and reviewing: dashed floor ring. */
  private readonly dashedRing: THREE.InstancedMesh;
  /** approval: diamond above the head, no floor ring. */
  private readonly diamond: THREE.InstancedMesh;
  /** error: warning triangle above the head, no floor ring. */
  private readonly triangle: THREE.InstancedMesh;
  private readonly selection: THREE.InstancedMesh;
  private readonly badges = new Map<ActivityKind, THREE.InstancedMesh>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  constructor() {
    this.group.name = 'work-markers';
    this.ring = this.status(new THREE.RingGeometry(RING_INNER, RING_OUTER, 40).rotateX(-Math.PI / 2), STATUS_STYLE.working.color, .96, 'ring');
    this.dashedRing = this.status(dashedRingGeometry(), STATUS_STYLE.thinking.color, .96, 'dashed-ring');
    this.diamond = this.status(new THREE.OctahedronGeometry(.2).scale(.82, 1.3, .82), STATUS_STYLE.approval.color, 1, 'diamond');
    this.triangle = this.status(warningTriangleGeometry(), '#ffffff', 1, 'triangle');
    (this.triangle.material as THREE.MeshBasicMaterial).vertexColors = true;
    this.selection = this.instances(new THREE.RingGeometry(1.08, 1.14, 40).rotateX(-Math.PI / 2), '#fffdf5', .98);
    this.selection.name = 'work-selection-ring';
    for (const kind of Object.keys(accents) as ActivityKind[]) {
      const parts: THREE.BufferGeometry[] = [];
      const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
        parts.push(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z));
      if (kind === 'coding') { box(-.17, .08, 0, .25, .25, .22); box(.15, .23, .05, .25, .25, .22); }
      else if (kind === 'documents') { for (let i = 0; i < 3; i++) box(i * .07 - .07, i * .09, i * .05, .36, .44, .035); }
      else if (kind === 'research') { parts.push(new THREE.TorusGeometry(.2, .045, 5, 14)); box(.18, -.22, 0, .08, .27, .08); }
      else if (kind === 'testing') { for (const x of [-.22, .22]) box(x, .12, 0, .075, .46, .08); box(0, .35, 0, .5, .08, .08); box(0, -.04, 0, .22, .17, .18); }
      else if (kind === 'reviewing') { box(-.13, 0, 0, .26, .36, .04); parts.push(new THREE.TorusGeometry(.14, .04, 5, 12).translate(.17, .14, .06)); }
      else if (kind === 'planning') { for (let i = 0; i < 3; i++) box((i - 1) * .2, (i % 2) * .18, 0, .14, .21, .055); }
      else if (kind === 'design') { box(0, .06, 0, .4, .34, .07); box(.26, .06, .05, .055, .5, .055); }
      else if (kind === 'delivery') { parts.push(new THREE.ConeGeometry(.2, .5, 3).rotateZ(-Math.PI / 2)); }
      else if (kind === 'shipping') { box(0, 0, 0, .4, .32, .3); box(0, .24, 0, .43, .055, .33); }
      else { for (let i = 0; i < 3; i++) box((i - 1) * .15, 0, 0, .085, .085, .085); }
      const normalized = parts.map(part => part.index ? part.toNonIndexed() : part);
      const geometry = mergeGeometries(normalized)!;
      for (const part of normalized) if (!parts.includes(part)) part.dispose();
      for (const part of parts) part.dispose();
      this.badges.set(kind, this.instances(geometry, accents[kind], .94));
    }
  }
  private status(geometry: THREE.BufferGeometry, color: string, opacity: number, shape: keyof typeof STATUS_MARKER_NAMES) {
    const mesh = this.instances(geometry, color, opacity);
    mesh.name = STATUS_MARKER_NAMES[shape];
    (mesh.material as THREE.MeshBasicMaterial).toneMapped = false;
    return mesh;
  }
  private instances(geometry: THREE.BufferGeometry, color: string, opacity: number) {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true,
      opacity, depthWrite: false, side: THREE.DoubleSide }), MAX_OFFICE_AGENTS + 1);
    mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh); return mesh;
  }
  private place(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, scale = 1, angle = 0) {
    this.position.set(x, y, z); this.scale.setScalar(scale);
    this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    this.matrix.compose(this.position, this.quaternion, this.scale); mesh.setMatrixAt(index, this.matrix);
  }
  /**
   * `cardOpenId`: the employee whose card is open keeps only the selection ring; the scene passes it only at detail LOD.
   * `facing`: the camera yaw, so the flat error triangle reads as a triangle from every side.
   */
  update(figures: readonly MarkerFigure[], time: number, focus: string | null, reduced: boolean,
    detailedIds: ReadonlySet<string>, cardOpenId: string | null = null, facing = 0): void {
    let rings = 0, dashes = 0, diamonds = 0, triangles = 0, selections = 0;
    for (const mesh of this.badges.values()) mesh.count = 0;
    for (const figure of figures) {
      if (!figure.group.visible || figure.id === 'boss') continue;
      const working = isWorkingStatus(figure.status);
      const shape = statusStyleFor(figure.status).shape;
      const alert = shape === 'diamond' || shape === 'triangle';
      const point = figure.group.position;
      const carded = cardOpenId !== null && figure.id === cardOpenId;
      if (carded) {
        this.place(this.selection, selections++, point.x, .075, point.z);
        continue;
      }
      if (working || alert) {
        const wave = reduced ? 0 : Math.sin(time * 1.8 + point.x) * .035;
        if (shape === 'ring') this.place(this.ring, rings++, point.x, .07, point.z, 1 + wave);
        else if (shape === 'dashed-ring') this.place(this.dashedRing, dashes++, point.x, .07, point.z, 1 + wave);
        else if (shape === 'diamond') this.place(this.diamond, diamonds++, point.x, OVERHEAD_Y + wave, point.z);
        else if (shape === 'triangle') this.place(this.triangle, triangles++, point.x, OVERHEAD_Y + wave, point.z, 1, facing);
        if (!detailedIds.has(figure.id)) {
          const kind = figure.activityKind ?? 'general', badge = this.badges.get(kind) ?? this.badges.get('general')!;
          this.place(badge, badge.count++, figure.origin.x - .22, 2.15, figure.origin.z - 1.05,
            1, reduced || alert ? 0 : Math.sin(time * .65 + point.x) * .12);
        }
      }
      if (focus === figure.id) this.place(this.selection, selections++, point.x, .075, point.z);
    }
    this.ring.count = rings; this.dashedRing.count = dashes; this.diamond.count = diamonds;
    this.triangle.count = triangles; this.selection.count = selections;
    for (const child of this.group.children) (child as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }
  dispose(): void {
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose();
    }
    this.group.removeFromParent(); this.group.clear();
  }
}
