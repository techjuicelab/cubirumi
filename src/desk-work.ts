import * as THREE from 'three';
import { WorkActivity, type WorkObservation } from './work-activity.ts';
import { WorkProps, type WorkKind } from './work-props.ts';
import { isExternalCall } from './status-style.ts';
import type { ActivityKind } from './protocol.ts';

type Slot = { kind: WorkKind; props: WorkProps; since: number; exitScale?: number };
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Lazily mounts at most two desk props and a short outgoing transition. */
export class DeskWork {
  readonly group = new THREE.Group();
  readonly activity = new WorkActivity();
  private primary?: Slot;
  private secondary?: Slot;
  private outgoing?: Slot;
  private seed = 0;
  private identity = '';
  private taskId?: string;
  // While an external (MCP) call runs, work time stands still: the props wait where they are and resume without a jump.
  private holdStartedAt: number | null = null;
  private heldSeconds = 0;
  private heldKind?: ActivityKind;
  private heldWaiting = false;

  constructor() { this.group.name = 'desk-work'; }

  /** True while the observed employee is on an external call. */
  get onHold(): boolean { return this.holdStartedAt !== null; }

  /** Scene seconds minus every interval spent on a call; frozen during one. */
  private workTime(now: number): number {
    return (this.holdStartedAt ?? now) - this.heldSeconds;
  }

  observe(input: WorkObservation & { toolName?: string }, now: number): void {
    const replaced = this.identity !== input.id || Boolean(input.taskId && this.taskId && input.taskId !== this.taskId);
    if (replaced) {
      // A new person never inherits the previous occupant's call: that hold ends here and any new one starts below.
      if (this.holdStartedAt !== null) { this.heldSeconds += Math.max(0, now - this.holdStartedAt); this.holdStartedAt = null; }
      this.clear(); this.identity = input.id; this.heldKind = undefined; this.heldWaiting = false;
      this.seed = [...input.id].reduce((seed, c) => (seed * 31 + c.charCodeAt(0)) >>> 0, 0) % 997;
    }
    const calling = isExternalCall(input as Parameters<typeof isExternalCall>[0]);
    const startsHold = calling && this.holdStartedAt === null;
    if (startsHold) {
      // Keep the scene that was on the desk: the call's own action kind must not replace it.
      const frame = this.activity.frame(this.workTime(now));
      this.heldKind = replaced ? undefined : frame.auxiliary ?? frame.main ?? undefined;
      this.heldWaiting = frame.waiting;
      this.holdStartedAt = now;
    } else if (!calling && this.holdStartedAt !== null) {
      this.heldSeconds += Math.max(0, now - this.holdStartedAt);
      this.holdStartedAt = null; this.heldKind = undefined;
    }
    this.taskId = input.taskId;
    const observation = calling && this.heldKind ? { ...input, activityKind: this.heldKind } : input;
    this.activity.observe(observation, this.workTime(now));
    // A newcomer has no desk scene of their own before this observation, so their held pose follows what they report.
    if (startsHold && replaced) this.heldWaiting = this.activity.frame(this.workTime(now)).waiting;
  }

  /** The activity frame on work time, so a call never promotes or stows props early. */
  frame(sceneNow: number, reducedMotion = false) {
    return this.activity.frame(this.workTime(sceneNow), reducedMotion);
  }

  private create(kind: WorkKind, now: number): Slot {
    const props = new WorkProps(kind, this.seed);
    this.group.add(props.group);
    // A scene mounted while a call holds time is shown fully grown, so it neither stays invisible nor pops after the call.
    return { kind, props, since: this.onHold ? now - 1 : now };
  }

  update(sceneNow: number, options: { detail: boolean; reducedMotion: boolean; paused: boolean; away: boolean }) {
    const now = this.workTime(sceneNow);
    const frame = this.activity.frame(now, options.reducedMotion);
    this.group.userData.activityKind = frame.main;
    this.group.userData.auxiliaryKind = frame.auxiliary;
    this.group.userData.onHold = this.onHold;
    this.group.visible = options.detail && !options.away && Boolean(frame.main);
    if (!this.group.visible) { this.clear(); return frame; }
    if (this.primary?.kind !== frame.main) {
      this.outgoing?.props.dispose();
      // With time held, a replaced scene leaves at once instead of freezing half-way out.
      if (this.onHold) this.primary?.props.dispose();
      this.outgoing = this.onHold ? undefined : this.primary;
      if (this.outgoing) { this.outgoing.since = now; this.outgoing.exitScale = this.outgoing.props.group.scale.x; }
      this.primary = frame.main ? this.create(frame.main, now) : undefined;
    }
    if (this.secondary?.kind !== frame.auxiliary) {
      this.secondary?.props.dispose();
      this.secondary = frame.auxiliary ? this.create(frame.auxiliary, now) : undefined;
    }
    // `thinking` follows a tool result and is still active work, not an idle/waiting signal.
    // Keep the established desk scene gently alive between short calls; only actual stops freeze it.
    const settled = frame.stopped || options.paused;
    // A result arriving mid-call (working <-> thinking) must not change the waiting pose's amplitude either.
    const quiet = this.onHold ? this.heldWaiting : frame.waiting;
    if (this.primary) {
      const scale = options.reducedMotion || options.paused ? 1 : smooth((now - this.primary.since) / .5);
      this.primary.props.group.scale.setScalar(scale * frame.amount);
      this.primary.props.update(now, { reducedMotion: options.reducedMotion, waiting: settled, error: frame.error,
        intensity: quiet ? .4 : 1 });
    }
    if (this.secondary) {
      const scale = options.reducedMotion || options.paused ? .48 : .48 * smooth((now - this.secondary.since) / .4);
      this.secondary.props.group.scale.setScalar(scale);
      this.secondary.props.group.position.set(.78, .12, .02);
      this.secondary.props.update(now, { reducedMotion: options.reducedMotion, waiting: settled, error: false,
        intensity: quiet ? .3 : .7 });
    }
    if (this.outgoing) {
      const scale = options.reducedMotion || options.paused ? 0
        : (this.outgoing.exitScale ?? 1) * (1 - smooth((now - this.outgoing.since) / .35));
      this.outgoing.props.group.scale.setScalar(scale);
      if (scale <= 0) { this.outgoing.props.dispose(); this.outgoing = undefined; }
    }
    return frame;
  }

  clear(): void {
    this.primary?.props.dispose(); this.secondary?.props.dispose(); this.outgoing?.props.dispose();
    this.primary = this.secondary = this.outgoing = undefined;
  }
  dispose(): void { this.clear(); this.group.removeFromParent(); }
}
