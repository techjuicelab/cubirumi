export type CinematicView = 'employee' | 'room' | 'building';

/** Angles are additive radians; target components are fractions of the scene's reference span. */
export interface CinematicOffset {
  yaw: number;
  elevation: number;
  zoomScale: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}
export interface CinematicMotionState {
  elapsedSeconds: number;
  heldUntilMs: number;
  offset: CinematicOffset;
}
export interface CinematicMotionFrame {
  kind: CinematicView;
  deltaSeconds: number;
  nowMs: number;
  enabled: boolean;
  paused?: boolean;
  reducedMotion?: boolean;
  interacting?: boolean;
}

export const CINEMATIC_MANUAL_HOLD_MS = 18_000;
export const CINEMATIC_PROFILES = Object.freeze({
  employee: Object.freeze({ yaw: .11, elevation: .052, zoomVariation: .065, targetX: .0025, targetY: .0015, targetZ: .0025, pace: 1 }),
  room: Object.freeze({ yaw: .26, elevation: .10, zoomVariation: .09, targetX: .008, targetY: .0035, targetZ: .008, pace: 1.2 }),
  building: Object.freeze({ yaw: .38, elevation: .15, zoomVariation: .115, targetX: .013, targetY: .006, targetZ: .013, pace: 1.5 }),
});
const MAX_OFFSET = CINEMATIC_PROFILES.building;
const FIELDS = ['yaw', 'elevation', 'zoomScale', 'targetX', 'targetY', 'targetZ'] as const;
const SLEW_PER_SECOND: CinematicOffset = { yaw: .045, elevation: .025, zoomScale: .02, targetX: .0015, targetY: .0008, targetZ: .0015 };
const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
const nonnegative = (value: number): number => Math.max(0, finite(value));
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function neutralCinematicOffset(): CinematicOffset {
  return { yaw: 0, elevation: 0, zoomScale: 1, targetX: 0, targetY: 0, targetZ: 0 };
}
export function createCinematicMotionState(): CinematicMotionState {
  return { elapsedSeconds: 0, heldUntilMs: 0, offset: neutralCinematicOffset() };
}

function boundedOffset(input: CinematicOffset): CinematicOffset {
  return {
    yaw: clamp(finite(input?.yaw), -MAX_OFFSET.yaw, MAX_OFFSET.yaw),
    elevation: clamp(finite(input?.elevation), -MAX_OFFSET.elevation, MAX_OFFSET.elevation),
    zoomScale: clamp(finite(input?.zoomScale, 1), 1 - MAX_OFFSET.zoomVariation, 1 + MAX_OFFSET.zoomVariation),
    targetX: clamp(finite(input?.targetX), -MAX_OFFSET.targetX, MAX_OFFSET.targetX),
    targetY: clamp(finite(input?.targetY), -MAX_OFFSET.targetY, MAX_OFFSET.targetY),
    targetZ: clamp(finite(input?.targetZ), -MAX_OFFSET.targetZ, MAX_OFFSET.targetZ),
  };
}
function cleanState(state: CinematicMotionState): CinematicMotionState {
  return { elapsedSeconds: nonnegative(state?.elapsedSeconds), heldUntilMs: nonnegative(state?.heldUntilMs), offset: boundedOffset(state?.offset) };
}
function wave(seconds: number, firstPeriod: number, secondPeriod: number, phase: number, secondPhase: number): number {
  // Reduce each phase before multiplying to remain finite even for very large clocks.
  return .72 * Math.sin((seconds % firstPeriod) / firstPeriod * Math.PI * 2 + phase)
    + .28 * Math.sin((seconds % secondPeriod) / secondPeriod * Math.PI * 2 + secondPhase);
}

/** A bounded multi-axis trajectory, with independent rhythms instead of a perpetual yaw orbit. */
export function sampleCinematicMotion(kind: CinematicView, elapsedSeconds: number): CinematicOffset {
  const profile = Object.hasOwn(CINEMATIC_PROFILES, kind) ? CINEMATIC_PROFILES[kind] : CINEMATIC_PROFILES.room;
  const seconds = nonnegative(elapsedSeconds);
  const rhythm = (first: number, second: number, phase: number, secondaryPhase: number) =>
    wave(seconds, first * profile.pace, second * profile.pace, phase, secondaryPhase);
  return {
    yaw: profile.yaw * rhythm(57, 91, 0, 1.7),
    elevation: profile.elevation * rhythm(41, 73, .8, -.4),
    zoomScale: 1 + profile.zoomVariation * rhythm(37, 61, -1.1, .5),
    targetX: profile.targetX * rhythm(83, 137, 1.2, -.7),
    targetY: profile.targetY * rhythm(47, 79, -.2, 1.9),
    targetZ: profile.targetZ * rhythm(97, 151, -.9, 2.4),
  };
}

/** Freeze the existing offset: manual input can adjust the base pose without a recentering jump. */
export function holdCinematicMotion(previous: CinematicMotionState, nowMs: number): CinematicMotionState {
  const state = cleanState(previous);
  return { ...state, heldUntilMs: Math.max(state.heldUntilMs, nonnegative(nowMs) + CINEMATIC_MANUAL_HOLD_MS) };
}

/**
 * Keep this state beside the base camera pose. Always compose state.offset for rendering,
 * including while held/disabled, and never add it back into the stored base pose.
 * A frozen clock resumes from its last phase; profile changes ease from the existing offset.
 */
export function stepCinematicMotion(previous: CinematicMotionState, frame: CinematicMotionFrame): CinematicMotionState {
  const state = cleanState(previous);
  if (frame.interacting) return holdCinematicMotion(state, frame.nowMs);
  if (!frame.enabled || frame.paused || frame.reducedMotion || nonnegative(frame.nowMs) < state.heldUntilMs) return state;
  // Background-tab gaps must not advance the camera by an entire unseen shot.
  const delta = Math.min(.25, nonnegative(frame.deltaSeconds));
  if (!delta) return state;
  const elapsedSeconds = state.elapsedSeconds + delta;
  const desired = sampleCinematicMotion(frame.kind, elapsedSeconds);
  const blend = 1 - Math.exp(-delta / 2.8);
  const offset = neutralCinematicOffset();
  for (const field of FIELDS) {
    const change = (desired[field] - state.offset[field]) * blend;
    const limit = SLEW_PER_SECOND[field] * delta;
    offset[field] = state.offset[field] + clamp(change, -limit, limit);
  }
  return { elapsedSeconds, heldUntilMs: state.heldUntilMs, offset };
}
