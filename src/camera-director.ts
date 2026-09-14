import type { Agent } from './protocol.ts';
import { connectedAgents, hasVisibleActivity } from './observation.ts';

export type CameraShot = { agentId: string | null; zoom: number };

/** Chooses shots from observed work. Rendering/interpolation remain in OfficeScene. */
export class CameraDirector {
  private lastShown = new Map<string, number>();
  private current: string | null = null;
  private nextAt: number;
  private heldUntil = 0;
  constructor(now = Date.now()) { this.nextAt = now + 6000; }
  hold(now = Date.now(), duration = 18000) {
    this.current = null;
    this.heldUntil = now + duration; this.nextAt = Math.max(this.nextAt, this.heldUntil);
  }
  roomChanged(now = Date.now()) { this.current = null; this.nextAt = Math.max(now + 5500, this.heldUntil); }
  get focusedId() { return this.current; }
  next(agents: readonly Agent[], now = Date.now(), enabled = true): CameraShot | undefined {
    if (!enabled) { this.nextAt = Math.max(this.nextAt, now + 3000); return; }
    if (now < this.nextAt || now < this.heldUntil) return;
    const candidates = connectedAgents(agents).filter(hasVisibleActivity);
    if (!candidates.length) {
      const hadFocus = this.current !== null;
      this.current = null; this.nextAt = now + 7000;
      return hadFocus ? { agentId: null, zoom: 1 } : undefined;
    }
    const alternatives = candidates.filter(agent => agent.id !== this.current);
    if (!alternatives.length && candidates.some(agent => agent.id === this.current)) { this.nextAt = now + 11000; return; }
    const sorted = (alternatives.length ? alternatives : candidates).sort((a, b) => {
      const left = this.lastShown.get(a.id) ?? -Infinity;
      const right = this.lastShown.get(b.id) ?? -Infinity;
      if (left !== right) return left < right ? -1 : 1;
      if ((a.status === 'approval') !== (b.status === 'approval')) return a.status === 'approval' ? -1 : 1;
      return (Date.parse(b.lastEventAt ?? '') || 0) - (Date.parse(a.lastEventAt ?? '') || 0);
    });
    const agent = sorted[0]!;
    this.current = agent.id;
    // Keep other rooms' history so each floor visit continues beyond its first seats.
    this.lastShown.delete(agent.id); this.lastShown.set(agent.id, now);
    if (this.lastShown.size > 1024) this.lastShown.delete(this.lastShown.keys().next().value!);
    this.nextAt = now + (agent.status === 'approval' ? 13000 : 11000);
    return { agentId: agent.id, zoom: agent.status === 'approval' ? 1.65 : 1.5 };
  }
}
