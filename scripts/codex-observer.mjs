#!/usr/bin/env node
// Codex 0.153.4 내부 JSONL 형식에 대한 실험적 읽기 전용 관측기입니다.
// 앱의 app-server를 시작·재개하거나 명령을 전달하지 않습니다.
import { mkdir, open, readFile, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { opaqueId, postEvent } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
import { classifyActivity, nextActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 구버전 Node는 아래에서 실행 안내를 반환합니다. */ }
const codexHome = () => resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'));

const MAX_READ = 16 * 1024 * 1024;
const tools = new Set(['exec','exec_command','write_stdin','apply_patch','Read','Write','Edit','Bash','Grep','Glob','WebSearch','WebFetch','spawn_agent','send_message','followup_task','wait_agent','wait','interrupt_agent','list_agents']);
const clean = (value,max=100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu,' ').trim().slice(0,max) : '';
export const agentId = id => `codex-${opaqueId(id)}-main`;
const toolName = name => tools.has(name) ? name : typeof name==='string' && name.startsWith('mcp__') ? 'MCP 도구' : '도구';

export function parentFromSource(source) {
  try {
    const parsed = typeof source==='string' ? JSON.parse(source) : source;
    return parsed?.subagent?.thread_spawn?.parent_thread_id || null;
  } catch { return null; }
}

/** Only resolve identities actually present in this task's metadata; nicknames are not identities. */
export function resolveMessageRecipient(rows, sender, target) {
  if(typeof target!=='string' || !target || target.length>256)return null;
  const peers=rows.filter(row=>row.rootSessionId===sender.rootSessionId);
  const exact=peers.find(row=>row.id===target);
  if(exact)return exact.id===sender.id?null:exact.id;
  const candidates=target.startsWith('/')?[target]:[`/root/${target}`,`${sender.agent_path || '/root'}/${target}`];
  const matches=peers.filter(row=>candidates.includes(row.agent_path || (row.id===row.rootSessionId?'/root':null)));
  return matches.length===1 && matches[0].id!==sender.id?matches[0].id:null;
}

export class RolloutState {
  constructor(metadata, { rootSessionId=metadata.id, resolveRecipient=()=>null }={}) {
    this.metadata=metadata;
    this.rootSessionId=rootSessionId;
    this.resolveRecipient=resolveRecipient;
    this.active=false;
    this.status='idle';
    this.activityKind=undefined;
    this.turnId=null;
    this.models=new Map();
    this.ownTurns=new Set();
    this.pending=new Map();
    this.observed=false;
    this.sequence=0;
    this.messageIds=new Set();
    this.inputObserved=false;
    this.awaitingInput=false;
    this.lastEventAt=null;
  }

  event(type,status,title,extra={}) {
    const m=this.metadata;
    const ownModel=(!m.parent_thread_id || this.ownTurns.has(this.turnId))?this.models.get(this.turnId):undefined;
    const event={
      source:'codex',type,agentId:agentId(m.id),
      agentName:clean(m.agent_nickname,64)||`Codex 직원 ${opaqueId(m.id).slice(0,4)}`,
      sessionId:this.rootSessionId,observation:'codex-log',
      modelEvidence:ownModel?'reported':'unknown',
      status,title,timestamp:new Date().toISOString(),
      id:`log-${opaqueId(m.id)}-${opaqueId(`${this.turnId}:${this.sequence++}:${Date.now()}`)}`,
      ...extra,
    };
    if (type !== 'message.sent' && this.activityKind !== undefined && event.activityKind === undefined) event.activityKind = this.activityKind;
    if(ownModel)event.model=ownModel;
    if(m.parent_thread_id)event.parentAgentId=agentId(m.parent_thread_id);
    if(m.agent_role)event.role=clean(m.agent_role,80);
    const name=clean(m.sessionName || m.name,120);
    if(name)event.sessionName=name;
    if(m.cwd && typeof m.cwd==='string' && m.cwd.startsWith('/')) {
      event.projectId=`project-${opaqueId(resolve(m.cwd))}`;
      event.projectName=basename(resolve(m.cwd)).slice(0,100)||'기본 프로젝트';
    }
    if(this.turnId)event.taskId=`codex-turn-${opaqueId(`${m.id}:${this.turnId}`)}`;
    return event;
  }

  consume(record,{emit=true}={}) {
    if(!record || typeof record!=='object')return [];
    const p=record.payload;
    if(!p || typeof p!=='object')return [];
    const observedAt=typeof record.timestamp==='string' && Number.isFinite(Date.parse(record.timestamp))
      ? new Date(record.timestamp).toISOString() : new Date().toISOString();
    const out=[];
    const add=(type,status,title,extra={})=>{
      this.activityKind=nextActivityKind(this.activityKind,{type,...extra},status);
      this.status=status;this.lastEventAt=observedAt;if(emit)out.push(this.event(type,status,title,{timestamp:observedAt,...extra}));
    };
    const modelEvidence=title=>{
      // 실행 모델 확인은 최근 작업 상태를 보강하며 새 활동 시각을 만들지 않습니다.
      if(emit)out.push(this.event('agent.status',this.status,title,{timestamp:this.lastEventAt ?? observedAt}));
    };
    const input=()=>{
      if(!this.active){this.awaitingInput=true;return;}
      if(!this.inputObserved){this.inputObserved=true;add('user.instruction','thinking','사장님의 업무 지시 접수');}
    };
    const message=(key,title,extra={})=>{
      if(this.messageIds.has(key))return;
      this.messageIds.add(key);
      if(this.messageIds.size>2048)this.messageIds.delete(this.messageIds.values().next().value);
      if(emit)out.push(this.event('message.sent',undefined,title,{id:`codex-message-${opaqueId(`${this.metadata.id}:${key}`)}`,timestamp:observedAt,...extra}));
    };
    if(record.type==='response_item' && p.type==='message' && p.role==='user') {
      const content=Array.isArray(p.content)?p.content:[];
      const text=content.filter(item=>item?.type==='input_text' && typeof item.text==='string').map(item=>item.text).join('\n');
      // Forwarded agent envelopes and injected environment messages are not instructions from the owner.
      if(text.trim() && !/Message Type:\s*(?:NEW_TASK|MESSAGE|FINAL_ANSWER)|^\s*<(?:environment_context|system_reminder|turn_aborted|permissions|collaboration)/iu.test(text))input();
      return out;
    }
    if(record.type==='turn_context') {
      // 모델 카탈로그·DB 기본값·부모 세션 메타데이터는 실행 모델 증거로 쓰지 않습니다.
      if(typeof p.turn_id==='string' && typeof p.model==='string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/u.test(p.model)) {
        this.models.set(p.turn_id,p.model);
        if(this.models.size>16)this.models.delete(this.models.keys().next().value);
        if(this.active && this.turnId===p.turn_id)modelEvidence('실행 모델 확인');
      }
      return out;
    }
    if(record.type==='event_msg') {
      if(p.thread_id===this.metadata.id && typeof p.turn_id==='string') {
        const newlyOwned=!this.ownTurns.has(p.turn_id);
        this.ownTurns.add(p.turn_id);
        if(this.ownTurns.size>32)this.ownTurns.delete(this.ownTurns.values().next().value);
        if(newlyOwned && this.active && this.turnId===p.turn_id && this.models.has(p.turn_id))modelEvidence('하위 에이전트 실행 모델 확인');
      }
      if(p.type==='task_started' && typeof p.turn_id==='string') {
        this.active=true;this.turnId=p.turn_id;this.pending.clear();this.inputObserved=false;
        add('agent.started','working','Codex 작업 시작');
        if(this.awaitingInput){this.awaitingInput=false;input();}
      } else if(p.type==='user_message') {
        input();
      } else if(p.type==='task_complete' && p.turn_id===this.turnId) {
        this.active=false;this.pending.clear();
        add('agent.completed','done','Codex 응답 종료');
      } else if(p.type==='turn_aborted' && (!p.turn_id || p.turn_id===this.turnId)) {
        this.active=false;this.pending.clear();
        add('agent.status','waiting','Codex 작업 중단');
      } else if(this.active && p.type==='item_completed' && (!p.turn_id || p.turn_id===this.turnId)) {
        const item=p.item;
        if(item?.type==='UserMessage')input();
        if(item?.type==='CommandExecution')add('agent.status',item.exit_code!==null && item.exit_code!==undefined && item.exit_code!==0?'error':'thinking','명령 실행 결과 수신',
          {toolName:'Bash',activityKind:classifyActivity('Bash',{command:item.command})});
        if(item?.type==='FileChange') {
          const changes=item.changes && typeof item.changes==='object' && !Array.isArray(item.changes)?Object.keys(item.changes).slice(0,128):[];
          add('agent.status','working','파일 변경 기록 확인',{toolName:'apply_patch',
            activityKind:classifyActivity('apply_patch',changes.map(path=>`*** Update File: ${path}`).join('\n'))});
        }
        if(item?.type==='McpToolCall')add('agent.status',item.status==='failed'?'error':'thinking','MCP 도구 결과 수신',
          {toolName:'MCP 도구',activityKind:classifyActivity(item.tool,item.arguments)});
      }
      return out;
    }
    if(!this.active || record.type!=='response_item')return out;
    if(p.type==='message' && p.role==='assistant') {
      if(!['analysis','thinking'].includes(p.channel) && !['analysis','thinking'].includes(p.phase)
        && Array.isArray(p.content) && p.content.some(item=>item?.type==='output_text' && typeof item.text==='string' && item.text.trim())) {
        message(`text:${p.id || `${this.turnId}:${record.timestamp || this.sequence++}`}`,'메시지 전송 기록');
      }
    } else if(['function_call','custom_tool_call'].includes(p.type)) {
      const name=typeof p.name==='string'?p.name.split('.').at(-1):p.name;
      const label=toolName(name);
      const activityKind=classifyActivity(p.namespace?`${p.namespace}.${name}`:p.name,p.input ?? p.arguments);
      // 원문 arguments를 보관하지 않습니다. 명시적인 메시지 수신자만 짧게 보관합니다.
      let recipient=null,messageCall=false;
      if(['send_message','followup_task'].includes(name) && p.namespace==='collaboration') {
        try {
          const args=JSON.parse(p.arguments);
          if(typeof args.target==='string' && args.target && typeof args.message==='string' && args.message.trim()){
            recipient=this.resolveRecipient(args.target);messageCall=true;
          }
        } catch { /* 검증 불가한 수신자는 추정하지 않습니다. */ }
      }
      if(typeof p.call_id==='string') {
        this.pending.set(p.call_id,{tool:label,recipient,messageCall,activityKind});
        if(this.pending.size>128)this.pending.delete(this.pending.keys().next().value);
      }
      add('agent.status','working',`${label} 실행 중`,{toolName:label,activityKind});
    } else if(['function_call_output','custom_tool_call_output'].includes(p.type)) {
      const pending=this.pending.get(p.call_id);
      if(!pending)return out;
      this.pending.delete(p.call_id);
      // 빈 Desktop output은 성공 증거가 아닙니다. 실제 호출의 전달 요청만 표시합니다.
      let confirmed=false,failed=false;
      try {
        const result=typeof p.output==='string' && p.output.length<8192?JSON.parse(p.output):null;
        confirmed=result?.success===true || result?.ok===true || result?.sent===true;
        failed=result?.success===false || result?.ok===false || result?.sent===false || result?.isError===true
          || Boolean(result?.error) || result?.status==='failed'
          || Number.isFinite(result?.exit_code) && result.exit_code!==0;
      } catch { failed=typeof p.output==='string' && /^\s*(?:error|failed)\b/iu.test(p.output); }
      const active=[...this.pending.values()].at(-1);
      const resumed=active ?? pending;
      if(failed)add('agent.status','error',`${pending.tool} 실행 실패`,{toolName:pending.tool,activityKind:pending.activityKind});
      else if(pending.recipient && (confirmed || p.output===''))add('handoff','working',confirmed?'에이전트에게 자료 전달 확인':'에이전트에게 메시지 전달 요청',
        {toAgentId:agentId(pending.recipient),toolName:resumed.tool,activityKind:resumed.activityKind});
      else if(pending.messageCall && (confirmed || p.output===''))message(`tool:${p.call_id}`,'메시지 전달 요청 · 수신자 미확인',{toolName:pending.tool});
      else add('agent.status',active?'working':'thinking',active?`${active.tool} 실행 중`:`${pending.tool} 결과 수신`,
        {toolName:resumed.tool,activityKind:resumed.activityKind});
    }
    return out;
  }

  snapshot() {
    if(!this.active || (this.metadata.parent_thread_id && !this.ownTurns.has(this.turnId)))return null;
    return this.event('agent.status',this.status,'실행 중인 Codex 작업 관측',{timestamp:this.lastEventAt ?? new Date().toISOString()});
  }
}

async function readSlice(path,position,length) {
  const file=await open(path,'r');
  try {const buffer=Buffer.alloc(length);const {bytesRead}=await file.read(buffer,0,length,position);return buffer.subarray(0,bytesRead);}
  finally {await file.close();}
}

function* recordsFromChunk(entry,buffer) {
  let position=0;
  while(position<buffer.length) {
    const newline=buffer.indexOf(10,position),end=newline<0?buffer.length:newline;
    const segment=buffer.subarray(position,end);
    if(entry.skippingLine) {
      if(newline>=0)entry.skippingLine=false;
    } else if(entry.partial.length+segment.length>MAX_READ) {
      // 한 레코드가 읽기 한도를 넘더라도 다음 줄의 종료 이벤트까지 버리지 않습니다.
      entry.partial=Buffer.alloc(0);entry.skippingLine=newline<0;
    } else if(newline<0) {
      entry.partial=entry.partial.length?Buffer.concat([entry.partial,segment]):Buffer.from(segment);
    } else {
      const line=entry.partial.length?Buffer.concat([entry.partial,segment]):segment;
      entry.partial=Buffer.alloc(0);
      // UTF-8 문자는 바이트 경계에서 나뉠 수 있으므로 완전한 JSONL 줄만 디코딩합니다.
      try {yield JSON.parse(line.toString('utf8'));} catch { /* 불완전하거나 잘못된 레코드는 추정하지 않습니다. */ }
    }
    position=newline<0?buffer.length:newline+1;
  }
}

export class CodexLogObserver {
  constructor({dbPath=resolve(codexHome(),'state_5.sqlite'),sessionsDir=resolve(codexHome(),'sessions'),send=postEvent,threadId=null,maxAgeMs=24*60*60*1000,previous=[]}={}) {
    if (!DatabaseSync) throw new Error('Node.js 24 이상이 필요합니다.');
    this.db=new DatabaseSync(dbPath,{readOnly:true});
    this.sessionsDir=resolve(sessionsDir);
    this.send=send;this.threadId=threadId;this.maxAgeMs=maxAgeMs;this.files=new Map();
    this.previous=new Map(previous.filter(x=>x && typeof x.id==='string').map(x=>[x.id,x]));
    this.queue=[];this.canSend=true;
    this.sent=0;this.failures=0;this.startedAt=Date.now();
  }
  close(){this.db.close();}
  metadata() {
    // title은 최초 사용자 프롬프트를 담을 수 있으므로 조회하지 않습니다.
    const columns='id,rollout_path,cwd,name,source,agent_nickname,agent_role,agent_path,archived';
    const rows=this.db.prepare(`SELECT ${columns} FROM threads WHERE archived=0 AND COALESCE(updated_at_ms,updated_at*1000)>=? ORDER BY COALESCE(updated_at_ms,updated_at*1000) DESC LIMIT 160`).all(Date.now()-this.maxAgeMs);
    const selected=new Set(rows.map(row=>row.id));
    const known=[...new Set([...this.previous.keys(),...this.files.keys()])].filter(id=>!selected.has(id));
    // 새 작업 발견 한도와 이미 관측한 작업의 보관 확인을 분리합니다. 알려진 ID만 인덱스로 조회합니다.
    for(let index=0;index<known.length;index+=160){
      const batch=known.slice(index,index+160);
      rows.push(...this.db.prepare(`SELECT ${columns} FROM threads WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch));
    }
    const edges=new Map(this.db.prepare('SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges').all().map(e=>[e.child_thread_id,e.parent_thread_id]));
    const map=new Map(rows.map(row=>[row.id,row]));
    for(const row of rows)row.parent_thread_id=edges.get(row.id)||parentFromSource(row.source);
    const root=id=>{let current=id;const seen=new Set();while(!seen.has(current)){seen.add(current);const parent=edges.get(current)||map.get(current)?.parent_thread_id;if(!parent)break;current=parent;}return current;};
    for(const row of rows){row.rootSessionId=root(row.id);const rootMeta=map.get(row.rootSessionId);row.sessionName=rootMeta?.name||row.name||`Codex 작업 ${opaqueId(row.rootSessionId).slice(0,4)}`;}
    return rows.filter(row=>!this.threadId || row.id===this.threadId || row.rootSessionId===this.threadId);
  }
  async forward(events) {
    for(const event of events){
      if(event.type==='agent.status'){
        const previous=this.queue.findIndex(queued=>queued.type==='agent.status' && queued.agentId===event.agentId && queued.taskId===event.taskId);
        if(previous>=0)this.queue.splice(previous,1);
      }
      this.queue.push(event);
      if(this.queue.length>256){const disposable=this.queue.findIndex(queued=>queued.type==='agent.status');this.queue.splice(disposable>=0?disposable:0,1);}
    }
    if(this.canSend)await this.flush();
  }
  async flush(){
    while(this.queue.length && this.canSend){
      try{await this.send(this.queue[0]);this.queue.shift();this.sent++;}
      catch{this.failures++;this.canSend=false;}
    }
  }
  async poll() {
    this.canSend=true;await this.flush();
    const rows=this.metadata();
    const allowedRoot=await realpath(this.sessionsDir);
    let active=0;
    for(const row of rows) {
      try {
        let entry=this.files.get(row.id);
        // Archiving is database metadata and need not append another rollout record.
        if(entry && row.archived) {
          if(!entry.archived && entry.state.observed)await this.forward([entry.state.event('agent.retired','idle','보관된 Codex 작업 확인')]);
          entry.archived=true;entry.resumePending=false;entry.state.active=false;entry.state.pending.clear();
          continue;
        }
        const path=await realpath(row.rollout_path);
        if(!path.startsWith(allowedRoot+sep)||!path.endsWith('.jsonl'))continue;
        const info=await stat(path);
        if(entry){entry.state.metadata=row;entry.state.rootSessionId=row.rootSessionId;entry.state.resolveRecipient=target=>resolveMessageRecipient(rows,row,target);}
        if(entry)entry.archived=false;
        if(!entry || info.size<entry.offset) {
          const state=new RolloutState(row,{rootSessionId:row.rootSessionId,resolveRecipient:target=>resolveMessageRecipient(rows,row,target)});
          const previous=entry?{turnId:entry.state.turnId,active:entry.state.active||entry.resumePending,observed:entry.state.observed}:this.previous.get(row.id);
          // 시작 줄이 tail 밖이어도 저장된 동일 턴의 명시적 종료만 복구합니다. 새 활동은 만들지 않습니다.
          const canRecover=previous?.active && previous.observed && typeof previous.turnId==='string';
          if(canRecover)state.turnId=previous.turnId;
          const start=Math.max(0,info.size-MAX_READ);
          const buffer=await readSlice(path,start,info.size-start);
          entry={state,offset:start+buffer.length,partial:Buffer.alloc(0),skippingLine:start>0};
          for(const record of recordsFromChunk(entry,buffer)){try{state.consume(record,{emit:false});}catch{}}
          // 종료 줄이 아직 쓰이는 중이면 다음 재시작에도 이미 관측한 턴의 정체만 보존합니다.
          entry.resumePending=Boolean(canRecover && state.turnId===previous.turnId && !state.active && !['done','waiting'].includes(state.status));
          if(entry.resumePending)state.observed=true;
          this.files.set(row.id,entry);
          const snapshot=state.snapshot();
          if(row.archived){
            if(previous?.observed){await this.forward([state.event('agent.retired','idle','보관된 Codex 작업 확인')]);state.observed=true;}
            state.active=false;entry.resumePending=false;entry.archived=true;
          }
          else if(snapshot){await this.forward([snapshot]);state.observed=true;}
          else if(previous?.active && previous.observed && previous.turnId===state.turnId && ['done','waiting'].includes(state.status)) {
            await this.forward([state.event(state.status==='done'?'agent.completed':'agent.status',state.status,'관측 재연결: 작업 종료 확인',
              {timestamp:state.lastEventAt ?? new Date().toISOString()})]);state.observed=true;
          }
        } else if(info.size>entry.offset) {
          const buffer=await readSlice(path,entry.offset,Math.min(MAX_READ,info.size-entry.offset));
          entry.offset+=buffer.length;
          for(const record of recordsFromChunk(entry,buffer)){try{const events=entry.state.consume(record);await this.forward(events);if(events.length)entry.state.observed=true;}catch{}}
        }
        if(entry.state.active || ['done','waiting'].includes(entry.state.status))entry.resumePending=false;
        if((entry.state.active || entry.resumePending) && (!row.parent_thread_id || entry.resumePending || entry.state.ownTurns.has(entry.state.turnId)))active++;
      } catch { this.failures++; }
    }
    return {observation:'codex-log',experimental:true,active,tracked:this.files.size,sent:this.sent,queued:this.queue.length,failures:this.failures};
  }
  savedState(){return {version:1,threads:[...this.files].map(([id,entry])=>({id,turnId:entry.state.turnId,active:entry.state.active||entry.resumePending||this.queue.some(event=>event.agentId===agentId(id)),observed:entry.state.observed}))};}
}

export async function main(args=process.argv.slice(2)) {
  const value=flag=>{const index=args.indexOf(flag);return index>=0?args[index+1]:undefined;};
  let observer;
  const dataDir=process.env.AGENT_OFFICE_DATA_DIR;
  const writeData=async(name,data)=>{
    if(!dataDir)return;
    await mkdir(dataDir,{recursive:true,mode:0o700});
    const path=resolve(dataDir,name);
    const temp=path+`.${process.pid}.tmp`;
    await writeFile(temp,JSON.stringify(data)+'\n',{mode:0o600});
    await rename(temp,path);
  };
  const writeStatus=report=>writeData('observer-status.json',{...report,pid:process.pid,updatedAt:new Date().toISOString()});
  try {
    const dry=args.includes('--dry-run');
    let previous=[];
    if(dataDir){try{const text=await readFile(resolve(dataDir,'observer-cursors.json'),'utf8');if(text.length<65536){const parsed=JSON.parse(text);if(parsed.version===1 && Array.isArray(parsed.threads))previous=parsed.threads;}}catch{}}
    observer=new CodexLogObserver({dbPath:value('--db'),sessionsDir:value('--sessions-dir'),threadId:value('--thread'),previous,send:dry?async event=>process.stdout.write(JSON.stringify(event)+'\n'):postEvent});
    const interval=3000;
    let stopping=false;
    const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    do {
      const report=await observer.poll();
      await writeStatus({...report,state:args.includes('--once')?'complete':'running'});
      if(!dry)await writeData('observer-cursors.json',observer.savedState());
      if(args.includes('--once')){process.stderr.write(JSON.stringify(report)+'\n');break;}
      if(!stopping)await new Promise(resolve=>setTimeout(resolve,interval));
    } while(!stopping);
  } catch {
    try{await writeStatus({observation:'codex-log',experimental:true,state:'unavailable'});}catch{}
    process.stderr.write(DatabaseSync ? 'Codex 로컬 작업 기록에 읽기 전용으로 연결하지 못했습니다.\n' : 'Codex 관측기는 node:sqlite를 제공하는 Node.js 24 이상이 필요합니다.\n');process.exitCode=2;
  } finally {observer?.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main();
