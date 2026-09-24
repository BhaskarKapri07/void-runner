import { DurableObject } from 'cloudflare:workers';
import { Room } from '../shared/engine.js';
import { STEP, SNAPSHOT_TICKS } from '../shared/netcode.js';
import { PROTOCOL, Broadcaster, decodeFrames } from '../shared/protocol.js';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>alphabet[n%alphabet.length]).join('');

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS'}});
    if(!['/','/health','/location'].includes(url.pathname))return new Response('Not found',{status:404});
    const id=env.ARENA.idFromName(env.ARENA_INSTANCE||'india-v1');
    // Only first access honors this hint. Region placement on the Worker is separate.
    return env.ARENA.get(id,{locationHint:'apac'}).fetch(request);
  }
};

export class Arena extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.rooms=new Map();this.nets=new Map();this.peerRooms=new Map();this.clients=new Set();this.timer=null;this.idleTimer=null;this.clock=0;this.carry=0;this.steps=0;}
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/health')return Response.json({ok:true,backend:'cloudflare-durable-object',protocol:PROTOCOL,rooms:this.rooms.size,peerRooms:this.peerRooms.size,placementTarget:'near aws:ap-south-1',durableObjectHint:'apac',indiaGuaranteed:false},{headers:{'Access-Control-Allow-Origin':'*'}});
    if(url.pathname==='/location'){
      // Request.cf is ingress metadata, NOT proof of the Durable Object's location.
      let egressColo=null;try{const trace=await fetch('https://www.cloudflare.com/cdn-cgi/trace');const body=await trace.text();egressColo=body.match(/^colo=(.+)$/m)?.[1]||null;}catch{}
      return Response.json({workerTarget:'aws:ap-south-1',durableObjectHint:'apac',ingressColo:request.cf?.colo||null,observedEgressColo:egressColo,note:'Egress observation is diagnostic, not a contractual India location guarantee. Measure in-game RTT.'},{headers:{'Access-Control-Allow-Origin':'*'}});
    }
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('VOIDRUNNER multiplayer backend. Use the local HTML client with this HTTPS address. See /health and /location.',{headers:{'Content-Type':'text/plain'}});
    if(this.clients.size>=200)return new Response('Server full',{status:503});
    const pair=new WebSocketPair(),client=pair[0],ws=pair[1];ws.accept();
    const c={ws,room:null,peerRoom:null,pid:null,needSync:false,lastSeen:Date.now(),count:0,windowStart:Date.now()};this.clients.add(c);
    ws.addEventListener('message',event=>this.message(c,event.data));ws.addEventListener('close',()=>this.leave(c));ws.addEventListener('error',()=>this.leave(c));this.startIdleCheck();
    return new Response(null,{status:101,webSocket:client});
  }
  send(c,m){if(!c||c.ws.readyState!==1)return false;try{c.ws.send(typeof m==='string'?m:JSON.stringify(m));return true}catch{this.leave(c);return false}}
  leave(c){
    if(!this.clients.delete(c))return;
    if(c.room){const room=c.room;room.remove(c.pid);this.nets.get(room)?.clients.delete(c);if(!room.players.length){this.rooms.delete(room.code);this.nets.delete(room)}c.room=null;}
    const r=c.peerRoom;if(r){r.peers.delete(c.pid);if(r.host===c.pid){this.peerRooms.delete(r.code);for(const other of r.peers.values()){other.peerRoom=null;this.send(other,{type:'peer-ended',message:'Host left. Create a new room.'})}}else this.send(r.peers.get(r.host),{type:'peer-left',peer:c.pid});c.peerRoom=null;}
    if(!this.rooms.size)this.stopClock();
    if(!this.clients.size&&this.idleTimer){clearInterval(this.idleTimer);this.idleTimer=null;}
  }
  message(c,raw){
    // Messages can still arrive after leave() on a socket that is closing; they must not create rooms or pilots.
    if(!this.clients.has(c))return;
    c.lastSeen=Date.now();if(typeof raw!=='string'||raw.length>16384){c.ws.close(1009,'Message too large');this.leave(c);return;}
    if(Date.now()-c.windowStart>1000){c.count=0;c.windowStart=Date.now()}if(++c.count>90){c.ws.close(1008,'Too many messages');this.leave(c);return;}
    try{const m=JSON.parse(raw);if(!m||typeof m!=='object')return;
      if(m.type==='ping'){this.send(c,{type:'pong',sent:m.sent});return;}
      // Direct-mode clients go quiet after connecting; their periodic keepalive only refreshes lastSeen.
      if(m.type==='keepalive')return;
      if(m.type==='leave'){this.leave(c);c.ws.close(1000,'Left room');return;}
      if(m.type==='peer-create'||m.type==='peer-join'){
        if(c.room||c.peerRoom)throw Error('Already in a room.');let r;
        if(m.type==='peer-create'){if(this.peerRooms.size>=50)throw Error('Too many rooms.');let key;do{key=code()}while(this.peerRooms.has(key));r={code:key,host:null,peers:new Map(),started:false};this.peerRooms.set(key,r);}
        else{r=this.peerRooms.get(String(m.code||'').toUpperCase());if(!r)throw Error('Peer room not found.');if(r.started)throw Error('This run has started.');if(r.peers.size>=4)throw Error('Room is full (4/4).');}
        c.pid=crypto.randomUUID();c.peerRoom=r;r.host??=c.pid;r.peers.set(c.pid,c);this.send(c,{type:'peer-ready',peer:c.pid,code:r.code,host:r.host});if(c.pid!==r.host)this.send(r.peers.get(r.host),{type:'peer-new',peer:c.pid});return;
      }
      if(m.type==='signal'){const r=c.peerRoom;if(!r||!r.peers.has(m.to)||(c.pid!==r.host&&m.to!==r.host))return;this.send(r.peers.get(m.to),{type:'signal',from:c.pid,data:m.data});return;}
      if(m.type==='peer-started'){if(c.peerRoom?.host===c.pid)c.peerRoom.started=true;return;}
      if(m.type==='create'||m.type==='join'){
        if(c.room||c.peerRoom)throw Error('Already in a room.');if(m.v!==PROTOCOL)throw Error('This game client is out of date. Download the latest voidrunner.html.');let r;
        if(m.type==='create'){if(this.rooms.size>=50)throw Error('Too many rooms.');let key;do{key=code()}while(this.rooms.has(key));r=new Room(key);this.rooms.set(key,r);this.nets.set(r,{broadcaster:new Broadcaster(r),clients:new Set()});}
        else{r=this.rooms.get(String(m.code||'').toUpperCase());if(!r)throw Error('Room not found.');}
        const p=r.add(m.name);c.room=r;c.pid=p.id;c.needSync=true;this.nets.get(r).clients.add(c);this.send(c,{type:'joined',id:p.id,code:r.code,v:PROTOCOL});this.startClock();return;
      }
      if(m.type==='frames'){const d=decodeFrames(m);if(d)c.room?.frames(c.pid,d.frames,d.epoch);}
      if(m.type==='resync')c.needSync=!!c.room;
      if(m.type==='input')c.room?.input(c.pid,m.input);
      if(m.type==='start')c.room?.start(c.pid);
      if(m.type==='choose')c.room?.choose(c.pid,m.index);
    }catch(e){this.send(c,{type:'error',message:e instanceof SyntaxError?'Invalid message.':e.message});}
  }
  // The 60 Hz simulation only runs while a dedicated-server room exists; signaling alone never ticks.
  startClock(){
    if(this.timer)return;this.clock=Date.now();this.carry=0;this.steps=0;
    this.timer=setInterval(()=>{
      const now=Date.now();this.carry+=Math.min(.1,(now-this.clock)/1000);this.clock=now;
      while(this.carry>=STEP){for(const r of this.rooms.values())r.tick(STEP);this.carry-=STEP;this.steps++;}
      if(this.steps>=SNAPSHOT_TICKS){this.steps=0;this.publish();}
    },1000/60);
  }
  stopClock(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
  publish(){
    for(const net of this.nets.values()){
      const {rel,hot,resync}=net.broadcaster.frame();let text=null,syncText=null;
      for(const c of net.clients){
        if(c.needSync||resync){syncText??=JSON.stringify(net.broadcaster.sync());if(this.send(c,syncText))c.needSync=false;continue;}
        if(!rel&&!hot)continue;text??=JSON.stringify(hot?(rel?{...hot,r:rel}:hot):rel);if(!this.send(c,text)&&rel)c.needSync=true;
      }
    }
  }
  startIdleCheck(){
    if(this.idleTimer)return;
    this.idleTimer=setInterval(()=>{const now=Date.now();for(const c of this.clients)if(now-c.lastSeen>45000){c.ws.close(1001,'Connection idle');this.leave(c);}},5000);
  }
}
