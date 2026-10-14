import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n.ts';
import { eventTitle, agentTask } from '../src/event-label.ts';

const event = (fields = {}) => ({ id: 'system-event', timestamp: '2026-01-01T00:00:00Z', source: 'codex',
  observation: 'codex-log', agentId: 'worker', type: 'agent.completed', title: 'Codex 응답 종료', ...fields });
const agent = (fields = {}) => ({ id: 'worker', name: '직접 정한 이름', role: '직접 정한 역할', source: 'codex',
  status: 'idle', color: '#91b9ce', task: 'Codex 응답 종료', lastEventId: 'system-event', ...fields });

test('known observer and hook titles follow the display language without changing stored records', t => {
  t.after(() => setLanguage('en'));
  const records = [
    event(),
    event({ type: 'agent.status', title: '실행 모델 확인' }),
    event({ source: 'claude', observation: 'claude-log', type: 'agent.started', title: 'Claude 대화 기록 연결' }),
    event({ source: 'claude', observation: 'claude-log', type: 'message.sent', title: '메시지 전송 기록' }),
    event({ observation: 'hook', type: 'user.instruction', title: '사장님의 새 업무 지시 접수' }),
    event({ observation: 'hook', type: 'session.ended', title: '세션 종료' }),
    event({ type: 'agent.completed', title: '관측 재연결: 작업 종료 확인' }),
  ].map(Object.freeze);
  const original = JSON.stringify(records);
  setLanguage('en');
  assert.deepEqual(records.map(eventTitle), ['Codex response ended', 'Runtime model confirmed', 'Claude conversation log connected',
    'Message sent', 'New owner instruction received', 'Session ended', 'Observer reconnected: Work ended']);
  setLanguage('ko');
  assert.deepEqual(records.map(eventTitle), records.map(item => item.title));
  assert.equal(JSON.stringify(records), original);
});

test('manual, demo, mismatched origins, event types, and similar user text stay verbatim', t => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const records = [
    event({ source: 'manual' }), event({ source: 'demo' }), event({ observation: undefined }),
    event({ observation: 'manual' }), event({ observation: 'app-server' }),
    event({ source: 'claude' }), event({ observation: 'claude-log' }),
    event({ type: 'message.sent' }), event({ title: 'Codex 응답 종료를 검토해 주세요' }),
    event({ title: ' Codex 응답 종료' }), event({ title: 'Codex 응답 종료\n' }),
    event({ title: '<img src=x onerror=alert(1)>Codex 응답 종료' }),
  ];
  assert.deepEqual(records.map(eventTitle), records.map(item => item.title));
});

test('tool titles require exact tool metadata, a matching event type and phase', t => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const records = [
    event({ type: 'agent.status', toolName: 'Read', toolPhase: 'started', title: 'Read 실행 중' }),
    event({ type: 'agent.status', toolName: 'Read', toolPhase: 'completed', title: 'Read 결과 수신' }),
    event({ type: 'agent.status', toolName: 'Read', toolPhase: 'failed', title: 'Read 실행 실패' }),
    event({ observation: 'hook', type: 'approval.requested', toolName: 'Read', title: 'Read 승인 요청' }),
    event({ source: 'claude', observation: 'claude-log', type: 'agent.status', toolName: 'Read', toolPhase: 'started', title: 'Read 실행 기록' }),
    event({ type: 'agent.status', toolName: 'MCP 도구', toolPhase: 'running', title: 'MCP 도구 실행 중' }),
  ];
  assert.deepEqual(records.map(eventTitle), ['Running Read', 'Result received from Read', 'Read failed', 'Approval requested for Read', 'Read execution recorded', 'Running MCP tool']);
  for (const fields of [
    { toolName: 'Write' }, { toolName: undefined }, { toolPhase: 'completed' },
    { type: 'message.sent' }, { title: 'Read 실행 중 사용자 메모' }, { observation: undefined },
  ]) {
    const record = { ...records[0], ...fields };
    assert.equal(eventTitle(record), record.title);
  }
  setLanguage('ko');
  assert.deepEqual(records.map(eventTitle), records.map(item => item.title));
});

test('agent tasks need an exact event identity and remain immutable', t => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const original = Object.freeze(event()), employee = Object.freeze(agent());
  assert.equal(agentTask(employee, [original]), 'Codex response ended');
  for (const changed of [
    { lastEventId: undefined }, { lastEventId: 'other' }, { source: 'manual' }, { id: 'other-worker' }, { task: 'Codex 응답 종료 관련 메모' },
  ]) {
    const other = { ...employee, ...changed };
    assert.equal(agentTask(other, [original]), other.task);
  }
  assert.equal(agentTask(employee, []), employee.task);
  assert.equal(employee.name, '직접 정한 이름');
  assert.equal(employee.role, '직접 정한 역할');
  assert.equal(employee.task, 'Codex 응답 종료');
  setLanguage('ko');
  assert.equal(agentTask(employee, [original]), employee.task);
});

test('translated tool labels are plain text and do not reinterpret markup or interpolation syntax', t => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const toolName = '<img src=x onerror=alert(1)> {tool} $&';
  const record = Object.freeze(event({ type: 'agent.status', toolName, toolPhase: 'started', title: `${toolName} 실행 중` }));
  assert.equal(eventTitle(record), `Running ${toolName}`);
  assert.equal(record.title, `${toolName} 실행 중`);
});
