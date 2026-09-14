import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createEventStore } from './store.mjs';
import { isWithin, serveStatic } from './static.mjs';
import { createSettingsStore, SettingsValidationError } from './settings.mjs';
import { createUsageStore, UsageValidationError } from './usage.mjs';
import { ACTIVITY_KINDS } from '../integrations/claude-plugin/scripts/activity-kind.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const REPLAY_LIMIT = 100;
const MAX_SSE_CLIENTS = 64;
const MAX_FUTURE_SKEW_MS = 60_000;
const SOURCES = new Set(['codex', 'claude', 'manual']);
const EVENT_TYPES = new Set([
  'agent.started', 'agent.status', 'agent.completed', 'message.sent', 'handoff',
  'approval.requested', 'approval.resolved', 'task.created',
  'user.instruction', 'agent.retired', 'session.ended', 'agent.model',
]);
const MODEL_EVIDENCE = new Set(['reported', 'unknown']);
const ACTIVITIES = new Set(ACTIVITY_KINDS);
const OBSERVATIONS = new Set(['hook', 'app-server', 'codex-log', 'claude-log', 'manual']);
const API_PATHS = ['/api/health', '/api/events', '/api/history', '/api/state', '/api/settings', '/api/usage'];
const STATUSES = new Set([
  'working', 'thinking', 'waiting', 'reviewing', 'approval', 'done', 'error', 'idle',
]);
const LOCAL_HOSTS = new Set(
  ['localhost', '127.0.0.1'].flatMap((host) =>
    [5173, 4173, 4780].map((port) => `${host}:${port}`)),
);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((host) => `http://${host}`));

export class EventValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'EventValidationError';
    this.statusCode = statusCode;
  }
}

function textField(input, name, maximum, required = false) {
  const value = input[name];
  if (value === undefined) {
    if (required) throw new EventValidationError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new EventValidationError(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new EventValidationError(`${name} must contain 1-${maximum} characters without control characters`);
  }
  return trimmed;
}

function enumField(input, name, choices, required = false) {
  if (input[name] === undefined && !required) return undefined;
  if (!choices.has(input[name])) {
    throw new EventValidationError(`${name} is not supported`);
  }
  return input[name];
}

function dateField(input, name, required = false) {
  const timestamp = textField(input, name, 40, required);
  if (timestamp === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== timestamp.slice(0, 10)
    || Number(timestamp.slice(11, 13)) > 23) {
    throw new EventValidationError(`${name} must be an ISO 8601 date-time with a timezone`);
  }
  return new Date(timestamp).toISOString();
}

/** Keep only intentionally public, short office metadata. Never retain extra input fields. */
export function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EventValidationError('event must be a JSON object');
  }
  const source = enumField(input, 'source', SOURCES, true);
  const type = enumField(input, 'type', EVENT_TYPES, true);
  if (type === 'message.sent' && (input.toAgentId !== undefined || input.toAgentName !== undefined)) {
    throw new EventValidationError('message.sent has no inferred recipient; use handoff for an identified recipient');
  }
  const event = {
    id: textField(input, 'id', 120) ?? randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    type,
    agentId: textField(input, 'agentId', 160, true),
    title: textField(input, 'title', 160, true),
    modelEvidence: enumField(input, 'modelEvidence', MODEL_EVIDENCE) ?? 'unknown',
  };

  if (input.timestamp !== undefined) event.timestamp = dateField(input, 'timestamp', true);

  for (const [name, maximum] of [
    ['agentName', 64], ['role', 80], ['toAgentId', 160], ['toAgentName', 64], ['taskId', 120],
    ['projectId', 120], ['projectName', 100], ['sessionId', 120], ['sessionName', 160],
    ['parentAgentId', 120], ['toolName', 100],
  ]) {
    const value = textField(input, name, maximum, type === 'handoff' && name === 'toAgentId');
    if (value !== undefined) event[name] = value;
  }
  const status = enumField(input, 'status', STATUSES);
  if (status !== undefined) event.status = status;
  const activityKind = enumField(input, 'activityKind', ACTIVITIES);
  if (activityKind !== undefined && !['agent.model', 'message.sent', 'agent.completed', 'agent.retired', 'session.ended'].includes(type)
    && !['idle', 'done', 'waiting'].includes(status)) event.activityKind = activityKind;
  const observation = enumField(input, 'observation', OBSERVATIONS);
  if (observation !== undefined) event.observation = observation;
  const model = textField(input, 'model', 100, event.modelEvidence === 'reported');
  if (event.modelEvidence === 'reported') event.model = model;
  const modelObservedAt = dateField(input, 'modelObservedAt', type === 'agent.model');
  if (modelObservedAt !== undefined && event.modelEvidence === 'reported') event.modelObservedAt = modelObservedAt;
  if (type === 'agent.model') {
    if (source !== 'claude' || observation !== 'claude-log' || event.modelEvidence !== 'reported') {
      throw new EventValidationError('agent.model requires reported Claude transcript evidence');
    }
    event.referenceEventId = textField(input, 'referenceEventId', 120, true);
  }
  return Object.freeze(event);
}

function sendJSON(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJSON(req) {
  const mediaType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    req.resume();
    throw new EventValidationError('Content-Type must be application/json', 415);
  }
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    req.resume();
    throw new EventValidationError('event body exceeds 16 KiB', 413);
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        chunks = [];
        reject(new EventValidationError('event body exceeds 16 KiB', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new EventValidationError('body must contain valid JSON'));
      }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new EventValidationError('request was aborted')));
  });
}

