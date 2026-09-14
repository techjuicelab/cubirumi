import {
  appendFileSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';

const JOURNAL_LIMIT = 5000;
const JOURNAL_COMPACTION_BATCH = 256;
const REGISTRY_LIMIT = 512;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SESSION_AUTHORITY = { manual: 0, hook: 1, 'codex-log': 2, 'claude-log': 2, 'app-server': 3 };

function assertRegularFile(path) {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error('Persistent data must use private regular files');
  }
}

function atomicWrite(path, content) {
  assertRegularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function serializeJournal(events) {
  return events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

/** Metadata-only local persistence. No disk access unless dataDir was explicitly provided. */
export function createEventStore({ dataDir, initialEvents = [], normalize }) {
  const history = [];
  const journal = [];
  const registry = new Map();
  const ids = new Map();
  let lastReceivedAt = null;
  let lastWriteAt = null;
  let healthy = true;
  let recoveredRecords = 0;
  let journalPath;
  let registryPath;
  let directory;
  let journalDiskEntries = 0;

  function updateRegistry(event) {
    // A visible message is communication evidence, never a lifecycle or model update.
    if (event.type === 'message.sent') return;
    const manualInstruction = event.source === 'manual' && event.type === 'user.instruction';
    if (manualInstruction) {
      const targetId = event.toAgentId ?? event.agentId;
      const targets = [...registry.values()].filter(agent => agent.agentId === targetId && agent.agentId !== 'boss');
      // Owner provenance does not identify a provider. Only a unique, observed employee can be updated.
      if (targets.length !== 1) return;
      const target = targets[0];
      event = { ...event, source: target.source, agentId: target.agentId, observation: 'manual',
        modelEvidence: 'unknown', model: undefined, modelObservedAt: undefined };
      for (const field of ['agentName', 'role', 'projectId', 'projectName', 'sessionId', 'sessionName', 'parentAgentId']) event[field] = target[field];
    }
    const key = `${event.source}:${event.agentId}`;
    const previous = registry.get(key);
    if (event.type === 'agent.model') {
      if (!previous || previous.id !== event.referenceEventId
        || (previous.taskStartedAt && Date.parse(event.modelObservedAt) < Date.parse(previous.taskStartedAt))
        || (previous.modelObservedAt && Date.parse(event.modelObservedAt) < Date.parse(previous.modelObservedAt))) return;
      // A transcript proof corrects metadata, never creates a worker or advances reported activity.
      registry.set(key, { ...previous, model: event.model, modelEvidence: 'reported', modelObservedAt: event.modelObservedAt });
      return;
    }
    // Apply a session boundary per employee before checking the sender's own newer turn.
    // Model-only corrections never advance lastEventAt and cannot suppress a real closure.
    if (event.type === 'session.ended' && event.sessionId) {
      for (const agent of registry.values()) {
        if (agent.source === event.source && agent.sessionId === event.sessionId
          && Date.parse(agent.lastEventAt ?? agent.timestamp) <= Date.parse(event.timestamp)) {
          agent.sessionEnded = true;
          agent.status = 'idle';
          agent.lastEventAt = event.timestamp;
          delete agent.activityKind;
        }
      }
    }
    // Match the UI: late history cannot replace a newer lifecycle snapshot; ties keep arrival order.
    if (previous && Date.parse(event.timestamp) < Date.parse(previous.lastEventAt ?? previous.timestamp)) return;
    const record = { ...previous, ...event, lastEventAt: event.timestamp };
    const claudeInstruction = event.source === 'claude' && event.type === 'user.instruction';
    const newTask = manualInstruction || claudeInstruction || (Boolean(event.taskId) && event.taskId !== previous?.taskId);
    if (manualInstruction || claudeInstruction) record.taskStartedAt = event.timestamp;
    if (event.modelEvidence !== 'reported' && previous?.modelEvidence === 'reported' && !newTask) {
      record.model = previous.model;
      record.modelEvidence = 'reported';
    } else if (event.modelEvidence !== 'reported' && newTask) {
      delete record.model;
      delete record.modelObservedAt;
    }
    if (event.modelEvidence === 'reported' && event.modelObservedAt === undefined
      && (newTask || event.model !== previous?.model)) delete record.modelObservedAt;
    const previousSessionObservation = previous?.sessionObservation ?? previous?.observation ?? 'manual';
    const sessionObservation = event.observation ?? 'manual';
    if (event.sessionId) {
      if (previous?.sessionId && SESSION_AUTHORITY[previousSessionObservation] > SESSION_AUTHORITY[sessionObservation]) {
        record.sessionId = previous.sessionId;
        if (previous.sessionName) record.sessionName = previous.sessionName;
        else delete record.sessionName;
        record.sessionObservation = previousSessionObservation;
      } else {
        record.sessionObservation = sessionObservation;
      }
    }
    record.retired = previous?.retired ?? false;
    record.sessionEnded = previous?.sessionEnded ?? false;
    if (event.type === 'agent.completed') record.status = 'idle';
    else if (event.type === 'agent.retired') {
      record.status = 'idle';
      record.retired = true;
    } else if (event.type === 'session.ended') record.status = 'idle';
    else if (event.type === 'approval.requested') record.status = 'approval';
    else if (event.type === 'agent.started' || event.type === 'task.created' || event.type === 'user.instruction') {
      record.status = event.status ?? 'working';
      record.retired = false;
      record.sessionEnded = false;
    } else if (event.type === 'approval.resolved') record.status = event.status ?? 'idle';
    record.status ??= 'idle';
    const activityKind = nextActivityKind(newTask ? undefined : previous?.activityKind, event, record.status);
    if (activityKind === undefined) delete record.activityKind;
    else record.activityKind = activityKind;
    registry.delete(key);
    registry.set(key, record);
    if (event.type === 'session.ended') {
      record.sessionEnded = true;
    }
    while (registry.size > REGISTRY_LIMIT) registry.delete(registry.keys().next().value);
  }

  function remember(event) {
    history.push(event);
    if (history.length > 200) history.shift();
    journal.push(event);
    ids.set(event.id, event);
    const limit = dataDir === undefined ? 200 : JOURNAL_LIMIT;
    while (journal.length > limit) ids.delete(journal.shift().id);
    updateRegistry(event);
  }

  function writeSnapshot() {
    atomicWrite(registryPath, JSON.stringify({
      version: 1,
      lastEventId: journal.at(-1)?.id ?? null,
      agents: [...registry.values()],
    }));
  }

  if (dataDir !== undefined) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir must be a directory path');
    const requested = resolve(dataDir);
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const info = lstatSync(requested);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('dataDir must not be a symlink');
    chmodSync(requested, 0o700);
    directory = realpathSync(requested);
    journalPath = join(directory, 'events.jsonl');
    registryPath = join(directory, 'agents.json');
    for (const path of [journalPath, registryPath]) {
      assertRegularFile(path);
      if (existsSync(path)) chmodSync(path, 0o600);
    }

    let snapshot;
    if (existsSync(registryPath)) {
      try {
        if (statSync(registryPath).size > 8 * 1024 * 1024) throw new Error('Snapshot is too large');
        const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
        if (parsed.version !== 1 || !Array.isArray(parsed.agents)) throw new Error('Invalid snapshot');
        snapshot = { lastEventId: parsed.lastEventId, agents: [] };
        for (const candidate of parsed.agents.slice(-REGISTRY_LIMIT)) {
          const clean = normalize(candidate);
          const taskStartedAt = candidate.taskStartedAt === undefined ? undefined
            : normalize({ ...candidate, timestamp: candidate.taskStartedAt }).timestamp;
          const lastEventAt = candidate.lastEventAt === undefined ? clean.timestamp
            : normalize({ ...candidate, timestamp: candidate.lastEventAt }).timestamp;
          snapshot.agents.push({ ...clean, lastEventAt,
            retired: candidate.retired === true, sessionEnded: candidate.sessionEnded === true,
            ...(taskStartedAt === undefined ? {} : { taskStartedAt }),
            ...(Object.hasOwn(SESSION_AUTHORITY, candidate.sessionObservation)
              ? { sessionObservation: candidate.sessionObservation } : {}),
          });
        }
      } catch {
        snapshot = undefined;
        recoveredRecords++;
      }
    }
    if (existsSync(journalPath)) {
      // The normal journal is <= 5000 small normalized records; bound reads of damaged files too.
      if (statSync(journalPath).size > 96 * 1024 * 1024) throw new Error('Persistent journal exceeds its safety limit');
      for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          if (Buffer.byteLength(line) > 16 * 1024) throw new Error('Record is too large');
          const event = normalize(JSON.parse(line));
          if (!ids.has(event.id)) remember(event);
        } catch {
          recoveredRecords++;
        }
      }
      lastWriteAt = statSync(journalPath).mtime.toISOString();
    }
    if (snapshot) {
      const checkpoint = journal.findIndex(event => event.id === snapshot.lastEventId);
      // Older snapshots lack turn boundaries. Recover only evidence that precedes their checkpoint.
      const boundaries = new Map();
      const boundaryEventTimes = new Map();
      for (const event of checkpoint >= 0 ? journal.slice(0, checkpoint + 1) : journal) {
        if (event.source !== 'claude' || event.type === 'agent.model') continue;
        const key = `${event.source}:${event.agentId}`;
        const observed = Date.parse(event.timestamp);
        if (observed < (boundaryEventTimes.get(key) ?? -Infinity)) continue;
        boundaryEventTimes.set(key, observed);
        if (event.type === 'user.instruction') boundaries.set(key, event.timestamp);
      }
      for (const record of snapshot.agents) {
        const boundary = boundaries.get(`${record.source}:${record.agentId}`);
        if (!record.taskStartedAt && boundary && Date.parse(boundary) <= Date.parse(record.timestamp)) record.taskStartedAt = boundary;
      }
      if (checkpoint >= 0) {
        registry.clear();
        for (const record of snapshot.agents) registry.set(`${record.source}:${record.agentId}`, record);
        for (const event of journal.slice(checkpoint + 1)) updateRegistry(event);
      } else {
        // Preserve quiet agents missing from the journal, without overwriting its newer records.
        for (const record of snapshot.agents) {
          const key = `${record.source}:${record.agentId}`;
          if (!registry.has(key) && registry.size < REGISTRY_LIMIT) registry.set(key, record);
        }
      }
    }
  }

  if (!Array.isArray(initialEvents)) throw new Error('initialEvents must be an array');
  for (const candidate of initialEvents) {
    const event = normalize(candidate);
    if (!ids.has(event.id)) remember(event);
  }
  if (journalPath) {
    // Sanitize recovered records and enforce the bound before serving requests.
    atomicWrite(journalPath, serializeJournal(journal));
    journalDiskEntries = journal.length;
    writeSnapshot();
  }

  return {
    history,
    get directory() { return directory; },
    duplicate(id) { return ids.get(id); },
    append(event) {
      if (journalPath) {
        try {
          if (journalDiskEntries >= JOURNAL_LIMIT + JOURNAL_COMPACTION_BATCH - 1) {
            const retained = [...journal.slice(-(JOURNAL_LIMIT - 1)), event];
            atomicWrite(journalPath, serializeJournal(retained));
            journalDiskEntries = retained.length;
          } else {
            assertRegularFile(journalPath);
            const fd = openSync(journalPath, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW);
            try {
              fchmodSync(fd, 0o600);
              appendFileSync(fd, `${JSON.stringify(event)}\n`);
              fsyncSync(fd);
            } finally { closeSync(fd); }
            journalDiskEntries++;
          }
          lastWriteAt = new Date().toISOString();
          healthy = true;
        } catch (error) {
          healthy = false;
          throw error;
        }
      }
      remember(event);
      lastReceivedAt = new Date().toISOString();
      if (registryPath) {
        try { writeSnapshot(); } catch { healthy = false; }
      }
    },
    state() {
      const agents = [...registry.values()];
      const projects = new Map();
      for (const agent of agents) {
        if (!agent.projectId) continue;
        const project = projects.get(agent.projectId) ?? {
          projectId: agent.projectId, agentCount: 0, activeAgentCount: 0, sessions: new Set(),
        };
        if (agent.projectName) project.projectName = agent.projectName;
        project.agentCount++;
        if (!agent.retired) project.activeAgentCount++;
        if (agent.sessionId) project.sessions.add(agent.sessionId);
        projects.set(agent.projectId, project);
      }
      return { events: history, agents, projects: [...projects.values()].map(({ sessions, ...project }) =>
        ({ ...project, sessionCount: sessions.size })) };
    },
    health() {
      return {
        lastEventAt: history.at(-1)?.timestamp ?? null,
        lastReceivedAt,
        agentCount: registry.size,
        persistence: { enabled: Boolean(journalPath), format: journalPath ? 'jsonl' : null,
          retainedEventCount: journal.length, maxEvents: journalPath ? JOURNAL_LIMIT : 200,
          maxAgents: REGISTRY_LIMIT, healthy, lastWriteAt, recoveredRecords },
      };
    },
  };
}
