import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opaqueId } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { collectClaudeEvents, pollClaudeObserver, createClaudeObserver } from '../scripts/claude-observer.mjs';
import { pollClaudeModels } from '../scripts/claude-models.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const NOW = Date.now();
const SESSION = 'fixture-new-session';
const id = (raw = null, session = SESSION) => `claude-${opaqueId(session)}-${raw ? opaqueId(raw) : 'main'}`;
const record = (type, offset, extra = {}) => ({ type, sessionId: SESSION, isSidechain: false,
  uuid: `fixture-${offset}`, timestamp: new Date(NOW + offset).toISOString(), cwd: '/example/projects/office', ...extra });
const user = (offset, extra = {}) => record('user', offset, { message: { role: 'user', content: 'PRIVATE PROMPT' }, ...extra });
const assistant = (offset, stop = null, extra = {}) => record('assistant', offset, { message: { model: 'claude-fixture-own',
  stop_reason: stop, content: [{ type: 'text', text: 'PRIVATE RESPONSE' }] }, ...extra });

const interrupted = offset => user(offset, { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
const terminalToolResult = offset => user(offset, { agentId: 'child', isSidechain: true, toolEndsTurn: true,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'terminal-tool', content: 'PRIVATE RESULT' }] } });

test('explicit Claude interruption and toolEndsTurn records finish their own employee without claiming task success', async t => {
  const f = await fixture(t);
  await f.file(`${SESSION}.jsonl`, [user(0), interrupted(10)]);
  await f.file(`${SESSION}/subagents/workflows/wf-1/agent-child.jsonl`, [
    user(0, { agentId: 'child', isSidechain: true }), terminalToolResult(20),
  ]);
  await pollClaudeObserver(f.options);
  assert.ok(f.state.agents.every(agent => agent.type === 'agent.completed' && agent.status === 'idle'));
  assert.equal(f.state.agents.find(agent => agent.agentId === id()).title, 'Claude 응답 중단');
  assert.equal(f.state.agents.find(agent => agent.agentId === id('child')).title, 'Claude 응답 종료');
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|Request interrupted|toolEndsTurn|reclassifiedFrom/);
});

test('restart repairs the same previously misclassified terminal record once without overriding a newer hook', async t => {
  for (const [raw, terminal, oldType] of [[null, interrupted(-600_000), 'user.instruction'], ['child', terminalToolResult(-600_000), 'agent.status']]) {
    const oldId = `claude-log-${opaqueId(`${id(raw)}:${opaqueId(terminal.uuid)}:${oldType}:${terminal.timestamp}`)}`;
    const state = { agents: [{ id: oldId, agentId: id(raw), source: 'claude', sessionId: SESSION, observation: 'claude-log',
      type: oldType, status: 'thinking', timestamp: terminal.timestamp, lastEventAt: terminal.timestamp }] };
    const f = await fixture(t, state);
    await f.file(raw === null ? `${SESSION}.jsonl` : `${SESSION}/subagents/workflows/wf-1/agent-child.jsonl`, [terminal]);
    await pollClaudeObserver(f.options);
    assert.equal(state.agents[0].status, 'idle', 'an old terminal record must correct its own stored thinking state after restart');
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].type, 'agent.completed');
    assert.equal(f.events[0].timestamp, terminal.timestamp, 'correction retains the observed end time');
    await pollClaudeObserver({ ...f.options, discoveryCache: {} });
    assert.equal(f.events.length, 1, 'a fresh observer does not repeat the accepted correction');
    for (const offset of [0, 1000]) {
      state.agents[0] = { ...state.agents[0], id: 'unrelated-hook', type: 'agent.status', status: 'working', observation: 'hook',
        timestamp: new Date(Date.parse(terminal.timestamp) + offset).toISOString(), lastEventAt: new Date(Date.parse(terminal.timestamp) + offset).toISOString() };
      assert.deepEqual(await collectClaudeEvents(state, f.options), [], 'same-time unrelated or newer work is not overwritten');
    }
  }
});

