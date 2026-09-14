import type { Agent, AgentStatus } from './protocol.ts';
import { isWorkingStatus } from './work-activity.ts';

/** Color is never the only cue: each status family also has its own marker shape. */
export type StatusShape = 'ring' | 'dashed-ring' | 'diamond' | 'triangle' | 'check' | 'bar' | 'unknown';
export type StatusStyle = { label: string; color: string; shape: StatusShape };

/** The single status table for 3D markers, halos, cards, roster, bubbles and the building view. */
export const STATUS_STYLE: Record<AgentStatus, StatusStyle> = {
  working: { label: '작업 중', color: '#ff5b54', shape: 'ring' },
  thinking: { label: '처리 중', color: '#ff5b54', shape: 'dashed-ring' },
  reviewing: { label: '검토 중', color: '#ff5b54', shape: 'dashed-ring' },
  approval: { label: '확인 요청', color: '#e6bd61', shape: 'diamond' },
  error: { label: '오류', color: '#ba3344', shape: 'triangle' },
  done: { label: '응답 종료', color: '#83b491', shape: 'check' },
  idle: { label: '대기 중', color: '#c3c5b7', shape: 'bar' },
  waiting: { label: '대기 중', color: '#c3c5b7', shape: 'bar' },
};

/** Scene inputs carry free-form status strings; anything unreported reads as quiet, never as work. */
export function statusStyleFor(status: string): StatusStyle {
  return Object.hasOwn(STATUS_STYLE, status) ? STATUS_STYLE[status as AgentStatus] : STATUS_STYLE.idle;
}

/**
 * Presentation only (activity-freshness): an active report too old to confirm. It is not a reported status, so it lives
 * beside the table rather than in it, and cards, roster, owner card and building windows all read it from here.
 */
export const UNCONFIRMED_STYLE: StatusStyle = { label: '현재 상태 미확인', color: '#95a9b8', shape: 'unknown' };

/** The style a viewer sees: the unconfirmed style while the original status can no longer be confirmed, else the table. */
export function presentedStatusStyle(agent: Pick<Agent, 'status' | 'unconfirmedStatus'>): StatusStyle {
  return agent.unconfirmedStatus ? UNCONFIRMED_STYLE : statusStyleFor(agent.status);
}

/** Adapters report external service tools under this name only; the service itself is never received. */
export const EXTERNAL_TOOL_NAME = 'MCP 도구';
/** What cards and 3D bubbles say during an external call; the other service's name is never received. */
export const EXTERNAL_CALL_LABEL = '외부 서비스 연동 중';

/** A phone call is shown only while a working-family status is using the external tool. */
export function isExternalCall(agent: Pick<Agent, 'status' | 'toolName'>): boolean {
  return isWorkingStatus(agent.status) && agent.toolName === EXTERNAL_TOOL_NAME;
}
