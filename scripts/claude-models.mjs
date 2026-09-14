#!/usr/bin/env node
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ENDPOINT, endpointUrl, opaqueId, readTranscriptEvidence } from '../integrations/claude-plugin/scripts/adapter-core.mjs';

export const MODEL_POLL_MS = 10_000;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/u;
const MAX_AGENTS = 512;
const MAX_ENTRIES = 32_768;
const MAX_READS = 128;
const MAX_STATE_BYTES = 8 * 1024 * 1024;

export function claudeProjectsDir(env = process.env) {
  return join(resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')), 'projects');
}

function time(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null; }

/** Only registry identities are eligible. A transcript never creates a new employee. */
function registeredUnknowns(state) {
  if (!Array.isArray(state?.agents)) return [];
  const results = new Map();
  for (const snapshot of state.agents.slice(0, MAX_AGENTS)) {
    if (snapshot?.source !== 'claude' || snapshot.modelEvidence === 'reported'
      || typeof snapshot.sessionId !== 'string' || !SEGMENT.test(snapshot.sessionId)
      || typeof snapshot.id !== 'string' || !snapshot.id || snapshot.id.length > 160
      || /[\u0000-\u001f]/u.test(snapshot.id) || time(snapshot.timestamp) === null) continue;
    const prefix = `claude-${opaqueId(snapshot.sessionId)}-`;
    if (typeof snapshot.agentId !== 'string' || !snapshot.agentId.startsWith(prefix)) continue;
    const suffix = snapshot.agentId.slice(prefix.length);
    if (suffix !== 'main' && !/^[a-f0-9]{16}$/u.test(suffix)) continue;
    if (snapshot.taskStartedAt !== undefined && (time(snapshot.taskStartedAt) === null
      || time(snapshot.taskStartedAt) > time(snapshot.timestamp))) continue;
    results.set(snapshot.agentId, { id: snapshot.id, agentId: snapshot.agentId,
      sessionId: snapshot.sessionId, timestamp: snapshot.timestamp,
      taskStartedAt: snapshot.taskStartedAt, suffix });
  }
  return [...results.values()];
}

async function plainPath(path, directory = false) {
  try {
    const info = await lstat(path);
    return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
      && await realpath(path) === resolve(path);
  } catch { return false; }
}

async function entries(path, budget, limit = 4096) {
  if (budget.entries <= 0 || !await plainPath(path, true)) return [];
  const result = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      budget.entries--;
      if (!entry.isSymbolicLink()) result.push(entry);
      if (result.length >= limit || budget.entries <= 0) break;
    }
  } catch { /* A disappearing or unreadable folder is retried on the next poll. */ }
  return result;
}

/** Discover names only under the requested sessions; unrelated transcript bodies are never read. */
async function transcriptCandidates(projectsDir, snapshots, budget) {
  const wanted = new Map();
  const candidates = new Map(snapshots.map(snapshot => [snapshot.agentId, []]));
  for (const snapshot of snapshots) {
    if (!wanted.has(snapshot.sessionId)) wanted.set(snapshot.sessionId, new Map());
    wanted.get(snapshot.sessionId).set(snapshot.suffix, snapshot);
  }
  function add(snapshot, path, rawAgentId) {
    const list = candidates.get(snapshot.agentId);
    if (list.length < 8) list.push({ path, rawAgentId });
  }
  async function children(directory, session) {
    for (const entry of await entries(directory, budget)) {
      if (!entry.isFile()) continue;
      const match = /^agent-([A-Za-z0-9_-][A-Za-z0-9._-]{0,119})\.jsonl$/u.exec(entry.name);
      if (!match) continue;
      const snapshot = session.get(opaqueId(match[1]));
      if (snapshot) add(snapshot, join(directory, entry.name), match[1]);
    }
  }
  for (const project of await entries(projectsDir, budget, 1024)) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    for (const entry of await entries(projectPath, budget, 8192)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const main = wanted.get(entry.name.slice(0, -6))?.get('main');
        if (main) add(main, join(projectPath, entry.name), null);
      } else if (entry.isDirectory() && wanted.has(entry.name)) {
        const session = wanted.get(entry.name);
        if ([...session.keys()].every(key => key === 'main')) continue;
        const subagents = join(projectPath, entry.name, 'subagents');
        await children(subagents, session);
        const workflows = join(subagents, 'workflows');
        for (const workflow of await entries(workflows, budget, 128)) {
          if (workflow.isDirectory()) await children(join(workflows, workflow.name), session);
        }
      }
    }
  }
  return candidates;
}

