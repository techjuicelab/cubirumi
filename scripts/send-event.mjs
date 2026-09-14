#!/usr/bin/env node
import { postEvent, readJsonInput } from '../integrations/claude-plugin/scripts/adapter-core.mjs';

// JSON 객체 하나를 stdin으로 받는 명시적 전송 명령입니다.
try {
  const input = await readJsonInput();
  const fields = ['source', 'type', 'agentId', 'agentName', 'role', 'status', 'title', 'toAgentId', 'toAgentName', 'taskId', 'id', 'timestamp', 'projectId', 'projectName', 'sessionId', 'sessionName', 'parentAgentId', 'model', 'modelEvidence', 'observation', 'toolName'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON 객체를 입력해 주세요.');
  const event = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  if (!['codex', 'claude', 'manual'].includes(event.source) || !['agent.started', 'agent.status', 'agent.completed', 'handoff', 'approval.requested', 'approval.resolved', 'task.created', 'user.instruction', 'agent.retired', 'session.ended'].includes(event.type)) throw new Error('source 또는 type이 올바르지 않습니다.');
  if (typeof event.agentId !== 'string' || !event.agentId || typeof event.title !== 'string' || !event.title || event.title.length > 160) throw new Error('agentId와 160자 이하 title이 필요합니다.');
  if (event.type === 'handoff' && (typeof event.toAgentId !== 'string' || !event.toAgentId)) throw new Error('handoff에는 toAgentId가 필요합니다.');
  await postEvent(event);
  process.stdout.write('사무실에 이벤트를 전달했습니다.\n');
} catch (error) {
  process.stderr.write(`이벤트 전송 실패: ${error instanceof Error ? error.message : '알 수 없는 오류'}\n`);
  process.exitCode = 1;
}
