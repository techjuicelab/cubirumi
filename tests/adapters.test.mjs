import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { endpointUrl, normalizeLifecycle, postEvent, opaqueId } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { normalizeCodexNotify } from '../scripts/codex-notify.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = { session_id: 'fixture-main-session', agent_id: 'fixture-child', agent_type: 'Explore', hook_event_name: 'SubagentStart', transcript_path: '/private/secret.jsonl', prompt: 'PRIVATE PROMPT', tool_input: { command: 'SECRET COMMAND' }, last_assistant_message: 'PRIVATE OUTPUT' };

function run(script, { input = '', args = [], endpoint } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, AGENT_OFFICE_ENDPOINT: endpoint || 'http://127.0.0.1:1/api/events' }, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    const killTimer = setTimeout(() => { child.kill(); reject(new Error('adapter execution timeout')); }, 3500);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(killTimer); resolve({code,stdout,stderr}); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function receiver(t, handler) {
  const events = [];
  const server = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    events.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (handler) return handler(req,res);
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { events, endpoint:`http://127.0.0.1:${server.address().port}/api/events` };
}

test('Claude lifecycle fixtures preserve identities without raw content or invented handoffs', () => {
  const start = normalizeLifecycle(fixture);
  const stop = normalizeLifecycle({...fixture,hook_event_name:'SubagentStop'});
  const tool = normalizeLifecycle({...fixture,hook_event_name:'PreToolUse',tool_name:'Read'});
  assert.equal(start.type,'agent.started');
  assert.equal(start.role,'리서치');
  assert.equal(stop.type,'agent.completed');
  assert.equal(start.agentId,stop.agentId);
  assert.equal(start.agentId,tool.agentId);
  assert.equal(tool.title,'Read 실행 중');
  for (const event of [start,stop,tool]) {
    assert.notEqual(event.type,'handoff');
    assert.doesNotMatch(JSON.stringify(event),/PRIVATE|SECRET|private\/secret|fixture-child/);
    assert.equal('toAgentId' in event,false);
  }
  assert.equal(normalizeLifecycle({...fixture,agent_id:undefined}),null);
  assert.equal(normalizeLifecycle({...fixture,hook_event_name:'Unexpected'}),null);
  assert.equal(normalizeLifecycle({hook_event_name:'SessionStart'}),null);
});

test('approval and tool failure labels are metadata-only', () => {
  const approval=normalizeLifecycle({...fixture,hook_event_name:'Notification',notification_type:'permission_prompt',message:'SECRET MESSAGE'});
  assert.equal(approval.type,'approval.requested');
  assert.equal(approval.status,'approval');
  const unknown=normalizeLifecycle({...fixture,hook_event_name:'PreToolUse',tool_name:'sensitive-custom-name'});
  assert.equal(unknown.title,'도구 실행 중');
  const failure=normalizeLifecycle({...fixture,hook_event_name:'PostToolUseFailure',tool_name:'Bash',error:'SECRET ERROR'});
  assert.equal(failure.status,'error');
  assert.doesNotMatch(JSON.stringify([approval,unknown,failure]),/SECRET|sensitive/);
});

test('Codex hook and notify identities correlate; notify only accepts completion', () => {
  const hook=normalizeLifecycle({session_id:'thread-1',hook_event_name:'Stop',turn_id:'turn-2'},'codex');
  const notify=normalizeCodexNotify({type:'agent-turn-complete','thread-id':'thread-1','turn-id':'turn-2','last-assistant-message':'SECRET','input-messages':['PRIVATE']});
  assert.equal(hook.agentId,notify.agentId);
  assert.equal(hook.taskId,notify.taskId);
  assert.equal(notify.type,'agent.completed');
  assert.doesNotMatch(JSON.stringify(notify),/SECRET|PRIVATE/);
  assert.equal(normalizeCodexNotify({type:'approval-requested','thread-id':'thread-1'}),null);
  const child=normalizeLifecycle({...fixture,agent_id:'child-session'},'codex');
  const childTool=normalizeLifecycle({session_id:'child-session',hook_event_name:'PreToolUse',tool_name:'Bash'},'codex');
  assert.equal(child.agentId,childTool.agentId);
  assert.equal(child.agentId,`codex-${opaqueId('child-session')}-main`);
});

