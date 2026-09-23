import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';
import { Room } from '../shared/engine.js';
import { STEP, stepShip, reconcile } from '../shared/netcode.js';
import { PROTOCOL, Broadcaster, ClientWorld, NetClock, encodeFrames, decodeFrames } from '../shared/protocol.js';
import { BUILDS, simulate } from '../scripts/netbench.js';
import { PeerSession } from '../peer.js';

test('bandwidth stays small and flat as builds and swarms grow',()=>{
 for(const scenario of Object.values(BUILDS)){
  const r=simulate(scenario);
  // Budgets leave headroom over measured values (0.3-1.3 KB average, <2.6 KB peak).
  assert(r.average<2048,`${scenario.label}: ${r.average.toFixed(0)} B average`);
  assert(r.peak<6144,`${scenario.label}: ${r.peak} B peak`);
  assert(r.legacy/r.average>30,`${scenario.label}: only ${(r.legacy/r.average).toFixed(1)}x smaller than v1`);
 }
});

test('client-computed projectiles match the authority, including after lost messages',()=>{
 for(const scenario of Object.values(BUILDS)){
  assert(simulate(scenario,{check:true}).worst<.5,scenario.label);
  const lossy=simulate(scenario,{check:true,seconds:12,drop:n=>n%11===0});
  assert(lossy.resyncs>0,'the lossy run exercised a resync');
  assert(lossy.worst<.5,scenario.label+' with loss');
 }
});

test('a missing journal batch is detected instead of silently diverging',()=>{
 const room=new Room('GAP'),p=room.add('A');room.start(p.id);const b=new Broadcaster(room),w=new ClientWorld();w.setMe(p.id);w.sync(b.sync());
 room.fire(p);const first=b.frame();room.fire(p);const second=b.frame();
 assert(first.rel&&second.rel);
 assert.equal(w.rel(second.rel),false);assert.equal(w.synced,false);
 w.sync(b.sync());assert.equal(w.bullets.size,room.bullets.length);
});

test('input frames round-trip as bitmasks and malformed batches are rejected',()=>{
 const frames=[{seq:41,input:{left:true,fire:true}},{seq:42,input:{up:true,right:true,down:true}}];
 const wire=encodeFrames(3,frames);assert.deepEqual(wire.i,[17,14]);
 const back=decodeFrames(JSON.parse(JSON.stringify(wire)));assert.equal(back.epoch,3);
 assert.deepEqual(back.frames.map(f=>f.seq),[41,42]);assert.equal(back.frames[0].input.fire,true);assert.equal(back.frames[1].input.left,false);
 for(const bad of [{s:1,i:[32]},{s:1,i:[1.5]},{s:1.5,i:[1]},{s:1,i:Array(13).fill(0)},{s:1,i:'x'}])assert.equal(decodeFrames(bad),null);
});

test('local fire prediction reproduces the authority volley for volley, and adopts its ids',()=>{
 const room=new Room('FIRE'),p=room.add('A');room.start(p.id);Object.assign(p,{rate:.13,spread:5});
 const b=new Broadcaster(room),w=new ClientWorld();w.setMe(p.id);w.sync(b.sync());
 let predicted=reconcile(w.view().players[0],[]),predictedSeqs=[],fired=[];
 for(let seq=1;seq<=240;seq++){
  const input={fire:seq%90<60,right:seq%40<20};
  if(stepShip(predicted,input)){predictedSeqs.push(seq);w.predict(seq,predicted.x,predicted.y-20,predicted.spread,room.tickId+1)}
  room.frames(p.id,[{seq,input}],room.epoch);room.tick(STEP);
  const {rel,hot}=b.frame();if(rel){for(const e of rel.l)if(e[0]===0)fired.push(e[7]);w.rel(rel)}if(hot)w.state(hot);
 }
 assert(fired.length>20);assert.deepEqual(predictedSeqs,fired);
 assert.equal(w.predicted.size,0,'every predicted volley was claimed');
 for(const bullet of room.bullets)assert(w.bullets.has(bullet.id),'authority ids adopted');
 assert(![...w.bullets.keys()].some(id=>id<0),'no provisional ids left');
});

test('a mispredicted volley disappears once the authority has clearly not fired it',()=>{
 const room=new Room('MISS'),p=room.add('A');room.start(p.id);const b=new Broadcaster(room),w=new ClientWorld();w.setMe(p.id);w.sync(b.sync());
 w.predict(1,p.x,p.y-20,1,room.tickId);assert.equal(w.bullets.size,1);
 for(let seq=1;seq<=14;seq++){room.frames(p.id,[{seq,input:{}}],room.epoch);room.tick(STEP);const {rel,hot}=b.frame();if(rel)w.rel(rel);if(hot)w.state(hot)}
 assert.equal(w.bullets.size,0);assert.equal(w.predicted.size,0);
});

test('network clock never runs backwards and widens its buffer under jitter',()=>{
 const steady=new NetClock(),jittery=new NetClock();let last=-Infinity,ownLast=-Infinity;
 for(let i=0;i<300;i++){
  const sent=i*1000/30;steady.observe(i*2,sent+40);jittery.observe(i*2,sent+40+(i%3?0:45));
  const now=sent+45,t=jittery.interp(now),own=jittery.own(now,6);assert(t>=last&&own>=ownLast);last=t;ownLast=own;
 }
 assert(jittery.buffer>steady.buffer+1,`buffer ${jittery.buffer.toFixed(2)} vs ${steady.buffer.toFixed(2)}`);
 assert(steady.buffer>=3&&steady.buffer<5);
 const before=steady.offset;steady.observe(598,299*1000/30+90);assert.equal(steady.offset,before,'repeated or older ticks are ignored');
});

