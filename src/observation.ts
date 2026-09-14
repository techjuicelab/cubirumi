import type { Agent, OfficeEvent } from './protocol.ts';
import { projectKey, sessionKey, UNKNOWN_PROJECT, UNKNOWN_SESSION } from './office-state.ts';

export const UNKNOWN_MODEL = '__unreported_model__';

// An explicit tool-start event is supported without changing the existing wire protocol.
export type ObservationEvent = OfficeEvent | (Omit<OfficeEvent, 'type'> & { type: 'tool.started' });

export interface ConnectionSnapshot {
  agents: Agent[];
  connectedCount: number;
  workingCount: number;
  stale: boolean;
}

export interface CctvCandidate {
  key: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionName: string;
  page: number;
  pageCount: number;
  agents: Agent[];
  agentIds: string[];
  workingCount: number;
  roomAgentCount: number;
}

export interface ModelActivity {
  key: string;
  model?: string;
  label: string;
  modelEvidence: 'reported' | 'unknown';
  connectedCount: number;
  workingCount: number;
  toolStarts: number;
  handoffs: number;
  responsesEnded: number;
  observedEvents: number;
}

const liveSources = new Set<Agent['source']>(['codex', 'claude', 'manual']);
const workingStatuses = new Set<Agent['status']>(['working', 'thinking', 'reviewing']);
const identity = (source: Agent['source'], id: string) => JSON.stringify([source, id]);

function uniqueAgents(agents: readonly Agent[]): Agent[] {
  const unique = new Map<string, Agent>();
  for (const agent of agents) {
    const key = identity(agent.source, agent.id);
    const previous = unique.get(key);
    const incomingTime = Date.parse(agent.lastEventAt ?? '');
    const previousTime = Date.parse(previous?.lastEventAt ?? '');
    // This only resolves duplicate snapshots; elapsed time never disconnects a worker.
    if (previous && Number.isFinite(incomingTime) && Number.isFinite(previousTime) && incomingTime < previousTime) continue;
    unique.set(key, agent);
  }
  return [...unique.values()];
}

function isConnected(agent: Agent): boolean {
  return agent.id !== 'boss' && liveSources.has(agent.source) && !agent.retired && !agent.sessionEnded;
}

function isWorking(agent: Agent): boolean {
  return isConnected(agent) && workingStatuses.has(agent.status);
}

/** Only activity needs a character and a permanent desk; quiet records remain in the roster. */
export function hasVisibleActivity(agent: Pick<Agent, 'status'>): boolean {
  return workingStatuses.has(agent.status) || agent.status === 'approval' || agent.status === 'error';
}

/** Reported presence, including quiet/long-running workers, until an explicit end event. */
export function connectedAgents(agents: readonly Agent[]): Agent[] {
  return uniqueAgents(agents).filter(isConnected);
}

/** Bridge loss makes the entire observation stale; it does not fabricate agent departures. */
export function connectionSnapshot(agents: readonly Agent[], bridgeConnected: boolean): ConnectionSnapshot {
  const connected = connectedAgents(agents);
  return { agents: connected, connectedCount: connected.length,
    workingCount: connected.filter(isWorking).length, stale: !bridgeConnected };
}

/** Expanded offices render every connected employee; camera rotation switches rooms, not seat pages. */
export function cctvRooms(agents: readonly Agent[]) {
  const rooms = new Map<string, { projectId: string; sessionId: string; workingCount: number }>();
  for (const agent of connectedAgents(agents)) {
    const projectId = projectKey(agent);
    const sessionId = sessionKey(agent);
    const key = JSON.stringify([projectId, sessionId]);
    const room = rooms.get(key) ?? { projectId, sessionId, workingCount: 0 };
    if (isWorking(agent)) room.workingCount++;
    rooms.set(key, room);
  }
  return [...rooms.values()].sort((a, b) => b.workingCount - a.workingCount);
}