test('adapters post safe events through real loopback HTTP and stay silent', async t => {
  const { events,endpoint }=await receiver(t);
  const claude=await run('scripts/claude-hook.mjs',{input:JSON.stringify(fixture),endpoint});
  const codex=await run('scripts/codex-hook.mjs',{input:JSON.stringify({...fixture,hook_event_name:'PreToolUse',tool_name:'Bash'}),endpoint});
  const notify=await run('scripts/codex-notify.mjs',{args:[JSON.stringify({type:'agent-turn-complete','thread-id':'fixture-thread'})],endpoint});
  for (const result of [claude,codex,notify]) assert.deepEqual(result,{code:0,stdout:'',stderr:''});
  assert.equal(events.length,3);
  assert.deepEqual(events.map(event=>event.source),['claude','codex','codex']);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE|SECRET|transcript/);
});

test('plugin bundle runs standalone from its bundled path', async t => {
  const { events,endpoint }=await receiver(t);
  const result=await run('integrations/claude-plugin/scripts/claude-hook.mjs',{input:JSON.stringify(fixture),endpoint});
  assert.equal(result.code,0);
  assert.equal(events[0].type,'agent.started');
  const config=JSON.parse(await readFile(new URL('../integrations/claude-plugin/hooks/hooks.json',import.meta.url)));
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) for (const hook of group.hooks) {
      assert.equal(hook.type,'command');
      assert.equal(hook.timeout,3);
      assert.equal(hook.command,'node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-hook.mjs"');
    }
  }
});

test('public Codex plugin uses PATH Node and portable contributor metadata', async t => {
  const base = new URL('../plugins/agent-office/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', base)));
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.author.name, 'Agent Office contributors');
  const hooks = JSON.parse(await readFile(new URL('hooks/hooks.json', base)));
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
    assert.equal(hook.command, 'node "${PLUGIN_ROOT}/scripts/codex-hook.mjs"');
  }
  const { events, endpoint } = await receiver(t);
  const result = await run('plugins/agent-office/scripts/codex-hook.mjs', { input: JSON.stringify(fixture), endpoint });
  assert.equal(result.code, 0); assert.equal(events[0].source, 'codex');
});

test('hook malformed input and unavailable bridge never block the original work', async () => {
  for (const input of ['{broken',JSON.stringify(fixture)]) {
    const started=Date.now();
    const result=await run('scripts/claude-hook.mjs',{input});
    assert.deepEqual(result,{code:0,stdout:'',stderr:''});
    assert.ok(Date.now()-started<2500);
  }
});

test('slow bridge times out and redirect targets are never followed', async t => {
  const slow=await receiver(t,() => {});
  await assert.rejects(postEvent({title:'fixture'},{endpoint:slow.endpoint,timeout:60}),{name:'TimeoutError'});
  const redirect=await receiver(t,(_req,res) => { res.writeHead(302,{Location:'https://example.com/'});res.end(); });
  await assert.rejects(postEvent({title:'fixture'},{endpoint:redirect.endpoint}));
  assert.equal(redirect.events.length,1);
});

test('transport rejects non-loopback addresses and credentials', () => {
  for (const address of ['https://example.com/api/events','http://127.0.0.1.evil.test/api/events','http://user:pass@127.0.0.1:4780/api/events','http://127.0.0.1:4780/other','http://127.0.0.1:4780/api/events?secret=x']) assert.throws(()=>endpointUrl(address));
});

