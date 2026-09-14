import type { ActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
export type { ActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
import { STATUS_STYLE } from './status-style.ts';
export const activityNames: Record<ActivityKind, string> = {
  coding: '코드 작업', documents: '문서 정리', research: '자료 조사', testing: '테스트·빌드',
  reviewing: '검토', planning: '계획 정리', design: '디자인 작업', delivery: '업무 전달',
  shipping: '결과물 내보내기', general: '일반 작업',
};
export type AgentStatus = 'working' | 'thinking' | 'waiting' | 'reviewing' | 'approval' | 'done' | 'error' | 'idle';
export type Source = 'demo' | 'codex' | 'claude' | 'manual';
export interface OfficeEvent {
  id: string; timestamp: string; source: Source;
  type: 'agent.model' | 'agent.started' | 'agent.status' | 'agent.completed' | 'message.sent' | 'handoff' | 'approval.requested' | 'approval.resolved' | 'task.created' | 'user.instruction' | 'agent.retired' | 'session.ended';
  agentId: string; agentName?: string; role?: string; status?: AgentStatus; activityKind?: ActivityKind;
  title: string; toAgentId?: string; toAgentName?: string; taskId?: string;
  projectId?: string; projectName?: string; sessionId?: string; sessionName?: string;
  parentAgentId?: string; model?: string; modelEvidence?: 'reported' | 'unknown';
  observation?: 'hook' | 'app-server' | 'codex-log' | 'claude-log' | 'manual'; toolName?: string;
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
export const statusNames = Object.fromEntries((Object.keys(STATUS_STYLE) as AgentStatus[])
  .map(status => [status, STATUS_STYLE[status].label])) as Record<AgentStatus, string>;
export const sourceNames: Record<Source, string> = { demo: '시연', codex: 'Codex', claude: 'Claude Code', manual: '직접 전송' };
export const observationNames: Record<NonNullable<OfficeEvent['observation']>, string> = {
  hook: '앱 작업 알림', 'app-server': '앱 실행 정보', 'codex-log': '로컬 실행 기록', 'claude-log': 'Claude 로컬 모델 기록', manual: '직접 전달',
};
export const seatIds = ['boss', 'planner', 'designer', 'developer', 'reviewer', 'researcher'];
export const colors = ['#eab65e', '#8aac8f', '#b0a0d5', '#80afcb', '#d99b89', '#b8bd76'];
export function initialAgents(demo = true): Agent[] {
  const names = ['사장님', '모아', '루미', '코디', '체키', '노바'];
  const roles = ['대표실', '기획팀', '디자인팀', '개발팀', '품질관리팀', '리서치팀'];
  const tasks = ['우리 팀의 오늘을 살펴보는 중', '새로운 프로젝트 구상하기', '첫 화면 디자인 다듬기', '사무실에 생명 불어넣기', '완성된 기능 꼼꼼히 살펴보기', '더 좋은 연결 방법 찾아보기'];
  return seatIds.map((id, i) => ({ id, name: names[i], role: roles[i], color: colors[i],
    status: demo ? (i === 0 ? 'working' : i === 4 ? 'waiting' : 'working') : 'idle',
    task: demo ? tasks[i] : i === 0 ? '연결된 팀의 이벤트를 기다리는 중' : '아직 연결된 직원이 없어요', source: 'demo' }));
}
