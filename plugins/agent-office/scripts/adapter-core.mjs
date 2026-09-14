import { createHash } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyActivity } from './activity-kind.mjs';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4780/api/events';
export const INPUT_LIMIT = 2 * 1024 * 1024;
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/u;
const START_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
// ASCII control characters (U+0000..U+001F) are never allowed in paths that reach the office.
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'u');
const KNOWN_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'SendMessage', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'NotebookEdit', 'apply_patch', 'spawn_agent', 'send_message', 'wait_agent', 'exec_command', 'update_plan']);

export function opaqueId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0,16);
}

export function endpointUrl(value = DEFAULT_ENDPOINT) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/api/events' || url.search || url.hash) {
    throw new Error('로컬 /api/events 주소만 사용할 수 있습니다.');
  }
  return url;
}

export async function postEvent(event, { endpoint = process.env.AGENT_OFFICE_ENDPOINT || DEFAULT_ENDPOINT, timeout = 900 } = {}) {
  const url = endpointUrl(endpoint);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`사무실 서버 응답: ${response.status}`);
}

export async function readJsonInput(stream = process.stdin) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > INPUT_LIMIT) throw new Error('입력 크기 제한을 초과했습니다.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function toolLabel(value) {
  if (KNOWN_TOOLS.has(value)) return value;
  return typeof value === 'string' && value.startsWith('mcp__') ? 'MCP 도구' : '도구';
}

function roleLabel(value) {
  if (['Explore', 'explorer', 'researcher'].includes(value)) return '리서치';
  if (['Plan', 'planner'].includes(value)) return '기획';
  if (['reviewer', 'code-reviewer'].includes(value)) return '검토';
  return '개발';
}

export function normalizeLifecycle(payload, source = 'claude', timestamp = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['claude', 'codex'].includes(source)) return null;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return null;
  const session = opaqueId(payload.session_id);
  const agent = typeof payload.agent_id === 'string' && payload.agent_id ? opaqueId(payload.agent_id) : 'main';
  const label = source === 'claude' ? 'Claude' : 'Codex';
  const base = {
    source,
    agentId: source === 'codex' ? `codex-${agent === 'main' ? session : agent}-main` : `${source}-${session}-${agent}`,
    agentName: source === 'codex' ? `Codex 직원 ${(agent === 'main' ? session : agent).slice(0,4)}` : agent === 'main' ? `${label} 팀장 ${session.slice(0,4)}` : `${label} 직원 ${agent.slice(0,4)}`,
    role: agent === 'main' ? '총괄' : roleLabel(payload.agent_type),
    timestamp,
    sessionId: payload.session_id,
    observation: 'hook',
    modelEvidence: 'unknown',
  };
  if (typeof payload.cwd === 'string' && payload.cwd.startsWith('/') && !CONTROL_CHARACTERS.test(payload.cwd)) {
    const projectPath = resolve(payload.cwd);
    base.projectId = `project-${opaqueId(projectPath)}`;
    base.projectName = basename(projectPath).slice(0,100) || '기본 프로젝트';
  }
  if (agent !== 'main') {
    base.parentAgentId = source === 'codex' ? `codex-${session}-main` : `${source}-${session}-main`;
  }
  // Subagent lifecycle hooks may report the parent's active model. Never assign it to the child.
  const isParentScopedSubagentEvent = ['SubagentStart','SubagentStop'].includes(payload.hook_event_name);
  if (!isParentScopedSubagentEvent && typeof payload.model === 'string' && MODEL_PATTERN.test(payload.model)) {
    base.model = payload.model;
    base.modelEvidence = 'reported';
  }
  // Codex 하위 에이전트의 도구 hook은 자신의 session_id만 제공할 수 있습니다.
  // 별도 agent_type 없는 후속 이벤트가 시작 시 받은 역할을 덮어쓰지 않습니다.
  if (source === 'codex' && !payload.agent_type) delete base.role;
  if (!isParentScopedSubagentEvent && (payload.turn_id || payload.prompt_id)) base.taskId = `${source}-turn-${opaqueId(`${payload.session_id}:${payload.turn_id || payload.prompt_id}`)}`;
  const tool = toolLabel(payload.tool_name);
  if (payload.tool_name) base.toolName = tool;
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(payload.hook_event_name)) {
    base.activityKind = classifyActivity(payload.tool_name, payload.tool_input);
  }
  const state = (type, status, title) => ({ ...base, type, status, title });
  switch (payload.hook_event_name) {
    case 'SessionStart': return state('agent.started', 'idle', '세션 시작');
    case 'UserPromptSubmit': return state('user.instruction', 'thinking', '사장님의 새 업무 지시 접수');
    case 'SubagentStart':
      if (agent === 'main') return null;
      return state('agent.started', 'working', '하위 에이전트 시작');
    case 'PreToolUse': return state('agent.status', 'working', `${tool} 실행 중`);
    case 'PostToolUse': return state('agent.status', 'thinking', `${tool} 결과 수신`);
    case 'PostToolUseFailure': return state('agent.status', 'error', `${tool} 실행 실패`);
    case 'PermissionRequest': return state('approval.requested', 'approval', `${tool} 승인 요청`);
    case 'Notification':
      if (payload.notification_type === 'permission_prompt') return state('approval.requested', 'approval', '도구 승인 요청');
      if (['idle_prompt', 'agent_needs_input'].includes(payload.notification_type)) return state('agent.status', 'waiting', '사용자 입력 대기');
      return null;
    case 'SubagentStop':
      if (agent === 'main') return null;
      return state('agent.completed', 'done', '하위 에이전트 응답 종료');
    case 'Stop': return state('agent.completed', 'done', '응답 종료');
    case 'StopFailure': return state('agent.status', 'error', '응답 중 오류 발생');
    case 'Interrupt': return state('agent.status', 'waiting', '사용자가 작업 중단');
    case 'SessionEnd': return state('session.ended', 'idle', '세션 종료');
    default: return null;
  }
}