test('project and actual model metadata distinguish main and parent-scoped child hooks', () => {
  const payload = {session_id:'actual-thread', cwd:'/Users/example/Projects/Office', model:'gpt-6-astra', hook_event_name:'UserPromptSubmit', prompt:'DO NOT SEND THIS'};
  const main = normalizeLifecycle(payload,'codex');
  assert.equal(main.type,'user.instruction');
  assert.equal(main.sessionId,'actual-thread');
  assert.equal(main.projectId,`project-${opaqueId(payload.cwd)}`);
  assert.equal(main.projectName,'Office');
  assert.equal(main.model,'gpt-6-astra');
  assert.equal(main.modelEvidence,'reported');
  assert.equal(main.observation,'hook');
  assert.doesNotMatch(JSON.stringify(main),/DO NOT SEND|Users\/example/);
  const child = normalizeLifecycle({...payload, hook_event_name:'SubagentStart', agent_id:'child-thread',turn_id:'parent-turn'},'codex');
  assert.equal(child.parentAgentId,main.agentId);
  assert.equal(child.model,undefined);
  assert.equal(child.modelEvidence,'unknown');
  assert.equal(child.taskId,undefined);
  const childOwn = normalizeLifecycle({...payload,session_id:'child-thread',hook_event_name:'PreToolUse',tool_name:'Read',model:'gpt-5.6-sol'},'codex');
  assert.equal(childOwn.agentId,child.agentId);
  assert.equal(childOwn.model,'gpt-5.6-sol');
});

test('approval completion and retirement are never inferred from tool or response completion', () => {
  const base = {session_id:'thread',model:'not a valid model'};
  for (const name of ['PostToolUse','Stop','SessionEnd']) {
    const event = normalizeLifecycle({...base,hook_event_name:name},'codex');
    assert.notEqual(event.type,'approval.resolved');
    assert.notEqual(event.type,'agent.retired');
    assert.equal(event.modelEvidence,'unknown');
  }
  assert.equal(normalizeLifecycle({...base,hook_event_name:'SessionEnd'},'codex').type,'session.ended');
});

test('manual stdin handoff sends explicit recipient; malformed handoff fails visibly', async t => {
  const { events,endpoint }=await receiver(t);
  const event=JSON.parse(await readFile(new URL('../integrations/handoff.example.json',import.meta.url)));
  const valid=await run('scripts/send-event.mjs',{input:JSON.stringify({...event,rawPrompt:'STRIPPED'}),endpoint});
  assert.equal(valid.code,0);
  assert.equal(events[0].toAgentId,'engineering-team');
  assert.equal(events[0].rawPrompt,undefined);
  const invalid=await run('scripts/send-event.mjs',{input:JSON.stringify({...event,toAgentId:undefined}),endpoint});
  assert.equal(invalid.code,1);
  assert.match(invalid.stderr,/toAgentId/);
  assert.equal(events.length,1);
});

// --- Claude 실행 모델: 직원 자신의 로컬 트랜스크립트에서 model 필드만 읽는다 ---
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptModel, readTranscriptEvidence, resolveClaudeModel, claudeTranscriptCandidates } from '../integrations/claude-plugin/scripts/adapter-core.mjs';