test('ordinary tool results and human text resembling an interruption do not establish completion', async t => {
  for (const extra of [
    { ...terminalToolResult(0), agentId: undefined, isSidechain: false, toolEndsTurn: false },
    { ...terminalToolResult(0), agentId: undefined, isSidechain: false, toolEndsTurn: 'true' },
    { ...interrupted(0), origin: { kind: 'human' } },
    user(0, { message: { content: '[Request interrupted by user] PRIVATE quoted example' } }),
  ]) {
    const f = await fixture(t);
    await f.file(`${SESSION}.jsonl`, [extra]);
    await pollClaudeObserver(f.options);
    assert.equal(f.state.agents[0].status, 'thinking');
    assert.equal(f.events.some(event => event.type === 'agent.completed'), false);
  }
});

test('Claude tool kinds follow their own result IDs while parallel work, unknown results and response endings stay honest', async t => {
  const f = await fixture(t);
  const using = (offset, id, name, input) => assistant(offset, null, { message: { model: 'claude-fixture-own',
    content: [{ type: 'tool_use', id, name, input }] } });
  const result = (offset, id, error = false) => user(offset, { message: { content: [
    { type: 'tool_result', tool_use_id: id, is_error: error, content: 'PRIVATE RESULT' },
  ] } });
  await f.file(`${SESSION}.jsonl`, [user(0),
    using(10, 'doc', 'Write', { file_path: '/PRIVATE/plan.md', content: 'PRIVATE CONTENT' }),
    using(20, 'code', 'Edit', { file_path: '/PRIVATE/main.ts', new_string: 'PRIVATE CODE' }),
    result(30, 'doc'), result(40, 'code'), result(50, 'unmatched'),
    using(60, 'test', 'Bash', { command: 'pnpm test' }), result(70, 'test', true), assistant(80, 'end_turn'),
  ]);
  await pollClaudeObserver(f.options);
  const at = offset => f.events.find(event => event.timestamp === new Date(NOW + offset).toISOString() && event.type !== 'message.sent');
  assert.equal(at(10).activityKind, 'documents'); assert.equal(at(20).activityKind, 'coding');
  assert.equal(at(30).activityKind, 'coding'); assert.equal(at(30).status, 'working', 'an earlier result cannot stop a different running tool');
  assert.equal(at(40).activityKind, 'coding'); assert.equal(at(40).status, 'thinking');
  assert.equal(at(50).activityKind, 'general', 'a result without its observed call cannot borrow the last kind');
  assert.equal(at(60).activityKind, 'testing'); assert.equal(at(70).activityKind, 'testing'); assert.equal(at(70).status, 'error');
  assert.equal(at(80).type, 'agent.completed'); assert.equal(at(80).activityKind, undefined);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|tool_use_id|file_path|new_string|command/);
});

test('continuous Claude polling reads tracked appends without rescanning discovery until its bounded interval', async t => {
  const f = await fixture(t), discoveryCache = {};
  const path = await f.file(`${SESSION}.jsonl`, [user(0)]);
  const options = { ...f.options, discoveryCache };
  const initial = await collectClaudeEvents({ agents: [] }, options);
  const state = { agents: [initial.at(-1)] };
  await appendFile(path, JSON.stringify(assistant(2000, 'end_turn'))+'\n');
  await f.file('second-session.jsonl', [user(2000, { sessionId: 'second-session' })]);
  const fast = await collectClaudeEvents(state, { ...options, now: NOW + 3000 });
  assert.ok(fast.some(event => event.type === 'agent.completed'), 'tracked completion remains a fast poll');
  assert.equal(fast.some(event => event.sessionId === 'second-session'), false, 'a fast poll does not walk all old project directories');
  const discovered = await collectClaudeEvents(state, { ...options, now: NOW + 16_000 });
  assert.ok(discovered.some(event => event.sessionId === 'second-session'), 'new transcripts are discovered within fifteen seconds');
});