function socket(url){return new Promise((resolve,reject)=>{const ws=new WebSocket(url),messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.once('error',reject);ws.once('open',()=>resolve({ws,messages,send:m=>ws.send(JSON.stringify(m)),wait:async fn=>{const start=Date.now();while(Date.now()-start<2500){const m=messages.find(fn);if(m)return m;await new Promise(r=>setTimeout(r,10))}throw Error('Timed out waiting for message')}}))})}
test('server rejects out-of-date clients and answers resync requests with a full sync',async()=>{
 const app=createGameServer();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='ws://127.0.0.1:'+app.server.address().port;
 try{
  const old=await socket(url);old.send({type:'create',name:'Old'});assert.match((await old.wait(m=>m.type==='error')).message,/out of date/);
  const c=await socket(url);c.send({type:'create',name:'New',v:PROTOCOL});const joined=await c.wait(m=>m.type==='joined');assert.equal(joined.v,PROTOCOL);
  await c.wait(m=>m.type==='sync');const syncs=()=>c.messages.filter(m=>m.type==='sync').length,before=syncs();
  c.send({type:'resync'});const start=Date.now();while(syncs()===before&&Date.now()-start<2000)await new Promise(r=>setTimeout(r,10));
  assert.equal(syncs(),before+1);
  for(const s of [old,c])s.ws.close();
 }finally{await app.close()}
});

// Regression: 0.2 s is exactly 12 frames, so the authority's cooldown ends a hair above zero.
// Any rounding of `cool` on the wire flips the client's fire decision by a frame.
test('fire prediction stays exact at the default fire rate for any latency',()=>{
 for(let latency=0;latency<=6;latency++){
  const room=new Room('RATE'),p=room.add('A');room.start(p.id);const b=new Broadcaster(room),w=new ClientWorld();w.setMe(p.id);w.sync(b.sync());
  const toServer=[],toClient=[],predictedSeqs=[],fired=[];let pending=[],predicted=reconcile(w.view().players[0],[]);
  for(let seq=1;seq<=600;seq++){
   const input={fire:seq%200<150};pending.push({seq,input});if(stepShip(predicted,input))predictedSeqs.push(seq);
   toServer.push([seq+latency,{seq,input}]);while(toServer[0]?.[0]<=seq)room.frames(p.id,[toServer.shift()[1]],room.epoch);
   room.tick(STEP);
   if(seq%2===0){const out=b.frame();for(const e of out.rel?.l??[])if(e[0]===0)fired.push(e[7]);toClient.push([seq+latency,out])}
   while(toClient[0]?.[0]<=seq){const {rel,hot}=toClient.shift()[1];if(rel)w.rel(rel);if(hot&&w.state(hot)){const mine=w.view().players[0];pending=pending.filter(f=>f.seq>mine.ack);predicted=reconcile(mine,pending)}}
  }
  assert(fired.length>30);assert.deepEqual(predictedSeqs.filter(s=>s<=fired.at(-1)),fired,`latency ${latency} frames`);
 }
});

test('state overtaking a delayed journal batch (WebRTC) does not discard a correct prediction',()=>{
 const room=new Room('LAG'),p=room.add('A');room.start(p.id);const b=new Broadcaster(room),w=new ClientWorld();w.setMe(p.id);w.sync(b.sync());
 w.predict(1,p.x,p.y-20,p.spread,room.tickId+1);const held=[];
 for(let seq=1;seq<=20;seq++){room.frames(p.id,[{seq,input:{fire:seq===1}}],room.epoch);room.tick(STEP);const {rel,hot}=b.frame();if(rel)held.push(rel);if(hot)w.state(hot)}
 assert.equal(w.predicted.size,1,'kept while its journal batch is still in flight');
 for(const rel of held)assert(w.rel(rel));
 assert.equal(w.predicted.size,0);assert(room.bullets.length&&room.bullets.every(x=>w.bullets.has(x.id)));
});

test('direct mode: a dropped signaling socket does not remove a pilot whose data channel is open',async()=>{
 const failures=[],host=new PeerSession(()=>{},()=>{},m=>failures.push(m));host.name='Host';
 await host.message({type:'peer-ready',peer:'H',host:'H',code:'PABCDE'});
 const guestPlayer=host.room.add('Guest').id,channel={readyState:'open'};
 host.peers.set('G',{pc:{close(){}},control:channel,player:guestPlayer});
 await host.message({type:'peer-left',peer:'G'});
 assert(host.peers.has('G'));assert.equal(host.room.players.length,2);
 channel.readyState='closed';await host.message({type:'peer-left',peer:'G'});
 assert(!host.peers.has('G'));assert.equal(host.room.players.length,1);
 const guest=new PeerSession(()=>{},()=>{},m=>failures.push(m));await guest.message({type:'peer-ready',peer:'G',host:'H',code:'PABCDE'});
 guest.peers.set('H',{pc:{close(){}},control:{readyState:'open'}});await guest.message({type:'peer-ended',message:'Host left.'});
 assert.deepEqual(failures,[]);
 guest.peers.get('H').control.readyState='closed';await guest.message({type:'peer-ended',message:'Host left.'});assert.deepEqual(failures,['Host left.']);
 host.close();guest.close();
});
