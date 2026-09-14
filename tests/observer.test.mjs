import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,appendFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexLogObserver,RolloutState,agentId,parentFromSource,resolveMessageRecipient } from '../scripts/codex-observer.mjs';
import { createEventStore } from '../server/store.mjs';
import { normalizeEvent } from '../server/bridge.mjs';

const row={id:'child-id',cwd:'/work/office',name:'테스트 채팅',agent_nickname:'검수 직원',parent_thread_id:'root-id'};
const record=(type,payload)=>({type,payload});
const start=id=>record('event_msg',{type:'task_started',turn_id:id});
const complete=id=>record('event_msg',{type:'task_complete',turn_id:id,last_agent_message:'SECRET OUTPUT'});
const context=(id,model)=>record('turn_context',{turn_id:id,model,summary:'SECRET SUMMARY'});

test('forked session metadata never changes the owning employee; own turn model only',()=>{
  const state=new RolloutState(row,{rootSessionId:'root-id'});
  state.consume(record('session_meta',{id:'root-id',model:'parent-model',base_instructions:'SECRET'}));
  state.consume(context('parent-turn','parent-model'));
  state.consume(start('child-turn'));
  let event=state.event('agent.status','working','작업 관측');
  assert.equal(event.agentId,agentId('child-id'));assert.equal(event.parentAgentId,agentId('root-id'));
  assert.equal(event.sessionId,'root-id');assert.equal(event.modelEvidence,'unknown');assert.equal(event.model,undefined);
  state.consume(context('child-turn','actual-child-model'));
  state.consume(record('event_msg',{type:'item_completed',thread_id:'child-id',turn_id:'child-turn',item:{type:'AgentMessage',content:'SECRET'}}));
  event=state.snapshot();assert.equal(event.model,'actual-child-model');assert.equal(event.modelEvidence,'reported');
  state.consume(start('next-turn'));assert.equal(state.event('agent.status','working','작업 관측').model,undefined);
  assert.doesNotMatch(JSON.stringify(event),/SECRET|parent-model/);
});

test('copied active parent history cannot present a child as active or report the parent model',()=>{
  const state=new RolloutState(row,{rootSessionId:'root-id'});
  for(const entry of [record('session_meta',{id:'root-id'}),start('parent-turn'),context('parent-turn','parent-only-model'),record('event_msg',{type:'item_completed',thread_id:'root-id',turn_id:'parent-turn',item:{type:'AgentMessage'}})])state.consume(entry,{emit:false});
  assert.equal(state.snapshot(),null);
  assert.equal(state.event('agent.status','working','확인').model,undefined);
  assert.equal(state.event('agent.status','working','확인').modelEvidence,'unknown');
});

test('completed historical work has no initial snapshot',()=>{
  const state=new RolloutState(row);
  state.consume(start('t'),{emit:false});state.consume(context('t','model-x'),{emit:false});state.consume(complete('t'),{emit:false});
  assert.equal(state.snapshot(),null);
});

test('raw prompt, command, reasoning, output and arguments are excluded',()=>{
  const state=new RolloutState(row);state.consume(start('t'));
  const events=[
    ...state.consume(record('event_msg',{type:'item_completed',turn_id:'t',item:{type:'UserMessage',content:'SECRET PROMPT'}})),
    ...state.consume(record('response_item',{type:'function_call',name:'exec',arguments:'SECRET COMMAND',call_id:'a'})),
    ...state.consume(record('response_item',{type:'function_call_output',call_id:'a',output:'SECRET OUTPUT'})),
    ...state.consume(record('event_msg',{type:'item_completed',turn_id:'t',item:{type:'Reasoning',raw_content:'SECRET REASONING'}})),
  ];
  assert.equal(events[0].type,'user.instruction');
  assert.doesNotMatch(JSON.stringify(events),/SECRET/);
  assert.ok(events.every(e=>e.observation==='codex-log'));
});