test('bounded Claude polling reaches large quiet transcripts fairly across the byte budget and discovery refreshes', async t => {
  const sessions = Array.from({ length: 136 }, (_, index) => `fair-session-${String(index).padStart(3, '0')}`);
  const state = { agents: sessions.map(session => ({ source: 'claude', agentId: id(null, session), sessionId: session,
    id: `known-${session}`, type: 'agent.status', status: 'thinking', timestamp: new Date(NOW - 600_000).toISOString() })) };
  const f = await fixture(t, state), discoveryCache = {};
  for (const session of sessions) await f.file(`${session}.jsonl`, [
    record('attachment', -600_000, { sessionId: session, padding: 'x'.repeat(256 * 1024) }),
    assistant(-590_000, 'end_turn', { sessionId: session }),
  ]);
  await pollClaudeObserver({ ...f.options, discoveryCache });
  assert.equal(f.events.length, 32, 'one poll retains the 8 MiB budget instead of reading every 256 KiB tail');
  for (let round = 1; round < 5; round++) {
    discoveryCache.nextAt = 0; // A discovery refresh must not reset already visited files to the front.
    await pollClaudeObserver({ ...f.options, discoveryCache, now: NOW + 1000 + round * 2000 });
  }
  assert.equal(f.events.length, sessions.length, 'large files beyond both the first 32 and first 128 must receive a turn');
  assert.ok(state.agents.every(agent => agent.status === 'idle'));
  const count = f.events.length;
  await pollClaudeObserver({ ...f.options, discoveryCache, now: NOW + 12_000 });
  assert.equal(f.events.length, count, 'finished transcripts remain deduplicated on a later turn');
});

