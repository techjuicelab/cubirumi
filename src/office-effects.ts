import * as THREE from 'three';

export const YAWN_DURATION = 3.2;

/** Deterministic individual timing, independent of polling frequency or rendered frame rate. */
export function idleYawnDelay(id: string, cycle = 0): number {
  let hash = 2166136261;
  for (const character of `${id}:${cycle}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return (cycle === 0 ? 12 : 26) + hash % 2700 / 100;
}

/** Staggered timers for small idle actions: same hash as the yawn delay, so seats never move in lockstep. */
export function actionDelay(id: string, kind: string, cycle: number, base: number, spread: number): number {
  let hash = 2166136261;
  for (const character of `${id}:${kind}:${cycle}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return base + hash % 1000 / 1000 * spread;
}

export function yawnStrength(seconds: number): number {
  if (seconds <= 0 || seconds >= YAWN_DURATION) return 0;
  const ramp = Math.min(seconds / .85, (YAWN_DURATION - seconds) / .9, 1);
  return ramp * ramp * (3 - 2 * ramp);
}

const laneSlot = (lane: number): number => Number.isFinite(lane) ? Math.max(0, Math.floor(lane)) % 32 : 0;
const laneSpread = (slot: number): number => slot === 0 ? 0 : Math.ceil(slot / 2) * (slot % 2 ? 1 : -1);
function direction(normal: THREE.Vector3): THREE.Vector3 {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  return Number.isFinite(length) && length > 1e-8 ? normal.clone().multiplyScalar(1 / length) : new THREE.Vector3(0, 0, 1);
}

/** A horizontal circle occupies the middle half; matched derivatives join its approach and departure. */
class PaperLoopCurve extends THREE.Curve<THREE.Vector3> {
  private readonly approach: THREE.CubicBezierCurve3;
  private readonly departure: THREE.CubicBezierCurve3;
  private readonly side: THREE.Vector3;
  private readonly forward: THREE.Vector3;
  private readonly center: THREE.Vector3;
  private readonly radius: number;

  constructor(start: THREE.Vector3, end: THREE.Vector3, fromNormal: THREE.Vector3, toNormal: THREE.Vector3,
    center: THREE.Vector3, forward: THREE.Vector3, radius: number, handle: number) {
    super();
    this.arcLengthDivisions = 400;
    this.center = center.clone(); this.forward = forward.clone(); this.radius = radius;
    this.side = new THREE.Vector3(forward.z, 0, -forward.x);
    const seam = center.clone().addScaledVector(this.side, radius);
    // 3 * joinHandle / .25 === 2 * PI * radius / .5, including speed at both joins.
    const joinHandle = Math.PI * radius / 3;
    this.approach = new THREE.CubicBezierCurve3(start.clone(), start.clone().addScaledVector(fromNormal, handle),
      seam.clone().addScaledVector(forward, -joinHandle), seam.clone());
    this.departure = new THREE.CubicBezierCurve3(seam.clone(), seam.clone().addScaledVector(forward, joinHandle),
      end.clone().addScaledVector(toNormal, handle), end.clone());
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const time = THREE.MathUtils.clamp(Number.isFinite(t) ? t : 0, 0, 1);
    if (time <= .25) return this.approach.getPoint(time * 4, target);
    if (time >= .75) return this.departure.getPoint((time - .75) * 4, target);
    const angle = (time - .25) * Math.PI * 4;
    return target.copy(this.center).addScaledVector(this.side, Math.cos(angle) * this.radius)
      .addScaledVector(this.forward, Math.sin(angle) * this.radius);
  }
  override getTangent(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const time = THREE.MathUtils.clamp(Number.isFinite(t) ? t : 0, 0, 1);
    if (time >= .25 && time <= .75) {
      const angle = (time - .25) * Math.PI * 4;
      return target.copy(this.side).multiplyScalar(-Math.sin(angle)).addScaledVector(this.forward, Math.cos(angle));
    }
    const curve = time < .25 ? this.approach : this.departure;
    const u = time < .25 ? time * 4 : (time - .75) * 4;
    target.subVectors(curve.v1, curve.v0).multiplyScalar(3 * (1 - u) ** 2)
      .addScaledVector(new THREE.Vector3().subVectors(curve.v2, curve.v1), 6 * (1 - u) * u)
      .addScaledVector(new THREE.Vector3().subVectors(curve.v3, curve.v2), 3 * u ** 2);
    return target.lengthSq() > 1e-16 ? target.normalize() : target.copy(this.forward);
  }
}

export function paperPlaneCurve(start: THREE.Vector3, end: THREE.Vector3, fromNormal: THREE.Vector3, toNormal: THREE.Vector3, lane = 0): THREE.Curve<THREE.Vector3> {
  const slot = laneSlot(lane), from = direction(fromNormal), to = direction(toNormal);
  const forward = direction(new THREE.Vector3(from.x, 0, from.z));
  const side = new THREE.Vector3(forward.z, 0, -forward.x);
  const radius = THREE.MathUtils.clamp(start.distanceTo(end) * .065, .75, 1.6) + slot % 4 * .055;
  const center = start.clone().lerp(end, .5).addScaledVector(forward, .9 + slot * .025)
    .addScaledVector(side, THREE.MathUtils.clamp(laneSpread(slot) * .16, -.9, .9));
  center.y = Math.max(start.y, end.y) + THREE.MathUtils.clamp(start.distanceTo(end) * .08, 1.3, 2.8) + Math.floor(slot / 4) * .09;
  return new PaperLoopCurve(start, end, from, to, center, forward, radius, .75);
}

/** A message with no recipient makes one small loop in front of its own computer and returns there. */
export function paperPlaneMessageCurve(start: THREE.Vector3, normal: THREE.Vector3, lane = 0): THREE.Curve<THREE.Vector3> {
  const slot = laneSlot(lane), from = direction(normal);
  const forward = direction(new THREE.Vector3(from.x, 0, from.z));
  const radius = .42 + slot % 8 * .02;
  const center = start.clone().addScaledVector(forward, radius + .65)
    .addScaledVector(new THREE.Vector3(forward.z, 0, -forward.x), laneSpread(slot) * .045);
  center.y = start.y + .75 + Math.floor(slot / 8) * .055;
  return new PaperLoopCurve(start, start, from, from, center, forward, radius, .38);
}

/** The .52-unit model stays .208 units long, approximately the diameter of a character's hand. */
export function paperPlaneScale(_unitsPerPixel: number): number {
  return .4;
}

/** Four folded facets and a navy crease, with the nose pointing along local +Z. */
export function foldedPaperPlane(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, .025, .3, -.22, 0, -.22, 0, .025, -.12,
    0, .025, .3, 0, .025, -.12, .22, 0, -.22,
    0, .025, .3, 0, -.075, -.17, -.075, .005, -.16,
    0, .025, .3, .075, .005, -.16, 0, -.075, -.17,
  ], 3));
  geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1); geometry.addGroup(6, 6, 2);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, ['#ffffff', '#66c8e8', '#24465e'].map(color =>
    new THREE.MeshStandardMaterial({ color, roughness: .7, emissive: color, emissiveIntensity: .12, side: THREE.DoubleSide, flatShading: true })));
  mesh.name = 'handoff-paper-plane';
  mesh.scale.setScalar(paperPlaneScale(0));
  const crease = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 12), new THREE.LineBasicMaterial({ color: '#24465e' }));
  crease.name = 'handoff-paper-crease'; mesh.add(crease);
  return mesh;
}

