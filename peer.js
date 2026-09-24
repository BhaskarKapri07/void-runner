import { Room } from './shared/engine.js';
import { STEP, SNAPSHOT_TICKS } from './shared/netcode.js';
import { PROTOCOL, Broadcaster, decodeFrames } from './shared/protocol.js';
// The signaling service carries only room discovery and SDP/ICE. Gameplay goes over data channels:
// journal batches and syncs on the reliable `control` channel, latest-only state on `state`.
export class PeerSession {
  constructor(signal, receive, fail) {
    Object.assign(this,{signal,receive,fail,peers:new Map(),room:null,broadcaster:null,id:null,host:null,code:null,closed:false,carry:0,steps:0,last:null,ticker:null,keepAt:0,localSync:false});
  }
  message(m) {
    this.signaling=(this.signaling||Promise.resolve()).then(()=>this.handleMessage(m));
    return this.signaling;
  }
  async handleMessage(m) {
    try {
      if(m.type==='peer-ready') {
        this.id=m.peer;this.host=m.host;this.code=m.code;
        if(this.id===this.host){this.room=new Room(this.code);this.broadcaster=new Broadcaster(this.room);const p=this.room.add(this.name);this.player=p.id;this.receive({type:'joined',id:p.id,code:this.code,v:PROTOCOL});this.localSync=true;this.publish();this.startTicker(1000/60);}
        else this.startTicker(1000);
      }
      if(m.type==='peer-new')await this.link(m.peer,true);
      if(m.type==='signal') {
        const entry=this.peers.get(m.from)||await this.link(m.from,false);
        if(m.data?.description){await entry.pc.setRemoteDescription(m.data.description);for(const ice of entry.ice.splice(0))await entry.pc.addIceCandidate(ice);if(m.data.description.type==='offer'){await entry.pc.setLocalDescription(await entry.pc.createAnswer());this.signal({type:'signal',to:m.from,data:{description:entry.pc.localDescription}})}}
        if(m.data?.candidate){if(entry.pc.remoteDescription)await entry.pc.addIceCandidate(m.data.candidate);else entry.ice.push(m.data.candidate)}
      }
      // Signaling sockets can drop while data channels stay open; only a closed channel means someone left.
      if(m.type==='peer-left'&&this.peers.get(m.peer)?.control?.readyState!=='open')this.drop(m.peer);
      if(m.type==='peer-ended'&&!this.linked())this.fail(m.message);
    }catch(e){this.fail('Peer connection failed. Try server mode; this network may need a TURN relay.')}
  }
  // True while a reliable channel is open: to the host for a guest, to any guest for the host.
  linked(){return this.room?[...this.peers.values()].some(e=>e.control?.readyState==='open'):this.peers.get(this.host)?.control?.readyState==='open'}
  async link(id,offer) {
    const pc=new RTCPeerConnection({iceServers:window.VOIDRUNNER_ICE_SERVERS||[{urls:'stun:stun.l.google.com:19302'}]});
    const e={pc,ice:[],control:null,state:null,player:null,needSync:false};this.peers.set(id,e);
    pc.onicecandidate=ev=>{if(ev.candidate)this.signal({type:'signal',to:id,data:{candidate:ev.candidate}})};
    const deadline=setTimeout(()=>{if(!this.closed&&pc.connectionState!=='connected'){this.fail('Direct connection timed out. Try server mode; this network may need a TURN relay.')}},15000);
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected')clearTimeout(deadline);if(pc.connectionState==='failed'){clearTimeout(deadline);this.lost(id)}};
    const attach=channel=>{e[channel.label]=channel;channel.onmessage=ev=>{if(ev.data.length>262144)return;try{const m=JSON.parse(ev.data);if(this.room)this.command(e,m);else this.receive(m)}catch{}};
      // The reliable channel closing is the fastest signal that the other browser left.
      if(channel.label==='control')channel.onclose=()=>this.lost(id);
      let opened=false;const ready=()=>{if(opened)return;opened=true;if(!this.room&&channel.label==='control')channel.send(JSON.stringify({type:'hello',name:this.name,v:PROTOCOL}));};channel.onopen=ready;if(channel.readyState==='open')ready();};
    pc.ondatachannel=ev=>attach(ev.channel);
    if(offer){attach(pc.createDataChannel('control'));attach(pc.createDataChannel('state',{ordered:false,maxRetransmits:0}));await pc.setLocalDescription(await pc.createOffer());this.signal({type:'signal',to:id,data:{description:pc.localDescription}})}
    return e;
  }
  lost(id){if(this.closed||!this.peers.has(id))return;if(this.room)this.drop(id);else this.fail('Host connection lost. Return to the lobby.')}
  drop(id){const e=this.peers.get(id);if(!e)return;if(e.player)this.room?.remove(e.player);e.pc.close();this.peers.delete(id)}
  // Returns false when the channel is closed or backed up.
  write(channel,message){if(channel?.readyState!=='open'||channel.bufferedAmount>=131072)return false;channel.send(typeof message==='string'?message:JSON.stringify(message));return true}
  command(e,m) {
    if(m.type==='hello'&&!e.player){if(m.v!==PROTOCOL){this.write(e.control,{type:'error',message:'This game client and the host run different versions. Everyone needs the latest voidrunner.html.'});return}try{const p=this.room.add(m.name);e.player=p.id;e.needSync=true;this.write(e.control,{type:'joined',id:p.id,code:this.code,v:PROTOCOL});this.publish()}catch(err){this.write(e.control,{type:'error',message:err.message})}return}
    if(!e.player)return;
    if(m.type==='frames'){const d=decodeFrames(m);if(d)this.room.frames(e.player,d.frames,d.epoch)}
    if(m.type==='choose')this.room.choose(e.player,m.index);
    if(m.type==='resync')e.needSync=true;
    if(m.type==='ping')this.write(e.control,{type:'pong',sent:m.sent});
  }
  send(m) {
    if(this.room){if(m.type==='frames'){const d=decodeFrames(m);if(d)this.room.frames(this.player,d.frames,d.epoch)}if(m.type==='choose')this.room.choose(this.player,m.index);if(m.type==='start'){this.room.start(this.player);this.signal({type:'peer-started'})}if(m.type==='resync')this.localSync=true;if(m.type==='ping')this.receive({type:'pong',sent:m.sent});}
    else this.write(this.peers.get(this.host)?.control,m);
  }
  // Hidden tabs stop requestAnimationFrame, so a worker timer also drives pulse(): the host's simulation
  // and everyone's signaling keepalive. Callers share one wall clock, so extra calls cost nothing.
  startTicker(ms){if(this.ticker||typeof Worker==='undefined')return;try{const url=URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),'+ms+')'],{type:'text/javascript'}));this.ticker=new Worker(url);this.ticker.onmessage=()=>{URL.revokeObjectURL(url);this.ticker.onmessage=()=>this.pulse();this.pulse()}}catch{this.ticker=null}}
  // Signaling is otherwise silent once connected, and idle sockets get closed after 45 s.
  pulse(){const now=performance.now();if(!this.closed&&now-this.keepAt>20000){this.keepAt=now;this.signal({type:'keepalive'})}this.tick()}
  tick(){if(!this.room||this.closed)return;const now=performance.now();this.carry+=Math.min(.1,(now-(this.last??now))/1000);this.last=now;while(this.carry>=STEP){this.room.tick(STEP);this.carry-=STEP;this.steps++}if(this.steps>=SNAPSHOT_TICKS){this.steps=0;this.publish()}}
  // Each message is encoded once per publish and shared by every guest.
  publish(){
    if(!this.room)return;const {rel,hot,resync}=this.broadcaster.frame();let relText=null,hotText=null,sync=null,syncText=null;
    for(const e of this.peers.values()){if(!e.player)continue;
      if(e.needSync||resync){sync??=this.broadcaster.sync();syncText??=JSON.stringify(sync);if(this.write(e.control,syncText))e.needSync=false;continue}
      if(rel&&!this.write(e.control,relText??=JSON.stringify(rel)))e.needSync=true;
      // With ticks frozen (lobby, upgrades) the state sent with a roster change is the only one, so it can't be lossy.
      if(hot)this.write(rel?.meta?e.control:e.state,hotText??=JSON.stringify(hot));
    }
    if(this.localSync||resync){this.localSync=false;this.receive(sync??this.broadcaster.sync())}else{if(rel)this.receive(rel);if(hot)this.receive(hot)}
  }
  close(){this.closed=true;this.ticker?.terminate();this.ticker=null;for(const e of this.peers.values())e.pc.close();this.peers.clear();this.room=null;}
}
