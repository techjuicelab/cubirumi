import type { ActivityKind } from './protocol.ts';

export type WorkObservation = { id: string; taskId?: string; status: string; activityKind?: ActivityKind };
export const WORK_HOLD_SECONDS = 4;
export const WORK_CHANGE_SECONDS = 2.6;
export const WORK_STOW_SECONDS = .65;
export const isWorkingStatus = (status: string): boolean => ['working', 'thinking', 'reviewing'].includes(status);

/** A visual grouping of observed actions, never a guess at a task's purpose or completion. */
export class WorkActivity {
  private identity = '';
  private taskId?: string;
  private status = 'idle';
  private main: ActivityKind | null = null;
  private auxiliary: ActivityKind | null = null;
  private mainSince = 0;
  private auxiliarySince = 0;
  private stoppedAt = -Infinity;

  observe(input: WorkObservation, now: number): void {
    const replaced = input.id !== this.identity || Boolean(input.taskId && this.taskId && input.taskId !== this.taskId);
    if (replaced) { this.main = null; this.auxiliary = null; this.status = 'idle'; }
    this.identity = input.id;
    this.taskId = input.taskId;
    const wasWorking = isWorkingStatus(this.status);
    const working = isWorkingStatus(input.status);
    if (!working) {
      if (wasWorking || replaced) this.stoppedAt = now;
      this.auxiliary = null;
      this.status = input.status;
      return;
    }
    this.status = input.status;
    const kind = input.activityKind ?? 'general';
    if (!wasWorking || !this.main || kind === 'general' || this.main === 'general') {
      if (this.main !== kind || !wasWorking) this.mainSince = now;
      this.main = kind; this.auxiliary = null;
    } else if (kind === this.main) this.auxiliary = null;
    else if (kind !== this.auxiliary) { this.auxiliary = kind; this.auxiliarySince = now; }
  }

  frame(now: number, reducedMotion = false) {
    const working = isWorkingStatus(this.status);
    if (working && this.auxiliary && now - this.mainSince >= WORK_HOLD_SECONDS
      && now - this.auxiliarySince >= WORK_CHANGE_SECONDS) {
      this.main = this.auxiliary; this.mainSince = now; this.auxiliary = null;
    }
    const error = this.status === 'error';
    const amount = working || error ? 1 : reducedMotion ? 0 : Math.max(0, 1 - (now - this.stoppedAt) / WORK_STOW_SECONDS);
    return { main: amount > 0 ? this.main : null, auxiliary: working ? this.auxiliary : null,
      amount, working, waiting: this.status === 'thinking' || this.status === 'reviewing', error,
      stopped: !working, mainSince: this.mainSince };
  }
}