/** Every connected room/page appears once in a rotation, including pages containing idle agents. */
export function cctvCandidates(agents: readonly Agent[], { pageSize = 5 }: { pageSize?: number } = {}): CctvCandidate[] {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.min(5, Math.floor(pageSize)) : 5;
  const rooms = new Map<string, { projectId: string; sessionId: string; agents: Agent[] }>();
  for (const agent of connectedAgents(agents)) {
    const projectId = projectKey(agent);
    const sessionId = sessionKey(agent);
    const key = JSON.stringify([projectId, sessionId]);
    const room = rooms.get(key) ?? { projectId, sessionId, agents: [] };
    room.agents.push(agent);
    rooms.set(key, room);
  }
  const candidates: CctvCandidate[] = [];
  for (const room of rooms.values()) {
    // Keep the same seats/pages as the room roster; changing work status must not move staff.
    const ordered = room.agents;
    const pageCount = Math.ceil(ordered.length / size);
    const projectName = room.agents.find(agent => agent.projectName?.trim())?.projectName?.trim()
      ?? (room.projectId === UNKNOWN_PROJECT ? '프로젝트 미확인' : '이름 없는 프로젝트');
    const sessionName = room.agents.find(agent => agent.sessionName?.trim())?.sessionName?.trim()
      ?? (room.sessionId === UNKNOWN_SESSION ? '채팅방 미확인' : '이름 없는 채팅방');
    for (let page = 0; page < pageCount; page++) {
      const visible = ordered.slice(page * size, (page + 1) * size);
      candidates.push({ key: JSON.stringify([room.projectId, room.sessionId, page]),
        projectId: room.projectId, projectName, sessionId: room.sessionId, sessionName,
        page, pageCount, agents: visible, agentIds: visible.map(agent => agent.id),
        workingCount: visible.filter(isWorking).length, roomAgentCount: ordered.length });
    }
  }
  // Keep quiet pages in the list so CCTV rotation cannot starve an idle room.
  return candidates.sort((a, b) => b.workingCount - a.workingCount);
}

function reportedModel(value: Pick<Agent, 'model' | 'modelEvidence'>): string | undefined {
  return value.modelEvidence === 'reported' && value.model?.trim() ? value.model.trim() : undefined;
}

function eventModel(event: ObservationEvent, agent: Agent | undefined): string | undefined {
  const explicit = reportedModel(event);
  if (explicit) return explicit;
  // A current employee's model is not evidence for another explicitly identified turn.
  if (!agent || (event.taskId && event.taskId !== agent.taskId)) return undefined;
  return reportedModel(agent);
}

function isToolStart(event: ObservationEvent): boolean {
  if (event.type === 'tool.started') return true;
  const name = event.toolName?.trim();
  // Legacy hooks have no tool.started type. Do not count post-tool results/model confirmations.
  return event.type === 'agent.status' && event.status === 'working' && Boolean(name)
    && event.title === `${name} 실행 중`;
}

/**
 * Counts unique received event IDs, not productivity, successful work, or unique tool executions.
 * Historical activity remains a record after departure; current connection counts exclude it.
 */
export function modelActivity(agents: readonly Agent[], events: readonly ObservationEvent[]): ModelActivity[] {
  const roster = uniqueAgents(agents);
  const byIdentity = new Map(roster.map(agent => [identity(agent.source, agent.id), agent]));
  const buckets = new Map<string, ModelActivity>();
  function bucket(model: string | undefined): ModelActivity {
    const key = model ? `model:${model}` : UNKNOWN_MODEL;
    let item = buckets.get(key);
    if (!item) {
      item = { key, ...(model ? { model } : {}), label: model ?? '모델 미확인',
        modelEvidence: model ? 'reported' : 'unknown', connectedCount: 0, workingCount: 0,
        toolStarts: 0, handoffs: 0, responsesEnded: 0, observedEvents: 0 };
      buckets.set(key, item);
    }
    return item;
  }
  for (const agent of roster.filter(isConnected)) {
    const item = bucket(reportedModel(agent));
    item.connectedCount++;
    if (isWorking(agent)) item.workingCount++;
  }
  const seen = new Set<string>();
  for (const event of events) {
    if (!event.id || seen.has(event.id) || event.agentId === 'boss' || !liveSources.has(event.source)) continue;
    seen.add(event.id);
    if (event.type === 'user.instruction') continue;
    const toolStart = isToolStart(event);
    const handoff = event.type === 'handoff' && Boolean(event.toAgentId?.trim()) && event.toAgentId?.trim() !== event.agentId;
    const responseEnded = event.type === 'agent.completed';
    if (!toolStart && !handoff && !responseEnded) continue;
    const item = bucket(eventModel(event, byIdentity.get(identity(event.source, event.agentId))));
    if (toolStart) item.toolStarts++;
    if (handoff) item.handoffs++;
    if (responseEnded) item.responsesEnded++;
    item.observedEvents++;
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.modelEvidence !== b.modelEvidence) return a.modelEvidence === 'unknown' ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}
