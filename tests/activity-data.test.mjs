import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { ACTIVITY_KINDS, classifyActivity } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
import { normalizeLifecycle } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { normalizeEvent, createOfficeServer } from '../server/bridge.mjs';
import { createEventStore } from '../server/store.mjs';
import { updateAgentState } from '../src/office-state.ts';
import { activityMessage } from '../src/activity-bubble.ts';
import { RolloutState } from '../scripts/codex-observer.mjs';

const call = (name, args) => classifyActivity(name, args);
test('standalone public Codex plugin carries the same classifier and adapter contract', async () => {
  for (const name of ['activity-kind.mjs', 'adapter-core.mjs']) {
    const bundled = await readFile(new URL(`../plugins/agent-office/scripts/${name}`, import.meta.url), 'utf8');
    const canonical = await readFile(new URL(`../integrations/claude-plugin/scripts/${name}`, import.meta.url), 'utf8');
    assert.equal(bundled, canonical);
  }
});
test('tool classification uses actual edit paths and patch headers, not document contents or arguments mentioning work', () => {
  for (const path of ['/PRIVATE/app.ts', '/PRIVATE/main.py', '/PRIVATE/ContentView.swift']) assert.equal(call('Edit', { file_path: path, new_string: 'npm test document.md' }), 'coding');
  for (const path of ['/PRIVATE/계획.md', '/PRIVATE/report.docx', '/PRIVATE/data.xlsx']) assert.equal(call('Write', { file_path: path, content: 'const robot = "code"; npm test' }), 'documents');
  assert.equal(call('Edit', { file_path: '/PRIVATE/icon.svg' }), 'design');
  assert.equal(call('Edit', { file_path: '/PRIVATE/unknown.asset', new_string: 'code.ts' }), 'general');
  assert.equal(call('apply_patch', '*** Begin Patch\n*** Add File: PRIVATE/guide.md\n+*** Add File: misleading.ts\n*** End Patch'), 'documents');
  assert.equal(call('apply_patch', '*** Update File: PRIVATE/code.ts\n*** Update File: PRIVATE/guide.md'), 'general');
  assert.equal(call('Read', { file_path: 'README.md' }), 'reviewing');
  assert.equal(call('unknown', { file_path: 'app.ts', command: 'npm test' }), 'general');
});

test('command classification is bounded and recognizes executables without executing or scanning quoted script bodies', () => {
  for (const command of ['pnpm test', 'npm run test:unit', 'node --test tests/a.mjs', 'python3 -m pytest', 'cd /PRIVATE/project && pnpm build', 'xcodebuild -scheme Example']) assert.equal(call('Bash', { command }), 'testing', command);
  for (const command of ['rg -n "npm test" src', 'grep "deploy" file']) assert.equal(call('exec_command', { cmd: command }), 'research');
  assert.equal(call('Bash', { command: 'git diff -- PRIVATE.ts' }), 'reviewing');
  assert.equal(call('Bash', { command: 'git push origin work' }), 'shipping');
  for (const command of ['echo "npm test"', 'python3 -c "print(\"npm test\")"', 'node -e "console.log(\"build\")"', 'sh -c "npm test"', 'echo test; pnpm test', '$(pnpm test)', 'echo `npm test`', 'pnpm test >PRIVATE.txt', 'x'.repeat(150000)]) assert.equal(call('Bash', { command }), 'general', command.slice(0, 50));
});

test('fixed-purpose tools map consistently to all remaining activity families', () => {
  assert.equal(call('WebSearch', {}), 'research');
  assert.equal(call('web.run', {}), 'research');
  assert.equal(call('functions.update_plan', {}), 'planning');
  assert.equal(call('TaskUpdate', {}), 'planning');
  assert.equal(call('TodoWrite', { todos: [{ content: 'PRIVATE PLAN', status: 'in_progress' }] }), 'planning');
  assert.equal(call('image_gen.imagegen', {}), 'design');
  assert.equal(call('collaboration.spawn_agent', {}), 'delivery');
  assert.equal(call('SendMessage', {}), 'delivery');
  assert.equal(call('mcp__unknown__tool', { prompt: 'please review, test and ship' }), 'general');
  assert.equal(ACTIVITY_KINDS.length, 10);
});