test('Codex visible assistant messages emit once without replacing completion or exposing content',()=>{
  const state=new RolloutState({...row,parent_thread_id:null});state.consume(start('t'));
  const visible=(id,extra={})=>record('response_item',{type:'message',role:'assistant',id,content:[{type:'output_text',text:'PRIVATE RESPONSE'}],...extra});
  const events=[];
  for(const phase of ['commentary','final_answer',undefined])events.push(...state.consume(visible(`visible-${phase}`,{phase})));
  events.push(...state.consume(visible('visible-commentary',{phase:'commentary'})));
  for(const extra of [{channel:'analysis'},{phase:'analysis'},{channel:'thinking'},{phase:'thinking'},
    {type:'reasoning'},{role:'tool'},{content:[{type:'output_text',text:' '}]}])events.push(...state.consume(visible(`excluded-${events.length}`,extra)));
  assert.equal(events.length,3);assert.ok(events.every(event=>event.type==='message.sent' && event.status===undefined && event.toAgentId===undefined));
  assert.equal(new Set(events.map(event=>event.id)).size,3);
  assert.equal(state.status,'working');
  const completed=state.consume(complete('t'));assert.equal(completed.at(-1).type,'agent.completed');
  assert.doesNotMatch(JSON.stringify([...events,...completed]),/PRIVATE|SECRET/);
});

test('Codex actual input formats deduplicate within a turn and skip forwarded metadata',()=>{
  const state=new RolloutState({...row,parent_thread_id:null});
  const input=text=>record('response_item',{type:'message',role:'user',id:'input',content:[{type:'input_text',text}]});
  assert.deepEqual(state.consume(input('PRIVATE PROMPT')),[]);
  const first=state.consume(start('t'));
  assert.deepEqual(first.map(event=>event.type),['agent.started','user.instruction']);
  assert.deepEqual(state.consume(record('event_msg',{type:'user_message',message:'PRIVATE PROMPT'})),[]);
  assert.deepEqual(state.consume(record('event_msg',{type:'item_completed',turn_id:'t',item:{type:'UserMessage',content:'PRIVATE PROMPT'}})),[]);
  state.consume(complete('t'));
  for(const text of ['Message Type: MESSAGE\nPRIVATE AGENT','<environment_context>PRIVATE CONTEXT'])state.consume(input(text));
  assert.deepEqual(state.consume(start('next')).map(event=>event.type),['agent.started']);
  assert.equal(state.consume(record('event_msg',{type:'user_message',message:'PRIVATE NEXT'}))[0].type,'user.instruction');
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE/);
});

test('unmapped Codex message calls show one sender message, known handoffs and errors do not duplicate it',()=>{
  const state=new RolloutState(row,{resolveRecipient:target=>target==='known'?'recipient-id':null});state.consume(start('t'));
  const send=(id,target,output)=>{
    state.consume(record('response_item',{type:'function_call',namespace:'collaboration',name:'send_message',call_id:id,arguments:JSON.stringify({target,message:'PRIVATE BODY'})}));
    return state.consume(record('response_item',{type:'function_call_output',call_id:id,output}));
  };
  for(const output of ['', '{"success":true}']){
    const messages=send(`unknown-${output}`,'unknown',output);
    assert.equal(messages.length,1);assert.equal(messages[0].type,'message.sent');assert.equal(messages[0].toAgentId,undefined);
    assert.match(messages[0].title,/수신자 미확인/u);assert.doesNotMatch(JSON.stringify(messages),/PRIVATE/);
  }
  assert.deepEqual(send('known','known','').map(event=>event.type),['handoff']);
  const failed=send('failed','unknown','{"isError":true}');assert.equal(failed[0].status,'error');assert.equal(failed[0].type,'agent.status');
});