function sseFrame(event) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Returns an unstarted HTTP server so callers can manage its lifecycle. */
export function createOfficeServer({ dataDir, staticDir, initialEvents = [], service = 'agent-office', instanceId } = {}) {
  if (dataDir && staticDir && isWithin(resolve(staticDir), resolve(dataDir))) {
    throw new Error('Persistent data must not be inside the public static directory');
  }
  const store = createEventStore({ dataDir, initialEvents, normalize: normalizeEvent });
  const usage = createUsageStore({ dataDir });
  const settings = createSettingsStore({ dataDir });
  const { history } = store;
  const clients = new Set();
  const startedAt = new Date().toISOString();

  function broadcast(event) {
    const frame = sseFrame(event);
    for (const client of clients) {
      if (client.destroyed || client.writableLength > 256 * 1024) {
        clients.delete(client);
        client.destroy();
      } else {
        client.write(frame);
      }
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    // Check Host even for CLI calls to prevent hostile DNS names resolving to loopback.
    if (!LOCAL_HOSTS.has(req.headers.host?.toLowerCase())) {
      req.resume();
      sendJSON(res, 403, { ok: false, error: 'Host is not allowed' });
      return;
    }
    if ((origin !== undefined && !LOCAL_ORIGINS.has(origin))
      || (origin === undefined && req.headers['sec-fetch-site'] === 'cross-site')) {
      req.resume();
      sendJSON(res, 403, { ok: false, error: 'Origin is not allowed' });
      return;
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1:4780').pathname;
    } catch {
      req.resume();
      sendJSON(res, 400, { ok: false, error: 'Request URL is invalid' });
      return;
    }
    if (req.method === 'OPTIONS' && API_PATHS.includes(pathname)) {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': pathname === '/api/settings' ? 'GET, POST, PATCH, OPTIONS' : 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJSON(res, 200, {
          ok: true, service, ...(instanceId ? { instanceId } : {}), startedAt,
          eventCount: history.length, connections: clients.size,
          ...store.health(),
        });
      } else if (pathname === '/api/settings' && req.method === 'GET') {
        sendJSON(res, 200, settings.state());
      } else if (pathname === '/api/settings' && ['POST', 'PATCH'].includes(req.method)) {
        sendJSON(res, 200, settings.update(await readJSON(req)));
      } else if (pathname === '/api/usage' && req.method === 'GET') {
        sendJSON(res, 200, usage.state());
      } else if (pathname === '/api/usage' && req.method === 'POST') {
        sendJSON(res, 202, { ok: true, provider: usage.update(await readJSON(req)) });
      } else if (pathname === '/api/history' && req.method === 'GET') {
        sendJSON(res, 200, { events: history });
      } else if (pathname === '/api/state' && req.method === 'GET') {
        sendJSON(res, 200, store.state());
      } else if (pathname === '/api/events' && req.method === 'GET') {
        if (clients.size >= MAX_SSE_CLIENTS) {
          sendJSON(res, 503, { ok: false, error: 'Too many event streams' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write('retry: 1500\n\n');
        const replay = history.slice(-REPLAY_LIMIT);
        const lastIndex = replay.findIndex((event) => event.id === req.headers['last-event-id']);
        for (const event of replay.slice(lastIndex + 1)) res.write(sseFrame(event));
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
        heartbeat.unref();
        res.once('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
      } else if (pathname === '/api/events' && req.method === 'POST') {
        const event = normalizeEvent(await readJSON(req));
        const duplicate = store.duplicate(event.id);
        if (duplicate) {
          sendJSON(res, 200, { ok: true, duplicate: true, event: duplicate });
          return;
        }
        // Receipt validation is separate from historical normalization and persistent replay.
        const latestAcceptedTime = Date.now() + MAX_FUTURE_SKEW_MS;
        if (['timestamp', 'modelObservedAt'].some(field => event[field] && Date.parse(event[field]) > latestAcceptedTime)) {
          throw new EventValidationError('Event time must not be more than 60 seconds ahead of the receiver');
        }
        store.append(event);
        broadcast(event);
        sendJSON(res, 202, { ok: true, duplicate: false, event });
      } else if (API_PATHS.includes(pathname)) {
        req.resume();
        res.setHeader('Allow', pathname === '/api/settings' ? 'GET, POST, PATCH, OPTIONS'
          : ['/api/events', '/api/usage'].includes(pathname) ? 'GET, POST, OPTIONS' : 'GET, OPTIONS');
        sendJSON(res, 405, { ok: false, error: 'Method is not allowed' });
      } else if (!serveStatic(req, res, pathname, staticDir, store.directory)) {
        req.resume();
        sendJSON(res, 404, { ok: false, error: 'Route was not found' });
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const statusCode = error instanceof EventValidationError || error instanceof UsageValidationError || error instanceof SettingsValidationError ? error.statusCode : 500;
      const message = statusCode === 500 ? 'Internal bridge error' : error.message;
      sendJSON(res, statusCode, { ok: false, error: message });
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const originalClose = server.close.bind(server);
  server.close = (...args) => {
    for (const client of clients) client.end();
    clients.clear();
    return originalClose(...args);
  };
  return server;
}