test('Codex freeform exec only parses literal tools calls and ignores strings, comments, regex, dynamic code and ambiguity', () => {
  assert.equal(call('exec', 'const r = await tools.exec_command({cmd: "pnpm test", yield_time_ms: 1000}); text(r);'), 'testing');
  assert.equal(call('functions.exec', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: PRIVATE/guide.md\\n+x\\n*** End Patch"));'), 'documents');
  assert.equal(call('exec', 'await Promise.all([tools.exec_command({cmd:"pnpm build"}), tools.exec_command({cmd:"npm test"})]);'), 'testing');
  for (const source of [
    'text("tools.exec_command({cmd:\\"npm test\\"})")',
    '"tools.exec_command({cmd:\\"npm test\\"})"',
    '// tools.exec_command({cmd:"npm test"})',
    '/* tools.exec_command({cmd:"npm test"}) */',
    'const regex = /tools.exec_command({cmd:"npm test"})/;',
    'const value = `tools.exec_command({cmd:"npm test"})`;',
    'await tools.exec_command({cmd:command});',
    'await tools.exec_command({cmd:`${command}`});',
    'await tools.exec_command({cmd:"npm test" + extra});',
    'await tools.exec_command({cmd:"npm test", ...options});',
    'await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"rg foo"});',
    'eval("tools.exec_command({cmd:\\"npm test\\"})")',
  ]) assert.equal(call('exec', source), 'general', source);
});

test('hook output exposes only a fixed activity enum and distinguishes docs, tests, failures and unknown tools', () => {
  for (const source of ['claude', 'codex']) for (const hook of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
    const event = normalizeLifecycle({ session_id: 'test', hook_event_name: hook, tool_name: 'Edit',
      tool_input: { file_path: '/PRIVATE/guide.md', new_string: 'PRIVATE CONTENT' } }, source);
    assert.equal(event.activityKind, 'documents');
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE|file_path|new_string|tool_input/);
  }
  assert.equal(normalizeLifecycle({ session_id: 'test', hook_event_name: 'PostToolUse', tool_name: 'Bash' }).activityKind, 'general');
  const planning = normalizeLifecycle({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'PRIVATE PLAN' }] } });
  assert.equal(planning.activityKind, 'planning'); assert.equal(planning.toolName, 'TodoWrite');
  assert.doesNotMatch(JSON.stringify(planning), /PRIVATE|todos/);
});

const record = (type, payload) => ({ type, payload });
const started = () => record('event_msg', { type: 'task_started', turn_id: 'turn-one' });
const tool = (id, name, input, custom = false) => record('response_item', { type: custom ? 'custom_tool_call' : 'function_call',
  call_id: id, name, namespace: 'functions', ...(custom ? { input } : { arguments: JSON.stringify(input) }) });
const result = (id, output = '{}', custom = false) => record('response_item', { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output });

test('Codex call/output matching survives parallel calls, wrappers, model updates and completion without stale activity', () => {
  const state = new RolloutState({ id: 'fixture' }); state.consume(started());
  const first = state.consume(tool('doc', 'apply_patch', '*** Update File: PRIVATE/plan.md', true))[0];
  assert.equal(first.activityKind, 'documents');
  assert.equal(state.consume(tool('test', 'exec', 'await tools.exec_command({cmd:"pnpm test"});', true))[0].activityKind, 'testing');
  const earlierFinished = state.consume(result('doc', '{}', true))[0];
  assert.equal(earlierFinished.activityKind, 'testing'); assert.equal(earlierFinished.status, 'working');
  const model = state.consume(record('turn_context', { turn_id: 'turn-one', model: 'actual-model' }))[0];
  assert.equal(model.activityKind, 'testing');
  const failedTest = state.consume(result('test', '{"exit_code":1}', true))[0];
  assert.equal(failedTest.activityKind, 'testing'); assert.equal(failedTest.status, 'error');
  assert.equal(state.consume(tool('unknown', 'exec_command', { cmd: 'echo PRIVATE' }))[0].activityKind, 'general');
  assert.equal(state.consume(result('unknown', '{"isError":true,"error":"PRIVATE"}'))[0].activityKind, 'general');
  assert.deepEqual(state.consume(result('unmatched')), []);
  const ended = state.consume(record('event_msg', { type: 'task_complete', turn_id: 'turn-one' }))[0];
  assert.equal(ended.activityKind, undefined); assert.equal(state.activityKind, undefined);
  assert.equal(state.consume(started())[0].activityKind, 'general');
  assert.doesNotMatch(JSON.stringify([first, earlierFinished, model, ended]), /PRIVATE|tool_input|arguments|command/);
});