test('observed message requests survive empty desktop results without claiming success',()=>{
  const state=new RolloutState(row,{resolveRecipient:x=>x==='/root/reviewer'?'reviewer-id':null});state.consume(start('t'));
  const call=id=>record('response_item',{type:'function_call',namespace:'collaboration',name:'send_message',arguments:JSON.stringify({target:'/root/reviewer',message:'SECRET'}),call_id:id});
  state.consume(call('empty'));
  const requested=state.consume(record('response_item',{type:'function_call_output',call_id:'empty',output:''}));
  assert.equal(requested[0].type,'handoff');assert.match(requested[0].title,/전달 요청$/u);
  assert.equal(requested[0].toAgentId,agentId('reviewer-id'));
  state.consume(call('ok'));
  const events=state.consume(record('response_item',{type:'function_call_output',call_id:'ok',output:'{"success":true}'}));
  assert.equal(events[0].type,'handoff');assert.equal(events[0].toAgentId,agentId('reviewer-id'));
  assert.doesNotMatch(JSON.stringify(events),/SECRET/);
  for(const output of ['{"success":false}','{"ok":true,"error":"SECRET FAILURE"}','{"isError":true}','Error: SECRET FAILURE']){
    state.consume(call('error'));
    const failed=state.consume(record('response_item',{type:'function_call_output',call_id:'error',output}));
    assert.equal(failed[0].status,'error');assert.ok(failed.every(event=>event.type!=='handoff'));
    assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
  }
  state.consume(record('response_item',{type:'function_call',namespace:'collaboration',name:'followup_task',arguments:JSON.stringify({target:'/root/reviewer',message:'SECRET'}),call_id:'followup'}));
  assert.equal(state.consume(record('response_item',{type:'function_call_output',call_id:'followup',output:''}))[0].type,'handoff');
  state.consume(record('response_item',{type:'function_call',namespace:'collaboration',name:'send_message',arguments:JSON.stringify({target:'/root/unknown',message:'SECRET'}),call_id:'unknown'}));
  assert.ok(state.consume(record('response_item',{type:'function_call_output',call_id:'unknown',output:''})).every(event=>event.type!=='handoff'));
});

test('message recipients resolve the observed root and exact peers, never unknown or ambiguous names',()=>{
  const root={id:'root-id',rootSessionId:'root-id',agent_path:null};
  const sender={id:'sender-id',rootSessionId:'root-id',agent_path:'/root/sender'};
  const peer={id:'peer-id',rootSessionId:'root-id',agent_path:'/root/reviewer'};
  const rows=[root,sender,peer,{id:'unrelated',rootSessionId:'other-root',agent_path:'/root/other'}];
  assert.equal(resolveMessageRecipient(rows,sender,'/root'),'root-id');
  assert.equal(resolveMessageRecipient(rows,sender,'reviewer'),'peer-id');
  assert.equal(resolveMessageRecipient(rows,sender,'peer-id'),'peer-id');
  for(const target of ['/root/unknown','/root/other','sender-id'])assert.equal(resolveMessageRecipient(rows,sender,target),null);
  assert.equal(resolveMessageRecipient([...rows,{id:'nested',rootSessionId:'root-id',agent_path:'/root/sender/reviewer'}],sender,'reviewer'),null);
});

test('source parser reads only the explicitly reported parent relationship',()=>{
  assert.equal(parentFromSource(JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'parent'}}})),'parent');
  assert.equal(parentFromSource('vscode'),null);
});