async function transcriptFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-office-transcript-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const line = value => `${JSON.stringify({ sessionId: 'fixture-main-session', timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false, ...value })}\n`;
  const main = join(dir, 'fixture-main-session.jsonl');
  await writeFile(main, [
    line({ type: 'user', message: { role: 'user', content: 'PRIVATE PROMPT' } }),
    line({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-fixture-main', content: [{ type: 'text', text: 'PRIVATE OUTPUT' }] } }),
    line({ type: 'assistant', isSidechain: true, agentId: 'fixture-child', message: { role: 'assistant', model: 'claude-fixture-sidechain', content: 'PRIVATE CHILD OUTPUT' } }),
    line({ type: 'progress', data: { model: 'not-an-assistant-record', text: 'PRIVATE PROGRESS' } }),
  ].join(''));
  const subagents = join(dir, 'fixture-main-session', 'subagents');
  await mkdir(join(subagents, 'workflows', 'wf_fixture'), { recursive: true });
  await mkdir(join(dir, 'elsewhere'), { recursive: true });
  await writeFile(join(subagents, 'agent-fixture-child.jsonl'), line({ type: 'assistant', isSidechain: true, agentId: 'fixture-child', message: { model: 'claude-fixture-child', content: 'PRIVATE CHILD OUTPUT' } }));
  await writeFile(join(subagents, 'workflows', 'wf_fixture', 'agent-fixture-flow.jsonl'), line({ type: 'assistant', isSidechain: true, agentId: 'fixture-flow', message: { model: 'claude-fixture-flow' } }));
  await writeFile(join(dir, 'elsewhere', 'agent-fixture-flow.jsonl'), line({ type: 'assistant', isSidechain: true, agentId: 'fixture-flow', message: { model: 'claude-fixture-explicit' } }));
  await writeFile(join(subagents, 'agent-fixture-empty.jsonl'), '');
  await writeFile(join(subagents, 'agent-fixture-bad-model.jsonl'), line({ type: 'assistant', agentId: 'fixture-bad-model', message: { model: 'not a valid model' } }));
  return { dir, main, subagents };
}

test('transcript model reader returns only the last own assistant model and never file content', async t => {
  const { main, subagents } = await transcriptFixture(t);
  assert.equal(await readTranscriptModel(main, { sessionId: 'fixture-main-session' }), 'claude-fixture-main', '팀장은 sidechain 기록을 건너뛴다');
  assert.equal(await readTranscriptModel(main, { sessionId: 'fixture-main-session', agentId: 'fixture-child' }), 'claude-fixture-sidechain', '직원 범위 지정은 자신의 기록만 인정한다');
  assert.equal(await readTranscriptModel(main, { sessionId: 'fixture-main-session', agentId: 'someone-else' }), null);
  assert.equal(await readTranscriptModel(join(subagents, 'agent-fixture-empty.jsonl'), { sessionId: 'fixture-main-session' }), null);
  assert.equal(await readTranscriptModel(join(subagents, 'agent-fixture-bad-model.jsonl'), { sessionId: 'fixture-main-session' }), null);
  assert.equal(await readTranscriptModel(join(subagents, 'missing.jsonl'), { sessionId: 'fixture-main-session' }), null);
  assert.equal(await readTranscriptModel(main, { sessionId: 'fixture-main-session', tailBytes: 8 }), null, '잘린 꼬리는 추정하지 않는다');
  for (const bad of ['relative.jsonl', '/tmp/not-a-transcript.txt', `${main}\n`, 42, null, undefined]) assert.equal(await readTranscriptModel(bad, { sessionId: 'fixture-main-session' }), null);
});

test('Claude model resolves from the employee own transcript, never from the parent session file', async t => {
  const { main, dir } = await transcriptFixture(t);
  const base = { session_id: 'fixture-main-session', transcript_path: main, cwd: '/Users/example/Projects/Office' };
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }), 'claude-fixture-main');
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'fixture-child' }), 'claude-fixture-child', '하위 에이전트 도구 hook은 subagents 폴더의 자기 파일을 쓴다');
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'PostToolUse', agent_id: 'fixture-flow' }), 'claude-fixture-flow', '워크플로 하위 폴더도 찾는다');
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'SubagentStop', agent_id: 'fixture-flow', agent_transcript_path: join(dir, 'elsewhere', 'agent-fixture-flow.jsonl') }), 'claude-fixture-explicit', 'agent_transcript_path가 우선한다');
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'SubagentStart', agent_id: 'fixture-unborn' }), null, '아직 기록이 없는 직원은 부모 모델을 물려받지 않는다');
  assert.equal(await resolveClaudeModel({ ...base, hook_event_name: 'PreToolUse', agent_id: 'fixture-bad-model' }), null);
  assert.equal(await resolveClaudeModel({ ...base, session_id: '../fixture-main-session', agent_id: 'fixture-child' }), null, '경로 조작 가능한 식별자는 무시한다');
  assert.equal(await resolveClaudeModel({ ...base, transcript_path: undefined, agent_id: 'fixture-child' }), null);
  assert.equal(await resolveClaudeModel(null), null);
  const candidates = await claudeTranscriptCandidates({ ...base, agent_id: 'fixture-child' });
  assert.ok(candidates.every(path => !path.endsWith('fixture-main-session.jsonl')), '부모 세션 파일은 후보에 들어가지 않는다');
});