async function fixture(t, state = { agents: [] }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-office-claude-observer-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'claude'), projectsDir = join(configDir, 'projects'), project = join(projectsDir, 'fixture-project');
  await mkdir(project, { recursive: true });
  const events = []; state.events = events; let failType = null;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/state') { res.end(JSON.stringify(state)); return; }
    if (req.method === 'POST' && req.url === '/api/events') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks));
      if (event.type === failType) { failType = null; res.writeHead(503); res.end('{}'); return; }
      events.push(event);
      if (event.type !== 'message.sent') {
        const previous = state.agents.findIndex(agent => agent.agentId === event.agentId);
        if (previous < 0) state.agents.push(event);
        else if (Date.parse(state.agents[previous].timestamp) <= Date.parse(event.timestamp)) state.agents[previous] = { ...state.agents[previous], ...event };
      }
      res.writeHead(202); res.end('{}'); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/events`;
  async function file(name, records) { const path = join(project, name); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n'); return path; }
  return { dir, configDir, projectsDir, project, endpoint, events, state, file, failNext(type) { failType = type; },
    options: { projectsDir, endpoint, now: NOW + 1000, startedAt: NOW } };
}

test('a new transcript becomes a registered idle/active/completed employee through the actual observer and HTTP receiver', async t => {
  const f = await fixture(t);
  const path = await f.file(`${SESSION}.jsonl`, [record('bridge-session', 0)]);
  await pollClaudeModels(f.options);
  assert.equal(f.state.agents.length, 0, 'the previous model-only path cannot discover a new conversation without a hook');
  await pollClaudeObserver(f.options);
  assert.equal(f.state.agents.length, 1); assert.equal(f.state.agents[0].status, 'idle');
  assert.equal(f.state.agents[0].projectId, `project-${opaqueId('/example/projects/office')}`);
  assert.equal(f.state.agents[0].projectName, 'office'); assert.equal(f.state.agents[0].sessionId, SESSION);
  await appendFile(path, JSON.stringify(user(100)) + '\n' + JSON.stringify(assistant(200)) + '\n');
  await pollClaudeObserver(f.options);
  assert.equal(f.state.agents[0].status, 'thinking');
  await appendFile(path, JSON.stringify(assistant(300, 'end_turn')) + '\n');
  await pollClaudeObserver(f.options);
  assert.equal(f.state.agents[0].type, 'agent.completed'); assert.equal(f.state.agents[0].status, 'idle');
  assert.equal(f.state.agents[0].model, 'claude-fixture-own');
  const count = f.events.length; await pollClaudeObserver(f.options); assert.equal(f.events.length, count);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|PROMPT|RESPONSE|transcript|cwd|\/example\/projects/u);
});

test('completed new sessions stay idle and old modified history is never imported or revived', async t => {
  const f = await fixture(t);
  await f.file(`${SESSION}.jsonl`, [user(0), assistant(10, 'end_turn')]);
  await f.file('old-session.jsonl', [user(-86_400_000, { sessionId: 'old-session' }), assistant(-86_399_000, 'end_turn', { sessionId: 'old-session' })]);
  await pollClaudeObserver(f.options);
  assert.deepEqual(f.state.agents.map(agent => [agent.agentId, agent.status]), [[id(), 'idle']]);
  const hook = { ...f.state.agents[0], id: 'newer-hook', timestamp: new Date(NOW + 2000).toISOString(), status: 'approval', observation: 'hook' };
  f.state.agents[0] = hook; const count = f.events.length;
  await pollClaudeObserver(f.options);
  assert.equal(f.events.length, count); assert.equal(f.state.agents[0].status, 'approval');
});

test('closed employees reenter only after fresh own input, never after late completion or tool results', async t => {
  for (const raw of [null, 'child']) for (const closed of ['sessionEnded', 'retired']) {
    const own = value => raw === null ? value : { ...value, agentId: raw, isSidechain: true };
    const state = { agents: [{ id: 'closed-lifecycle', agentId: id(raw), sessionId: SESSION, source: 'claude',
      type: closed === 'retired' ? 'agent.retired' : 'session.ended', timestamp: new Date(NOW - 600_000).toISOString(),
      status: 'idle', [closed]: true }] };
    const f = await fixture(t, state);
    const path = await f.file(raw === null ? `${SESSION}.jsonl` : `${SESSION}/subagents/agent-${raw}.jsonl`, [own(assistant(-540_000, 'end_turn'))]);
    assert.deepEqual(await collectClaudeEvents(state, f.options), [], 'late completed record outside the two-minute window cannot reopen a closed employee');
    await appendFile(path, JSON.stringify(own(assistant(0, 'end_turn'))) + '\n' + JSON.stringify(own(user(10, {
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'PRIVATE RESULT' }] } }))) + '\n');
    assert.deepEqual(await collectClaudeEvents(state, f.options), [], 'even fresh output/tool results do not prove a new input');
    await appendFile(path, JSON.stringify(own(user(20))) + '\n');
    const events = await collectClaudeEvents(state, f.options);
    assert.deepEqual(events.map(event => event.type), ['agent.started', raw === null ? 'user.instruction' : 'agent.status']);
    assert.equal(events[0].timestamp, new Date(NOW + 20).toISOString());
    assert.equal(events[1].status, 'thinking');
    assert.ok(events.every(event => !Object.hasOwn(event, 'inputRecorded')));
  }
});

test('own child files and workflows connect to their real parent session without borrowing its model', async t => {
  const f = await fixture(t);
  await f.file(`${SESSION}.jsonl`, [assistant(0, 'end_turn')]);
  await f.file(`${SESSION}/subagents/agent-child.jsonl`, [user(20, { agentId: 'child', isSidechain: true }),
    assistant(30, 'end_turn', { agentId: 'child', isSidechain: true, message: { model: 'claude-child-own', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE CHILD' }] } })]);
  await f.file(`${SESSION}/subagents/workflows/wf-1/agent-workflow.jsonl`, [user(40, { agentId: 'workflow', isSidechain: true })]);
  await f.file(`${SESSION}/subagents/agent-wrong.jsonl`, [assistant(50, 'end_turn', { agentId: 'foreign', isSidechain: true })]);
  await f.file(`${SESSION}/subagents/agent-foreign-session.jsonl`, [assistant(60, 'end_turn', { agentId: 'foreign-session', isSidechain: true, sessionId: 'another-session' })]);
  await pollClaudeObserver(f.options);
  assert.deepEqual(f.state.agents.map(agent => agent.agentId).sort(), [id(), id('child'), id('workflow')].sort());
  const child = f.state.agents.find(agent => agent.agentId === id('child'));
  assert.equal(child.parentAgentId, id()); assert.equal(child.model, 'claude-child-own');
  assert.equal(child.status, 'idle'); assert.equal(child.sessionId, SESSION);
  const workflow = f.state.agents.find(agent => agent.agentId === id('workflow'));
  assert.equal(workflow.modelEvidence, 'unknown'); assert.equal(workflow.model, undefined);
});

test('tool activity is generic, a tool result is not a new user instruction, and symlink sources are rejected', async t => {
  const f = await fixture(t);
  const content = [{ type: 'tool_use', id: 'tool-fixture', name: 'Bash', input: { command: 'PRIVATE COMMAND' } }];
  const path = await f.file(`${SESSION}.jsonl`, [user(0), assistant(10, null, { message: { model: 'claude-fixture', content } })]);
  await pollClaudeObserver(f.options); assert.equal(f.state.agents[0].status, 'working'); assert.equal(f.state.agents[0].toolName, 'Bash');
  await appendFile(path, JSON.stringify(user(20, { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: 'PRIVATE RESULT' }] } })) + '\n');
  const count = f.events.filter(event => event.type === 'user.instruction').length;
  await pollClaudeObserver(f.options); assert.equal(f.state.agents[0].status, 'thinking');
  assert.equal(f.events.filter(event => event.type === 'user.instruction').length, count);
  const other = await f.file('outside.jsonl', [record('bridge-session', 0, { sessionId: 'linked' })]);
  await symlink(other, join(f.project, 'linked.jsonl'));
  await pollClaudeObserver(f.options); assert.ok(!f.state.agents.some(agent => agent.sessionId === 'linked'));
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|COMMAND|RESULT/u);
});

test('serial observer retries a failed poll and stops without overlapping work', async () => {
  let release, count = 0; const timers = [];
  const observer = createClaudeObserver({ poll: async () => { count++; if (count === 1) await new Promise(resolve => { release = resolve; }); else throw new Error('fixture'); },
    schedule: (callback, delay) => { timers.push({ callback, delay }); return 1; }, cancel() {} });
  const first = observer.start(); await observer.start(); assert.equal(count, 1); release(); await first;
  assert.equal(timers[0].delay, 2000); await timers.shift().callback(); assert.equal(timers.length, 1);
  observer.stop(); await timers[0].callback(); assert.equal(count, 2);
});

test('a failed first instruction after successful registration is retried at the same timestamp', async t => {
  const f = await fixture(t);
  await f.file(`${SESSION}.jsonl`, [user(0)]);
  f.failNext('user.instruction');
  await assert.rejects(pollClaudeObserver(f.options));
  assert.equal(f.state.agents[0].status, 'idle');
  await pollClaudeObserver(f.options);
  assert.equal(f.state.agents[0].status, 'thinking');
  assert.equal(f.events.filter(event => event.type === 'user.instruction').length, 1);
});

test('CLI dry run observes only temporary files and never posts an event', async t => {
  const f = await fixture(t);
  const now = Date.now();
  await f.file(`${SESSION}.jsonl`, [{ ...record('bridge-session', 0), timestamp: new Date(now).toISOString() }]);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/claude-observer.mjs', '--once', '--dry-run'], { cwd: root,
      env: { ...process.env, AGENT_OFFICE_ENDPOINT: f.endpoint, CLAUDE_CONFIG_DIR: f.configDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 5000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout)[0].agentId, id()); assert.equal(f.events.length, 0);
});

test('visible Claude text blocks emit separate messages once while completion and private content stay separate', async t => {
  const f = await fixture(t);
  await f.file(`${SESSION}.jsonl`, [user(0), assistant(10, 'end_turn', { message: { model: 'claude-own', stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: 'PRIVATE THOUGHT' }, { type: 'text', text: 'PRIVATE FIRST' },
    { type: 'text', text: 'PRIVATE SECOND' }, { type: 'text', text: ' ' }] } })]);
  await pollClaudeObserver(f.options);
  const messages = f.events.filter(event => event.type === 'message.sent');
  assert.equal(messages.length, 2); assert.equal(new Set(messages.map(event => event.id)).size, 2);
  assert.ok(messages.every(event => event.status === undefined && event.toAgentId === undefined));
  assert.equal(f.events.at(-1).type, 'agent.completed'); assert.equal(f.state.agents[0].status, 'idle');
  await pollClaudeObserver(f.options); assert.equal(f.events.filter(event => event.type === 'message.sent').length, 2);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|THOUGHT|FIRST|SECOND/u);
});

test('Claude matched successful SendMessage results emit a local message without guessing a recipient', async t => {
  const f = await fixture(t);
  const call = (offset, toolId) => assistant(offset, null, { message: { content: [{ type: 'tool_use', id: toolId, name: 'SendMessage', input: { recipient: 'PRIVATE PERSON', content: 'PRIVATE MESSAGE' } }] } });
  const result = (offset, toolId, is_error = false) => user(offset, { message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error, content: 'PRIVATE RESULT' }] } });
  await f.file(`${SESSION}.jsonl`, [user(0), call(10, 'sent'), result(20, 'sent'), call(30, 'failed'), result(40, 'failed', true), result(50, 'unknown'),
    assistant(60, null, { message: { channel: 'analysis', content: [{ type: 'text', text: 'PRIVATE ANALYSIS' }] } }),
    assistant(70, null, { message: { content: [{ type: 'thinking', thinking: 'PRIVATE THOUGHT' }] } })]);
  await pollClaudeObserver(f.options);
  const messages = f.events.filter(event => event.type === 'message.sent');
  assert.equal(messages.length, 1); assert.equal(messages[0].toolName, 'SendMessage');
  assert.match(messages[0].title, /수신자 미확인/u); assert.equal(messages[0].toAgentId, undefined);
  assert.equal(f.events.filter(event => event.type === 'handoff').length, 0);
  assert.equal(f.events.filter(event => event.type === 'user.instruction').length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|PERSON|ANALYSIS|THOUGHT/u);
});

test('fresh Claude messages survive newer hook snapshots, retry failures and never replay pre-connection text', async t => {
  const current = { id: 'newer-hook', agentId: id(), sessionId: SESSION, source: 'claude', status: 'approval',
    timestamp: new Date(NOW + 900).toISOString(), taskId: 'current-task', model: 'claude-current', modelEvidence: 'reported' };
  const f = await fixture(t, { agents: [current] });
  await f.file(`${SESSION}.jsonl`, [assistant(-100), assistant(100)]);
  const seenMessages = new Map(); const options = { ...f.options, seenMessages };
  f.failNext('message.sent'); await assert.rejects(pollClaudeObserver(options));
  assert.equal(seenMessages.size, 0);
  await pollClaudeObserver(options);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'message.sent');
  assert.deepEqual(f.state.agents, [current]);
  f.state.events = [];
  await pollClaudeObserver(options); assert.equal(f.events.length, 1, 'short-lived metadata dedup also works after history rotates');
});
