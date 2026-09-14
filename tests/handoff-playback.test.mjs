import test from 'node:test';
import assert from 'node:assert/strict';
import { HandoffPlayback } from '../src/handoff-playback.ts';

const now = Date.parse('2026-01-01T00:00:00Z');
const event = (overrides = {}) => ({ source:'codex', type:'handoff', id:'message', agentId:'sender', toAgentId:'recipient',
  title:'에이전트에게 메시지 전달 요청', timestamp:new Date(now).toISOString(), ...overrides });

test('an offscreen observed handoff waits for real endpoints and successful rendering, then plays once', () => {
  const playback = new HandoffPlayback(); const played=[];
  assert.equal(playback.enqueue(event(),now),true);
  assert.equal(playback.enqueue(event(),now),false);
  assert.equal(playback.drain({now,ready:()=>false,play:entry=>{played.push(entry);return true;}}),0);
  assert.equal(playback.size,1);
  assert.equal(playback.drain({now:now+1000,ready:()=>true,play:()=>false}),0);
  assert.equal(playback.size,1,'a scene that rejects missing endpoints must not consume the event');
  assert.equal(playback.drain({now:now+2000,ready:(from,to)=>from==='sender'&&to==='recipient',play:entry=>{played.push(entry);return true;}}),1);
  assert.equal(playback.size,0);assert.equal(played.length,1);
  assert.equal(playback.enqueue(event(),now+3000),false);
});

test('pause/hidden gating, bounded expiry and explicit historical replay do not synthesize communication', () => {
  const playback=new HandoffPlayback(30_000,2);
  assert.equal(playback.enqueue(event({type:'agent.status'}),now),false);
  assert.equal(playback.enqueue(event({source:'demo'}),now),false);
  assert.equal(playback.enqueue(event({toAgentId:'sender'}),now),false);
  assert.equal(playback.enqueue(event({toAgentId:undefined}),now),false);
  assert.equal(playback.enqueue(event({timestamp:new Date(now-31_000).toISOString()}),now),false);
  assert.equal(playback.enqueue(event(),now),true);
  assert.equal(playback.drain({now:now+20_000,enabled:false,ready:()=>true,play:()=>true}),0);
  assert.equal(playback.size,1);
  assert.equal(playback.drain({now:now+30_000,ready:()=>true,play:()=>true}),0);
  assert.equal(playback.size,0);
  assert.equal(playback.enqueue(event(),now+40_000,{replay:true}),true);
  for(const id of ['second','third'])playback.enqueue(event({id,timestamp:new Date(now+40_000).toISOString()}),now+40_000);
  assert.equal(playback.size,2);
  const ids=[];playback.drain({now:now+40_000,ready:()=>true,play:entry=>{ids.push(entry.id);return true;},limit:1});
  assert.deepEqual(ids,['second']);assert.equal(playback.size,1);
  playback.clear();assert.equal(playback.size,0);
});

test('local messages need only their observed worker, and instructions use the actual recipient', () => {
  const playback = new HandoffPlayback(); const entries = []; const endpoints = [];
  assert.equal(playback.enqueue(event({ id:'sent', type:'message.sent', toAgentId:undefined }),now),true);
  assert.equal(playback.enqueue(event({ id:'instruction', type:'user.instruction', agentId:'owner', toAgentId:'worker' }),now),true);
  assert.equal(playback.enqueue(event({ id:'direct-instruction', type:'user.instruction', agentId:'direct-worker', toAgentId:undefined }),now),true);
  playback.drain({now, ready:(from,to)=>{ endpoints.push([from,to]); return true; },play:entry=>{entries.push(entry);return true;}});
  assert.deepEqual(endpoints,[['sender',undefined],['worker',undefined],['direct-worker',undefined]]);
  assert.equal(entries.length,3);
  assert.equal(entries[0].toAgentId,undefined,'a local flight does not fabricate a recipient');
  assert.equal(entries[1].agentId,'owner','the original event remains intact');
  assert.equal(playback.enqueue(entries[0],now),false,'local events retain deduplication');
});

test('a recorded-only communication leaves the queue without using the play limit or the local cooldown', () => {
  const playback = new HandoffPlayback(); const played = [];
  const dropped = event({ id:'dropped', type:'user.instruction', agentId:'owner', toAgentId:'worker' });
  assert.equal(playback.enqueue(dropped,now),true);
  assert.equal(playback.enqueue(event({ id:'next', type:'message.sent', agentId:'worker', toAgentId:undefined }),now),true);
  const count = playback.drain({ now, limit:1, ready:()=>true, play:entry => entry.id === 'dropped' ? 'drop' : (played.push(entry.id), true) });
  assert.equal(count,1);
  assert.deepEqual(played,['next'],'the same worker plays right after a drop');
  assert.equal(playback.size,0);
  assert.equal(playback.enqueue(dropped,now),false,'a dropped event stays deduplicated');
});

test('local flight cooldown is per employee and never blocks an unrelated handoff or loses its pending events', () => {
  const playback=new HandoffPlayback(); const played=[];
  for(const item of [
    event({id:'one',type:'message.sent',toAgentId:undefined}),
    event({id:'two',type:'user.instruction',toAgentId:undefined}),
    event({id:'other',type:'message.sent',agentId:'other',toAgentId:undefined}),
    event({id:'handoff'}),
  ]) playback.enqueue(item,now);
  const drain=at=>playback.drain({now:at,ready:()=>true,play:entry=>{played.push(entry.id);return true;}});
  assert.equal(drain(now),3);
  assert.deepEqual(played,['one','other','handoff']);
  assert.equal(playback.size,1);
  assert.equal(drain(now+2999),0);
  assert.equal(drain(now+3000),1);
  assert.deepEqual(played,['one','other','handoff','two']);
});

test('offscreen and disabled local events expire, while failed rendering does not consume the cooldown', () => {
  const playback=new HandoffPlayback();
  const local=event({type:'message.sent',toAgentId:undefined});
  assert.equal(playback.enqueue(local,now),true);
  assert.equal(playback.drain({now,ready:()=>true,play:()=>false}),0);
  assert.equal(playback.drain({now,enabled:false,ready:()=>true,play:()=>true}),0);
  assert.equal(playback.drain({now:now+1000,ready:()=>false,play:()=>true}),0);
  assert.equal(playback.drain({now:now+30_000,ready:()=>true,play:()=>true}),0);
  assert.equal(playback.size,0);
  assert.equal(playback.enqueue(local,now+30_000,{replay:true}),true);
  assert.equal(playback.drain({now:now+30_000,ready:()=>true,play:()=>false}),0);
  assert.equal(playback.drain({now:now+30_000,ready:()=>true,play:()=>true}),1);
  assert.equal(playback.enqueue({...local,id:'explicit-again'},now+30_001,{replay:true}),true);
  assert.equal(playback.drain({now:now+30_001,ready:()=>true,play:()=>true}),1,'an explicit replay is not delayed behind the live cooldown');
});
