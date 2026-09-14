#!/usr/bin/env node
// Experimental read-only observer for Claude Code's local transcript metadata.
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeProjectsDir } from './claude-models.mjs';
import { DEFAULT_ENDPOINT, endpointUrl, opaqueId } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { classifyActivity } from '../integrations/claude-plugin/scripts/activity-kind.mjs';

export const CLAUDE_POLL_MS = 2000;
export const CLAUDE_DISCOVERY_MS = 15_000;
const NEW_SESSION_WINDOW_MS = 120_000;
const TAIL_BYTES = 256 * 1024;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/u;
const TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'SendMessage', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'NotebookEdit']);
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const employeeId = (sessionId, raw = null) => `claude-${opaqueId(sessionId)}-${raw === null ? 'main' : opaqueId(raw)}`;
const registrationId = (id, timestamp) => `claude-log-${opaqueId(`${id}:registered:${timestamp}`)}`;
const actionId = (id, action) => `claude-log-${opaqueId(`${id}:${action.recordKey}:${action.type}:${action.timestamp}`)}`;
const labelTool = value => TOOLS.has(value) ? value : typeof value === 'string' && value.startsWith('mcp__') ? 'MCP 도구' : '도구';

async function plainInfo(path, directory = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
      || await realpath(path) !== resolve(path)) return null;
    return info;
  } catch { return null; }
}

async function entries(path, budget, max = 4096) {
  if (budget.entries <= 0 || !await plainInfo(path, true)) return [];
  const result = [];
  try {
    for await (const item of await opendir(path)) {
      budget.entries--;
      if (!item.isSymbolicLink()) result.push(item);
      if (result.length >= max || budget.entries <= 0) break;
    }
  } catch { /* Missing/inaccessible directories are retried on the next poll. */ }
  return result;
}

