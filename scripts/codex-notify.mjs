#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { opaqueId, postEvent, INPUT_LIMIT } from '../integrations/claude-plugin/scripts/adapter-core.mjs';

export function normalizeCodexNotify(payload, timestamp = new Date().toISOString()) {
  if (!payload || payload.type !== 'agent-turn-complete' || typeof payload['thread-id'] !== 'string' || !payload['thread-id']) return null;
  const session = opaqueId(payload['thread-id']);
  const event = {
    source: 'codex',
    type: 'agent.completed',
    agentId: `codex-${session}-main`,
    agentName: `Codex 직원 ${session.slice(0,4)}`,
    status: 'done',
    title: '응답 종료 (notify)',
    timestamp,
    sessionId: payload['thread-id'],
    observation: 'hook',
    modelEvidence: 'unknown',
  };
  if (payload['turn-id']) {
    event.taskId = `codex-turn-${opaqueId(`${payload['thread-id']}:${payload['turn-id']}`)}`;
    event.id = `codex-notify-${opaqueId(`${payload['thread-id']}:${payload['turn-id']}`)}`;
  }
  return event;
}

export async function main() {
  const deadline = setTimeout(() => process.exit(0), 1800);
  try {
    const input = process.argv[2] || '';
    if (Buffer.byteLength(input) > INPUT_LIMIT) return;
    const event = normalizeCodexNotify(JSON.parse(input));
    if (event) await postEvent(event);
  } catch {
    // 외부 관측기는 작업 실패나 알림 재시도를 유발하지 않습니다.
  } finally {
    clearTimeout(deadline);
    process.exitCode = 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
