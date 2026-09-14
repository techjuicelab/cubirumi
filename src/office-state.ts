import { colors, initialAgents, sourceNames, type Agent, type OfficeEvent } from './protocol.ts';
import { nextActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';

export const UNKNOWN_PROJECT = '__unreported_project__';
export const UNKNOWN_SESSION = '__unreported_session__';
export const projectKey = (agent: Pick<Agent, 'projectId'>) => agent.projectId ?? UNKNOWN_PROJECT;
export const sessionKey = (agent: Pick<Agent, 'sessionId'>) => agent.sessionId ?? UNKNOWN_SESSION;
const sessionAuthority = { 'app-server': 3, 'codex-log': 2, 'claude-log': 2, hook: 1, manual: 0 } as const;
export function modelColor(model: string | undefined): string {
  if (!model) return '#a3aea5';
  let hash = 0;
  for (const character of model) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}
export function owner(): Agent {
  return { ...initialAgents(false)[0]!, source: 'manual', task: '우리 회사의 프로젝트와 작업을 살펴보는 중' };
}
export function updateAgentState(agents: Agent[], event: OfficeEvent): Agent | undefined {
  // Registry snapshots already identify their provider; only incoming owner events need target resolution.
  const manualInstruction = event.source === 'manual' && event.type === 'user.instruction' && event.lastEventAt === undefined;
  if (manualInstruction) {
    const targetId = event.toAgentId ?? event.agentId;
    const targets = agents.filter(item => item.id === targetId && item.id !== 'boss' && item.source !== 'demo');
    if (targets.length !== 1) return undefined;
    const target = targets[0]!;
    event = { ...event, source: target.source, agentId: target.id, agentName: target.name,
      role: target.role, projectId: target.projectId, projectName: target.projectName,
      sessionId: target.sessionId, sessionName: target.sessionName, parentAgentId: target.parentAgentId,
      observation: 'manual', modelEvidence: 'unknown', model: undefined, modelObservedAt: undefined };
  }
  let agent = agents.find(item => item.id === event.agentId && item.source === event.source);
  // Communication effects do not change work, presence, model evidence or lifecycle ordering.
  if (event.type === 'message.sent') return agent;
  if (event.type === 'agent.model') {
    if (!agent || agent.source !== event.source || agent.lastEventId !== event.referenceEventId) return agent;
    if (!event.modelObservedAt || !Number.isFinite(Date.parse(event.modelObservedAt))
      || (agent.taskStartedAt && Date.parse(event.modelObservedAt) < Date.parse(agent.taskStartedAt))) return agent;
    if (agent.modelObservedAt && Date.parse(event.modelObservedAt) < Date.parse(agent.modelObservedAt)) return agent;
    if (event.modelEvidence === 'reported' && event.model) {
      agent.model = event.model; agent.modelEvidence = 'reported';
      agent.modelObservedAt = event.modelObservedAt; agent.color = modelColor(event.model);
    }
    return agent;
  }
  // A session ends each employee's older work even if its sender already started another turn.
  // Metadata-only model corrections above do not advance this lifecycle ordering boundary.
  if (event.type === 'session.ended' && event.sessionId) {
    for (const item of agents) if (item.source === event.source && item.sessionId === event.sessionId
      && (!item.lastEventAt || Date.parse(item.lastEventAt) <= Date.parse(event.timestamp))) {
      item.sessionEnded = true;
      item.status = 'idle';
      item.lastEventAt = event.timestamp;
      delete item.activityKind;
    }
  }
  if (!agent) {
    agent = { id: event.agentId, name: event.agentName ?? `직원 ${event.agentId.slice(-6)}`,
      role: event.role ?? (event.parentAgentId ? '하위 에이전트' : sourceNames[event.source]),
      source: event.source, color: modelColor(undefined), status: 'idle', task: event.title,
      modelEvidence: 'unknown', retired: false };
    agents.push(agent);
  }
  if (agent.lastEventAt && new Date(event.lastEventAt ?? event.timestamp).getTime() < new Date(agent.lastEventAt).getTime()) return agent;
  if (event.agentName) agent.name = event.agentName;
  if (event.role) agent.role = event.role;
  agent.source = event.source;
  agent.task = event.title;
  agent.lastEventAt = event.lastEventAt ?? event.timestamp;
  agent.lastEventId = event.id;
  const claudeInstruction = event.source === 'claude' && event.type === 'user.instruction';
  if (event.taskStartedAt) agent.taskStartedAt = event.taskStartedAt;
  if (manualInstruction || claudeInstruction) agent.taskStartedAt = event.timestamp;
  const taskChanged = manualInstruction || claudeInstruction || event.taskId !== undefined && event.taskId !== agent.taskId;
  if (event.taskId !== undefined) agent.taskId = event.taskId;
  // Model evidence belongs to a particular turn, not to the employee forever.
  // A routine event without model metadata can preserve evidence only within that turn.
  if (taskChanged && !(event.modelEvidence === 'reported' && event.model)) {
    delete agent.model;
    delete agent.modelObservedAt;
    agent.modelEvidence = 'unknown';
    agent.color = modelColor(undefined);
  }
  const sessionObservation = event.sessionObservation ?? event.observation;
  const incomingAuthority = sessionObservation ? sessionAuthority[sessionObservation] : 0;
  const existingAuthority = agent.sessionObservation ? sessionAuthority[agent.sessionObservation] : 0;
  if ((!agent.sessionId || incomingAuthority >= existingAuthority) && event.sessionId) {
    if (event.sessionId !== agent.sessionId && event.sessionName === undefined) delete agent.sessionName;
    agent.sessionId = event.sessionId;
    if (event.sessionName !== undefined) agent.sessionName = event.sessionName;
    if (sessionObservation) agent.sessionObservation = sessionObservation;
  } else if (event.sessionName !== undefined && incomingAuthority >= existingAuthority && (!event.sessionId || event.sessionId === agent.sessionId)) {
    agent.sessionName = event.sessionName;
  }
  for (const key of ['projectId', 'projectName', 'parentAgentId', 'observation', 'toolName'] as const) {
    if (event[key] !== undefined) Object.assign(agent, { [key]: event[key] });
  }
  if (event.modelEvidence === 'reported' && event.model) {
    agent.model = event.model;
    agent.modelEvidence = 'reported';
    agent.color = modelColor(event.model);
    if (event.modelObservedAt) agent.modelObservedAt = event.modelObservedAt;
  }
  if (event.status) agent.status = event.status;
  if (event.type === 'agent.started' || event.type === 'task.created' || event.type === 'user.instruction') { agent.status = event.status ?? 'working'; agent.retired = false; agent.sessionEnded = false; }
  if (event.type === 'agent.completed') agent.status = 'idle';
  if (event.type === 'approval.requested') agent.status = 'approval';
  if (event.type === 'approval.resolved') agent.status = event.status ?? 'idle';
  if (event.type === 'agent.retired') { agent.retired = true; agent.status = 'idle'; }
  if (event.type === 'session.ended') {
    agent.sessionEnded = true;
    agent.status = 'idle';
    delete agent.activityKind;
  }
  if (event.retired !== undefined) agent.retired = event.retired;
  if (event.sessionEnded !== undefined) agent.sessionEnded = event.sessionEnded;
  const activityKind = nextActivityKind(taskChanged ? undefined : agent.activityKind, event, agent.status);
  if (activityKind === undefined) delete agent.activityKind;
  else agent.activityKind = activityKind;
  return agent;
}
export function pageAgents(agents: Agent[], page: number, pageSize = 5): Agent[] {
  return agents.filter(agent => agent.id !== 'boss' && !agent.retired).slice(page * pageSize, (page + 1) * pageSize);
}
export function isWorkingAgent(agent: Agent): boolean {
  return agent.id !== 'boss' && !agent.retired && ['working', 'thinking', 'reviewing'].includes(agent.status);
}
export function summarizeOfficeActivity(agents: Agent[], displayed: Agent[], projectId?: string, sessionId?: string) {
  const busy = agents.filter(isWorkingAgent);
  const onFloor = projectId ? busy.filter(agent => projectKey(agent) === projectId) : busy;
  const inWorkzone = sessionId ? onFloor.filter(agent => sessionKey(agent) === sessionId) : onFloor;
  const displayedIds = new Set(displayed.map(agent => agent.id));
  const visible = inWorkzone.filter(agent => displayedIds.has(agent.id)).length;
  return { total: busy.length, floor: onFloor.length, workzone: inWorkzone.length, visible,
    otherFloors: busy.length - onFloor.length, otherWorkzones: onFloor.length - inWorkzone.length,
    otherPages: inWorkzone.length - visible };
}