async function discoverFiles(projectsDir, previous, cutoff, budget) {
  const files = [], sessions = new Map();
  for (const entry of previous.values()) if (typeof entry.sessionId === 'string') sessions.set(entry.sessionId, true);
  const sessionDirectories = [];
  async function candidate(path, sessionId, rawAgentId = null) {
    if (files.length >= 512) return;
    const info = await plainInfo(path);
    if (!info || (!previous.has(employeeId(sessionId, rawAgentId)) && info.mtimeMs < cutoff)) return;
    files.push({ path, sessionId, rawAgentId, modifiedAt: info.mtimeMs });
  }
  for (const project of await entries(projectsDir, budget, 1024)) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    for (const entry of await entries(projectPath, budget, 8192)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && SEGMENT.test(entry.name.slice(0, -6))) {
        await candidate(join(projectPath, entry.name), entry.name.slice(0, -6));
      } else if (entry.isDirectory() && SEGMENT.test(entry.name)) {
        const path = join(projectPath, entry.name), info = await plainInfo(path, true);
        if (info && (sessions.has(entry.name) || info.mtimeMs >= cutoff)) sessionDirectories.push({ path, sessionId: entry.name });
      }
    }
  }
  async function children(path, sessionId) {
    for (const entry of await entries(path, budget)) {
      const match = entry.isFile() && /^agent-([A-Za-z0-9_-][A-Za-z0-9._-]{0,119})\.jsonl$/u.exec(entry.name);
      if (match) await candidate(join(path, entry.name), sessionId, match[1]);
    }
  }
  for (const session of sessionDirectories.slice(0, 128)) {
    const subagents = join(session.path, 'subagents');
    await children(subagents, session.sessionId);
    for (const flow of await entries(join(subagents, 'workflows'), budget, 128)) {
      if (flow.isDirectory()) await children(join(subagents, 'workflows', flow.name), session.sessionId);
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function ownRecord(record, file) {
  if (!record || typeof record !== 'object' || record.sessionId !== file.sessionId) return false;
  if (file.rawAgentId !== null) return record.agentId === file.rawAgentId;
  return record.agentId === undefined && record.isSidechain !== true;
}

/** Convert immediately to fixed metadata. Message text, tool inputs, and account fields never leave this function. */
function actionForRecord(record, file, info, cutoff, now, pendingTools) {
  if (!ownRecord(record, file)) return null;
  let timestamp = isoTime(record.timestamp);
  if (timestamp === null && record.type === 'bridge-session' && info.birthtimeMs >= cutoff) timestamp = info.birthtimeMs;
  if (timestamp === null || timestamp > now + 60_000) return null;
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const content = Array.isArray(message.content) ? message.content.filter(item => item && typeof item === 'object') : [];
  let type = 'agent.status', status = 'idle', title;
  let toolName, activityKind, reclassifiedFrom, inputRecorded = false;
  const kindOf = tools => {
    const kinds = new Set(tools.map(tool => tool.activityKind));
    return kinds.size === 1 ? [...kinds][0] : 'general';
  };
  if (record.type === 'bridge-session') title = 'Claude 대화 기록 연결';
  else if (record.type === 'user') {
    if (record.isMeta === true) return null;
    // Claude writes an exact synthetic marker when the user interrupts, not a new prompt.
    const interrupted = record.origin === undefined && record.promptSource === undefined
      && content.length === 1 && content[0].type === 'text' && content[0].text === '[Request interrupted by user]';
    if (interrupted) {
      type = 'agent.completed'; status = 'idle'; title = 'Claude 응답 중단';
      reclassifiedFrom = file.rawAgentId === null ? 'user.instruction' : 'agent.status';
      pendingTools.clear();
    } else if (record.toolEndsTurn === true && content.some(item => item.type === 'tool_result')) {
      type = 'agent.completed'; status = 'idle'; title = 'Claude 응답 종료';
      reclassifiedFrom = 'agent.status'; pendingTools.clear();
    } else if (content.some(item => item.type === 'tool_result')) {
      const results = content.filter(item => item.type === 'tool_result');
      const completed = results.map(item => {
        const own = pendingTools.get(item.tool_use_id) ?? { activityKind: 'general' };
        pendingTools.delete(item.tool_use_id); return { ...own, failed: item.is_error === true };
      });
      const failed = completed.filter(tool => tool.failed);
      const remaining = [...pendingTools.values()];
      status = failed.length ? 'error' : remaining.length ? 'working' : 'thinking';
      title = failed.length ? '도구 실행 실패' : remaining.length ? '다른 도구 실행 중' : '도구 결과 수신';
      const observed = failed.length ? failed : remaining.length ? remaining : completed;
      activityKind = kindOf(observed);
      if (observed.length === 1) toolName = observed[0].toolName;
    }
    else if (!record.sourceToolUseID && !record.sourceToolAssistantUUID && !record.toolUseResult
      && (typeof message.content === 'string' || content.some(item => item.type === 'text'))) {
      type = file.rawAgentId === null ? 'user.instruction' : 'agent.status'; status = 'thinking'; title = '새 업무 입력 기록';
      inputRecorded = true;
      activityKind = 'general'; pendingTools.clear();
    } else return null;
  } else if (record.type === 'assistant') {
    const tools = content.filter(item => item.type === 'tool_use');
    if (tools.length) {
      const observed = tools.map(tool => ({ toolName: labelTool(tool.name), activityKind: classifyActivity(tool.name, tool.input) }));
      for (let index = 0; index < tools.length; index++) {
        if (typeof tools[index].id === 'string') pendingTools.set(tools[index].id, observed[index]);
        if (pendingTools.size > 128) pendingTools.delete(pendingTools.keys().next().value);
      }
      status = 'working'; toolName = observed[0].toolName; activityKind = kindOf(observed); title = `${toolName} 실행 기록`;
    }
    else if (['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(message.stop_reason)
      && !content.every(item => item.type === 'thinking' || item.type === 'redacted_thinking')) {
      type = 'agent.completed'; status = 'idle'; title = 'Claude 응답 종료';
      pendingTools.clear();
    } else { status = 'thinking'; title = 'Claude 응답 기록 중'; }
  } else return null;
  const action = { type, status, title, timestamp: new Date(timestamp).toISOString(), modelEvidence: 'unknown' };
  if (inputRecorded) action.inputRecorded = true;
  if (reclassifiedFrom) action.reclassifiedFrom = reclassifiedFrom;
  if (toolName) action.toolName = toolName;
  if (activityKind) action.activityKind = activityKind;
  if (record.type === 'assistant' && typeof message.model === 'string' && MODEL.test(message.model)) {
    action.model = message.model; action.modelEvidence = 'reported'; action.modelObservedAt = action.timestamp;
  }
  if (typeof record.cwd === 'string' && record.cwd.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(record.cwd)) {
    const cwd = resolve(record.cwd);
    action.projectId = `project-${opaqueId(cwd)}`;
    action.projectName = basename(cwd).slice(0, 100) || '기본 프로젝트';
  }
  // UUID is only hashed for deduplication; no transcript content participates in the event payload.
  action.recordKey = typeof record.uuid === 'string' ? opaqueId(record.uuid) : opaqueId(`${record.type}:${action.timestamp}:${message.stop_reason || ''}`);
  return action;
}

async function readActions(file, budget, cutoff, now) {
  if (budget.bytes <= 0) return [];
  let handle;
  try {
    if (!await plainInfo(file.path)) return [];
    handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) return [];
    const length = Math.min(info.size, TAIL_BYTES, budget.bytes); budget.bytes -= length;
    const buffer = Buffer.alloc(length); const start = info.size - length;
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines.at(-1) !== '') lines.pop(); // Wait for complete JSONL records; partial writes are never inferred.
    const actions = [], pendingMessages = new Set(), pendingTools = new Map();
    for (const line of lines) {
      try {
        const record = JSON.parse(line), action = actionForRecord(record, file, info, cutoff, now, pendingTools);
        if (!action) continue;
        const content = Array.isArray(record.message?.content) ? record.message.content : [];
        const communication = (suffix, title, toolName) => {
          const { status, inputRecorded, reclassifiedFrom, ...metadata } = action;
          delete metadata.toolName;
          delete metadata.activityKind;
          actions.push({ ...metadata, type: 'message.sent', title, recordKey: `${action.recordKey}:${suffix}`,
            ...(toolName ? { toolName } : {}) });
        };
        if (record.type === 'assistant') {
          const visible = !['analysis', 'thinking'].includes(record.message?.channel)
            && !['analysis', 'thinking'].includes(record.channel);
          for (let index = 0; index < content.length; index++) {
            const item = content[index];
            if (visible && item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) communication(`text:${index}`, '메시지 전송 기록');
            if (item?.type === 'tool_use' && item.name === 'SendMessage' && typeof item.id === 'string') pendingMessages.add(item.id);
          }
        } else if (record.type === 'user') {
          for (const item of content) if (item?.type === 'tool_result' && pendingMessages.delete(item.tool_use_id) && item.is_error !== true) {
            communication(`tool:${opaqueId(item.tool_use_id)}`, '메시지 전달 요청 · 수신자 미확인', 'SendMessage');
          }
        }
        // Keep the original lifecycle event last, including explicit response completion.
        actions.push(action);
      } catch { /* Invalid/partial records are ignored. */ }
    }
    return actions.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  } catch { return []; }
  finally { await handle?.close().catch(() => {}); }
}

export async function collectClaudeEvents(state, { projectsDir = claudeProjectsDir(), now = Date.now(), startedAt = now, seenMessages = new Map(), discoveryCache } = {}) {
  const previous = new Map((Array.isArray(state?.agents) ? state.agents : []).filter(agent => agent?.source === 'claude').slice(0, 512).map(agent => [agent.agentId, agent]));
  const cutoff = Math.max(startedAt, now) - NEW_SESSION_WINDOW_MS;
  const seen = new Set([...seenMessages.keys(), ...(Array.isArray(state?.events) ? state.events.map(event => event?.id) : [])]);
  const budget = { entries: 32_768, bytes: 8 * 1024 * 1024 };
  const output = [], known = new Map(previous);
  const directory = resolve(projectsDir);
  const readOrder = discoveryCache?.readOrder instanceof Map ? discoveryCache.readOrder : new Map();
  let readSequence = discoveryCache?.readSequence ?? 0;
  if (discoveryCache) discoveryCache.readOrder = readOrder;
  let files = discoveryCache?.files;
  if (!Array.isArray(files) || discoveryCache.projectsDir !== directory || now >= discoveryCache.nextAt || now < discoveryCache.scannedAt) {
    files = await discoverFiles(directory, previous, cutoff, budget);
    const retained = new Set(files.map(file => file.path));
    for (const path of readOrder.keys()) if (!retained.has(path)) readOrder.delete(path);
    if (discoveryCache) Object.assign(discoveryCache, { projectsDir: directory, files, scannedAt: now, nextAt: now + CLAUDE_DISCOVERY_MS });
  }
  // Read every discovered file in turn: unchanged large tails must not consume every poll's budget.
  // Keep ordering across discovery refreshes while retaining the bounded 512-file inventory and 8 MiB reads.
  const orderedFiles = [...files].sort((a, b) => (readOrder.get(a.path) ?? -1) - (readOrder.get(b.path) ?? -1)
    || b.modifiedAt - a.modifiedAt);
  // readActions still validates each tracked path before reading, including after replacement or removal.
  for (const file of orderedFiles) {
    if (budget.bytes < TAIL_BYTES) break; // Defer rather than truncate this file's normal tail to the remaining budget.
    readOrder.set(file.path, ++readSequence);
    if (discoveryCache) discoveryCache.readSequence = readSequence;
    const id = employeeId(file.sessionId, file.rawAgentId), snapshot = known.get(id);
    const after = Math.max(isoTime(snapshot?.lastEventAt) ?? -Infinity, isoTime(snapshot?.timestamp) ?? cutoff - 1);
    const observed = await readActions(file, budget, cutoff, now);
    const acknowledged = observed.findIndex(action => actionId(id, action) === snapshot?.id);
    const onlyRegistered = snapshot?.id === registrationId(id, snapshot?.timestamp);
    let actions = observed.filter((action, index) => {
      const timestamp = Date.parse(action.timestamp);
      if (action.type === 'message.sent') return timestamp >= Math.max(cutoff, startedAt) && !seen.has(actionId(id, action));
      if (timestamp < cutoff && action.type !== 'agent.completed') return false;
      // Repair only this exact previously misclassified transcript record, retaining its observed time.
      const reclassified = action.reclassifiedFrom && snapshot?.observation === 'claude-log'
        && snapshot.id === actionId(id, { ...action, type: action.reclassifiedFrom });
      return timestamp > after || timestamp === after && (onlyRegistered || reclassified || acknowledged >= 0 && index > acknowledged);
    }).slice(-64);
    if (!actions.length) continue;
    const closed = snapshot?.sessionEnded === true || snapshot?.retired === true;
    if (closed) {
      // Delayed output and tool results belong to the closed work; only fresh own input proves reentry.
      const newInput = actions.findIndex(action => action.inputRecorded === true && Date.parse(action.timestamp) >= cutoff);
      if (newInput < 0) continue;
      actions = actions.slice(newInput);
    }
    const base = { source: 'claude', agentId: id, sessionId: file.sessionId, observation: 'claude-log',
      agentName: file.rawAgentId === null ? `Claude 팀장 ${opaqueId(file.sessionId).slice(0, 4)}` : `Claude 직원 ${opaqueId(file.rawAgentId).slice(0, 4)}`,
      role: file.rawAgentId === null ? '총괄' : '하위 에이전트', sessionName: `Claude 대화 ${opaqueId(file.sessionId).slice(0, 4)}`,
      ...(file.rawAgentId === null ? {} : { parentAgentId: employeeId(file.sessionId) }) };
    const project = [...actions].reverse().find(action => action.projectId);
    if (project) { base.projectId = project.projectId; base.projectName = project.projectName; }
    if (!snapshot || closed) {
      output.push({ ...base, type: 'agent.started', status: 'idle', modelEvidence: 'unknown',
        timestamp: actions[0].timestamp, title: 'Claude 대화 기록 연결', id: registrationId(id, actions[0].timestamp) });
    }
    for (const { recordKey, inputRecorded, reclassifiedFrom, ...action } of actions) {
      // Metadata-only bridge records establish a new conversation; they never overwrite live hook state.
      if (action.title === 'Claude 대화 기록 연결') continue;
      output.push({ ...base, ...action, id: actionId(id, { ...action, recordKey }) });
    }
    known.set(id, { timestamp: actions.at(-1).timestamp });
  }
  return output.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

async function readState(response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error('State unavailable'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 8 * 1024 * 1024) throw new Error('State exceeds limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function pollClaudeObserver({ endpoint = process.env.AGENT_OFFICE_ENDPOINT || DEFAULT_ENDPOINT,
  projectsDir = claudeProjectsDir(), now = Date.now(), startedAt = now, dryRun = false, fetchImpl = fetch, signal, seenMessages = new Map(), discoveryCache } = {}) {
  const target = endpointUrl(endpoint);
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  const state = await readState(await fetchImpl(new URL('/api/state', target), { redirect: 'error', signal: requestSignal() }));
  const events = await collectClaudeEvents(state, { projectsDir, now, startedAt, seenMessages, discoveryCache });
  if (!dryRun) for (const event of events) {
    const response = await fetchImpl(target, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event), redirect: 'error', signal: requestSignal() });
    await response.body?.cancel(); if (!response.ok) throw new Error('Observer receiver unavailable');
    if (event.type === 'message.sent') seenMessages.set(event.id, now);
  }
  for (const [id, timestamp] of seenMessages) if (timestamp < now - NEW_SESSION_WINDOW_MS) seenMessages.delete(id);
  while (seenMessages.size > 4096) seenMessages.delete(seenMessages.keys().next().value);
  return events;
}

