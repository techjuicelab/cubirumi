import * as THREE from 'three';
import { officeBounds, seatPosition, MAX_OFFICE_AGENTS } from './office-layout.ts';
import { foldedPaperPlane, paperPlaneCurve, paperPlaneMessageCurve, paperPlaneScale } from './office-effects.ts';
import type { ActivityKind, AgentStatus } from './protocol.ts';
import { appearanceFor } from './appearance.ts';
import { STATUS_STYLE, UNCONFIRMED_STYLE } from './status-style.ts';

export type BuildingEmployee = { id: string; status: string; color?: string; name?: string; activityKind?: ActivityKind; showCharacter?: boolean; unconfirmedStatus?: AgentStatus };
/** Exact observed head counts for one project. Unconfirmed records are separate from known idle, waiting or done. */
export type BuildingFloorCounts = { working: number; approval: number; error: number; quiet: number; unconfirmed?: number };
export type BuildingFloorInput = { id: string; name: string; agents: BuildingEmployee[]; counts?: BuildingFloorCounts };
export type WindowState = keyof BuildingFloorCounts | 'dark';
type Floor = { id: string; name: string; group: THREE.Group; label: HTMLButtonElement; labelNumber: HTMLSpanElement; labelName: HTMLSpanElement;
  labelCounts: HTMLSpanElement; anchor: THREE.Vector3; width: number; depth: number; centerX: number; gap: number; level: number;
  signature: string; agents: BuildingEmployee[]; counts: Required<BuildingFloorCounts>; cells: string;
  /** Detailed floors draw furniture, people and work; compressed floors keep only the slab, windows and attention markers. */
  detailed: boolean; dimmed: boolean; detailMeshes: THREE.InstancedMesh[];
  /** Above the ground floor a storey's slab is the ceiling of the storey below and stays see-through (decision 48). */
  ceiling: boolean;
  screenX: number; screenY: number; onScreen: boolean; labelX: number; labelY: number;
  /**
   * Estimated full, compact and shortest ellipsis-cut compact plate widths, the laid-out plate centre height, whether the layout
   * shows the plate and the inline max width written to cut a compact name short (0 when the stylesheet's width applies).
   */
  plateWidth: number; plateCompactWidth: number; plateLeastWidth: number; plateY: number; plateShown: boolean; plateMaxWidth: number;
  arms: THREE.InstancedMesh; screens: THREE.InstancedMesh; points: THREE.Vector3[]; materials: THREE.Material[];
  bodies: THREE.InstancedMesh; heads: THREE.InstancedMesh; hair: THREE.InstancedMesh; knees: THREE.InstancedMesh; characterVisibility: boolean[];
  workBoxes: THREE.InstancedMesh; workSpheres: THREE.InstancedMesh; workHoops: THREE.InstancedMesh;
  activityRings: THREE.InstancedMesh; activityDashes: THREE.InstancedMesh; activityHeads: THREE.InstancedMesh; activityPins: THREE.InstancedMesh;
  activityMeshes: THREE.InstancedMesh[];
  /** Whether a drawn person on this floor is working, so its instances change with time while motion is on. */
  animated: boolean;
  /** Inputs of the last instance rewrite; an unchanged zoom, roster and motion time skips the rewrite and its GPU upload. */
  drawnUnits: number; drawnRoster: number; drawnTime: number };
type Flight = { from: string; to: string; plane: THREE.Mesh; trail: THREE.Line; trailPositions: THREE.BufferAttribute;
  curve: THREE.Curve<THREE.Vector3>; elapsed: number; duration: number; lane: number };
type RailItem = { item: HTMLLIElement; button: HTMLButtonElement; number: HTMLSpanElement; name: HTMLSpanElement; counts: HTMLSpanElement;
  approval: HTMLSpanElement; error: HTMLSpanElement; key: string };
const activeWork = (status: string) => status === 'working' || status === 'thinking' || status === 'reviewing';
const busy = (status: string) => activeWork(status) || status === 'approval';
const WORK_BOXES = 9, WORK_SPHERES = 3, WORK_HOOPS = 2;
type Part = { shape: 'box' | 'sphere' | 'hoop'; color: THREE.Color; point: readonly number[]; size: readonly number[];
  motion?: 'float' | 'slide' | 'tilt' | 'spin'; rotation?: number };
const part = (shape: Part['shape'], color: string, point: readonly number[], size: readonly number[], motion?: Part['motion'], rotation = 0): Part =>
  ({ shape, color: new THREE.Color(color), point, size, motion, rotation });
const CREAM = '#fff1ce', TEAL = '#67c6c2', INK = '#537889', GOLD = '#e7b66f', PINK = '#d8a1b4';
// Shared miniature desk rigs use a fixed number of instances, independent of roster size.
// Their motion conveys activity only; assembly positions never claim real task progress.
const WORK_PARTS: Record<ActivityKind, readonly Part[]> = {
  coding: [
    part('box', INK, [-.42, .24, 0], [.13, .5, .16]), part('box', INK, [.42, .24, 0], [.13, .5, .16]),
    part('box', TEAL, [-.24, .55, 0], [.43, .12, .16], 'tilt'), part('box', TEAL, [.24, .55, 0], [.43, .12, .16], 'tilt'),
    part('box', CREAM, [-.14, .1, .05], [.26, .2, .26]), part('box', GOLD, [.14, .13, .05], [.25, .26, .26]),
    part('box', TEAL, [0, .36, .08], [.24, .2, .24], 'float'),
    part('sphere', GOLD, [-.42, .48, 0], [.13, .13, .13]), part('sphere', GOLD, [.42, .48, 0], [.13, .13, .13]),
  ],
  documents: [
    part('box', GOLD, [0, 0, 0], [.95, .12, .62]), part('box', INK, [.4, .2, -.22], [.09, .4, .14]),
    part('box', CREAM, [-.13, .18, .04], [.64, .055, .47]),
    part('box', CREAM, [-.06, .39, .04], [.64, .055, .47], 'slide'),
    part('box', '#ffffff', [.12, .66, -.02], [.56, .055, .45], 'float'),
    part('box', TEAL, [.12, .7, -.02], [.32, .025, .065], 'float'),
  ],
  research: [
    part('box', CREAM, [0, .02, .04], [.64, .08, .46]), part('sphere', TEAL, [0, .64, 0], [.24, .14, .18], 'float'),
    part('box', INK, [0, .66, 0], [.93, .055, .09], 'float'),
    part('hoop', CREAM, [-.4, .72, 0], [.24, .24, .24], 'float', -Math.PI / 2),
    part('hoop', CREAM, [.4, .72, 0], [.24, .24, .24], 'float', -Math.PI / 2),
    part('sphere', GOLD, [0, .55, .17], [.08, .08, .08], 'float'),
  ],
  testing: [
    part('box', INK, [0, .03, 0], [1.12, .12, .6]),
    part('box', TEAL, [-.43, .37, 0], [.11, .66, .16]), part('box', TEAL, [.43, .37, 0], [.11, .66, .16]),
    part('box', TEAL, [0, .72, 0], [.97, .12, .16]), part('box', CREAM, [0, .24, .07], [.28, .28, .3], 'slide'),
    part('box', '#aeeae2', [0, .48, 0], [.6, .04, .2], 'float'),
    part('sphere', GOLD, [.43, .76, .07], [.09, .09, .09]),
  ],
  reviewing: [
    part('box', CREAM, [-.17, .2, 0], [.64, .5, .08]), part('box', TEAL, [-.22, .22, .055], [.35, .035, .025]),
    part('box', TEAL, [-.22, .34, .055], [.35, .035, .025]),
    part('hoop', GOLD, [.15, .58, .14], [.34, .34, .34], 'slide'),
    part('box', INK, [.15, .22, .14], [.1, .43, .1], 'slide'),
  ],
  planning: [
    part('box', INK, [0, .12, 0], [.13, .26, .13]), part('box', CREAM, [0, .52, 0], [1.03, .73, .09]),
    part('box', TEAL, [-.31, .65, .075], [.23, .2, .045]), part('box', GOLD, [0, .65, .075], [.23, .2, .045]),
    part('box', PINK, [.31, .65, .075], [.23, .2, .045]), part('box', TEAL, [0, .36, .085], [.23, .2, .045], 'slide'),
  ],
  design: [
    part('box', GOLD, [-.2, .39, 0], [.7, .8, .1]), part('box', CREAM, [-.2, .39, .065], [.58, .66, .035]),
    part('box', PINK, [-.26, .48, .09], [.27, .15, .03]), part('box', TEAL, [-.1, .28, .1], [.22, .2, .03]),
    part('box', INK, [.38, .4, .14], [.065, .65, .065], 'tilt'),
    part('sphere', PINK, [.38, .76, .14], [.075, .1, .075], 'float'),
  ],
  delivery: [
    part('box', GOLD, [0, .08, 0], [.86, .18, .5]), part('box', CREAM, [0, .47, .03], [.68, .42, .07], 'float'),
    part('box', TEAL, [-.16, .56, .085], [.36, .035, .025], 'float', -.48),
    part('box', TEAL, [.16, .56, .085], [.36, .035, .025], 'float', .48),
  ],
  shipping: [
    part('box', INK, [0, .03, 0], [1.1, .12, .6]), part('box', GOLD, [0, .31, 0], [.6, .48, .47]),
    part('box', CREAM, [0, .31, .246], [.13, .48, .025]), part('box', GOLD, [0, .69, 0], [.66, .075, .5], 'float'),
    part('box', CREAM, [0, .73, 0], [.13, .025, .5], 'float'),
  ],
  general: [
    part('box', INK, [0, .07, 0], [.66, .12, .5]), part('box', TEAL, [0, .4, 0], [.35, .35, .35], 'spin'),
    part('sphere', GOLD, [.35, .55, .04], [.09, .09, .09], 'float'),
  ],
};
// Marker shapes follow the status table: working = coral floor ring, thinking and reviewing = dashed coral ring,
// approval = amber diamond, error = dark red pin.
const RING_COLOR = new THREE.Color(STATUS_STYLE.working.color), DIAMOND_COLOR = new THREE.Color(STATUS_STYLE.approval.color);
const DASHED_COLOR = new THREE.Color(STATUS_STYLE.thinking.color);
const dashedStatus = (status: string) => (STATUS_STYLE as Record<string, { shape: string } | undefined>)[status]?.shape === 'dashed-ring';
const WHITE = new THREE.Color('#ffffff');
const SCREEN_BUSY = new THREE.Color('#75e4d1'), SCREEN_IDLE = new THREE.Color('#acccd8');
const WINDOW_COLORS: Record<WindowState, THREE.Color> = {
  working: new THREE.Color(STATUS_STYLE.working.color), approval: new THREE.Color(STATUS_STYLE.approval.color),
  error: new THREE.Color(STATUS_STYLE.error.color), quiet: new THREE.Color(STATUS_STYLE.idle.color),
  unconfirmed: new THREE.Color(UNCONFIRMED_STYLE.color), dark: new THREE.Color('#aebfcb'),
};
const WINDOW_ORDER = ['working', 'approval', 'error', 'quiet', 'unconfirmed'] as const;
const COUNT_LABELS: Record<keyof BuildingFloorCounts, string> = { working: '작업', approval: '확인 요청', error: '오류', quiet: '대기', unconfirmed: '미확인' };
const SPOKEN_LABELS: Record<keyof BuildingFloorCounts, string> = { working: '작업 중', approval: '확인 요청', error: '오류', quiet: '대기', unconfirmed: UNCONFIRMED_STYLE.label };
export const WINDOW_CELLS = 12;
const WINDOW_COLUMNS = 6;

/** OfficeScene.updateCamera's default building pose: yaw .61 and elevation .81 lowered by .28. */
export const BUILDING_VIEW = Object.freeze({ yaw: .61, elevation: .53 });
/** A floor slab spans y -.68..-.08 below its own floor; seat rings sit just above the floor top. */
const SLAB_UNDERSIDE = .68, RING_Y = .095;
export const STORY_LIMITS = Object.freeze({ min: 5.6, max: 24 });
/** Solid lower part of the right side wall. Glass above it keeps the rightmost seat rings visible. */
export const SIDE_WALL_HEIGHT = 3.3;
const BACK_WALL_HEIGHT = 2.2, PARAPET_TOP = .72, SIGN_LIFT = .7, GROUND_THICKNESS = .55;
const GROUND_BOTTOM = -SLAB_UNDERSIDE - GROUND_THICKNESS;
const CORE_WIDTH = 5, CORE_DEPTH = 5;
const STRUCTURE_PER_FLOOR = 16, STRUCTURE_FIXED = 32;
const SIGN_CANVAS = { width: 1024, height: 162 } as const;
const SIGN_FONT = "400 92px 'Gowun Dodum', 'IBM Plex Sans KR', sans-serif";
const MARKER_MIN_PIXELS = 10, MARKER_BASE_Y = 2.5;
/** Instance matrices are Float32 on the GPU; a sliver of headroom keeps an enlarged marker from rounding below the minimum. */
const MARKER_HEADROOM = 1.0001;
/** Smallest world extent of each marker at unit scale; used to keep every marker at least 10 screen pixels. */
const RING_EXTENT = 1.6, DIAMOND_EXTENT = .38, PIN_EXTENT = .5;
/** Dashed work ring: short arcs covering this share of each of the evenly spaced slots. */
const DASHED_RING = { dashes: 12, fill: .58, steps: 3 } as const;
/** Above this many seated people, the work ring pulse stops; the markers themselves stay. */
export const LARGE_BUILDING_AGENTS = 240;
/**
 * Nameplate boxes in CSS px (heights include the 3px ledge shadow), estimated from the text so plates are laid out without
 * reading the DOM. Plates stand in one column `gap` px right of the storeys' outer right side wall; neighbouring plate centres
 * keep their height plus `spacing` apart and may move at most `shiftShare` of the storey spacing away from their floor.
 * A form that no longer fits only returns once it fits by `returnShare` of that move and `returnMargin` px of width.
 * A compact name is cut with an ellipsis down to `nameMinWidth` px of name text before the plates drop to their numbers, on a
 * stage at least `nameCutMinWidth` px wide only: the narrow layout names the floor in its project selector, so there plates show
 * their numbers instead of cut names (decision 57).
 */
