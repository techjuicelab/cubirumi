import type { Agent } from './protocol.ts';
import { projectKey } from './office-state.ts';
import { hasVisibleActivity } from './observation.ts';

export const ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;

/** Quiet only the current presentation; absence of observations cannot establish completion. */
export function presentAgentActivity(agent: Agent, now: number): Agent {
  if (agent.id === 'boss' || agent.source === 'demo' || agent.retired || agent.sessionEnded) return agent;
  if (!['working', 'thinking', 'reviewing', 'error'].includes(agent.status)) return agent;

  const observedAt = Date.parse(agent.lastEventAt ?? '');
  if (Number.isFinite(observedAt)
    && (!Number.isFinite(now) || now - observedAt < ACTIVITY_FRESHNESS_MS)) return agent;

  return { ...agent, status: 'idle', unconfirmedStatus: agent.status };
}

/** A floor left out of the view; `lastEventAt` is absent when no observation time on it is known. */
export interface DormantFloor { id: string; name: string; lastEventAt?: string }

/**
 * Leaves out the project floors nobody has reported from for `dormantAfterMs`, then keeps at most `maxFloors` of the rest: the
 * floors reported from most recently. 0 turns a limit off. Presentation only, like the quieted status above: the people stay
 * connected in the source state, and their floor returns with its next report. Expects presented staff, so work too old to
 * confirm does not hold a floor. A floor showing work, an approval request or an error is never left out, even past the floor
 * limit. Elapsed time that cannot be measured hides nothing, so an unknown observation time only ranks last for the floor limit.
 * The floors left out are listed from the most recently used.
 */
export function splitDormantFloors(staff: readonly Agent[], now: number, dormantAfterMs: number, maxFloors = 0): { staff: Agent[]; dormant: DormantFloor[] } {
  const timed = dormantAfterMs > 0 && Number.isFinite(dormantAfterMs) && Number.isFinite(now);
  const capped = maxFloors >= 1 && Number.isFinite(maxFloors);
  if (!timed && !capped) return { staff: [...staff], dormant: [] };
  const floors = new Map<string, { id: string; name?: string; latest: number; active: boolean; timeless: boolean }>();
  for (const agent of staff) {
    const id = projectKey(agent);
    const floor = floors.get(id) ?? { id, latest: -Infinity, active: false, timeless: false };
    const observedAt = Date.parse(agent.lastEventAt ?? '');
    if (hasVisibleActivity(agent)) floor.active = true;
    if (Number.isFinite(observedAt)) floor.latest = Math.max(floor.latest, observedAt);
    else floor.timeless = true;
    floor.name ??= agent.projectName;
    floors.set(id, floor);
  }
  const quiet = [...floors.values()].filter(floor => !floor.active);
  const rested = new Set(timed ? quiet.filter(floor => !floor.timeless && now - floor.latest >= dormantAfterMs) : []);
  if (capped && floors.size - rested.size > maxFloors) {
    const room = Math.max(0, maxFloors - (floors.size - quiet.length));
    const recent = quiet.filter(floor => !rested.has(floor)).sort((a, b) => b.latest - a.latest);
    for (const floor of recent.slice(room)) rested.add(floor);
  }
  if (!rested.size) return { staff: [...staff], dormant: [] };
  const hidden = new Set([...rested].map(floor => floor.id));
  const dormant = [...rested].sort((a, b) => b.latest - a.latest).map(floor => ({ id: floor.id, name: floor.name ?? '프로젝트 미확인',
    ...(Number.isFinite(floor.latest) ? { lastEventAt: new Date(floor.latest).toISOString() } : {}) }));
  return { staff: staff.filter(agent => !hidden.has(projectKey(agent))), dormant };
}