test('appended desktop messages to the observed root reach the receiver once, while failures never become flights',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'agent-office-message-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'state.sqlite'),rootPath=join(dir,'root.jsonl'),childPath=join(dir,'child.jsonl');
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT,status TEXT);');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('root',rootPath,dir,'테스트',null,'vscode',null,null,null,0,Date.now(),0);
  insert.run('child',childPath,dir,'테스트',null,'vscode',null,null,'/root/child',0,Date.now(),0);
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run('child','root','running');db.close();
  const lines=values=>values.map(value=>JSON.stringify(value)).join('\n')+'\n';
  await writeFile(rootPath,lines([start('root-turn')]));
  await writeFile(childPath,lines([start('child-turn'),record('event_msg',{type:'item_completed',thread_id:'child',turn_id:'child-turn',item:{type:'AgentMessage'}})]));
  const received=[];const observer=new CodexLogObserver({dbPath,sessionsDir:dir,send:async event=>received.push(event)});t.after(()=>observer.close());
  await observer.poll();assert.equal(received.filter(event=>event.type==='handoff').length,0,'historical logs never replay communications at startup');
  const call=id=>record('response_item',{type:'function_call',namespace:'collaboration',name:'send_message',call_id:id,arguments:JSON.stringify({target:'/root',message:'PRIVATE MESSAGE BODY'})});
  await appendFile(childPath,lines([call('requested'),record('response_item',{type:'function_call_output',call_id:'requested',output:''})]));
  await observer.poll();await observer.poll();
  const handoffs=received.filter(event=>event.type==='handoff');
  assert.equal(handoffs.length,1);assert.equal(handoffs[0].agentId,agentId('child'));assert.equal(handoffs[0].toAgentId,agentId('root'));
  assert.equal(handoffs[0].sessionId,'root');assert.match(handoffs[0].title,/전달 요청$/u);
  await appendFile(childPath,lines([call('failed'),record('response_item',{type:'function_call_output',call_id:'failed',output:'{"isError":true}'})]));
  await observer.poll();assert.equal(received.filter(event=>event.type==='handoff').length,1);assert.equal(received.at(-1).status,'error');
  assert.doesNotMatch(JSON.stringify(received),/PRIVATE MESSAGE BODY/);
});

test('read-only DB discovery imports active snapshot only and follows appended bytes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'agent-office-observer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'state.sqlite'),activePath=join(dir,'active.jsonl'),oldPath=join(dir,'old.jsonl');
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT,status TEXT);');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for(const [id,path] of [['active',activePath],['old',oldPath]])insert.run(id,path,dir,'채팅',null,'vscode',null,null,null,0,Date.now(),Math.floor(Date.now()/1000));
  db.close();
  const lines=xs=>xs.map(x=>JSON.stringify(x)).join('\n')+'\n';
  await writeFile(activePath,lines([start('current'),context('current','reported-model')]));
  await writeFile(oldPath,lines([start('old'),complete('old')]));
  const events=[];const observer=new CodexLogObserver({dbPath,sessionsDir:dir,send:async event=>events.push(event)});t.after(()=>observer.close());
  const report=await observer.poll();assert.equal(report.active,1);assert.equal(events.length,1);assert.equal(events[0].model,'reported-model');
  const previous=observer.savedState().threads;
  await observer.poll();assert.equal(events.length,1);
  await appendFile(activePath,lines([complete('current')]));await observer.poll();
  assert.equal(events.length,2);assert.equal(events[1].type,'agent.completed');
  const reconnected=[];const next=new CodexLogObserver({dbPath,sessionsDir:dir,previous,send:async event=>reconnected.push(event)});t.after(()=>next.close());
  await next.poll();assert.equal(reconnected.length,1);assert.equal(reconnected[0].type,'agent.completed');
  assert.match(reconnected[0].title,/재연결/);
  assert.throws(()=>observer.db.exec('DELETE FROM threads'),/readonly|read-only/i);
  await appendFile(activePath,lines([start('retry-turn'),context('retry-turn','retry-model')]));
  let unavailable=true;const recovered=[];
  const flaky=new CodexLogObserver({dbPath,sessionsDir:dir,send:async event=>{if(unavailable)throw new Error('offline');recovered.push(event);}});t.after(()=>flaky.close());
  const failed=await flaky.poll();assert.equal(failed.queued,1);assert.equal(recovered.length,0);
  await appendFile(activePath,lines([complete('retry-turn')]));unavailable=false;
  const healthy=await flaky.poll();assert.equal(healthy.queued,0);assert.equal(recovered.length,2);assert.equal(recovered[1].type,'agent.completed');
});