test('claude hook posts the transcript model as reported evidence without leaking transcript content', async t => {
  const { main, dir } = await transcriptFixture(t);
  const { events, endpoint } = await receiver(t);
  const base = { session_id: 'fixture-main-session', transcript_path: main, cwd: '/Users/example/Projects/Office' };
  const results = [];
  results.push(await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE PROMPT' }), endpoint }));
  results.push(await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'SECRET COMMAND' }, agent_id: 'fixture-child', agent_type: 'Explore' }), endpoint }));
  results.push(await run('integrations/claude-plugin/scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'SubagentStop', agent_id: 'fixture-flow', agent_transcript_path: join(dir, 'elsewhere', 'agent-fixture-flow.jsonl'), last_assistant_message: 'PRIVATE OUTPUT' }), endpoint }));
  results.push(await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'SubagentStart', agent_id: 'fixture-unborn', agent_type: 'Explore', model: 'parent-only-model' }), endpoint }));
  for (const result of results) assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(event => [event.model, event.modelEvidence]), [
    [undefined, 'unknown'], ['claude-fixture-child', 'reported'], ['claude-fixture-explicit', 'reported'], [undefined, 'unknown'],
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET|transcript|parent-only|elsewhere|subagents/);
});

test('Claude start hooks do not promote an earlier transcript model into a new task', async t => {
  const { main } = await transcriptFixture(t);
  const { events, endpoint } = await receiver(t);
  const base = { session_id: 'fixture-main-session', transcript_path: main, turn_id: 'fresh-task' };
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'SubagentStart']) {
    await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name,
      ...(hook_event_name === 'SubagentStart' ? { agent_id: 'fixture-child' } : {}) }), endpoint });
  }
  assert.equal(events.length, 3);
  for (const event of events) assert.equal(event.modelEvidence, 'unknown', 'a new task needs its own assistant evidence');
});

