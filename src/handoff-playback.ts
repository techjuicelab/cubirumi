import type { OfficeEvent } from './protocol.ts';

type PendingHandoff = { event: OfficeEvent; expiresAt: number; replay: boolean };

/** The computers needed to replay an observed communication, without invented recipients. */
export function communicationEndpoints(event: OfficeEvent): string[] {
  if (!event.agentId) return [];
  if (event.type === 'handoff') return event.toAgentId && event.toAgentId !== event.agentId ? [event.agentId, event.toAgentId] : [];
  if (event.type === 'user.instruction') return [event.toAgentId ?? event.agentId].filter(Boolean);
  if (event.type === 'message.sent') return [event.agentId];
  return [];
}

/** Keeps observed communications until their real computers can be rendered. */
export class HandoffPlayback {
  private readonly pending = new Map<string, PendingHandoff>();
  private readonly seen = new Set<string>();
  private readonly localCooldownUntil = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  constructor(ttlMs = 30_000, capacity = 128) { this.ttlMs = ttlMs; this.capacity = capacity; }

  get size(): number { return this.pending.size; }
  get hasPendingHandoff(): boolean { return [...this.pending.values()].some(item => item.event.type === 'handoff'); }

  enqueue(event: OfficeEvent, now = Date.now(), { replay = false }: { replay?: boolean } = {}): boolean {
    this.expire(now);
    if (!event.id || !communicationEndpoints(event).length || !['codex', 'claude', 'manual'].includes(event.source)) return false;
    const observedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(observedAt) || !replay && (observedAt < now - this.ttlMs || observedAt > now + 60_000)) return false;
    if (this.pending.has(event.id) || !replay && this.seen.has(event.id)) return false;
    this.seen.add(event.id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    this.pending.set(event.id, { event: { ...event }, expiresAt: now + this.ttlMs, replay });
    if (this.pending.size > this.capacity) this.pending.delete(this.pending.keys().next().value!);
    return true;
  }

  drain({ now = Date.now(), enabled = true, ready, play, limit = 4 }: {
    now?: number; enabled?: boolean;
    ready: (agentId: string, toId?: string) => boolean;
    /** true: played; false: retry on a later drain; 'drop': recorded only, so it leaves the queue without a flight or cooldown. */
    play: (event: OfficeEvent) => boolean | 'drop'; limit?: number;
  }): number {
    this.expire(now);
    if (!enabled) return 0;
    let played = 0;
    for (const [id, item] of this.pending) {
      if (played >= limit) break;
      const [agentId, toId] = communicationEndpoints(item.event);
      const local = item.event.type !== 'handoff';
      if (local && !item.replay && now < (this.localCooldownUntil.get(agentId!) ?? 0)) continue;
      if (!ready(agentId!, toId)) continue;
      const result = play(item.event);
      if (result === 'drop') { this.pending.delete(id); continue; }
      if (!result) continue;
      if (local) this.localCooldownUntil.set(agentId!, now + 3000);
      this.pending.delete(id); played++;
    }
    return played;
  }

  clear(): void { this.pending.clear(); this.localCooldownUntil.clear(); }

  private expire(now: number): void {
    for (const [id, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(id);
    for (const [id, until] of this.localCooldownUntil) if (until <= now) this.localCooldownUntil.delete(id);
  }
}
