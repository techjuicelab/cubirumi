import type { Agent } from './protocol.ts';

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