export function createClaudeObserver({ poll = pollClaudeObserver, intervalMs = CLAUDE_POLL_MS,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let stopped = false, running = false, timer;
  const seenMessages = new Map();
  const discoveryCache = {};
  const startedAt = Date.now(), controller = new AbortController();
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { await poll({ startedAt, signal: controller.signal, seenMessages, discoveryCache }); } catch { /* Quiet serial retry; original Claude tasks are unaffected. */ }
    finally { running = false; if (!stopped) timer = schedule(tick, Math.max(1000, intervalMs)); }
  }
  return { start: tick, stop() { stopped = true; if (timer) cancel(timer); controller.abort(); }, get running() { return running; } };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--once', '--dry-run'].includes(arg)) || args.includes('--dry-run') && !args.includes('--once')) {
    process.stderr.write('사용법: node scripts/claude-observer.mjs [--once [--dry-run]]\n'); process.exitCode = 1; return;
  }
  if (args.includes('--once')) {
    try { const events = await pollClaudeObserver({ dryRun: args.includes('--dry-run') }); if (args.includes('--dry-run')) process.stdout.write(`${JSON.stringify(events)}\n`); }
    catch { process.exitCode = 1; }
    return;
  }
  const observer = createClaudeObserver();
  process.once('SIGINT', () => observer.stop()); process.once('SIGTERM', () => observer.stop());
  await observer.start();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