/** A short, metadata-free path tail; attach to the plane and update in the plane's local coordinates. */
export function paperPlaneTrail(): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(36), 3).setUsage(THREE.DynamicDrawUsage));
  const colors = [];
  for (let index = 0; index < 12; index++) colors.push(...new THREE.Color('#f1fafc').lerp(new THREE.Color('#299bbf'), index / 11).toArray());
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const trail = new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .85, depthWrite: false }));
  trail.name = 'handoff-paper-trail'; trail.frustumCulled = false; trail.visible = false;
  return trail;
}

export type WindowLightPeriod = 'night' | 'morning' | 'day' | 'evening';
export const WINDOW_LIGHT_TRANSITION_MINUTES = 10;
/** Local start minute of each period: morning 06, day 10, evening 17, night 20. */
const WINDOW_LIGHT_STARTS: ReadonlyArray<readonly [number, WindowLightPeriod]> = [[6 * 60, 'morning'], [10 * 60, 'day'], [17 * 60, 'evening'], [20 * 60, 'night']];
/** Pale window tints keep the room readable; only the glass and the floor light patch change, never the indoor lights. */
export const WINDOW_LIGHT: Readonly<Record<WindowLightPeriod, Readonly<{ glass: string; patch: string; patchOpacity: number }>>> = {
  night: { glass: '#91aac2', patch: '#7188a8', patchOpacity: .1 },
  morning: { glass: '#d8d4b8', patch: '#f3c97b', patchOpacity: .3 },
  day: { glass: '#c2dce9', patch: '#fffdf5', patchOpacity: .5 },
  evening: { glass: '#d6c3bb', patch: '#e7af96', patchOpacity: .28 },
};