export const PLATE = Object.freeze({ fullHeight: 53, compactHeight: 27, fullMaxWidth: 280, compactMaxWidth: 190,
  gap: 8, spacing: 2, shiftShare: .4, returnShare: .75, returnMargin: 8, nameMinWidth: 38, nameCutMinWidth: 1001 });
/** Half the compact plate height: the building shot keeps this much room above and below the ground-floor plate anchor. */
export const PLATE_HALF_HEIGHT = PLATE.compactHeight / 2;
/** Outer face of the right side wall's windows, measured from a storey's half width. */
export const PLATE_WALL_OUTSET = .42;
/** Silhouette points of the whole model: ground plate, parapet, rooftop sign top and core cap corners. */
const FRAME_POINTS = 16;
/** From this many floors an elevator rail lists every storey, and only the focus floor stays detailed (Building.dc.html). */
export const RAIL_MIN_FLOORS = 9;
export const DETAIL_RADIUS = 0;
/**
 * Unfocused floors fade toward the pale sky: furniture and people with a light emissive haze, their shell storey
 * (slab bands, beams, columns, walls, stair) with instance colours moved the same share toward it.
 * Status markers use basic materials and side-wall windows carry status proportions, so neither fades.
 */
const HAZE = new THREE.Color('#f2f7fa'), NO_HAZE = new THREE.Color('#000000');
export const HAZE_INTENSITY = .3;
/**
 * Decision 48: ceilings between storeys are drawn at this opacity without depth writes or shadows, so each storey's desks,
 * people and markers stay visible from outside: every slab above the ground floor with its floor finish and its thick edge
 * bands, the ceiling beams, and the roof slab with its finish and edge bands. An opaque edge band hid a strip of the
 * storey below (back-row desks and heads of deep floors), so the bands above the ground floor are see-through too.
 * Columns, walls, the core, parapets and the ground floor with its edge band stay opaque.
 */
export const CEILING_OPACITY = .2;
/** See-through storey parts: two beams per floor plus two edge bands above the ground floor; roof slab, finish and two bands. */
const CEILINGS_PER_FLOOR = 4, CEILINGS_FIXED = 4;
/** See-through ceilings draw before the side glass (2), approval marks (3) and paper flights (4, 5). */
const CEILING_RENDER_ORDER = 1;
const SLAB_COLOR = '#afc5d6', FLOOR_FINISH_COLOR = '#edf3f5', EDGE_COLOR = '#c6d4de';
/**
 * The focus floor's slab edge band turns the navy of the design's focus cell. It is drawn opaque around the see-through
 * band, standing this much proud of it so the two never share a face, and keeps the focus readable through the ceilings.
 */
const FOCUS_EDGE = new THREE.Color('#3f5d78'), FOCUS_EDGE_GROW = .02;
/** The thick slab edge along a storey's open front and right side, hanging below the floor level y. */
function edgeBands(width: number, depth: number, y: number, grow: number, emit: (x: number, y: number, z: number, sx: number, sy: number, sz: number) => void) {
  emit(0, y - .38, depth / 2 + .08, width + .36 + grow, .8 + grow, .36 + grow);
  emit(width / 2 + .08, y - .38, 0, .36 + grow, .8 + grow, depth + .36 + grow);
}
/** Slab edge bands hang this far below a floor, so a storey's pick volume starts there and ends where the next one starts. */
const STOREY_DROP = .78;
/** Pick volume around a seated person (body, head, arms and knees), widened to stay at least minPixels wide on screen. */
const PERSON_PICK = { half: .5, halfHeight: .95, centerY: 1.5, backZ: .2, minPixels: 14, maxHalf: 1.2 } as const;
const TRAIL_POINTS = 12;
const FORWARD = new THREE.Vector3(0, 0, 1);

const clampCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const minimumScale = (unitsPerPixel: number, extent: number) => Math.max(1, MARKER_MIN_PIXELS * unitsPerPixel / extent * MARKER_HEADROOM);

/** Reported counts win; otherwise the supplied roster is classified by status (done counts as quiet). */
export function floorCounts(input: Pick<BuildingFloorInput, 'agents' | 'counts'>): BuildingFloorCounts {
  if (input.counts) {
    return { working: clampCount(input.counts.working), approval: clampCount(input.counts.approval),
      error: clampCount(input.counts.error), quiet: clampCount(input.counts.quiet),
      ...(input.counts.unconfirmed !== undefined ? { unconfirmed: clampCount(input.counts.unconfirmed) } : {}) };
  }
  const counts: BuildingFloorCounts = { working: 0, approval: 0, error: 0, quiet: 0 };
  for (const agent of input.agents) {
    if (agent.unconfirmedStatus) counts.unconfirmed = (counts.unconfirmed ?? 0) + 1;
    else if (activeWork(agent.status)) counts.working++;
    else if (agent.status === 'approval') counts.approval++;
    else if (agent.status === 'error') counts.error++;
    else counts.quiet++;
  }
  return counts;
}

/** PageUp moves the building focus one storey up and PageDown one storey down; other keys do not move it. */
export function floorKeyStep(key: string): -1 | 0 | 1 {
  return key === 'PageUp' ? 1 : key === 'PageDown' ? -1 : 0;
}

/** Nameplate numbers: only non-zero states, in window order; '활동 없음' when nobody is connected. */
export function floorSummary(counts: BuildingFloorCounts): string {
  const parts = WINDOW_ORDER.filter(key => clampCount(counts[key]) > 0).map(key => `${COUNT_LABELS[key]} ${clampCount(counts[key])}`);
  return parts.length ? parts.join(' · ') : '활동 없음';
}
/** Rough rendered width of plate text in CSS px: Hangul and other wide glyphs take about one em, Latin letters and digits about .62. */
function plateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const char of text) { const code = char.codePointAt(0) ?? 0; em += code >= 0x1100 ? 1 : code === 32 ? .3 : .62; }
  return em * size;
}
/**
 * Estimated full (number and name over the counts line) and compact (number and name) plate widths, padding and border included,
 * and the least compact width: the name cut with an ellipsis to `PLATE.nameMinWidth` (a short name needs no cut).
 */
export function nameplateWidths(number: string, name: string, counts: string): { full: number; compact: number; least: number } {
  const numberWidth = number.length * 6.2;
  const compact = Math.ceil(Math.min(PLATE.compactMaxWidth, 18 + numberWidth + 7 + plateTextWidth(name, 12.5)));
  return {
    full: Math.ceil(Math.min(PLATE.fullMaxWidth, 24 + Math.max(numberWidth + 7 + plateTextWidth(name, 16), plateTextWidth(counts, 11)))),
    compact, least: Math.min(compact, Math.ceil(18 + numberWidth + 7 + PLATE.nameMinWidth)),
  };
}
function spokenSummary(counts: BuildingFloorCounts): string {
  const parts = WINDOW_ORDER.filter(key => clampCount(counts[key]) > 0).map(key => `${SPOKEN_LABELS[key]} ${clampCount(counts[key])}명`);
  return parts.length ? parts.join(', ') : '활동 없음';
}

/**
 * Twelve lit windows show proportions, never absolute numbers: work, approval, error, quiet, unconfirmed in that order.
 * Every state with at least one person keeps at least one window; an empty project stays dark.
 */
export function windowCells(counts: BuildingFloorCounts, cells = WINDOW_CELLS): WindowState[] {
  const values = WINDOW_ORDER.map(key => clampCount(counts[key]));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return Array.from({ length: cells }, (): WindowState => 'dark');
  const ideal = values.map(value => value / total * cells);
  const shares = values.map((value, i) => value ? Math.max(1, Math.floor(ideal[i]!)) : 0);
  let sum = shares.reduce((a, b) => a + b, 0);
  while (sum > cells) {
    // Minimum windows can overshoot; take back from the most over-served state (later states yield on ties).
    let pick = -1;
    for (let i = 0; i < shares.length; i++) {
      if (shares[i]! > 1 && (pick < 0 || shares[i]! - ideal[i]! >= shares[pick]! - ideal[pick]!)) pick = i;
    }
    shares[pick]!--; sum--;
  }
  while (sum < cells) {
    let pick = -1;
    for (let i = 0; i < shares.length; i++) {
      if (values[i]! > 0 && (pick < 0 || ideal[i]! - shares[i]! > ideal[pick]! - shares[pick]!)) pick = i;
    }
    shares[pick]!++; sum++;
  }
  return WINDOW_ORDER.flatMap((key, i) => Array.from({ length: shares[i]! }, () => key));
}

/**
 * Floor-to-floor height from the floor's own depth: the deepest seat ring stays visible under the slab above
 * from the default building camera, without the fixed tall gap that left most of each storey empty.
 */
export function storyHeight(bounds: { maxZ: number }): number {
  const deepest = bounds.maxZ - seatPosition(1).z;
  const rise = Math.tan(BUILDING_VIEW.elevation) / Math.cos(BUILDING_VIEW.yaw);
  return THREE.MathUtils.clamp(SLAB_UNDERSIDE + RING_Y + deepest * rise, STORY_LIMITS.min, STORY_LIMITS.max);
}

/** The side-wall window band starts near the open front, leaving the back of the wall for the glass core. */
export function windowBand(depth: number) {
  const width = THREE.MathUtils.clamp(depth * .5, 5, 10);
  return { width, center: depth / 2 - .9 - width / 2 };
}

/** Company sign lettering: whole text when it fits, otherwise the longest prefix with an ellipsis. */
export function fitSignText(context: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const characters = [...text];
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${characters.slice(0, middle).join('')}…`).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('')}…`;
}

function signSize(topWidth: number) {
  const width = THREE.MathUtils.clamp(topWidth * .55, 9, 16);
  return { width, height: width * SIGN_CANVAS.height / SIGN_CANVAS.width };
}

