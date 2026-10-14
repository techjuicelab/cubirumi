import type { Agent, OfficeEvent } from './protocol.ts';
import { msg } from './i18n.ts';

type TitlePair = readonly [korean: string, english: string];
type TitleCatalog = Partial<Record<OfficeEvent['type'], readonly TitlePair[]>>;

// These exact titles are emitted by the bundled observers and hooks. Unknown text stays verbatim.
const hookTitles: TitleCatalog = {
  'agent.started': [['세션 시작', 'Session started'], ['하위 에이전트 시작', 'Subagent started']],
  'user.instruction': [['사장님의 새 업무 지시 접수', 'New owner instruction received']],
  'agent.status': [['사용자 입력 대기', 'Waiting for user input'], ['응답 중 오류 발생', 'Response error'], ['사용자가 작업 중단', 'Work interrupted by the user']],
  'approval.requested': [['도구 승인 요청', 'Tool approval requested']],
  'agent.completed': [['하위 에이전트 응답 종료', 'Subagent response ended'], ['응답 종료', 'Response ended']],
  'session.ended': [['세션 종료', 'Session ended']],
};
const messageTitles: readonly TitlePair[] = [
  ['메시지 전송 기록', 'Message sent'],
  ['메시지 전달 요청 · 수신자 미확인', 'Message delivery requested · Recipient unknown'],
];
const codexTitles: TitleCatalog = {
  'user.instruction': [['사장님의 업무 지시 접수', 'Owner instruction received']],
  'agent.started': [['Codex 작업 시작', 'Codex work started']],
  'agent.completed': [['Codex 응답 종료', 'Codex response ended'], ['관측 재연결: 작업 종료 확인', 'Observer reconnected: Work ended']],
  'agent.status': [
    ['Codex 작업 중단', 'Codex work interrupted'],
    ['명령 실행 결과 수신', 'Command result received'],
    ['파일 변경 기록 확인', 'File changes observed'],
    ['MCP 도구 결과 수신', 'MCP tool result received'],
    ['실행 중인 Codex 작업 관측', 'Running Codex work observed'],
    ['관측 재연결: 작업 종료 확인', 'Observer reconnected: Work ended'],
    ['실행 모델 확인', 'Runtime model confirmed'],
    ['하위 에이전트 실행 모델 확인', 'Subagent runtime model confirmed'],
  ],
  'agent.retired': [['보관된 Codex 작업 확인', 'Archived Codex work observed']],
  'message.sent': messageTitles,
  'handoff': [['에이전트에게 자료 전달 확인', 'Handoff to agent confirmed'], ['에이전트에게 메시지 전달 요청', 'Message delivery to agent requested']],
};
const claudeTitles: TitleCatalog = {
  'agent.started': [['Claude 대화 기록 연결', 'Claude conversation log connected']],
  'agent.completed': [['Claude 응답 중단', 'Claude response interrupted'], ['Claude 응답 종료', 'Claude response ended']],
  'agent.status': [
    ['도구 실행 실패', 'Tool failed'], ['다른 도구 실행 중', 'Other tools running'],
    ['도구 결과 수신', 'Tool result received'], ['새 업무 입력 기록', 'New instruction recorded'],
    ['Claude 응답 기록 중', 'Claude response being recorded'],
  ],
  'user.instruction': [['새 업무 입력 기록', 'New instruction recorded']],
  'message.sent': messageTitles,
};

function catalogFor(event: OfficeEvent): TitleCatalog | undefined {
  if (event.source !== 'codex' && event.source !== 'claude') return;
  if (event.observation === 'hook') return hookTitles;
  if (event.source === 'codex' && event.observation === 'codex-log') return codexTitles;
  if (event.source === 'claude' && event.observation === 'claude-log') return claudeTitles;
}

function toolTitle(event: OfficeEvent): string | undefined {
  if (!event.toolName) return;
  const tool = event.toolName === 'MCP 도구' ? msg('MCP tool', 'MCP 도구')
    : event.toolName === '도구' ? msg('Tool', '도구') : event.toolName;
  if (event.type === 'approval.requested' && event.observation === 'hook'
    && event.title === `${event.toolName} 승인 요청`) return msg('Approval requested for {tool}', '{tool} 승인 요청', { tool });
  if (event.type !== 'agent.status') return;
  if ((event.toolPhase === 'started' || event.toolPhase === 'running')
    && event.title === `${event.toolName} 실행 중`) return msg('Running {tool}', '{tool} 실행 중', { tool });
  if (event.toolPhase === 'completed' && event.title === `${event.toolName} 결과 수신`) return msg('Result received from {tool}', '{tool} 결과 수신', { tool });
  if (event.toolPhase === 'failed' && event.title === `${event.toolName} 실행 실패`) return msg('{tool} failed', '{tool} 실행 실패', { tool });
  if (event.observation === 'claude-log' && event.toolPhase === 'started'
    && event.title === `${event.toolName} 실행 기록`) return msg('{tool} execution recorded', '{tool} 실행 기록', { tool });
}

/** Presentation only. Callers inserting the returned plain text into HTML must escape it. */
export function eventTitle(event: OfficeEvent): string {
  const catalog = catalogFor(event);
  if (!catalog) return event.title;
  const pair = catalog[event.type]?.find(([korean]) => event.title === korean);
  if (pair) return msg(pair[1], pair[0]);
  return toolTitle(event) ?? event.title;
}

/** An agent task is translated only when its exact originating event is still available. */
export function agentTask(agent: Agent, events: readonly OfficeEvent[]): string {
  if (!agent.lastEventId) return agent.task;
  const event = events.find(candidate => candidate.id === agent.lastEventId && candidate.source === agent.source
    && candidate.agentId === agent.id && candidate.title === agent.task);
  return event ? eventTitle(event) : agent.task;
}