/** The period at a local minute of the day and how far (0..1) its ten-minute blend from the previous period has come. */
export function windowLightAt(minuteOfDay: number, smooth = true): { from: WindowLightPeriod; to: WindowLightPeriod; blend: number } {
  const day = 24 * 60;
  const minute = Number.isFinite(minuteOfDay) ? (Math.floor(minuteOfDay) % day + day) % day : 12 * 60;
  // Before 06:00 the night that began at 20:00 the previous day is still current.
  let index = WINDOW_LIGHT_STARTS.length - 1;
  for (const [i, [start]] of WINDOW_LIGHT_STARTS.entries()) if (minute >= start) index = i;
  const [start, to] = WINDOW_LIGHT_STARTS[index]!;
  const from = WINDOW_LIGHT_STARTS[(index + WINDOW_LIGHT_STARTS.length - 1) % WINDOW_LIGHT_STARTS.length]![1];
  const since = (minute - start + day) % day;
  return { from, to, blend: smooth ? Math.min(1, since / WINDOW_LIGHT_TRANSITION_MINUTES) : 1 };
}

export const ROUTER_LED_COLORS = { connected: '#83b491', disconnected: '#f3c97b' } as const;
export const ROUTER_FLASH_SECONDS = .15;
/** Event flashes start at least this far apart, so the LED blinks at most twice per second. */
export const ROUTER_PULSE_GAP_SECONDS = .5;
export const ROUTER_RECONNECT_SECONDS = .6;

/** A reconnection blinks the green LED twice: on for .15s, off for .15s, on again, then steady. */
export function routerReconnectFlash(age: number): boolean {
  return age >= 0 && (age < ROUTER_FLASH_SECONDS || age >= .3 && age < .3 + ROUTER_FLASH_SECONDS);
}

/** The owner's own moments, in animation seconds. Only one runs at a time: attending > filing > instructing > click. */
export const OWNER_ACTION_SECONDS = { finish: 1.6, instruct: .8, click: 1.4, spin: 1.6 } as const;
export type OwnerActionKind = keyof typeof OWNER_ACTION_SECONDS;
export const OWNER_ACTION_RANK: Readonly<Record<OwnerActionKind, number>> = { finish: 3, instruct: 2, click: 1, spin: 1 };
/** A finished visit that could not be filed right away is forgotten instead of replaying late. */
export const OWNER_FINISH_WAIT_SECONDS = 1.5;
/** An idle owner slowly looks over the office and back to the monitor. */
export const OWNER_SURVEY_SECONDS = 4.2;
export const OWNER_SPIN_CLICKS = 5;
export const OWNER_SPIN_WINDOW_SECONDS = 3;
/** Instruction planes leave the owner's desk at most once per second and reach the same employee at most every four. */
export const INSTRUCTION_GAP_SECONDS = 1;
export const INSTRUCTION_TARGET_COOLDOWN_SECONDS = 4;