test('tracked Codex threads still retire after newer rows push them outside the discovery limit', async t => {
  const dir=await mkdtemp(join(tmpdir(),'agent-office-archive-cap-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'state.sqlite'),path=join(dir,'tracked.jsonl');
  const db=new DatabaseSync(dbPath);t.after(()=>db.close());
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT,status TEXT);');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'), now=Date.now();
  insert.run('tracked',path,dir,'채팅',null,'vscode',null,null,null,0,now,0);
  await writeFile(path,JSON.stringify(start('tracked-turn'))+'\n');
  const events=[], observer=new CodexLogObserver({dbPath,sessionsDir:dir,send:async event=>events.push(event)});t.after(()=>observer.close());
  await observer.poll(); assert.equal(events.length,1);
  for(let index=0;index<160;index++)insert.run(`new-${index}`,join(dir,`missing-${index}.jsonl`),dir,'새 채팅',null,'vscode',null,null,null,0,now+index+1,0);
  db.prepare('UPDATE threads SET archived=1 WHERE id=?').run('tracked');
  await observer.poll(); await observer.poll();
  const retired=events.filter(event=>event.type==='agent.retired');
  assert.equal(retired.length,1); assert.equal(retired[0].agentId,agentId('tracked'));
  assert.equal(observer.files.get('tracked').state.active,false);
  const restoredEvents=[], previous=[...Array.from({length:160},(_,index)=>({id:`previous-${index}`,observed:true})),
    {id:'tracked',turnId:'tracked-turn',active:true,observed:true}];
  const restored=new CodexLogObserver({dbPath,sessionsDir:dir,previous,send:async event=>restoredEvents.push(event)});t.after(()=>restored.close());
  await restored.poll();
  assert.equal(restoredEvents.filter(event=>event.type==='agent.retired' && event.agentId===agentId('tracked')).length,1,
    'restart must also retain known archive checks beyond the discovery limit');
});

async function burstFixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'agent-office-burst-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'state.sqlite'),path=join(dir,'worker.jsonl'),now=Date.now();
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, name TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT);');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('worker',path,dir,'Fixture','vscode',null,null,null,0,now,0);db.close();
  const line=(type,payload,delta=0)=>JSON.stringify({type,payload,timestamp:new Date(now+delta).toISOString()})+'\n';
  await writeFile(path,line('event_msg',{type:'task_started',turn_id:'burst-turn'},-2000));
  const events=[],store=createEventStore({normalize:normalizeEvent}),observers=new Set();
  t.after(()=>{for(const observer of observers)observer.close();});
  const create=previous=>{
    const observer=new CodexLogObserver({dbPath,sessionsDir:dir,previous,send:async event=>{events.push(event);store.append(normalizeEvent(event));}});
    observers.add(observer);return observer;
  };
  return {path,line,events,store,create,close(observer){observer.close();observers.delete(observer);}};
}

test('Codex bursts advance one bounded chunk per poll and finish after an oversized JSONL record',async t=>{
  const f=await burstFixture(t),observer=f.create(),limit=16*1024*1024;
  await observer.poll();const startOffset=observer.files.get('worker').offset;
  const terminal=f.line('event_msg',{type:'task_complete',turn_id:'burst-turn'},100);
  await appendFile(f.path,f.line('response_item',{type:'function_call_output',call_id:'fixture',output:'x'.repeat(limit+1024)})+terminal);
  assert.equal((await observer.poll()).active,1,'a backlog must not temporarily report the known active worker as absent');
  const pending=observer.files.get('worker');
  assert.equal(pending.offset-startOffset,limit,'only read bytes may advance the cursor');
  assert.ok(pending.partial.length<=limit,'incomplete records cannot accumulate unbounded memory');
  assert.equal(f.events.filter(event=>event.type==='agent.completed').length,0);
  assert.equal((await observer.poll()).active,0);
  assert.equal(f.events.filter(event=>event.type==='agent.completed').length,1);
  assert.equal(f.store.state().agents[0].status,'idle');
  await observer.poll();assert.equal(f.events.filter(event=>event.type==='agent.completed').length,1);
});