function localTranscriptPath(value) {
  return typeof value === 'string' && value.startsWith('/') && value.endsWith('.jsonl') && !CONTROL_CHARACTERS.test(value) ? value : null;
}

function validPathSegment(value) {
  return typeof value === 'string' && value !== '.' && value !== '..' && PATH_SEGMENT.test(value);
}

function timestampValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 실행 직원과 세션이 일치하는 assistant 모델 증거만 반환합니다.
 * 원문은 저장하지 않으며, 시간 경계가 주어지면 그 실행 구간 안의 기록만 인정합니다.
 */
export async function readTranscriptEvidence(path, { agentId = null, sessionId, since, before, tailBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  const file = localTranscriptPath(path);
  if (!file || !validPathSegment(sessionId) || agentId !== null && !validPathSegment(agentId)) return null;
  const lower = since === undefined ? -Infinity : timestampValue(since);
  const upper = before === undefined ? Infinity : timestampValue(before);
  if (lower === null || upper === null || lower > upper || !Number.isFinite(tailBytes) || tailBytes <= 0) return null;
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const length = Math.min(stat.size, Math.floor(tailBytes), TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"assistant"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || record.type !== 'assistant' || record.sessionId !== sessionId) continue;
      const own = agentId === null ? record.isSidechain === false && record.agentId === undefined : record.agentId === agentId;
      if (!own) continue;
      const timestamp = typeof record.timestamp === 'string' ? timestampValue(record.timestamp) : null;
      if (timestamp === null) return null;
      if (timestamp < lower || timestamp > upper) continue;
      const model = record.message?.model;
      return typeof model === 'string' && MODEL_PATTERN.test(model) ? { model, timestamp: new Date(timestamp).toISOString() } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** 기존 model/null 반환 형식을 유지하며 직원·세션·시각 검증을 공유합니다. */
export async function readTranscriptModel(path, options = {}) {
  return (await readTranscriptEvidence(path, options))?.model ?? null;
}

/** 하위 직원의 후보에는 부모 파일 또는 같은 파일을 가리키는 심볼릭 링크를 포함하지 않습니다. */
export async function claudeTranscriptCandidates(payload, { list = readdir } = {}) {
  if (!validPathSegment(payload?.session_id)) return [];
  const main = localTranscriptPath(payload?.transcript_path);
  const agentId = typeof payload?.agent_id === 'string' && payload.agent_id ? payload.agent_id : null;
  if (agentId === null) return main ? [main] : [];
  if (!validPathSegment(agentId)) return [];
  const candidates = [];
  const own = localTranscriptPath(payload.agent_transcript_path);
  if (own) candidates.push(own);
  if (main) {
    const subagents = join(dirname(main), payload.session_id, 'subagents');
    const file = `agent-${agentId}.jsonl`;
    candidates.push(join(subagents, file));
    let workflows = [];
    try { workflows = await list(join(subagents, 'workflows')); } catch { workflows = []; }
    for (const entry of workflows) if (validPathSegment(entry)) candidates.push(join(subagents, 'workflows', entry, file));
  }
  const parent = main ? await realpath(main).catch(() => resolve(main)) : null;
  const accepted = [];
  for (const candidate of new Set(candidates)) {
    const actualPath = await realpath(candidate).catch(() => resolve(candidate));
    if (parent !== null && actualPath === parent) continue;
    accepted.push(candidate);
  }
  return accepted;
}

/** 시작 hook의 과거 기록은 모델 근거가 아니며, 후속 hook은 해당 직원의 최신 유효 증거만 사용합니다. */
export async function resolveClaudeModel(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || START_HOOKS.has(payload.hook_event_name)) return null;
  if (!validPathSegment(payload.session_id)) return null;
  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : null;
  let latest = null;
  for (const path of await claudeTranscriptCandidates(payload, options)) {
    const evidence = await readTranscriptEvidence(path, { agentId, sessionId: payload.session_id,
      since: options.since, before: options.before, tailBytes: options.tailBytes });
    if (evidence && (!latest || evidence.timestamp > latest.timestamp)) latest = evidence;
  }
  return latest?.model ?? null;
}

export async function runLifecycleHook(source) {
  // 관측 실패는 원래 작업을 막지 않으며 hook 제어 출력을 내보내지 않습니다.
  const deadline = setTimeout(() => process.exit(0), 1800);
  try {
    const payload = await readJsonInput();
    const event = normalizeLifecycle(payload, source);
    if (event) {
      if (source === 'claude' && event.modelEvidence === 'unknown' && !START_HOOKS.has(payload.hook_event_name)) {
        const model = await resolveClaudeModel(payload, { before: event.timestamp });
        if (model) { event.model = model; event.modelEvidence = 'reported'; }
      }
      await postEvent(event);
    }
  } catch {
    // 입력 내용과 오류 원문을 로그에 기록하지 않습니다.
  } finally {
    clearTimeout(deadline);
    process.exitCode = 0;
  }
}