/** An employee's external (MCP) tool call: the phone reaches the ear in .6s while the seated body turns about 20°. */
export const CALL_ENTER_SECONDS = .6;
export const CALL_TURN_RADIANS = -.35;
/** The call screen's voice waveform: nine bars whose heights change every .4s; the static heights follow the design. */
export const CALL_WAVE_STEP_SECONDS = .4;
export const CALL_WAVE_BARS: readonly number[] = [8, 18, 32, 46, 28, 42, 24, 14, 8].map(height => height / 46);

/** Height (0..1] of one waveform bar; a negative step is the still waveform used for reduced motion and distant desks. */
export function callWaveLevel(bar: number, step: number): number {
  const index = Number.isFinite(bar) ? (Math.floor(bar) % CALL_WAVE_BARS.length + CALL_WAVE_BARS.length) % CALL_WAVE_BARS.length : 0;
  const still = CALL_WAVE_BARS[index]!;
  if (!Number.isFinite(step) || step < 0) return still;
  const hash = (Math.imul(Math.floor(step) + 1, 2654435761) ^ Math.imul(index + 7, 40503)) >>> 0;
  const noise = hash % 1000 / 999;
  return .18 + .82 * (.4 * still + .6 * noise);
}

/** Clicks on the owner within the last three seconds; the fifth one asks for a chair spin and starts a new count. */
export function registerOwnerClick(times: readonly number[], now: number): { times: number[]; spin: boolean } {
  if (!Number.isFinite(now)) return { times: [...times], spin: false };
  const recent = times.filter(time => Number.isFinite(time) && time <= now && now - time < OWNER_SPIN_WINDOW_SECONDS);
  recent.push(now);
  return recent.length >= OWNER_SPIN_CLICKS ? { times: [], spin: true } : { times: recent.slice(-OWNER_SPIN_CLICKS), spin: false };
}

/** Rough canvas width when measureText is unavailable: full-width for Hangul and CJK, about half for Latin. */
export function estimateTextWidth(text: string, fontPx: number): number {
  let width = 0;
  for (const character of text) width += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/u.test(character) ? fontPx : fontPx * .56;
  return width;
}

/** '{name} {suffix}' within maxWidth; a long name loses its end to an ellipsis while the suffix always stays whole. */
export function fitNameLabel(name: string, suffix: string, maxWidth: number, measure: (text: string) => number): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim();
  const full = clean ? `${clean} ${suffix}` : suffix;
  if (!clean || measure(full) <= maxWidth) return full;
  const characters = [...clean];
  const shortened = (count: number): string => `${characters.slice(0, count).join('').trimEnd()}… ${suffix}`;
  let low = 1, high = characters.length - 1, best = `… ${suffix}`;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(shortened(middle)) <= maxWidth) { best = shortened(middle); low = middle + 1; } else high = middle - 1;
  }
  return best;
}

export function updatePaperPlaneTrail(trail: THREE.Line, plane: THREE.Mesh, curve: THREE.Curve<THREE.Vector3>, progress: number): void {
  plane.updateWorldMatrix(true, false);
  const inverse = plane.matrixWorld.clone().invert();
  const positions = trail.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let index = 0; index < positions.count; index++) {
    const point = curve.getPoint(Math.max(0, progress - .19 * (1 - index / (positions.count - 1)))).applyMatrix4(inverse);
    positions.setXYZ(index, point.x, point.y, point.z);
  }
  positions.needsUpdate = true; trail.visible = progress > 0 && progress < 1;
}