test('Codex byte boundaries preserve split UTF-8 and wait for the final JSONL newline',async t=>{
  const f=await burstFixture(t),observer=f.create(),limit=16*1024*1024;
  await observer.poll();
  const turn='새로운-턴',next=f.line('event_msg',{type:'task_started',turn_id:turn},10);
  const prefix=f.line('ignored',{padding:''});
  const beforeCharacter=Buffer.byteLength(next.slice(0,next.indexOf(turn)));
  const padding=limit-beforeCharacter-1-Buffer.byteLength(prefix);
  const filler=f.line('ignored',{padding:'x'.repeat(padding)});
  const terminal=f.line('event_msg',{type:'task_complete',turn_id:turn},20);
  await appendFile(f.path,filler+next+terminal.trimEnd());
  await observer.poll();assert.equal(observer.files.get('worker').state.turnId,'burst-turn');
  await observer.poll();assert.equal(observer.files.get('worker').state.turnId,turn,'a character split across byte reads stays intact');
  assert.equal(f.events.filter(event=>event.type==='agent.completed').length,0,'even complete JSON waits for its record delimiter');
  await appendFile(f.path,'\n');await observer.poll();
  assert.equal(f.events.filter(event=>event.type==='agent.completed').length,1);
  assert.equal(f.store.state().agents[0].status,'idle');
});

test('a restart recovers only the saved active turn completion when a large tail omits its start',async t=>{
  const f=await burstFixture(t),observer=f.create(),limit=16*1024*1024;
  await observer.poll();
  const terminal=f.line('event_msg',{type:'task_complete',turn_id:'burst-turn'},100);
  await appendFile(f.path,f.line('response_item',{type:'function_call_output',call_id:'fixture',output:'x'.repeat(limit+1024)})+terminal);
  await observer.poll();const previous=observer.savedState().threads;f.close(observer);
  const restored=f.create(previous);await restored.poll();
  const completed=f.events.filter(event=>event.type==='agent.completed');
  assert.equal(completed.length,1);
  assert.equal(completed[0].timestamp,JSON.parse(terminal).timestamp,'restart cannot invent a newer activity timestamp');
  assert.equal(f.store.state().agents[0].status,'idle');
  const count=f.events.length,next=f.create(restored.savedState().threads);await next.poll();
  assert.equal(f.events.length,count,'a completed restart does not replay completion');
  const unrelated=f.create(previous.map(entry=>({...entry,turnId:'other-turn'})));await unrelated.poll();
  assert.equal(f.events.length,count,'a tail cannot complete a different saved turn');
});

test('restarting while a large-tail completion lacks its newline preserves the known turn until the record finishes',async t=>{
  const f=await burstFixture(t),observer=f.create(),limit=16*1024*1024;
  await observer.poll();
  await appendFile(f.path,f.line('response_item',{type:'function_call_output',call_id:'fixture',output:'x'.repeat(limit+1024)})
    +f.line('event_msg',{type:'task_complete',turn_id:'burst-turn'},100).trimEnd());
  let previous=observer.savedState().threads;f.close(observer);
  for(let restart=0;restart<2;restart++) {
    const waiting=f.create(previous);await waiting.poll();previous=waiting.savedState().threads;f.close(waiting);
    assert.equal(previous[0].active,true,'an incomplete terminal record cannot erase the last proven active turn');
    assert.equal(previous[0].observed,true);
    assert.equal(f.events.length,1,'restart does not invent fresh activity');
  }
  const resumed=f.create(previous);await resumed.poll();
  await appendFile(f.path,'\n');assert.equal((await resumed.poll()).active,0);
  assert.equal(f.events.filter(event=>event.type==='agent.completed').length,1);
  assert.equal(f.store.state().agents[0].status,'idle');
});