export async function collectClaudeModels(state, { projectsDir = claudeProjectsDir(), now = Date.now(),
  offset = 0, limit = MAX_AGENTS, readEvidence = readTranscriptEvidence } = {}) {
  const eligible = registeredUnknowns(state);
  const rotated = eligible.length ? [...eligible.slice(offset % eligible.length), ...eligible.slice(0, offset % eligible.length)] : [];
  const snapshots = rotated.slice(0, Math.max(1, Math.min(MAX_AGENTS, limit)));
  if (!snapshots.length) return [];
  const budget = { entries: MAX_ENTRIES, reads: MAX_READS };
  const candidates = await transcriptCandidates(resolve(projectsDir), snapshots, budget);
  const events = [];
  for (const snapshot of snapshots) {
    let newest = null;
    for (const candidate of candidates.get(snapshot.agentId)) {
      if (budget.reads <= 0) break;
      if (!await plainPath(candidate.path)) continue;
      budget.reads--;
      let evidence;
      try {
        evidence = await readEvidence(candidate.path, { agentId: candidate.rawAgentId, sessionId: snapshot.sessionId,
          since: snapshot.taskStartedAt, before: snapshot.timestamp, tailBytes: 256 * 1024 });
      } catch { continue; }
      // Validate the evidence contract again before crossing the HTTP boundary.
      const observed = time(evidence?.timestamp);
      if (typeof evidence?.model !== 'string' || !MODEL.test(evidence.model) || observed === null
        || observed > time(snapshot.timestamp) || (snapshot.taskStartedAt && observed < time(snapshot.taskStartedAt))) continue;
      if (!newest || observed > time(newest.timestamp)) newest = evidence;
    }
    if (!newest) continue;
    events.push({ id: `claude-model-${opaqueId(`${snapshot.agentId}:${snapshot.id}:${newest.model}:${newest.timestamp}`)}`,
      type: 'agent.model', source: 'claude', observation: 'claude-log', modelEvidence: 'reported',
      model: newest.model, modelObservedAt: newest.timestamp, referenceEventId: snapshot.id,
      agentId: snapshot.agentId, title: '실행 모델 확인', timestamp: new Date(now).toISOString() });
  }
  return events;
}

async function fetchState(url, { fetchImpl, signal }) {
  const response = await fetchImpl(url, { redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error('State unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('State unavailable');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STATE_BYTES) throw new Error('State exceeds metadata limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function pollClaudeModels({ endpoint = process.env.AGENT_OFFICE_ENDPOINT || DEFAULT_ENDPOINT,
  projectsDir = claudeProjectsDir(), dryRun = false, fetchImpl = fetch, now = Date.now(),
  signal, offset = 0, limit = MAX_AGENTS } = {}) {
  const target = endpointUrl(endpoint);
  const stateUrl = new URL('/api/state', target);
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  const state = await fetchState(stateUrl, { fetchImpl, signal: requestSignal() });
  const events = await collectClaudeModels(state, { projectsDir, now, offset, limit });
  if (!dryRun) {
    for (const event of events) {
      const response = await fetchImpl(target, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event), redirect: 'error', signal: requestSignal() });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Model receiver unavailable');
    }
  }
  return events;
}

/** Serial polling retries failed reads and sends. No transcripts, cursors, or raw payloads are persisted. */
export function createClaudeModelCollector({ poll = pollClaudeModels, intervalMs = MODEL_POLL_MS,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let stopped = false, running = false, timer, offset = 0;
  const controller = new AbortController();
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { await poll({ signal: controller.signal, offset, limit: 64 }); } catch { /* Quiet retry; never affect the original Claude task. */ }
    finally {
      running = false; offset = (offset + 64) % MAX_AGENTS;
      if (!stopped) timer = schedule(tick, Math.max(1000, intervalMs));
    }
  }
  return { start: tick, stop() { stopped = true; if (timer) cancel(timer); controller.abort(); }, get running() { return running; } };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--once', '--dry-run'].includes(arg)) || args.includes('--dry-run') && !args.includes('--once')) {
    process.stderr.write('사용법: node scripts/claude-models.mjs [--once [--dry-run]]\n'); process.exitCode = 1; return;
  }
  if (args.includes('--once')) {
    try {
      const events = await pollClaudeModels({ dryRun: args.includes('--dry-run') });
      if (args.includes('--dry-run')) process.stdout.write(`${JSON.stringify(events)}\n`);
    } catch { process.exitCode = 1; }
    return;
  }
  const collector = createClaudeModelCollector();
  process.once('SIGINT', () => collector.stop()); process.once('SIGTERM', () => collector.stop());
  await collector.start();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
