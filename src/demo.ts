import type { OfficeEvent } from './protocol';
type DemoStep = Omit<OfficeEvent, 'id' | 'timestamp' | 'source'>;
export const demoSteps: DemoStep[] = [
  { type: 'task.created', agentId: 'boss', title: '작고 즐거운 사무실을 만들어주세요', toAgentId: 'planner' },
  { type: 'handoff', agentId: 'boss', toAgentId: 'planner', title: '사장님의 새 프로젝트 의뢰서' },
  { type: 'agent.status', agentId: 'planner', status: 'thinking', title: '요구사항을 정리하고 역할을 나누고 있어요' },
  { type: 'handoff', agentId: 'planner', toAgentId: 'designer', title: '화면 구성과 디자인 요청서 전달' },
  { type: 'agent.status', agentId: 'designer', status: 'working', title: '따뜻한 미니어처 사무실을 디자인해요' },
  { type: 'handoff', agentId: 'researcher', toAgentId: 'developer', title: 'Codex · Claude 연결 방식 조사서' },
  { type: 'agent.status', agentId: 'developer', status: 'working', title: '직원과 서류가 움직이도록 구현해요' },
  { type: 'handoff', agentId: 'designer', toAgentId: 'developer', title: '사무실 화면 설계도 전달' },
  { type: 'agent.completed', agentId: 'designer', title: '첫 번째 사무실 디자인 완성' },
  { type: 'handoff', agentId: 'developer', toAgentId: 'reviewer', title: '서류 전달 기능 검수 요청' },
  { type: 'agent.status', agentId: 'reviewer', status: 'reviewing', title: '전달한 서류가 잘 도착하는지 확인해요' },
  { type: 'approval.requested', agentId: 'reviewer', title: '사장님, 첫 번째 사무실을 확인해주세요' },
  { type: 'agent.completed', agentId: 'developer', title: '직원과 서류 전달 애니메이션 완성' },
  { type: 'handoff', agentId: 'reviewer', toAgentId: 'boss', title: '작업 결과 보고서가 도착했어요' },
  { type: 'agent.completed', agentId: 'researcher', title: '연결 방식 조사 완료' },
  { type: 'agent.status', agentId: 'planner', status: 'working', title: '다음 작업을 준비하고 있어요' },
];
export function makeDemoEvent(step: DemoStep): OfficeEvent {
  return { projectId: 'demo-office', projectName: '작은회사 만들기', sessionId: 'demo-chat', sessionName: '첫 번째 사무실', ...step, id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: 'demo' };
}