/** The work ring broken into short arcs, in the same plane and radii as the solid RingGeometry. */
function dashedRingGeometry(inner = .72, outer = 1) {
  const positions: number[] = [];
  const slot = Math.PI * 2 / DASHED_RING.dashes, arc = slot * DASHED_RING.fill / DASHED_RING.steps;
  for (let dash = 0; dash < DASHED_RING.dashes; dash++) {
    for (let step = 0; step < DASHED_RING.steps; step++) {
      const a0 = dash * slot + step * arc, a1 = a0 + arc;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      positions.push(inner * c0, inner * s0, 0, outer * c0, outer * s0, 0, outer * c1, outer * s1, 0,
        inner * c0, inner * s0, 0, outer * c1, outer * s1, 0, inner * c1, inner * s1, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

/** A flat warning pin: dark red triangle with a white exclamation mark on both faces and a short stem. */
function pinGeometry() {
  const positions: number[] = [], colors: number[] = [];
  const red = new THREE.Color(STATUS_STYLE.error.color);
  const triangle = (a: number[], b: number[], c: number[], color: THREE.Color) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  };
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number, color: THREE.Color) => {
    triangle([x0, y0, z], [x1, y0, z], [x1, y1, z], color); triangle([x0, y0, z], [x1, y1, z], [x0, y1, z], color);
  };
  triangle([-.5, 0, 0], [.5, 0, 0], [0, .86, 0], red);
  for (const z of [.012, -.012]) { quad(-.045, .3, .045, .62, z, WHITE); quad(-.045, .13, .045, .22, z, WHITE); }
  quad(-.04, -.32, .04, 0, 0, red);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** An actual connected roster, shown as a cutaway building model. It never creates demo employees. */
export class BuildingOverview {
  readonly group = new THREE.Group();
  /** Cutaway shell (columns, walls, windows, core, roof, sign, ground) kept outside `group` so floors stay its only children. */
  readonly shell = new THREE.Group();
  readonly bounds = new THREE.Box3();
  readonly center = new THREE.Vector3();
  radius = 25;
  /** The model's silhouette (ground plate, parapet, rooftop sign and core cap corners); the building shot fits these on screen. */
  readonly framePoints: readonly THREE.Vector3[] = Array.from({ length: FRAME_POINTS }, () => new THREE.Vector3());
  /** How many of `framePoints` describe the current model; 0 without floors. */
  frameCount = 0;
  private readonly floors = new Map<string, Floor>();
  private readonly order: Floor[] = [];
  private readonly anchors = new Map<string, THREE.Vector3>();
  private readonly flights: Flight[] = [];
  private readonly seen = new Set<string>();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly sphere = new THREE.SphereGeometry(1, 10, 8);
  private readonly hair = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI * .55);
  private readonly hoop = new THREE.TorusGeometry(1, .13, 4, 16);
  private readonly ring = new THREE.RingGeometry(.72, 1, 24);
  private readonly dashedRing = dashedRingGeometry();
  private readonly diamond = new THREE.OctahedronGeometry(1);
  private readonly pin = pinGeometry();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Euler();
  private readonly tint = new THREE.Color();
  private readonly projected = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly trailPoint = new THREE.Vector3();
  private readonly structureMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .82 });
  private readonly windowMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
  private readonly glassMaterial = new THREE.MeshStandardMaterial({ color: '#bcd8e6', transparent: true, opacity: .2, roughness: .3, depthWrite: false });
  private readonly ceilingMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: CEILING_OPACITY, roughness: .82, depthWrite: false });
  private readonly focusEdgeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .82 });
  private readonly bushMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9 });
  private readonly groundMaterials = [new THREE.MeshStandardMaterial({ color: '#b9d9bf', roughness: .92 }),
    new THREE.MeshStandardMaterial({ color: '#9dbdaa', roughness: .92 })];
  /** See-through slab and floor finish materials of the storeys above the ground floor, kept apart from the shared colours. */
  private readonly ceilingSlabMaterials = new Map<string, THREE.MeshStandardMaterial>();
  private structure: THREE.InstancedMesh;
  private windows: THREE.InstancedMesh;
  private glass: THREE.InstancedMesh;
  private ceilings: THREE.InstancedMesh;
  /** The focus floor's two opaque navy edge bands; empty without a focus. A fixed two-instance buffer. */
  private readonly focusEdge: THREE.InstancedMesh;
  private readonly bushes: THREE.InstancedMesh;
  private readonly ground: THREE.Mesh;
  private readonly signText: THREE.Mesh;
  private readonly signCanvas?: HTMLCanvasElement;
  private readonly signContext?: CanvasRenderingContext2D;
  private readonly signTexture?: THREE.CanvasTexture;
  private shellCapacity = 0;
  private shellKey = '';
  private windowKey = '';
  private groundKey = '';
  private name = '';
  private selected = '';
  private time = 0;
  private unitsPerPixel = .05;
  private powerSaving = false;
  private agentTotal = 0;
  private compact = false;
  /** Whether the shown compact plates show only their floor numbers; all shown plates share one form. */
  private tight = false;
  /** The fewest visible storeys between shown plates (1 = all); tall stacks thin their plates when even compact plates crowd. */
  private plateStride = 1;
  /**
   * Reused by the plate layout: visible floor indices in stack order, the pooled blocks of the spacing fit, the plates a thinned
   * stack keeps and the plates shown in the previous layout, by visible slot.
   */
  private plateSlots = new Int32Array(0);
  private plateSums = new Float64Array(0);
  private plateSizes = new Int32Array(0);
  private plateKeep = new Uint8Array(0);
  private plateWas = new Uint8Array(0);
  private disposed = false;
  private layoutOrder = '';
  private focusId = '';
  private shellVersion = 0;
  private readonly paintedFocus = { version: -1, index: -1 };
  /** First structure instance of each storey, by floor order; a storey's parts run up to the next one. */
  private readonly storeySlots: number[] = [];
  /** First structure instance after the storeys (roof, sign, core, entrance), which never fades. */
  private roofSlot = 0;
  /** First see-through ceiling instance of each storey (beams, then edge bands above the ground floor), by floor order. */
  private readonly ceilingSlots: number[] = [];
  /** First ceiling instance of the roof (slab, finish, edge bands), which never fades. */
  private ceilingRoofSlot = 0;
  /** Plain structure and ceiling instance colours of the current layout, so the focus haze can be lifted exactly. */
  private structureBase = new Float32Array(0);
  private ceilingBase = new Float32Array(0);
  /** Advances on every roster update so each floor knows its instances need one rewrite. */
  private rosterVersion = 0;
  private readonly hazedMaterials = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  private readonly rail: HTMLOListElement;
  private readonly railItems = new Map<string, RailItem>();
  private readonly pickRay = new THREE.Ray();
  private readonly pickBox = new THREE.Box3();
  private readonly pickPoint = new THREE.Vector3();
  private readonly pickInverse = new THREE.Matrix4();
  private readonly container: HTMLElement;
  private readonly onFloor: (id: string) => void;
  private readonly onFocus?: (projectId: string | null) => void;

  /** onFocus reports focus changes the viewer made on the floor rail (click, PageUp/PageDown, arrows); API calls stay silent. */
  constructor(container: HTMLElement, onFloor: (id: string) => void, onFocus?: (projectId: string | null) => void) {
    this.container = container; this.onFloor = onFloor; this.onFocus = onFocus;
    const rail = this.rail = document.createElement('ol');
    rail.className = 'building-floor-rail'; rail.setAttribute('reversed', ''); rail.setAttribute('aria-label', '층 목록'); rail.hidden = true;
    rail.addEventListener('keydown', event => {
      const step = floorKeyStep(event.key) || (event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0);
      if (!step) return;
      event.preventDefault();
      // Keys move from the rail button that holds keyboard focus, not from wherever the building focus happens to be.
      const from = (event.target as Element | null)?.closest?.('.building-rail-floor') as HTMLElement | null;
      const next = this.stepFocus(step, from?.dataset.projectId);
      if (!next) return;
      this.railItems.get(next)?.button.focus({ preventScroll: true });
      this.onFocus?.(next);
    });
    this.group.name = 'connected-project-building'; this.group.visible = false;
    this.shell.name = 'building-cutaway-shell'; this.shell.visible = false;
    // The shell follows the overview group into whichever parent renders it, without becoming one of its children.
    this.group.addEventListener('added', () => { if (this.group.parent && this.shell.parent !== this.group.parent) this.group.parent.add(this.shell); });
    this.group.addEventListener('removed', () => { this.shell.removeFromParent(); });
    this.structure = this.shellMesh(this.box, this.structureMaterial, STRUCTURE_FIXED, 'building-structure');
    this.windows = this.shellMesh(this.box, this.windowMaterial, 0, 'building-windows');
    this.glass = this.shellMesh(this.box, this.glassMaterial, 1, 'building-glass');
    this.glass.renderOrder = 2;
    this.ceilings = this.shellMesh(this.box, this.ceilingMaterial, CEILINGS_FIXED, 'building-ceilings');
    this.ceilings.renderOrder = CEILING_RENDER_ORDER;
    this.focusEdge = this.shellMesh(this.box, this.focusEdgeMaterial, 2, 'building-focus-edge');
    this.focusEdge.setColorAt(0, FOCUS_EDGE); this.focusEdge.setColorAt(1, FOCUS_EDGE);
    this.bushes = this.shellMesh(this.sphere, this.bushMaterial, 9, 'building-bushes');
    this.ensureShellCapacity(4);
    this.ground = new THREE.Mesh(new THREE.BufferGeometry(), this.groundMaterials);
    this.ground.name = 'building-ground'; this.ground.receiveShadow = true; this.ground.visible = false;
    this.shell.add(this.ground);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext?.('2d') ?? undefined;
    let signMaterial: THREE.Material = this.material('#91aba9');
    if (context) {
      canvas.width = SIGN_CANVAS.width; canvas.height = SIGN_CANVAS.height;
      this.signCanvas = canvas; this.signContext = context;
      this.signTexture = new THREE.CanvasTexture(canvas);
      this.signTexture.colorSpace = THREE.SRGBColorSpace;
      signMaterial = new THREE.MeshStandardMaterial({ map: this.signTexture, roughness: 1 });
    }
    this.signText = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), signMaterial);
    this.signText.name = 'building-company-sign'; this.signText.visible = false; this.signText.userData.companyName = '';
    this.shell.add(this.signText);
    this.drawSign();
    // A web font that finishes loading after the first draw would otherwise leave the fallback lettering on the sign.
    document.fonts?.ready?.then(() => { if (!this.disposed) this.drawSign(); }).catch(() => {});
  }
  get companyName() { return this.name; }
  /** Setting value only: the rooftop sign repaints its single canvas texture when the name actually changes. */
  setCompanyName(name: string) {
    const next = String(name ?? '').trim();
    if (next === this.name) return;
    this.name = next; this.signText.userData.companyName = next;
    this.drawSign();
  }
  /** Power saving keeps every marker and window but stops building motion, like reduced motion. */
  setPowerSaving(enabled: boolean) { this.powerSaving = !!enabled; }
  private drawSign() {
    const context = this.signContext, canvas = this.signCanvas;
    if (!context || !canvas || !this.signTexture) return;
    context.fillStyle = '#91aba9'; context.fillRect(0, 0, canvas.width, canvas.height);
    if (this.name) {
      context.fillStyle = '#f5f9fb'; context.font = SIGN_FONT; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(fitSignText(context, this.name, canvas.width - 96), canvas.width / 2, canvas.height / 2 + 4);
    }
    this.signTexture.needsUpdate = true;
  }
  private material(color: string) {
    if (!this.materials.has(color)) this.materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .78 }));
    return this.materials.get(color)!;
  }
  /** See-through twin of a slab colour (decision 48), in its own cache so no shared opaque colour ever turns see-through. */
  private ceilingSlabMaterial(color: string) {
    let material = this.ceilingSlabMaterials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: .78, transparent: true, opacity: CEILING_OPACITY, depthWrite: false });
      this.ceilingSlabMaterials.set(color, material);
    }
    return material;
  }
  /** A storey's slab and floor finish (its first two children) become see-through from the second storey up; a hazed floor stays hazed. */
  private setCeiling(floor: Floor, ceiling: boolean) {
    if (floor.ceiling === ceiling) return;
    floor.ceiling = ceiling;
    floor.group.children.slice(0, 2).forEach((child, index) => {
      if (!(child instanceof THREE.Mesh)) return;
      const color = index === 0 ? SLAB_COLOR : FLOOR_FINISH_COLOR;
      const next = ceiling ? this.ceilingSlabMaterial(color) : this.material(color);
      child.castShadow = false; child.renderOrder = ceiling ? CEILING_RENDER_ORDER : 0;
      if (child.userData.clearMaterial) { child.userData.clearMaterial = next; child.material = this.hazedMaterial(next); }
      else child.material = next;
    });
  }
  private shellMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.name = name; mesh.frustumCulled = false; mesh.count = 0; mesh.receiveShadow = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3).fill(1), 3);
    this.shell.add(mesh); return mesh;
  }
  /** Instance buffers grow in powers of two and are reused, so the shell's draw objects never depend on floor count. */
  private ensureShellCapacity(floors: number) {
    const capacity = Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(1, floors))));
    if (capacity <= this.shellCapacity) return;
    this.shellCapacity = capacity;
    const replace = (previous: THREE.InstancedMesh, count: number) => {
      const next = this.shellMesh(previous.geometry, previous.material as THREE.Material, count, previous.name);
      next.renderOrder = previous.renderOrder;
      if (previous.parent) { previous.removeFromParent(); previous.dispose(); }
      return next;
    };
    this.structure = replace(this.structure, STRUCTURE_FIXED + STRUCTURE_PER_FLOOR * capacity);
    this.structureBase = new Float32Array((STRUCTURE_FIXED + STRUCTURE_PER_FLOOR * capacity) * 3);
    this.windows = replace(this.windows, WINDOW_CELLS * capacity);
    this.glass = replace(this.glass, 1 + capacity);
    this.ceilings = replace(this.ceilings, CEILINGS_FIXED + CEILINGS_PER_FLOOR * capacity);
    this.ceilingBase = new Float32Array((CEILINGS_FIXED + CEILINGS_PER_FLOOR * capacity) * 3);
    this.shellKey = ''; this.windowKey = '';
  }
  private block(parent: THREE.Group, size: number[], point: number[], color: string) {
    const mesh = new THREE.Mesh(this.box, this.material(color));
    mesh.scale.set(size[0]!, size[1]!, size[2]!); mesh.position.set(point[0]!, point[1]!, point[2]!);
    mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private instances(floor: Floor, geometry: THREE.BufferGeometry, count: number, color: string, tint = false) {
    const material = tint ? new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .8 }) : this.material(color);
    if (tint) floor.materials.push(material);
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false; floor.group.add(mesh); return mesh;
  }
  private place(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, sx: number, sy: number, sz: number,
    rotation = 0, rotateY = 0, rotateZ = 0) {
    this.quaternion.setFromEuler(this.rotation.set(rotation, rotateY, rotateZ));
    this.matrix.compose(this.position.set(x, y, z), this.quaternion, this.scale.set(sx, sy, sz));
    mesh.setMatrixAt(index, this.matrix);
  }
  private statusInstances(floor: Floor, geometry: THREE.BufferGeometry, name: string, overlay = false, vertexColors = false) {
    // Approval and error signals draw over slabs and walls, like the paper flights, so a back-row request is never hidden.
    const material = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false, vertexColors,
      depthTest: !overlay, depthWrite: !overlay });
    floor.materials.push(material);
    const mesh = new THREE.InstancedMesh(geometry, material, floor.agents.length);
    mesh.name = name; mesh.frustumCulled = false; if (overlay) mesh.renderOrder = 3;
    floor.group.add(mesh); return mesh;
  }
  private createFloor(input: BuildingFloorInput): Floor {
    const agents = input.agents.slice(0, MAX_OFFICE_AGENTS);
    const bounds = officeBounds(agents.length + 1);
    const group = new THREE.Group(); group.name = 'project-floor'; group.userData.projectId = input.id;
    const label = document.createElement('button'); label.className = 'building-floor-label';
    label.type = 'button'; label.hidden = true; label.dataset.projectId = input.id; label.dataset.compact = 'false'; label.dataset.tight = 'false';
    label.dataset.detail = 'true'; label.dataset.focused = 'false'; label.dataset.dimmed = 'false';
    // Two-step building click: the first click focuses the floor like the rail; a click on the focused floor opens its office.
    label.addEventListener('click', () => {
      if (this.focusId === input.id) { this.onFloor(input.id); return; }
      this.focusFloor(input.id); this.onFocus?.(this.focusId || null);
    });
    const labelNumber = document.createElement('span'); labelNumber.className = 'building-floor-number';
    const labelName = document.createElement('span'); labelName.className = 'building-floor-name';
    const labelCounts = document.createElement('span'); labelCounts.className = 'building-floor-counts';
    label.append(labelNumber, ' ', labelName, ' ', labelCounts);
    this.container.append(label);
    const floor: Floor = { id: input.id, name: input.name, group, label, labelNumber, labelName, labelCounts, anchor: new THREE.Vector3(),
      width: bounds.width, depth: bounds.depth, centerX: bounds.centerX, gap: storyHeight(bounds), level: 0,
      signature: '', agents, counts: { unconfirmed: 0, ...floorCounts(input) }, cells: '', detailed: true, dimmed: false, detailMeshes: [], ceiling: false,
      screenX: 0, screenY: 0, onScreen: false, labelX: NaN, labelY: NaN,
      plateWidth: 0, plateCompactWidth: 0, plateLeastWidth: 0, plateY: 0, plateShown: false, plateMaxWidth: 0,
      arms: null!, screens: null!, points: [], materials: [],
      bodies: null!, heads: null!, hair: null!, knees: null!, characterVisibility: [],
      workBoxes: null!, workSpheres: null!, workHoops: null!, activityRings: null!, activityDashes: null!, activityHeads: null!, activityPins: null!,
      activityMeshes: [], animated: false, drawnUnits: NaN, drawnRoster: -1, drawnTime: NaN };
    this.block(group, [bounds.width, .6, bounds.depth], [0, -.38, 0], SLAB_COLOR);
    this.block(group, [bounds.width - .25, .13, bounds.depth - .25], [0, -.02, 0], FLOOR_FINISH_COLOR);
    const tops = this.instances(floor, this.box, agents.length, '#e3cbb0');
    const legs = this.instances(floor, this.box, agents.length * 2, '#e3e9e9');
    const monitors = this.instances(floor, this.box, agents.length, '#405968');
    floor.screens = this.instances(floor, this.box, agents.length, '#b4dddb', true);
    const bodies = floor.bodies = this.instances(floor, this.sphere, agents.length, '#91b9ce', true);
    floor.heads = this.instances(floor, this.sphere, agents.length, '#ffffff', true);
    floor.hair = this.instances(floor, this.hair, agents.length, '#ffffff', true);
    floor.arms = this.instances(floor, this.box, agents.length * 2, '#ffffff', true);
    const chairs = this.instances(floor, this.box, agents.length, '#a9bdc8', true);
    floor.knees = this.instances(floor, this.box, agents.length * 2, '#738796');
    floor.workBoxes = this.instances(floor, this.box, agents.length * WORK_BOXES, CREAM, true);
    floor.workSpheres = this.instances(floor, this.sphere, agents.length * WORK_SPHERES, CREAM, true);
    floor.workHoops = this.instances(floor, this.hoop, agents.length * WORK_HOOPS, CREAM, true);
    floor.workBoxes.name = 'building-activity-boxes'; floor.workSpheres.name = 'building-activity-spheres'; floor.workHoops.name = 'building-activity-hoops';
    floor.activityRings = this.statusInstances(floor, this.ring, 'building-activity-rings');
    floor.activityDashes = this.statusInstances(floor, this.dashedRing, 'building-activity-dashed-rings');
    floor.activityHeads = this.statusInstances(floor, this.diamond, 'building-activity-heads', true);
    floor.activityPins = this.statusInstances(floor, this.pin, 'building-activity-pins', true, true);
    floor.activityMeshes = [floor.workBoxes, floor.workSpheres, floor.workHoops, floor.activityRings, floor.activityDashes,
      floor.activityHeads, floor.activityPins];
    // Approval diamonds and error pins are not listed: a compressed floor still shows who needs attention.
    floor.detailMeshes = [tops, legs, monitors, floor.screens, bodies, floor.heads, floor.hair, floor.arms, chairs, floor.knees,
      floor.workBoxes, floor.workSpheres, floor.workHoops, floor.activityRings, floor.activityDashes];
    for (const mesh of floor.activityMeshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.count * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    }
    for (let i = 0; i < agents.length; i++) {
      const seat = seatPosition(i + 1), x = seat.x - bounds.centerX, z = seat.z - bounds.centerZ;
      floor.points.push(new THREE.Vector3(x, 0, z));
      this.place(tops, i, x, 1.15, z - 1.05, 3.65, .18, 1.65);
      this.place(legs, i * 2, x - 1.4, .54, z - 1.05, .18, 1.08, 1.3);
      this.place(legs, i * 2 + 1, x + 1.4, .54, z - 1.05, .18, 1.08, 1.3);
      this.place(monitors, i, x, 1.85, z - 1.45, 1.35, .87, .18);
      this.place(floor.screens, i, x, 1.85, z - 1.35, 1.18, .69, .025);
      this.place(chairs, i, x, .86, z + .2, 1.1, .14, .88);
      // The same look as the 3D office and card portraits: skin and hair follow the person, never the desk.
      const look = appearanceFor(agents[i]!.id);
      const color = /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(agents[i]!.color ?? '') ? agents[i]!.color! : look.seatShirt;
      bodies.setColorAt(i, this.tint.set(color)); chairs.setColorAt(i, this.tint);
      floor.heads.setColorAt(i, this.tint.set(look.skin));
      floor.arms.setColorAt(i * 2, this.tint); floor.arms.setColorAt(i * 2 + 1, this.tint);
      floor.hair.setColorAt(i, this.tint.set(look.hair));
    }
    this.block(group, [5.8, .025, 7.3], [-10 - bounds.centerX, .06, -bounds.centerZ - 2], '#d9e8e2');
    // Owner wing (Building.dc.html items 7 and 8): the owner is always at the desk, with a bookshelf and plants by reception.
    // The owner is decoration drawn once per floor: never an employee, never picked, and hidden with people on compressed floors.
    const ownerX = -10 - bounds.centerX, deskZ = -bounds.centerZ - 4, ownerZ = deskZ + 1.05, ownerLook = appearanceFor('boss');
    const ownerBody = this.instances(floor, this.sphere, 1, ownerLook.seatShirt), ownerHead = this.instances(floor, this.sphere, 1, ownerLook.skin);
    const ownerHair = this.instances(floor, this.hair, 1, ownerLook.hair), ownerKnees = this.instances(floor, this.box, 2, '#7188a8');
    this.place(ownerBody, 0, ownerX, 1.23, ownerZ, .38, .5, .3);
    this.place(ownerHead, 0, ownerX, 1.96, ownerZ - .04, .38, .4, .37);
    this.place(ownerHair, 0, ownerX, 2.01, ownerZ, .4, .41, .39);
    for (const side of [0, 1]) this.place(ownerKnees, side, ownerX + (side ? .18 : -.18), .65, ownerZ - .35, .23, .8, .24, -.22);
    floor.detailMeshes.push(ownerBody, ownerHead, ownerHair, ownerKnees);
    this.block(group, [.12, .8, .12], [ownerX, .4, ownerZ + .2], '#738796');
    this.block(group, [1.1, .14, .88], [ownerX, .86, ownerZ + .2], '#8a6a50');
    this.block(group, [1.1, .6, .14], [ownerX, 1.15, ownerZ + .66], '#7a5c45');
    const wallX = bounds.minX - bounds.centerX;
    this.block(group, [.62, 1.5, 2.4], [wallX + .5, .75, deskZ - 1.2], '#d8bd9a');
    ['#b6a4d4', '#91b9ce', '#e2bd6f', '#a9bd88'].forEach((color, i) =>
      this.block(group, [.46, .4, .34], [wallX + .72, i < 2 ? 1.08 : .5, deskZ - 1.95 + i % 2 * .6 + (i < 2 ? 0 : .5)], color));
    for (const [x, z] of [[wallX + .55, deskZ + 2.3], [ownerX + 2.45, deskZ - .7]] as const) {
      this.block(group, [.46, .46, .46], [x, .23, z], '#e1a38f');
      const leaves = new THREE.Mesh(this.sphere, this.material('#8fb79a'));
      leaves.scale.set(.42, .5, .42); leaves.position.set(x, .86, z); leaves.receiveShadow = true; group.add(leaves);
    }
    // The owner desk stands on the same leg pair as employee desks; its top stays the last child.
    for (const side of [-1, 1]) this.block(group, [.18, 1.08, 1.3], [-10 - bounds.centerX + side * 1.4, .54, -bounds.centerZ - 4], '#e3e9e9');
    this.block(group, [3.65, .2, 1.8], [-10 - bounds.centerX, 1.15, -bounds.centerZ - 4], '#d8bd9a');
    this.group.add(group); return floor;
  }
  setFloors(inputs: BuildingFloorInput[]) {
    const unique = [...new Map(inputs.map(input => [input.id, input])).values()];
    const ids = new Set(unique.map(input => input.id));
    const order = JSON.stringify(unique.map(input => input.id));
    let changed = order !== this.layoutOrder; this.layoutOrder = order;
    this.rosterVersion++;
    for (const [id, floor] of this.floors) if (!ids.has(id)) { this.removeFloor(floor); this.floors.delete(id); changed = true; }
    this.order.length = 0; this.agentTotal = 0;
    unique.forEach((input, index) => {
      const signature = JSON.stringify(input.agents.slice(0, MAX_OFFICE_AGENTS).map(agent => [agent.id, agent.color]));
      let floor = this.floors.get(input.id);
      if (!floor || floor.signature !== signature) {
        if (floor) this.removeFloor(floor);
        floor = this.createFloor(input); floor.signature = signature; this.floors.set(input.id, floor); changed = true;
      }
      floor.agents = input.agents.slice(0, MAX_OFFICE_AGENTS);
      floor.animated = floor.agents.some(agent => activeWork(agent.status) && agent.showCharacter !== false);
      floor.name = input.name;
      floor.counts = { unconfirmed: 0, ...floorCounts(input) };
      floor.labelNumber.textContent = `${index + 1}F`;
      floor.labelName.textContent = input.name;
      floor.labelCounts.textContent = floorSummary(floor.counts);
      floor.label.title = input.name;
      const widths = nameplateWidths(`${index + 1}F`, input.name, floor.labelCounts.textContent);
      floor.plateWidth = widths.full; floor.plateCompactWidth = widths.compact; floor.plateLeastWidth = widths.least;
      this.order.push(floor); this.agentTotal += floor.agents.length;
    });
    this.orderLabels();
    this.anchors.clear();
    let level = 0;
    for (const floor of this.order) {
      floor.level = level;
      this.setCeiling(floor, floor !== this.order[0]);
      floor.group.position.set(0, level, 0);
      floor.anchor.set(floor.width / 2 + .45, level + 1.05, windowBand(floor.depth).center);
      floor.agents.forEach((agent, i) => this.anchors.set(agent.id, floor.points[i]!.clone().add(new THREE.Vector3(0, level + 1.85, -1.35))));
      level += floor.gap;
    }
    const top = this.order.at(-1);
    const floorWidth = Math.max(0, ...this.order.map(floor => floor.width));
    const depth = Math.max(14, ...this.order.map(floor => floor.depth));
    const roofTop = top ? level + PARAPET_TOP + SIGN_LIFT + signSize(top.width).height : 3;
    this.bounds.set(new THREE.Vector3(-floorWidth / 2, GROUND_BOTTOM, -depth / 2), new THREE.Vector3(floorWidth / 2, Math.max(3, roofTop), depth / 2));
    this.center.set(0, (this.bounds.min.y + this.bounds.max.y) / 2, 0);
    this.radius = Math.hypot(Math.max(20, floorWidth), depth, this.bounds.max.y - this.bounds.min.y) * .58;
    this.layoutShell(level);
    this.paintWindows();
    if (this.focusId && !ids.has(this.focusId)) this.focusId = '';
    this.applyFocus();
    if (changed) for (const flight of [...this.flights]) this.removeFlight(flight);
    this.update(0, false, false, this.unitsPerPixel);
  }
  /** Nameplates keep DOM order equal to floor order, so keyboard and screen-reader order match the stack. */
  private orderLabels() {
    const current = Array.from(this.container.children).filter(element => element.classList.contains('building-floor-label'));
    if (current.length === this.order.length && current.every((element, i) => element === this.order[i]!.label)) return;
    const active = this.order.find(floor => floor.label === document.activeElement)?.label;
    for (const floor of this.order) this.container.append(floor.label);
    // Moving a focused plate would drop keyboard focus; restore it on the same floor.
    active?.focus({ preventScroll: true });
  }
  private layoutShell(roofY: number) {
    const floors = this.order;
    const top = floors.at(-1);
    const key = JSON.stringify(floors.map(floor => [floor.width, floor.depth, floor.gap, floor.centerX]));
    if (key === this.shellKey && this.structure.count > 0 === floors.length > 0) return;
    this.ensureShellCapacity(floors.length);
    this.shellKey = key; this.windowKey = '';
    // A new layout repaints every slab edge band in its plain colour, so the focus band is painted again afterwards.
    this.shellVersion++; this.storeySlots.length = 0; this.ceilingSlots.length = 0;
    const structure = this.structure, glass = this.glass;
    if (!top) {
      structure.count = 0; glass.count = 0; this.windows.count = 0; this.bushes.count = 0; this.ceilings.count = 0;
      this.ground.visible = false; this.signText.visible = false; this.frameCount = 0; return;
    }
    const ceilings = this.ceilings;
    let s = 0, g = 0, c = 0;
    const lid = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string) => {
      this.place(ceilings, c, x, y, z, sx, sy, sz); ceilings.setColorAt(c++, this.tint.set(color));
    };
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, rx = 0, ry = 0) => {
      this.place(structure, s, x, y, z, sx, sy, sz, rx, ry); structure.setColorAt(s++, this.tint.set(color));
    };
    const edgePut = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => put(x, y, z, sx, sy, sz, EDGE_COLOR);
    const edgeLid = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => lid(x, y, z, sx, sy, sz, EDGE_COLOR);
    const pane = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => { this.place(glass, g++, x, y, z, sx, sy, sz); };
    const maxWidth = Math.max(...floors.map(floor => floor.width)), maxDepth = Math.max(...floors.map(floor => floor.depth));
    const coreX = maxWidth / 2 + .3 + CORE_WIDTH / 2, coreZ = -maxDepth / 2 + .3 + CORE_DEPTH / 2;
    for (let index = 0; index < floors.length; index++) {
      const floor = floors[index]!;
      const { width: w, depth: d, level: y, gap } = floor;
      const ceiling = y + gap - SLAB_UNDERSIDE, column = ceiling - (y - .08);
      this.storeySlots.push(s); this.ceilingSlots.push(c);
      // Ceiling beams close each storey's frame even where the floor above is narrower; like every ceiling they are see-through.
      lid(0, ceiling - .16, d / 2 - .12, w, .32, .3, '#d8e0e5');
      lid(w / 2 - .12, ceiling - .16, 0, .3, .32, d, '#d8e0e5');
      // Thick slab edge along the open front and the right side: solid under the ground floor, a see-through ceiling edge above it.
      edgeBands(w, d, y, 0, index ? edgeLid : edgePut);
      const corridor = -4.7 - floor.centerX;
      const columns = [[-w / 2 + .25, d / 2 - .25], [w / 2 - .25, d / 2 - .25], [-w / 2 + .25, -d / 2 + .25], [w / 2 - .25, -d / 2 + .25]];
      if (Math.abs(corridor) < w / 2 - 1) columns.push([corridor, d / 2 - .25]);
      for (const [x, z] of columns) put(x!, y - .08 + column / 2, z!, .42, column, .42, '#eef5fa');
      // Right side wall: solid lower band for windows and the nameplate, glass up to the ceiling beam.
      put(w / 2 + .12, y - .08 + (SIDE_WALL_HEIGHT + .08) / 2, 0, .3, SIDE_WALL_HEIGHT + .08, d, '#dfe7ec');
      const glassHeight = Math.max(.1, ceiling - .32 - SIDE_WALL_HEIGHT - y);
      pane(w / 2 + .12, y + SIDE_WALL_HEIGHT + glassHeight / 2, 0, .12, glassHeight, d);
      const band = windowBand(d);
      put(w / 2 + .3, y + 2.41, band.center, .06, 1.52, band.width + .3, '#c6d4de');
      // Half-height clay wall at the back keeps the cutaway readable from above.
      put(0, y - .08 + BACK_WALL_HEIGHT / 2, -d / 2 + .15, w, BACK_WALL_HEIGHT, .3, '#d9e3e8');
      // Glass core landing and a scissor stair to the next storey.
      put(coreX, y - .08, coreZ, CORE_WIDTH - .3, .16, CORE_DEPTH - .3, '#d8e0e5');
      const run = CORE_DEPTH - 2.2, rise = gap / 2, slope = Math.atan2(rise, run), length = Math.hypot(run, rise);
      put(coreX - CORE_WIDTH / 4, y + rise / 2, coreZ, CORE_WIDTH / 2 - .45, .14, length, '#c6d4de', -slope);
      put(coreX - CORE_WIDTH / 4, y + rise * 1.5, coreZ, CORE_WIDTH / 2 - .45, .14, length, '#c6d4de', slope);
    }
    this.roofSlot = s; this.ceilingRoofSlot = c;
    const { width: tw, depth: td } = top;
    // See-through roof slab, finish and slab edge, then the solid parapet.
    lid(0, roofY - .38, 0, tw, .6, td, '#d8e0e5');
    lid(0, roofY - .02, 0, tw - .5, .1, td - .5, '#eef5fa');
    edgeBands(tw, td, roofY, 0, edgeLid);
    put(0, roofY + .32, td / 2 - .15, tw, .8, .3, '#d8e0e5');
    put(0, roofY + .32, -td / 2 + .15, tw, .8, .3, '#d8e0e5');
    put(-tw / 2 + .15, roofY + .32, 0, .3, .8, td, '#d8e0e5');
    put(tw / 2 - .15, roofY + .32, 0, .3, .8, td, '#d8e0e5');
    put(tw / 2 - 2.2, roofY + .45, -td / 2 + 1.6, 1.8, .9, 1.2, '#eef5fa');
    // Rooftop company sign on two posts; lettering is a single canvas texture on the front face.
    const sign = signSize(tw);
    const signX = -tw / 2 + 1.2 + sign.width / 2, signY = roofY + PARAPET_TOP + SIGN_LIFT + sign.height / 2, signZ = td / 2 - 1.4;
    put(signX, signY, signZ, sign.width, sign.height, .22, '#91aba9');
    put(signX, signY + sign.height / 2 + .04, signZ, sign.width, .08, .26, '#9fb6b4');
    for (const side of [-1, 1]) put(signX + side * sign.width * .32, roofY + (PARAPET_TOP + SIGN_LIFT) / 2, signZ - .05, .2, PARAPET_TOP + SIGN_LIFT + .1, .2, '#879ba3');
    this.signText.position.set(signX, signY, signZ + .115);
    this.signText.scale.set(sign.width - .3, sign.height - .24, 1);
    this.signText.visible = true;
    // Glass core with posts, cap and a parked elevator car; its entrance canopy faces the front.
    const coreTop = roofY + 1.4, coreHeight = coreTop + SLAB_UNDERSIDE;
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      put(coreX + x! * (CORE_WIDTH / 2 - .1), coreTop - coreHeight / 2, coreZ + z! * (CORE_DEPTH / 2 - .1), .22, coreHeight, .22, '#96acb5');
    }
    put(coreX, coreTop + .15, coreZ, CORE_WIDTH + .4, .3, CORE_DEPTH + .4, '#eef5fa');
    pane(coreX, coreTop - coreHeight / 2, coreZ, CORE_WIDTH, coreHeight, CORE_DEPTH);
    put(coreX + CORE_WIDTH / 4, 1.07, coreZ + CORE_DEPTH / 4, 1.9, 2.3, 1.7, '#fffdf5');
    put(coreX + CORE_WIDTH / 4 + .96, 1.4, coreZ + CORE_DEPTH / 4, .03, .9, 1.1, '#8fbbd2');
    const canopyZ = coreZ + CORE_DEPTH / 2 + 1.1;
    put(coreX, 2.95, canopyZ, CORE_WIDTH - .6, .18, 2.2, '#eef5fa');
    for (const side of [-1, 1]) put(coreX + side * (CORE_WIDTH / 2 - .6), 1.12, canopyZ + .95, .12, 3.6, .12, '#96acb5');
    // Rounded clay ground plate with an entrance path and a few shrubs.
    const minX = -maxWidth / 2 - 2.6, maxX = coreX + CORE_WIDTH / 2 + 2.6, minZ = -maxDepth / 2 - 2.2, maxZ = maxDepth / 2 + 3.4;
    put(coreX, -SLAB_UNDERSIDE + .02, (canopyZ + maxZ) / 2, 2.2, .04, maxZ - canopyZ, '#e5ebed');
    // Silhouette for the building shot; the widest storey's parapet stands in for the top corners of every storey below.
    const frame = this.framePoints;
    let f = 0;
    const corners = (x0: number, x1: number, y: number, z0: number, z1: number) => {
      frame[f++]!.set(x0, y, z0); frame[f++]!.set(x1, y, z0); frame[f++]!.set(x0, y, z1); frame[f++]!.set(x1, y, z1);
    };
    corners(minX, maxX, GROUND_BOTTOM, minZ, maxZ);
    corners(-maxWidth / 2, maxWidth / 2, roofY + PARAPET_TOP, -maxDepth / 2, maxDepth / 2);
    corners(signX - sign.width / 2, signX + sign.width / 2, signY + sign.height / 2 + .08, signZ - .13, signZ + .13);
    corners(coreX - CORE_WIDTH / 2 - .2, coreX + CORE_WIDTH / 2 + .2, coreTop + .3, coreZ - CORE_DEPTH / 2 - .2, coreZ + CORE_DEPTH / 2 + .2);
    this.frameCount = f;
    structure.count = s; glass.count = g; ceilings.count = c;
    structure.instanceMatrix.needsUpdate = true; glass.instanceMatrix.needsUpdate = true; ceilings.instanceMatrix.needsUpdate = true;
    if (ceilings.instanceColor) {
      ceilings.instanceColor.needsUpdate = true;
      this.ceilingBase.set((ceilings.instanceColor.array as Float32Array).subarray(0, c * 3));
    }
    if (structure.instanceColor) {
      structure.instanceColor.needsUpdate = true;
      this.structureBase.set((structure.instanceColor.array as Float32Array).subarray(0, s * 3));
    }
    const groundKey = JSON.stringify([minX, maxX, minZ, maxZ]);
    if (groundKey !== this.groundKey) {
      this.groundKey = groundKey;
      this.ground.geometry.dispose();
      this.ground.geometry = this.groundGeometry(minX, maxX, minZ, maxZ);
    }
    this.ground.visible = true;
    let b = 0;
    const clusters = [[minX + 1.5, maxZ - 1.3, 1.1], [maxX - 1.5, maxZ - 1.3, .9], [minX + 1.5, minZ + 1.5, 1]];
    const shrubs = [[-.35, .45, .1, .55, '#8daa99'], [.4, .42, -.1, .5, '#9dbdaa'], [0, .8, 0, .55, '#b9d9bf']] as const;
    for (const [x, z, size] of clusters) {
      for (const [dx, dy, dz, radius, color] of shrubs) {
        this.place(this.bushes, b, x! + dx * size!, -SLAB_UNDERSIDE + dy * size!, z! + dz * size!, radius * size!, radius * size!, radius * size!);
        this.bushes.setColorAt(b++, this.tint.set(color));
      }
    }
    this.bushes.count = b; this.bushes.instanceMatrix.needsUpdate = true;
    if (this.bushes.instanceColor) this.bushes.instanceColor.needsUpdate = true;
  }
  private groundGeometry(minX: number, maxX: number, minZ: number, maxZ: number) {
    // Shape y is -z so the extrusion, rotated onto the ground, keeps world orientation.
    const radius = 2.2, x0 = minX, x1 = maxX, y0 = -maxZ, y1 = -minZ;
    const shape = new THREE.Shape();
    shape.moveTo(x0 + radius, y0); shape.lineTo(x1 - radius, y0); shape.quadraticCurveTo(x1, y0, x1, y0 + radius);
    shape.lineTo(x1, y1 - radius); shape.quadraticCurveTo(x1, y1, x1 - radius, y1);
    shape.lineTo(x0 + radius, y1); shape.quadraticCurveTo(x0, y1, x0, y1 - radius);
    shape.lineTo(x0, y0 + radius); shape.quadraticCurveTo(x0, y0, x0 + radius, y0);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: GROUND_THICKNESS, bevelEnabled: false, curveSegments: 6 });
    geometry.rotateX(-Math.PI / 2); geometry.translate(0, GROUND_BOTTOM, 0);
    return geometry;
  }
  /** Side-wall windows: proportions of the reported counts, repainted only when counts or layout change. */
  private paintWindows() {
    for (const floor of this.order) floor.cells = windowCells(floor.counts).join(',');
    const key = `${this.shellKey}|${this.order.map(floor => floor.cells).join('|')}`;
    if (key === this.windowKey) return;
    this.windowKey = key;
    let index = 0;
    for (const floor of this.order) {
      const band = windowBand(floor.depth), column = band.width / WINDOW_COLUMNS;
      const cells = floor.cells.split(',') as WindowState[];
      for (let cell = 0; cell < WINDOW_CELLS; cell++) {
        const row = Math.floor(cell / WINDOW_COLUMNS), slot = cell % WINDOW_COLUMNS;
        // Reading order runs from the open front toward the back of the side wall, top row first.
        const z = band.center + band.width / 2 - column * (slot + .5);
        this.place(this.windows, index, floor.width / 2 + .36, floor.level + 2.78 - row * .74, z, .06, .56, column * .78);
        this.windows.setColorAt(index++, WINDOW_COLORS[cells[cell] ?? 'dark']);
      }
    }
    this.windows.count = index;
    this.windows.instanceMatrix.needsUpdate = true;
    if (this.windows.instanceColor) this.windows.instanceColor.needsUpdate = true;
  }
  hasAgent(id: string) { return this.anchors.has(id); }
  hasFloor(id: string) { return this.floors.has(id); }
  /** Where the ground floor's nameplate is centred (building coordinates); null without floors. */
  get groundPlateAnchor(): THREE.Vector3 | null { return this.order[0]?.anchor ?? null; }
  /**
   * Least px the nameplate column takes right of the storeys' outer side wall: the gap and the widest number-only plate (the tight
   * form, as wide as its floor number), which a narrow free area still shows.
   */
  get plateColumnReserve(): number { return this.order.length ? PLATE.gap + Math.ceil(18 + `${this.order.length}F`.length * 6.2) : 0; }
  /** World half width and half depth of the footprint corners the nameplate column starts right of (see `updateLabels`). */
  get plateWallHalfWidth(): number { return this.bounds.max.x + PLATE_WALL_OUTSET; }
  get plateWallHalfDepth(): number { return this.bounds.max.z; }
  get activeFlightCount() { return this.flights.length; }
  focusPoint(id?: string) { return this.floors.get(id ?? '')?.group.position.clone().add(new THREE.Vector3(0, 1, 0)) ?? this.center.clone(); }
  show(visible: boolean, projectId = '') {
    const changed = this.group.visible !== visible || this.selected !== projectId;
    this.group.visible = visible; this.shell.visible = visible; this.selected = projectId;
    if (!visible) {
      for (const floor of this.floors.values()) floor.label.hidden = true;
      for (const flight of [...this.flights]) this.removeFlight(flight);
    }
    // The camera's floor centres the detailed band when nothing is focused; repeated calls with the same view do nothing.
    if (changed && this.applyFocus()) this.refreshDetail();
  }
  /** The floor chosen by a floor click, the rail or PageUp/PageDown; null when none. */
  get focusedFloor(): string | null { return this.focusId || null; }
  /** True while the building has enough floors to list them on the elevator rail. */
  get railActive() { return this.order.length >= RAIL_MIN_FLOORS; }
  /**
   * Step one of the building click: the storey a pointer ray enters first. A storey spans its slab up to the next slab,
   * so a click on a person, desk, wall or open space of that storey picks it, while a slab in front that hides it wins.
   */
  pickFloor(raycaster: THREE.Raycaster): string | null {
    if (!this.group.visible || !this.order.length) return null;
    this.group.updateWorldMatrix(true, false);
    const ray = this.pickRay.copy(raycaster.ray).applyMatrix4(this.pickInverse.copy(this.group.matrixWorld).invert());
    let nearest = Infinity, picked: string | null = null;
    for (let i = 0; i < this.order.length; i++) {
      const floor = this.order[i]!, w = floor.width / 2, d = floor.depth / 2;
      this.pickBox.min.set(-w - .1, floor.level - STOREY_DROP, -d - .1);
      this.pickBox.max.set(w + .45, floor.level + floor.gap - STOREY_DROP, d + .3);
      if (!ray.intersectBox(this.pickBox, this.pickPoint)) continue;
      const distance = this.pickPoint.distanceToSquared(ray.origin);
      if (distance < nearest) { nearest = distance; picked = floor.id; }
    }
    return picked;
  }
  /** Step two: the drawn person a ray meets first on a detailed floor. Hidden people and compressed floors are never picked. */
  pickAgent(raycaster: THREE.Raycaster, projectId: string): string | null {
    const floor = this.floors.get(projectId);
    if (!this.group.visible || !floor || !floor.detailed || !floor.agents.length) return null;
    floor.group.updateWorldMatrix(true, false);
    const ray = this.pickRay.copy(raycaster.ray).applyMatrix4(this.pickInverse.copy(floor.group.matrixWorld).invert());
    const half = THREE.MathUtils.clamp(PERSON_PICK.minPixels / 2 * this.unitsPerPixel, PERSON_PICK.half, PERSON_PICK.maxHalf);
    const halfHeight = Math.max(PERSON_PICK.halfHeight, half);
    let nearest = Infinity, picked: string | null = null;
    for (let i = 0; i < floor.agents.length; i++) {
      const agent = floor.agents[i]!, p = floor.points[i]!;
      if (agent.showCharacter === false) continue;
      this.pickBox.min.set(p.x - half, PERSON_PICK.centerY - halfHeight, p.z - PERSON_PICK.backZ - half);
      this.pickBox.max.set(p.x + half, PERSON_PICK.centerY + halfHeight, p.z - PERSON_PICK.backZ + half);
      if (!ray.intersectBox(this.pickBox, this.pickPoint)) continue;
      const distance = this.pickPoint.distanceToSquared(ray.origin);
      if (distance < nearest) { nearest = distance; picked = agent.id; }
    }
    return picked;
  }
  /** Emphasises one floor with a navy slab edge and lightly hazes every other floor; null or an unknown id clears the focus. */
  focusFloor(projectId: string | null) {
    const next = projectId && this.floors.has(projectId) ? projectId : '';
    if (next === this.focusId) return;
    this.focusId = next;
    if (this.applyFocus()) this.refreshDetail();
  }
  /**
   * PageUp (+1) and PageDown (-1): move the focus by whole storeys from `from` (a rail button's floor), else the focus
   * or camera floor, else from the stack's end.
   */
  stepFocus(step: number, from?: string): string | null {
    const move = Number.isFinite(step) ? Math.trunc(step) : 0;
    if (!move || !this.order.length) return this.focusId || null;
    const base = from && this.floors.has(from) ? from : this.focusId || this.selected;
    const current = this.order.findIndex(floor => floor.id === base);
    const last = this.order.length - 1;
    const index = current < 0 ? move > 0 ? 0 : last : THREE.MathUtils.clamp(current + move, 0, last);
    this.focusFloor(this.order[index]!.id);
    return this.focusId || null;
  }
  /** Floors that just became detailed get their people, rings and rigs placed without advancing time or flights. */
  private refreshDetail() { this.update(0, true, false, this.unitsPerPixel); }
  /** Applies detail bands, haze, focus edge and rail state; returns true when a compressed floor became detailed. */
  private applyFocus() {
    const rail = this.order.length >= RAIL_MIN_FLOORS;
    const centerId = this.focusId || this.selected;
    const center = rail ? this.order.findIndex(floor => floor.id === centerId) : -1;
    let revealed = false;
    for (let i = 0; i < this.order.length; i++) {
      const floor = this.order[i]!;
      const detailed = !rail || center >= 0 && Math.abs(i - center) <= DETAIL_RADIUS;
      if (detailed !== floor.detailed) {
        floor.detailed = detailed; revealed ||= detailed; floor.drawnRoster = -1;
        for (const mesh of floor.detailMeshes) mesh.visible = detailed;
        floor.label.dataset.detail = String(detailed);
      }
      const dimmed = !!this.focusId && floor.id !== this.focusId;
      if (dimmed !== floor.dimmed) this.hazeFloor(floor, dimmed);
      const focused = String(floor.id === this.focusId);
      if (floor.label.dataset.focused !== focused) floor.label.dataset.focused = focused;
      // The plate names what its click does: pick the floor first, open the office once it is the focus floor.
      const action = floor.id === this.focusId ? '사무실 보기' : '층 선택';
      const aria = `${i + 1}층 ${floor.name} ${action} · ${spokenSummary(floor.counts)}`;
      if (floor.label.getAttribute('aria-label') !== aria) floor.label.setAttribute('aria-label', aria);
    }
    this.paintShellFocus();
    this.syncRail();
    return revealed;
  }
  private hazeFloor(floor: Floor, dimmed: boolean) {
    floor.dimmed = dimmed; floor.label.dataset.dimmed = String(dimmed);
    for (const child of floor.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const material = child.material;
      if (child.userData.clearMaterial && !dimmed) {
        child.material = child.userData.clearMaterial; delete child.userData.clearMaterial; continue;
      }
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (floor.materials.includes(material)) {
        // Tint materials belong to this floor, so the haze changes their uniforms in place.
        material.emissive.copy(dimmed ? HAZE : NO_HAZE); material.emissiveIntensity = dimmed ? HAZE_INTENSITY : 1;
      } else if (dimmed) {
        child.userData.clearMaterial = material; child.material = this.hazedMaterial(material);
      }
    }
  }
  /** One hazed twin per shared colour material, made on the first focus change and reused until teardown. */
  private hazedMaterial(material: THREE.MeshStandardMaterial) {
    let hazed = this.hazedMaterials.get(material);
    if (!hazed) {
      hazed = material.clone(); hazed.emissive.copy(HAZE); hazed.emissiveIntensity = HAZE_INTENSITY;
      this.hazedMaterials.set(material, hazed);
    }
    return hazed;
  }
  /**
   * Shell storeys follow the focus: the focus floor gets its opaque navy edge band and every other storey's parts, solid
   * and see-through, fade toward the haze. Runs only when the focus or the shell layout changes, never per frame.
   */
  private paintShellFocus() {
    const index = this.order.findIndex(floor => floor.id === this.focusId);
    const relaid = this.paintedFocus.version !== this.shellVersion;
    if (!relaid && this.paintedFocus.index === index) return;
    this.paintedFocus.version = this.shellVersion; this.paintedFocus.index = index;
    this.placeFocusEdge(this.order[index]);
    // A fresh layout already holds the plain colours.
    if (relaid && index < 0) return;
    this.hazeStoreys(this.structure, this.structureBase, this.storeySlots, this.roofSlot, index);
    this.hazeStoreys(this.ceilings, this.ceilingBase, this.ceilingSlots, this.ceilingRoofSlot, index);
  }
  /** The focus floor's front and side edge bands in navy, just proud of its own bands; nothing without a focus. */
  private placeFocusEdge(floor: Floor | undefined) {
    const mesh = this.focusEdge;
    let slot = 0;
    if (floor) edgeBands(floor.width, floor.depth, floor.level, FOCUS_EDGE_GROW, (x, y, z, sx, sy, sz) => this.place(mesh, slot++, x, y, z, sx, sy, sz));
    mesh.count = slot; mesh.instanceMatrix.needsUpdate = true;
  }
  /** Moves every storey's instance colours the haze share toward the sky, except on the focus storey; roof parts keep theirs. */
  private hazeStoreys(mesh: THREE.InstancedMesh, base: Float32Array, starts: readonly number[], roof: number, focus: number) {
    const colors = mesh.instanceColor;
    if (!colors) return;
    const target = colors.array as Float32Array, haze = [HAZE.r, HAZE.g, HAZE.b];
    for (let storey = 0; storey < starts.length; storey++) {
      const start = starts[storey]!, end = Math.min(starts[storey + 1] ?? roof, mesh.count), hazed = focus >= 0 && storey !== focus;
      for (let slot = start; slot < end; slot++) {
        for (let channel = 0; channel < 3; channel++) {
          const plain = base[slot * 3 + channel]!;
          target[slot * 3 + channel] = hazed ? plain + (haze[channel]! - plain) * HAZE_INTENSITY : plain;
        }
      }
    }
    colors.needsUpdate = true;
  }
  private createRailItem(id: string): RailItem {
    const item = document.createElement('li'); item.className = 'building-rail-floor'; item.dataset.projectId = id;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'building-rail-button';
    const span = (className: string) => { const element = document.createElement('span'); element.className = className; return element; };
    const car = span('building-rail-car'); car.setAttribute('aria-hidden', 'true');
    const number = span('building-rail-number'), name = span('building-rail-name'), counts = span('building-rail-counts');
    const alert = (state: 'approval' | 'error') => {
      const element = span('building-rail-alert');
      element.dataset.state = state; element.dataset.shape = STATUS_STYLE[state].shape;
      // The badge colour comes from the status table; CSS only draws the shape.
      element.style.setProperty('--status', STATUS_STYLE[state].color);
      element.setAttribute('aria-hidden', 'true'); element.hidden = true; return element;
    };
    const approval = alert('approval'), error = alert('error');
    button.append(car, number, name, counts, approval, error); item.append(button);
    button.addEventListener('click', () => { this.focusFloor(id); this.onFocus?.(this.focusId || null); });
    const entry: RailItem = { item, button, number, name, counts, approval, error, key: '' };
    this.railItems.set(id, entry); return entry;
  }
  /**
   * Elevator floor rail for tall buildings: top floor first under a reversed list, the focus floor marked as current,
   * detailed floors with exact counts, compressed floors with only their approval and error marks.
   */
  private syncRail() {
    const active = this.order.length >= RAIL_MIN_FLOORS;
    const live = new Set(active ? this.order.map(floor => floor.id) : []);
    for (const [id, entry] of this.railItems) if (!live.has(id)) { entry.item.remove(); this.railItems.delete(id); }
    if (!active) { this.rail.hidden = true; this.rail.remove(); return; }
    // Roving tab stop: one rail button (focus floor, else camera floor, else the top floor) is in the tab order.
    const tabStop = this.focusId || (this.floors.has(this.selected) ? this.selected : this.order.at(-1)!.id);
    for (let i = 0; i < this.order.length; i++) {
      const floor = this.order[i]!, focused = floor.id === this.focusId;
      const entry = this.railItems.get(floor.id) ?? this.createRailItem(floor.id);
      const key = JSON.stringify([i, floor.name, floor.counts, floor.detailed, focused, floor.id === tabStop]);
      if (entry.key === key) continue;
      entry.key = key;
      entry.button.setAttribute('tabindex', floor.id === tabStop ? '0' : '-1');
      entry.item.dataset.detail = String(floor.detailed); entry.item.dataset.focused = String(focused);
      entry.number.textContent = `${i + 1}F`; entry.name.textContent = floor.name; entry.button.title = floor.name;
      entry.counts.textContent = floor.detailed ? floorSummary(floor.counts) : ''; entry.counts.hidden = !floor.detailed;
      entry.approval.textContent = String(floor.counts.approval); entry.approval.hidden = !floor.counts.approval;
      entry.error.textContent = String(floor.counts.error); entry.error.hidden = !floor.counts.error;
      entry.button.setAttribute('aria-label', `${i + 1}층 ${floor.name}${focused ? ' · 선택한 층' : ''} · ${spokenSummary(floor.counts)}`);
      if (focused) entry.button.setAttribute('aria-current', 'true'); else entry.button.removeAttribute('aria-current');
    }
    const items = Array.from(this.rail.children), count = this.order.length;
    if (items.length !== count || items.some((element, i) => element !== this.railItems.get(this.order[count - 1 - i]!.id)!.item)) {
      const active = Array.from(this.railItems.values()).find(entry => entry.button === document.activeElement)?.button;
      for (let i = count - 1; i >= 0; i--) this.rail.append(this.railItems.get(this.order[i]!.id)!.item);
      // Moving a focused button would drop keyboard focus; restore it on the same floor.
      active?.focus({ preventScroll: true });
    }
    if (this.rail.parentNode !== this.container) this.container.append(this.rail);
    this.rail.hidden = !this.group.visible;
  }
  sendPaperPlane(from: string, to: string, eventId: string) {
    return this.startPaperFlight(from, to, eventId);
  }
  sendMessagePlane(agentId: string, eventId: string) {
    return this.startPaperFlight(agentId, agentId, eventId, true);
  }
  private startPaperFlight(from: string, to: string, eventId: string, localMessage = false) {
    const start = this.anchors.get(from), end = this.anchors.get(to);
    if (!start || !end || !localMessage && from === to || this.seen.has(eventId) || this.flights.length >= 32) return false;
    const normal = new THREE.Vector3(0, 0, 1);
    const occupied = new Set(this.flights.map(flight => flight.lane));
    let lane = 0; while (occupied.has(lane)) lane++;
    const curve = localMessage ? paperPlaneMessageCurve(start, normal, lane)
      : paperPlaneCurve(start, end, normal, normal, lane);
    const plane = foldedPaperPlane(); plane.position.copy(start); plane.scale.setScalar(paperPlaneScale(0));
    if (localMessage) plane.name = 'message-paper-plane';
    // One trail buffer per flight, rewritten in place every frame.
    const trailPositions = new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < TRAIL_POINTS; i++) trailPositions.setXYZ(i, start.x, start.y, start.z);
    const trailGeometry = new THREE.BufferGeometry(); trailGeometry.setAttribute('position', trailPositions);
    const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: '#3987b0', transparent: true, opacity: .65, depthTest: false }));
    trail.renderOrder = 4; trail.frustumCulled = false; plane.renderOrder = 5;
    this.group.add(plane, trail);
    this.flights.push({ from, to, plane, trail, trailPositions, curve, lane, elapsed: 0,
      duration: localMessage ? 2.8 : THREE.MathUtils.clamp(start.distanceTo(end) / 7, 6, 9) });
    this.seen.add(eventId); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
  private updateCharacter(floor: Floor, agent: BuildingEmployee, i: number, p: THREE.Vector3) {
    const visible = agent.showCharacter !== false;
    if (floor.characterVisibility[i] === visible) return;
    floor.characterVisibility[i] = visible;
    const scale = visible ? 1 : 0;
    // Only the person leaves the view. Their desk and observed message endpoints keep the same seat.
    this.place(floor.bodies, i, p.x, 1.23, p.z, .38 * scale, .5 * scale, .3 * scale);
    this.place(floor.heads, i, p.x, 1.96, p.z - .04, .38 * scale, .4 * scale, .37 * scale);
    this.place(floor.hair, i, p.x, 2.01, p.z, .4 * scale, .41 * scale, .39 * scale);
    for (let side = -1; side <= 1; side += 2) {
      this.place(floor.knees, i * 2 + (side === 1 ? 1 : 0), p.x + side * .18, .65, p.z - .35,
        .23 * scale, .8 * scale, .24 * scale, -.22);
    }
    floor.bodies.instanceMatrix.needsUpdate = true; floor.heads.instanceMatrix.needsUpdate = true;
    floor.hair.instanceMatrix.needsUpdate = true; floor.knees.instanceMatrix.needsUpdate = true;
  }
  /** Approval diamonds and error pins: static, and drawn on detailed and compressed floors alike. */
  private updateMarkers(floor: Floor, agent: BuildingEmployee, i: number, p: THREE.Vector3) {
    const shown = agent.showCharacter !== false, approval = agent.status === 'approval', error = agent.status === 'error';
    const unitsPerPixel = this.unitsPerPixel;
    const diamond = shown && approval ? minimumScale(unitsPerPixel, DIAMOND_EXTENT) : 0;
    this.place(floor.activityHeads, i, p.x, MARKER_BASE_Y + .3 * diamond, p.z, .19 * diamond, .3 * diamond, .19 * diamond);
    floor.activityHeads.setColorAt(i, DIAMOND_COLOR);
    const pin = shown && error ? .5 * minimumScale(unitsPerPixel, PIN_EXTENT) : 0;
    this.place(floor.activityPins, i, p.x, MARKER_BASE_Y + .32 * pin, p.z, pin, pin, pin, 0, BUILDING_VIEW.yaw);
    floor.activityPins.setColorAt(i, WHITE);
  }
  private updateActivity(floor: Floor, agent: BuildingEmployee, i: number, p: THREE.Vector3, still: boolean, pulsing: boolean) {
    const shown = agent.showCharacter !== false;
    const working = activeWork(agent.status), approval = agent.status === 'approval', error = agent.status === 'error';
    const visible = shown && (working || error || approval);
    const unitsPerPixel = this.unitsPerPixel;
    const ringPulse = working && pulsing ? Math.sin(this.time * 2.2 + i * 1.7) * .035 : 0;
    const ring = shown && working ? (1 + ringPulse) * minimumScale(unitsPerPixel, RING_EXTENT) : 0;
    // Working keeps the solid ring; thinking and reviewing wear the dashed ring of the status table.
    const dashed = dashedStatus(agent.status);
    const solid = dashed ? 0 : ring, dashes = dashed ? ring : 0;
    this.place(floor.activityRings, i, p.x, RING_Y, p.z - .05, solid * .94, solid * .8, solid, -Math.PI / 2);
    floor.activityRings.setColorAt(i, RING_COLOR);
    this.place(floor.activityDashes, i, p.x, RING_Y, p.z - .05, dashes * .94, dashes * .8, dashes, -Math.PI / 2);
    floor.activityDashes.setColorAt(i, DASHED_COLOR);
    this.updateMarkers(floor, agent, i, p);

    // Clearing the fixed slots prevents the previous rig surviving a kind change or ended task.
    for (let j = 0; j < WORK_BOXES; j++) this.place(floor.workBoxes, i * WORK_BOXES + j, 0, 0, 0, 0, 0, 0);
    for (let j = 0; j < WORK_SPHERES; j++) this.place(floor.workSpheres, i * WORK_SPHERES + j, 0, 0, 0, 0, 0, 0);
    for (let j = 0; j < WORK_HOOPS; j++) this.place(floor.workHoops, i * WORK_HOOPS + j, 0, 0, 0, 0, 0, 0);
    if (!visible) return;
    const parts = WORK_PARTS[agent.activityKind ?? 'general'] ?? WORK_PARTS.general;
    let boxes = 0, spheres = 0, hoops = 0;
    for (let j = 0; j < parts.length; j++) {
      const piece = parts[j]!;
      const mesh = piece.shape === 'box' ? floor.workBoxes : piece.shape === 'sphere' ? floor.workSpheres : floor.workHoops;
      const index = piece.shape === 'box' ? i * WORK_BOXES + boxes++ : piece.shape === 'sphere' ? i * WORK_SPHERES + spheres++ : i * WORK_HOOPS + hoops++;
      const phase = working && !still ? this.time * 2.8 + i * 1.7 : 0;
      const beat = Math.sin(phase);
      const x = p.x + 1.03 + piece.point[0]! + (piece.motion === 'slide' ? beat * .15 : 0);
      const y = 1.34 + piece.point[1]! + (piece.motion === 'float' ? beat * .055 : 0);
      const z = p.z - 1.03 + piece.point[2]!;
      const spin = piece.motion === 'spin' ? phase * .55 : 0;
      const tilt = piece.motion === 'tilt' ? beat * .16 : 0;
      this.place(mesh, index, x, y, z, piece.size[0]!, piece.size[1]!, piece.size[2]!,
        piece.shape === 'hoop' ? piece.rotation : 0, spin, piece.shape === 'hoop' ? 0 : (piece.rotation ?? 0) + tilt);
      mesh.setColorAt(index, piece.color);
    }
  }
  update(delta: number, paused: boolean, reduced: boolean, unitsPerPixel = .05) {
    this.unitsPerPixel = Number.isFinite(unitsPerPixel) && unitsPerPixel > 0 ? unitsPerPixel : .05;
    const still = reduced || this.powerSaving;
    if (!paused && !still) this.time += delta;
    const pulsing = !still && this.agentTotal <= LARGE_BUILDING_AGENTS;
    const units = this.unitsPerPixel, roster = this.rosterVersion;
    for (let f = 0; f < this.order.length; f++) {
      const floor = this.order[f]!;
      // Instances are rewritten and uploaded only when zoom or the roster changed, or while a detailed working floor moves.
      const time = floor.detailed && floor.animated && !still ? this.time : -1;
      if (floor.drawnUnits === units && floor.drawnRoster === roster && floor.drawnTime === time) continue;
      floor.drawnUnits = units; floor.drawnRoster = roster; floor.drawnTime = time;
      if (!floor.detailed) {
        // Hidden furniture, people and work rigs are not rewritten; only the attention markers follow zoom.
        for (let i = 0; i < floor.agents.length; i++) this.updateMarkers(floor, floor.agents[i]!, i, floor.points[i]!);
        floor.activityHeads.instanceMatrix.needsUpdate = true; floor.activityPins.instanceMatrix.needsUpdate = true;
        if (floor.activityHeads.instanceColor) floor.activityHeads.instanceColor.needsUpdate = true;
        if (floor.activityPins.instanceColor) floor.activityPins.instanceColor.needsUpdate = true;
        continue;
      }
      for (let i = 0; i < floor.agents.length; i++) {
        const agent = floor.agents[i]!, p = floor.points[i]!;
        this.updateCharacter(floor, agent, i, p);
        const scale = agent.showCharacter === false ? 0 : 1;
        const work = activeWork(agent.status) && !still;
        for (let side = -1; side <= 1; side += 2) {
          const beat = work ? Math.sin(this.time * 9 + i * 1.7 + side) * .055 : 0;
          this.place(floor.arms, i * 2 + (side === 1 ? 1 : 0), p.x + side * .38, 1.32 + beat, p.z - .43,
            .17 * scale, .17 * scale, .65 * scale, beat);
        }
        floor.screens.setColorAt(i, busy(agent.status) ? SCREEN_BUSY : SCREEN_IDLE);
        this.updateActivity(floor, agent, i, p, still, pulsing);
      }
      floor.arms.instanceMatrix.needsUpdate = true;
      if (floor.screens.instanceColor) floor.screens.instanceColor.needsUpdate = true;
      for (let m = 0; m < floor.activityMeshes.length; m++) {
        const mesh = floor.activityMeshes[m]!;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    for (let index = this.flights.length - 1; index >= 0; index--) {
      const flight = this.flights[index]!;
      if (!paused) flight.elapsed += delta;
      const t = Math.min(1, flight.elapsed / flight.duration);
      if (reduced) { this.removeFlight(flight); continue; }
      flight.curve.getPoint(t, flight.plane.position);
      flight.plane.quaternion.setFromUnitVectors(FORWARD, flight.curve.getTangent(t, this.tangent).normalize());
      flight.plane.scale.setScalar(paperPlaneScale(unitsPerPixel));
      for (let point = 0; point < TRAIL_POINTS; point++) {
        flight.curve.getPoint(Math.max(0, t - .16 + .16 * point / (TRAIL_POINTS - 1)), this.trailPoint);
        flight.trailPositions.setXYZ(point, this.trailPoint.x, this.trailPoint.y, this.trailPoint.z);
      }
      flight.trailPositions.needsUpdate = true;
      if (t === 1) this.removeFlight(flight);
    }
  }
  /**
   * Nameplates (decisions 27, 34, 43) stand in one column just right of the storeys' outer right side wall, so no plate covers
   * a storey's desks or people. Neighbouring plates are pushed apart only as far as needed not to overlap. Plates keep the full
   * form with exact counts unless full plates would move too far from their floors or pass the free area's right edge
   * (`area.right`, CSS px from the stage's right edge). Compact plates that would still move too far are thinned to every few
   * storeys at any building height, so no plate stands beside another storey (the floor list names every floor); thinning keeps
   * the plates that matter most (see `pickPlates`). All shown plates share one form: full, compact with names cut to the free
   * area, or only floor numbers.
   */
  updateLabels(camera: THREE.Camera, width: number, height: number, area?: { top: number; right: number; bottom: number; left: number }) {
    const floors = this.order, count = floors.length;
    if (this.plateSlots.length < count) {
      this.plateSlots = new Int32Array(count); this.plateSums = new Float64Array(count); this.plateSizes = new Int32Array(count);
      this.plateKeep = new Uint8Array(count); this.plateWas = new Uint8Array(count);
    }
    // The column starts right of the footprint's rightmost corner (outer wall face), whatever the orbit.
    let column = -Infinity;
    const halfWidth = this.bounds.max.x + PLATE_WALL_OUTSET, halfDepth = this.bounds.max.z;
    for (let corner = 0; corner < 4; corner++) {
      this.projected.set(corner & 1 ? halfWidth : -halfWidth, this.center.y, corner & 2 ? halfDepth : -halfDepth).project(camera);
      column = Math.max(column, (this.projected.x * .5 + .5) * width);
    }
    let shown = 0, minGap = Infinity;
    for (let i = 0; i < count; i++) {
      const floor = floors[i]!, projected = this.projected.copy(floor.anchor).project(camera);
      // Compressed floors of a tall building are listed on the rail instead of carrying a floating plate.
      floor.onScreen = this.group.visible && floor.detailed && projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
      floor.screenX = (projected.x * .5 + .5) * width; floor.screenY = (-projected.y * .5 + .5) * height;
      if (!floor.onScreen) continue;
      if (shown) minGap = Math.min(minGap, Math.abs(floors[this.plateSlots[shown - 1]!]!.screenY - floor.screenY));
      this.plateWas[shown] = floor.label.hidden ? 0 : 1;
      this.plateSlots[shown++] = i;
    }
    const x = Math.round((column + PLATE.gap) * 10) / 10, right = width - Math.max(0, area?.right ?? 0);
    const limit = shown > 1 ? PLATE.shiftShare * minGap : 0;
    const wasCompact = this.compact, wasThinned = this.plateStride > 1;
    const fullNeed = PLATE.fullHeight + PLATE.spacing, compactNeed = PLATE.compactHeight + PLATE.spacing;
    let fullFits = shown > 0;
    for (let s = 0; s < shown && fullFits; s++) fullFits = x + floors[this.plateSlots[s]!]!.plateWidth <= right - (wasCompact ? PLATE.returnMargin : 0);
    if (fullFits) fullFits = this.spacePlates(shown, fullNeed, false) <= limit * (wasCompact ? PLATE.returnShare : 1);
    const compact = !fullFits;
    let stride = 1;
    if (compact && this.spacePlates(shown, compactNeed, false) > limit * (wasThinned ? PLATE.returnShare : 1) && shown > 2) {
      // The fewest storeys between shown plates that keeps them apart. A thinned stack keeps its stride until a smaller one fits
      // with `returnShare` to spare, so the drift does not switch plates on and off at a boundary.
      const gap = Math.max(1, minGap), crowded = Math.ceil(compactNeed / gap), roomy = Math.ceil(compactNeed / (gap * PLATE.returnShare));
      stride = Math.min(shown - 1, Math.max(2, crowded, wasThinned ? Math.min(this.plateStride, roomy) : 2));
      this.pickPlates(shown, stride, wasThinned);
      this.spacePlates(shown, compactNeed, true);
    }
    // Every shown plate takes one form. A compact name that would pass the free area's right edge is cut with an ellipsis; once
    // some shown plate could not keep even its shortest cut name (a narrow phone), every plate shows only its floor number rather
    // than moving over the storey or under the side HUD. A narrow stage, whose project selector names the floor, cuts no name:
    // there a name that does not fit whole turns every plate to its number (decision 57). Names stay in each plate's title and
    // accessible name.
    const room = right - x, cuts = width >= PLATE.nameCutMinWidth;
    let tight = false, cut = false;
    for (let s = 0; s < shown && compact && !tight; s++) {
      const floor = floors[this.plateSlots[s]!]!;
      if (!floor.plateShown) continue;
      tight = room - (this.tight ? PLATE.returnMargin : 0) < (cuts ? floor.plateLeastWidth : floor.plateCompactWidth);
      cut ||= room < floor.plateCompactWidth;
    }
    // The cut is written in whole px and only while some shown name needs it, so the drift seldom rewrites the style (a
    // max-width change invalidates the layout even where every name fits).
    const maxWidth = compact && !tight && cut ? Math.max(0, Math.floor(room)) : 0;
    const compactValue = compact ? 'true' : 'false', tightValue = tight ? 'true' : 'false';
    const compactChanged = compact !== this.compact; this.compact = compact; this.tight = tight; this.plateStride = stride;
    for (let i = 0; i < count; i++) {
      const floor = floors[i]!, label = floor.label, hide = !floor.onScreen || !floor.plateShown;
      if (hide !== label.hidden) {
        // A plate that holds keyboard focus hands it to its rail button before it hides (a floor leaving the detail band).
        if (hide && label === document.activeElement) this.railItems.get(floor.id)?.button.focus({ preventScroll: true });
        label.hidden = hide;
      }
      const selected = floor.id === this.selected ? 'true' : 'false';
      if (label.dataset.selected !== selected) label.dataset.selected = selected;
      if (compactChanged || label.dataset.compact !== compactValue) label.dataset.compact = compactValue;
      if (label.dataset.tight !== tightValue) label.dataset.tight = tightValue;
      if (hide) continue;
      const y = Math.round(floor.plateY * 10) / 10;
      if (x !== floor.labelX || y !== floor.labelY) {
        floor.labelX = x; floor.labelY = y;
        label.style.transform = `translate(${x}px, ${y}px) translate(0, -50%)`;
      }
      if (floor.plateMaxWidth !== maxWidth) { floor.plateMaxWidth = maxWidth; label.style.maxWidth = maxWidth ? `${maxWidth}px` : ''; }
    }
  }
  /**
   * Chooses the plates a thinned stack shows, at least `stride` visible storeys apart, in priority order: the plate holding
   * keyboard focus, the focus floor, the selected floor, floors with an error, floors awaiting approval, the top and ground
   * storeys, then (while the stack was already thinned) plates shown last layout, then the rest from the top down. Keeping the
   * previous plates never shows fewer plates than a fresh choice. The choice depends on the stride, floor states and the previous
   * choice only, so drift and zoom jitter within a stride change nothing.
   */
  private pickPlates(shown: number, stride: number, keepPrevious: boolean) {
    const fresh = this.selectPlates(shown, stride, false);
    if (keepPrevious && this.selectPlates(shown, stride, true) < fresh) this.selectPlates(shown, stride, false);
  }
  /** Fills the kept plates for `pickPlates`, with or without the tier of plates shown last layout; returns how many it keeps. */
  private selectPlates(shown: number, stride: number, previous: boolean): number {
    const floors = this.order, slots = this.plateSlots, keep = this.plateKeep, was = this.plateWas, active = document.activeElement;
    keep.fill(0, 0, shown);
    let kept = 0;
    for (let tier = 0; tier < 8; tier++) {
      if (tier === 6 && !previous) continue;
      for (let s = shown - 1; s >= 0; s--) {
        if (keep[s]) continue;
        const floor = floors[slots[s]!]!;
        const wanted = tier === 0 ? floor.label === active : tier === 1 ? floor.id === this.focusId : tier === 2 ? floor.id === this.selected
          : tier === 3 ? floor.counts.error > 0 : tier === 4 ? floor.counts.approval > 0 : tier === 5 ? s === shown - 1 || s === 0
            : tier === 6 ? was[s] === 1 : true;
        if (!wanted) continue;
        let free = true;
        for (let near = Math.max(0, s - stride + 1), end = Math.min(shown, s + stride); near < end && free; near++) free = keep[near] === 0;
        if (free) { keep[s] = 1; kept++; }
      }
    }
    return kept;
  }
  /**
   * Places the visible plates (all, or with `thinned` those `pickPlates` kept) as close to their floors as they can while
   * neighbouring plate centres stay `need` px apart, and marks the others hidden. Upper storeys draw higher (smaller y), so
   * y[j] + j * need must never increase; pooling adjacent violating blocks gives the least-squares positions. Returns the
   * largest move in px.
   */
  private spacePlates(shown: number, need: number, thinned: boolean): number {
    const floors = this.order, slots = this.plateSlots, sums = this.plateSums, sizes = this.plateSizes, keep = this.plateKeep;
    let blocks = 0, placed = 0;
    for (let s = 0; s < shown; s++) {
      const floor = floors[slots[s]!]!;
      floor.plateShown = !thinned || keep[s] === 1;
      if (!floor.plateShown) continue;
      sums[blocks] = floor.screenY + placed++ * need; sizes[blocks++] = 1;
      while (blocks > 1 && sums[blocks - 2]! / sizes[blocks - 2]! < sums[blocks - 1]! / sizes[blocks - 1]!) {
        sums[blocks - 2] = sums[blocks - 2]! + sums[blocks - 1]!; sizes[blocks - 2] = sizes[blocks - 2]! + sizes[blocks - 1]!; blocks--;
      }
    }
    let shift = 0, block = 0, left = blocks ? sizes[0]! : 0;
    placed = 0;
    for (let s = 0; s < shown; s++) {
      const floor = floors[slots[s]!]!;
      if (!floor.plateShown) continue;
      while (left === 0) left = sizes[++block]!;
      floor.plateY = sums[block]! / sizes[block]! - placed++ * need;
      shift = Math.max(shift, Math.abs(floor.plateY - floor.screenY));
      left--;
    }
    return shift;
  }
  private removeFlight(flight: Flight) {
    flight.plane.removeFromParent(); flight.trail.removeFromParent(); flight.trail.geometry.dispose();
    flight.plane.traverse(object => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    });
    (flight.trail.material as THREE.Material).dispose(); this.flights.splice(this.flights.indexOf(flight), 1);
  }
  private removeFloor(floor: Floor) {
    floor.group.removeFromParent(); floor.label.remove();
    floor.group.traverse(object => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
    for (const material of floor.materials) material.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const flight of [...this.flights]) this.removeFlight(flight);
    for (const floor of this.floors.values()) this.removeFloor(floor);
    this.floors.clear(); this.order.length = 0; this.anchors.clear(); this.group.removeFromParent(); this.shell.removeFromParent();
    this.rail.remove(); this.railItems.clear();
    for (const material of this.hazedMaterials.values()) material.dispose(); this.hazedMaterials.clear();
    for (const mesh of [this.structure, this.windows, this.glass, this.ceilings, this.focusEdge, this.bushes]) mesh.dispose();
    this.ground.geometry.dispose(); this.signText.geometry.dispose(); this.signTexture?.dispose();
    if (this.signTexture) (this.signText.material as THREE.Material).dispose();
    this.shell.clear();
    for (const material of [this.structureMaterial, this.windowMaterial, this.glassMaterial, this.ceilingMaterial, this.focusEdgeMaterial, this.bushMaterial,
      ...this.groundMaterials]) material.dispose();
    this.box.dispose(); this.sphere.dispose(); this.hair.dispose(); this.hoop.dispose(); this.ring.dispose(); this.dashedRing.dispose(); this.diamond.dispose(); this.pin.dispose();
    for (const material of this.materials.values()) material.dispose(); this.materials.clear();
    for (const material of this.ceilingSlabMaterials.values()) material.dispose(); this.ceilingSlabMaterials.clear();
  }
}