test('Claude transcript fallback rejects anonymous sidechains and another session even through explicit paths', async t => {
  const { main, dir } = await transcriptFixture(t);
  const foreign = join(dir, 'foreign.jsonl');
  await writeFile(foreign, JSON.stringify({ type: 'assistant', sessionId: 'other-session', isSidechain: true,
    message: { model: 'claude-fixture-foreign' }, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  const payload = { session_id: 'fixture-main-session', agent_id: 'fixture-child', hook_event_name: 'PreToolUse',
    transcript_path: main, agent_transcript_path: foreign };
  assert.equal(await readTranscriptModel(foreign, { agentId: 'fixture-child', sessionId: 'fixture-main-session' }), null);
  await writeFile(foreign, JSON.stringify({ type: 'assistant', sessionId: 'other-session', isSidechain: true,
    agentId: 'fixture-child', message: { model: 'claude-fixture-foreign' }, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  assert.equal(await readTranscriptModel(foreign, { agentId: 'fixture-child', sessionId: 'fixture-main-session' }), null);
  const candidates = await claudeTranscriptCandidates({ ...payload, agent_transcript_path: main });
  assert.ok(!candidates.includes(main), 'an explicit child path cannot point back to the parent transcript');
});

test('Claude transcript candidate paths reject dot and dot-dot session segments', async t => {
  const { main } = await transcriptFixture(t);
  for (const session_id of ['.', '..']) {
    assert.deepEqual(await claudeTranscriptCandidates({ session_id, agent_id: 'fixture-child', transcript_path: main }), []);
  }
});

test('transcript evidence enforces exact ownership and inclusive timestamp bounds without returning content', async t => {
  const { main } = await transcriptFixture(t);
  const sessionId = 'fixture-main-session';
  const at = '2026-01-01T00:00:00.000Z';
  assert.deepEqual(await readTranscriptEvidence(main, { sessionId, since: at, before: Date.parse(at) }),
    { model: 'claude-fixture-main', timestamp: at });
  assert.equal(await readTranscriptEvidence(main), null, 'session identity is required');
  assert.equal(await readTranscriptEvidence(main, { sessionId: 'other-session' }), null);
  assert.equal(await readTranscriptEvidence(main, { sessionId, since: Date.parse(at) + 1 }), null);
  assert.equal(await readTranscriptEvidence(main, { sessionId, before: Date.parse(at) - 1 }), null);
  for (const options of [{ since: 'invalid' }, { before: NaN }, { since: at, before: '2025-01-01T00:00:00Z' }, { tailBytes: -1 }]) {
    assert.equal(await readTranscriptEvidence(main, { sessionId, ...options }), null);
  }
  for (const agentId of ['fixture-child', 'other-child']) {
    const evidence = await readTranscriptEvidence(main, { sessionId, agentId });
    assert.equal(evidence?.model ?? null, agentId === 'fixture-child' ? 'claude-fixture-sidechain' : null);
  }
});

test('unverified identity flags, invalid times and oversized tail records remain unknown', async t => {
  const { dir } = await transcriptFixture(t);
  const path = join(dir, 'strict.jsonl');
  const base = { type: 'assistant', sessionId: 'fixture-main-session', isSidechain: false,
    timestamp: '2026-01-01T00:00:00.000Z', message: { model: 'claude-fixture-current' } };
  for (const change of [{ isSidechain: undefined }, { agentId: 'child' }, { timestamp: undefined },
    { timestamp: 'not-a-time' }, { timestamp: '2026-02-30T00:00:00Z' }, { timestamp: 1767225600000 }]) {
    await writeFile(path, JSON.stringify({ ...base, ...change }) + '\n');
    assert.equal(await readTranscriptEvidence(path, { sessionId: base.sessionId }), null);
  }
  await writeFile(path, JSON.stringify({ ...base, timestamp: '2026-01-01T09:00:00+09:00' }) + '\n');
  assert.deepEqual(await readTranscriptEvidence(path, { sessionId: base.sessionId }),
    { model: 'claude-fixture-current', timestamp: '2026-01-01T00:00:00.000Z' });
  await writeFile(path, JSON.stringify({ ...base, message: { ...base.message, content: 'x'.repeat(300 * 1024) } }) + '\n');
  assert.equal(await readTranscriptEvidence(path, { sessionId: base.sessionId }), null);
});

test('child transcript candidates reject parent symlinks and choose the newest valid scoped evidence', async t => {
  const { main, dir, subagents } = await transcriptFixture(t);
  const link = join(dir, 'parent-link.jsonl');
  await symlink(main, link);
  const payload = { session_id: 'fixture-main-session', agent_id: 'fixture-child', hook_event_name: 'PreToolUse',
    transcript_path: main, agent_transcript_path: link };
  assert.ok(!(await claudeTranscriptCandidates(payload)).includes(link));
  const recent = join(subagents, 'workflows', 'wf_fixture', 'agent-fixture-child.jsonl');
  await writeFile(recent, JSON.stringify({ type: 'assistant', sessionId: payload.session_id, agentId: payload.agent_id,
    isSidechain: true, timestamp: '2026-02-01T00:00:00.000Z', message: { model: 'claude-fixture-newer' } }) + '\n');
  assert.equal(await resolveClaudeModel(payload), 'claude-fixture-newer');
  assert.equal(await resolveClaudeModel(payload, { before: '2026-01-15T00:00:00.000Z' }), 'claude-fixture-child');
  for (const session_id of ['.', '..']) assert.deepEqual(await claudeTranscriptCandidates({ ...payload, session_id }), []);
});

test('follow-up hook posts scoped timestamped evidence while direct startup model reports remain allowed', async t => {
  const { main } = await transcriptFixture(t);
  const { events, endpoint } = await receiver(t);
  const base = { session_id: 'fixture-main-session', transcript_path: main };
  await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }), endpoint });
  await run('scripts/claude-hook.mjs', { input: JSON.stringify({ ...base, hook_event_name: 'SessionStart', model: 'claude-fixture-direct' }), endpoint });
  assert.deepEqual(events.map(event => [event.model, event.modelEvidence]),
    [['claude-fixture-main', 'reported'], ['claude-fixture-direct', 'reported']]);
});
