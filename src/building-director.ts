import type { Agent } from './protocol.ts';
import { connectedAgents, hasVisibleActivity } from './observation.ts';
import { projectKey, sessionKey } from './office-state.ts';

export interface BuildingRoom { projectId: string; sessionId: string }
export interface BuildingShot extends BuildingRoom {
  view: 'overview';
  reason: 'initial' | 'activity' | 'cycle' | 'fairness' | 'quiet';
  focusAfterMs: number;
}
export interface BuildingDirectorOptions {
  now?: number;
  enabled?: boolean;
  scope?: 'building' | 'floor';
  projectId?: string;
  current?: BuildingRoom;
  cycleSeconds?: number;
}
type Room = BuildingRoom & { key: string; active: number };
type Floor = { projectId: string; rooms: Room[]; active: number; age: number };
const roomKey = (room: BuildingRoom) => JSON.stringify([room.projectId, room.sessionId]);
const MIN_DWELL = 12_000;
const ACTIVITY_SETTLE = 3000;

/** Chooses rooms with observed activity. Main owns navigation and OfficeScene owns interpolation. */
export class BuildingDirector {
  private currentKey: string | null = null;
  private currentProject: string | null = null;
  private arrivedAt: number;
  private heldUntil = 0;
  private lastHoldAt = -Infinity;
  private lastDisabledAt = -Infinity;
  private wasEnabled = true;
  private observed = false;
  private floorVisits = 0;
  private activeBefore = new Map<string, number>();
  private becameActive = new Map<string, number>();
  private firstSeen = new Map<string, number>();
  private floorSeen = new Map<string, number>();
  private roomSeen = new Map<string, number>();
  private dueAt: number;

  constructor(now = Date.now()) { this.arrivedAt = now; this.dueAt = now; }
  get nextAt() { return this.dueAt; }

  hold(now = Date.now(), durationMs = 18_000) {
    this.lastHoldAt = now;
    this.heldUntil = Math.max(this.heldUntil, now + Math.max(MIN_DWELL, durationMs));
    this.dueAt = Math.max(this.dueAt, this.heldUntil);
  }

  /** An explicit CCTV restart returns to a wide view; previous floor visits retain their fairness history. */
  reset(now = Date.now()) {
    this.currentKey = null; this.currentProject = null; this.floorVisits = 0;
    this.arrivedAt = now; this.dueAt = now; this.heldUntil = 0; this.wasEnabled = true;
    this.lastHoldAt = -Infinity; this.lastDisabledAt = -Infinity;
  }

  private arrive(room: Room, now: number, cycleMs: number) {
    this.floorVisits = this.currentProject === room.projectId ? this.floorVisits + 1 : 1;
    this.currentKey = room.key; this.currentProject = room.projectId;
    this.arrivedAt = now; this.dueAt = now + cycleMs;
    this.floorSeen.set(room.projectId, now); this.roomSeen.set(room.key, now);
    this.becameActive.delete(room.key);
  }

  private shot(room: Room, now: number, cycleMs: number, reason: BuildingShot['reason']): BuildingShot {
    this.arrive(room, now, cycleMs);
    return { projectId: room.projectId, sessionId: room.sessionId, view: 'overview', reason, focusAfterMs: 5500 };
  }