test('HTTP bridge, private persistence, recovered snapshot, reducer and bubble preserve only validated activity metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-activity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createOfficeServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET',
      headers: { Host: '127.0.0.1:4780', 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const event = normalizeLifecycle({ session_id: 'fixture', hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: '/PRIVATE/guide.md', content: 'PRIVATE CONTENT' } });
  const posted = await request('/api/events', event);
  assert.equal(posted.status, 202);
  const state = (await request('/api/state')).data; assert.equal(state.agents[0].activityKind, 'documents');
  const agent = updateAgentState([], state.agents[0]); assert.equal(activityMessage(agent).text, '문서 정리 중');
  const disk = await readFile(join(dir, 'events.jsonl'), 'utf8'); assert.doesNotMatch(disk, /PRIVATE|file_path|tool_input|content/);
  const restored = createEventStore({ dataDir: dir, normalize: normalizeEvent }); assert.equal(restored.state().agents[0].activityKind, 'documents');
  assert.throws(() => normalizeEvent({ ...event, activityKind: 'PRIVATE arbitrary text' }), /activityKind/);
  assert.throws(() => normalizeEvent({ ...event, activityKind: { kind: 'coding' } }), /activityKind/);
});

test('lifecycle reducers clear ended work, keep metadata-only model proofs and reset new unclassified executions', () => {
  let n = 0;
  const event = extra => normalizeEvent({ id: `activity-${++n}`, timestamp: new Date(1700000000000 + n * 1000).toISOString(),
    source: 'claude', type: 'agent.status', agentId: 'employee', status: 'working', title: '도구 실행', ...extra });
  const store = createEventStore({ normalize: normalizeEvent }), agents = [];
  const apply = extra => { const e = event(extra); store.append(e); updateAgentState(agents, e); return e; };
  const current = () => { assert.equal(agents[0].activityKind, store.state().agents[0].activityKind); return agents[0].activityKind; };
  const first = apply({ activityKind: 'coding' }); assert.equal(current(), 'coding');
  apply({ type: 'agent.model', observation: 'claude-log', referenceEventId: first.id, model: 'own-model', modelEvidence: 'reported',
    modelObservedAt: first.timestamp, activityKind: 'design' }); assert.equal(current(), 'coding');
  apply({ toolName: 'MCP 도구' }); assert.equal(current(), 'general');
  apply({ activityKind: 'documents' }); assert.equal(current(), 'documents');
  apply({ type: 'agent.completed', activityKind: 'documents' }); assert.equal(current(), undefined);
  apply({ type: 'user.instruction', status: 'thinking' }); assert.equal(current(), 'general');
  apply({ activityKind: 'testing' });
  apply({ type: 'session.ended' }); assert.equal(current(), undefined);
});

test('activity bubbles show confirmed families and state, never progress or success from completion', () => {
  assert.equal(activityMessage({ status: 'working', activityKind: 'coding', task: '/PRIVATE/main.ts' }).fullText, '코드 작업 중');
  assert.equal(activityMessage({ status: 'error', activityKind: 'testing' }).text, '테스트·빌드 · 오류');
  assert.equal(activityMessage({ status: 'approval', activityKind: 'shipping' }).text, '결과물 내보내기 · 확인 요청');
  assert.equal(activityMessage({ status: 'working', activityKind: 'general' }).text, '일반 작업 중');
  assert.equal(activityMessage({ status: 'done', activityKind: 'coding' }).text, '응답 종료');
  assert.equal(activityMessage({ status: 'idle', activityKind: 'coding' }).text, '');
});
