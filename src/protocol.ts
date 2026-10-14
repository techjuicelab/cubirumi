import type { ActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
export type { ActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
import { STATUS_STYLE } from './status-style.ts';
import { msg } from './i18n.ts';
export const activityNames: Record<ActivityKind, string> = {
  get coding() { return msg('Coding', '코드 작업'); }, get documents() { return msg('Documents', '문서 정리'); },
  get research() { return msg('Research', '자료 조사'); }, get testing() { return msg('Testing and building', '테스트·빌드'); },
  get reviewing() { return msg('Review', '검토'); }, get planning() { return msg('Planning', '계획 정리'); },
  get design() { return msg('Design', '디자인 작업'); }, get delivery() { return msg('Handoff', '업무 전달'); },
  get shipping() { return msg('Shipping', '결과물 내보내기'); }, get general() { return msg('General work', '일반 작업'); },
};
export type AgentStatus = 'working' | 'thinking' | 'waiting' | 'reviewing' | 'approval' | 'done' | 'error' | 'idle';
export type Source = 'demo' | 'codex' | 'claude' | 'manual';
export type ToolPhase = 'started' | 'running' | 'completed' | 'failed';
export interface OfficeEvent {
  id: string; timestamp: string; source: Source;
  type: 'agent.model' | 'agent.started' | 'agent.status' | 'agent.completed' | 'message.sent' | 'handoff' | 'approval.requested' | 'approval.resolved' | 'task.created' | 'user.instruction' | 'agent.retired' | 'session.ended';
  agentId: string; agentName?: string; role?: string; status?: AgentStatus; activityKind?: ActivityKind;
  title: string; toAgentId?: string; toAgentName?: string; taskId?: string;
  projectId?: string; projectName?: string; sessionId?: string; sessionName?: string;
  parentAgentId?: string; model?: string; modelEvidence?: 'reported' | 'unknown';
  observation?: 'hook' | 'app-server' | 'codex-log' | 'claude-log' | 'manual'; toolName?: string; toolPhase?: ToolPhase;
  sessionObservation?: 'hook' | 'app-server' | 'codex-log' | 'claude-log' | 'manual';
  retired?: boolean; sessionEnded?: boolean; lastEventAt?: string;
  referenceEventId?: string; modelObservedAt?: string; taskStartedAt?: string; lastEventId?: string;
}
export interface Agent {
  id: string; name: string; role: string; color: string;
  status: AgentStatus; task: string; source: Source; taskId?: string; activityKind?: ActivityKind;
  /** Presentation only: the original status when recent activity can no longer be confirmed. Never persisted as a lifecycle event. */
  unconfirmedStatus?: AgentStatus;
  projectId?: string; projectName?: string; sessionId?: string; sessionName?: string;
  parentAgentId?: string; model?: string; modelEvidence?: 'reported' | 'unknown';
  observation?: 'hook' | 'app-server' | 'codex-log' | 'claude-log' | 'manual'; toolName?: string;
  sessionObservation?: 'hook' | 'app-server' | 'codex-log' | 'claude-log' | 'manual';
  retired?: boolean; sessionEnded?: boolean; lastEventAt?: string;
  referenceEventId?: string; modelObservedAt?: string; taskStartedAt?: string; lastEventId?: string;
}
/** Derived from the shared status table so cards, roster and bubbles cannot drift apart. */
export const statusNames = Object.defineProperties({}, Object.fromEntries((Object.keys(STATUS_STYLE) as AgentStatus[])
  .map(status => [status, { enumerable: true, get: () => STATUS_STYLE[status].label }]))) as Record<AgentStatus, string>;
export const sourceNames: Record<Source, string> = {
  get demo() { return msg('Demo', '시연'); }, codex: 'Codex', claude: 'Claude Code',
  get manual() { return msg('Manual', '직접 전송'); },
};
export const observationNames: Record<NonNullable<OfficeEvent['observation']>, string> = {
  get hook() { return msg('App activity notification', '앱 작업 알림'); },
  get 'app-server'() { return msg('App runtime information', '앱 실행 정보'); },
  get 'codex-log'() { return msg('Local activity log', '로컬 실행 기록'); },
  get 'claude-log'() { return msg('Claude local model log', 'Claude 로컬 모델 기록'); },
  get manual() { return msg('Manual report', '직접 전달'); },
};
export const seatIds = ['boss', 'planner', 'designer', 'developer', 'reviewer', 'researcher'];
export const colors = ['#eab65e', '#8aac8f', '#b0a0d5', '#80afcb', '#d99b89', '#b8bd76'];
export function initialAgents(demo = true): Agent[] {
  const names = [msg('Owner', '사장님'), msg('Moa', '모아'), msg('Lumi', '루미'), msg('Codi', '코디'), msg('Checky', '체키'), msg('Nova', '노바')];
  const roles = [msg('Owner’s office', '대표실'), msg('Planning', '기획팀'), msg('Design', '디자인팀'), msg('Development', '개발팀'), msg('Quality assurance', '품질관리팀'), msg('Research', '리서치팀')];
  const tasks = [msg('Checking in on the team', '우리 팀의 오늘을 살펴보는 중'), msg('Planning a new project', '새로운 프로젝트 구상하기'), msg('Refining the first screen', '첫 화면 디자인 다듬기'), msg('Bringing the office to life', '사무실에 생명 불어넣기'), msg('Reviewing completed features', '완성된 기능 꼼꼼히 살펴보기'), msg('Finding better ways to connect', '더 좋은 연결 방법 찾아보기')];
  return seatIds.map((id, i) => ({ id, name: names[i], role: roles[i], color: colors[i],
    status: demo ? (i === 0 ? 'working' : i === 4 ? 'waiting' : 'working') : 'idle',
    task: demo ? tasks[i] : i === 0 ? msg('Waiting for activity from the connected team', '연결된 팀의 이벤트를 기다리는 중') : msg('No staff connected yet', '아직 연결된 직원이 없어요'), source: 'demo' }));
}