  next(agents: readonly Agent[], options: BuildingDirectorOptions = {}): BuildingShot | undefined {
    const now = options.now ?? Date.now();
    const seconds = options.cycleSeconds ?? 25;
    const cycleMs = (Number.isFinite(seconds) ? Math.max(15, Math.min(60, seconds)) : 25) * 1000;
    const all = new Map<string, Room>();
    for (const agent of connectedAgents(agents)) {
      const room = { projectId: projectKey(agent), sessionId: sessionKey(agent) };
      const key = roomKey(room), entry = all.get(key) ?? { ...room, key, active: 0 };
      if (hasVisibleActivity(agent)) entry.active++;
      all.set(key, entry);
    }
    for (const room of all.values()) {
      if (!this.firstSeen.has(room.projectId)) this.firstSeen.set(room.projectId, now);
      if (this.observed && room.active > 0 && (this.activeBefore.get(room.key) ?? 0) === 0) this.becameActive.set(room.key, now);
      if (room.active === 0) this.becameActive.delete(room.key);
    }
    this.activeBefore = new Map([...all.values()].map(room => [room.key, room.active]));
    this.observed = true;
    for (const key of this.becameActive.keys()) if (!all.has(key)) this.becameActive.delete(key);
    // Bound history while keeping temporarily disconnected rooms from becoming permanently preferred.
    for (const history of [this.firstSeen, this.floorSeen, this.roomSeen]) {
      while (history.size > 1024) history.delete(history.keys().next().value!);
    }
    const scopedRooms = [...all.values()].filter(room => options.scope !== 'floor' || room.projectId === options.projectId);
    const rooms = scopedRooms.filter(room => room.active > 0);
    const supplied = options.current && scopedRooms.find(room => room.key === roomKey(options.current!));
    const holdAnchor = Number.isFinite(this.lastHoldAt) && this.heldUntil >= now && this.lastHoldAt >= this.lastDisabledAt
      ? this.lastHoldAt : now;
    // `current` reports a room already displayed by main. Recognize it during an explicit hold;
    // waiting for a redundant initial shot would spend the next cycle on the same visible room.
    if (supplied && supplied.key !== this.currentKey && (this.currentKey !== null || Number.isFinite(this.lastHoldAt))) {
      this.arrive(supplied, holdAnchor, cycleMs);
    }
    if (options.enabled === false) {
      this.wasEnabled = false; this.lastDisabledAt = now; this.dueAt = now + cycleMs;
      return;
    }
    if (!this.wasEnabled) {
      this.wasEnabled = true; this.arrivedAt = holdAnchor; this.dueAt = holdAnchor + cycleMs;
      this.heldUntil = Math.max(this.heldUntil, holdAnchor + MIN_DWELL);
    }
    if (!rooms.length) { this.dueAt = now + cycleMs; return; }
    if (now < this.heldUntil) { this.dueAt = Math.max(this.dueAt, this.heldUntil); return; }
    const current = scopedRooms.find(room => room.key === this.currentKey);
    if (this.currentKey === null || !current) {
      const initial = supplied?.active ? supplied : rooms.sort((a, b) => b.active - a.active || a.key.localeCompare(b.key))[0]!;
      return this.shot(initial, now, cycleMs, 'initial');
    }
    if (current.active === 0) {
      // Completed work leaves its room out of the tour, while preserving the shot's minimum dwell.
      this.dueAt = Math.max(this.arrivedAt + MIN_DWELL, this.heldUntil);
      if (now < this.dueAt) return;
      const target = rooms.sort((a, b) => b.active - a.active || a.key.localeCompare(b.key))[0]!;
      return this.shot(target, now, cycleMs, 'activity');
    }
    if (rooms.length === 1) { this.dueAt = now + cycleMs; return; }

    const floorMap = new Map<string, Floor>();
    for (const room of rooms) {
      const floor = floorMap.get(room.projectId) ?? { projectId: room.projectId, rooms: [], active: 0,
        age: now - (this.floorSeen.get(room.projectId) ?? this.firstSeen.get(room.projectId) ?? now) };
      floor.rooms.push(room); floor.active += room.active; floorMap.set(room.projectId, floor);
    }
    let floors = [...floorMap.values()];
    const otherFloors = floors.filter(floor => floor.projectId !== current.projectId);
    if (otherFloors.length && (otherFloors.some(floor => floor.active > 0) || this.floorVisits >= 2)) floors = otherFloors;
    const floorIds = new Set(floors.map(floor => floor.projectId));
    const pending = rooms.filter(room => room.key !== current.key && floorIds.has(room.projectId) && room.active > 0
      && this.becameActive.has(room.key));
    const minAt = Math.max(this.arrivedAt + MIN_DWELL, this.heldUntil);
    const due = this.arrivedAt + cycleMs;
    const activityAt = pending.length ? Math.min(...pending.map(room => this.becameActive.get(room.key)! + ACTIVITY_SETTLE)) : Infinity;
    this.dueAt = Math.max(minAt, Math.min(due, activityAt));
    if (now < this.dueAt) return;

    const overdue = floors.filter(floor => floor.age >= cycleMs * Math.max(3, floorMap.size));
    const ready = pending.filter(room => now >= this.becameActive.get(room.key)! + ACTIVITY_SETTLE);
    let target: Room | undefined, reason: BuildingShot['reason'] = 'cycle';
    if (!overdue.length && ready.length) {
      // A newly busy room gets one delayed priority visit, never a camera jump on every tool event.
      target = ready.sort((a, b) => this.becameActive.get(a.key)! - this.becameActive.get(b.key)!
        || b.active - a.active || a.key.localeCompare(b.key))[0];
      reason = 'activity';
    } else {
      if (now < due && !overdue.length) return;
      const ranked = overdue.length ? overdue.sort((a, b) => b.age - a.age || a.projectId.localeCompare(b.projectId))
        : floors.sort((a, b) => {
          const score = (floor: Floor) => Math.log2(1 + floor.active) * 2 + floor.age / cycleMs * 1.5;
          return score(b) - score(a) || a.projectId.localeCompare(b.projectId);
        });
      const floor = ranked[0]!;
      const alternatives = floor.rooms.filter(room => room.key !== current.key);
      target = (alternatives.length ? alternatives : floor.rooms).sort((a, b) => {
        const left = this.roomSeen.get(a.key) ?? -Infinity, right = this.roomSeen.get(b.key) ?? -Infinity;
        if (left !== right) return left < right ? -1 : 1;
        return b.active - a.active || a.key.localeCompare(b.key);
      })[0];
      reason = overdue.length ? 'fairness' : 'cycle';
    }
    return target ? this.shot(target, now, cycleMs, reason) : undefined;
  }
}
