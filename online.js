import { PeerSession } from './peer.js';
import { STEP, SNAPSHOT_TICKS, COLORS, stepShip, reconcile, bulletAlive, shotAlive } from './shared/netcode.js';
import { PROTOCOL, ClientWorld, NetClock, encodeFrames } from './shared/protocol.js';
'use strict';
(()=>{
let peer=null,predicted=null,pending=[],batch=[],seq=0,stepCarry=0,history=[],rtt=0,pingAt=0,resyncAt=0,uiAt=0,flash=new Map(),damageText=[],muzzle=0,hits=0,hadSync=false,dirty=false;
let socket=null,me=null,state=null,uiKey='',barHTML='',modsHTML='',inputTime=0,session=0,clock=new NetClock();
const world=new ClientWorld();
const overlay=$('#overlay'),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const descriptions={rapid:['RAPID FIRE','20% faster firing'],spread:['SPLIT SHOT','Two more projectiles'],power:['HEAVY ROUNDS','+1 projectile damage'],speed:['ION THRUSTERS','20% faster movement'],repair:['HULL REPAIR','Restore 3 hull'],armor:['REINFORCED HULL','+2 max hull and repair 2'],pierce:['PHASE ROUNDS','Pierce one more enemy'],blast:['VOLATILE AMMO','Explosive splash damage']};
const bar=document.createElement('div');bar.id='netbar';bar.className='hidden';$('.arena').before(bar);
function rawSend(value){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value))}
function send(value){if(peer)peer.send(value);else rawSend(value)}
function endpoint(){const q=new URLSearchParams(location.search).get('server');return q||window.VOIDRUNNER_SERVER||(!location.hostname.endsWith('github.io')&&location.protocol!=='file:'?location.origin:'')}
function openOnline(){window.netActive=true;keys={};mode='online';$('#pause').textContent='? HELP';bar.classList.add('hidden');uiKey='';overlay.classList.remove('hidden');overlay.innerHTML='<div class="eyebrow">ONLINE CO-OP / 1–4 PILOTS</div><h2>FORM YOUR SQUAD.</h2><p>One arena. Four ships. Survive together.</p><div class="netform"><label>MATCH HOST<select id="hostmode"><option value="peer">Player browser (direct co-op)</option><option value="server">Dedicated server (fallback)</option></select></label><label>PILOT NAME<input id="pilotname" maxlength="16" value="Pilot" autocomplete="nickname"></label><label>ROOM CODE<input id="roomcode" maxlength="6" placeholder="6-character code" autocapitalize="characters"></label><div class="netrow"><button class="primary" id="createRoom">CREATE ROOM</button><button id="joinRoom">JOIN ROOM</button></div><details id="connection"><summary>Server connection</summary><label>SERVER ADDRESS<input id="serverurl" placeholder="https://your-server.onrender.com" value="'+esc(endpoint())+'"></label></details></div><div class="neterror" id="neterror" role="status"></div><button id="backSolo">BACK TO SOLO</button>';
if(!endpoint()){$('#connection').open=true;$('#neterror').textContent='A multiplayer server needs to be deployed first. Enter its address here.'}$('#createRoom').onclick=()=>connect('create');$('#joinRoom').onclick=()=>connect('join');$('#backSolo').onclick=()=>location.href=location.pathname;}
function connect(action){if(action==='join'&&!/^[A-Z2-9]{6}$/.test($('#roomcode').value.toUpperCase())){$('#neterror').textContent='Enter a six-character room code.';return}let url;try{url=new URL($('#serverurl').value.trim());if(!['https:','http:','ws:','wss:'].includes(url.protocol)||url.username||url.password)throw Error();url.protocol=url.protocol==='https:'||url.protocol==='wss:'?'wss:':'ws:';url.pathname='/';url.search='';url.hash='';if(location.protocol==='https:'&&url.protocol!=='wss:')throw Error();}catch{$('#neterror').textContent='Enter a valid HTTPS server address (HTTP works locally).';return}const usePeer=$('#hostmode').value==='peer';if(usePeer&&!window.RTCPeerConnection){$('#neterror').textContent='WebRTC is unavailable. Choose dedicated server mode.';return}const name=$('#pilotname').value;const message={type:usePeer?'peer-'+action:action,name:$('#pilotname').value,code:$('#roomcode').value.toUpperCase(),v:PROTOCOL};const current=++session;socket?.close();peer?.close();peer=null;state=null;me=null;uiKey='';barHTML='';modsHTML='';predicted=null;pending=[];batch=[];seq=0;history=[];stepCarry=0;rtt=0;hits=0;hadSync=false;flash.clear();damageText=[];world.reset();world.setMe(null);clock=new NetClock();if(usePeer){peer=new PeerSession(rawSend,receive,error);peer.name=name;}socket=new WebSocket(url);$('#neterror').textContent='Connecting… A sleeping server may take a minute.';$('#createRoom').disabled=$('#joinRoom').disabled=true;const timeout=setTimeout(()=>{if(current===session&&socket.readyState!==WebSocket.OPEN){socket.close();error('Connection timed out. Check the server address and try again.')}},65000);socket.onopen=()=>{clearTimeout(timeout);rawSend(message)};socket.onerror=()=>{if(current===session)error('Could not connect. Check the server is running and retry.')};socket.onclose=()=>{clearTimeout(timeout);if(current!==session)return;if(peer&&(peer.linked()||(peer.room&&state&&state.phase!=='lobby')))return;keys={};error(state?'Connection lost. This pilot left the run. Return to the lobby to create or join a new run.':'Connection closed. Check the server address and retry.')};socket.onmessage=e=>{if(current!==session)return;let m;try{m=JSON.parse(e.data)}catch{return}if(peer&&(m.type.startsWith('peer-')||m.type==='signal'))peer.message(m);else receive(m)};}
function receive(m){
 const now=performance.now();
 if(m.type==='joined'){if(m.v!==PROTOCOL){error('This game client and the match host run different versions. Everyone needs the latest voidrunner.html.');return}me=m.id;world.setMe(me);bar.classList.remove('hidden');return}
 if(m.type==='error'){error(m.message);return}
 if(m.type==='pong'){rtt=Math.round(now-m.sent);return}
 if(m.type==='sync'){world.sync(m);hadSync=true;applyState(now);return}
 if(m.type==='rel'){if(applyRel(m,now)&&dirty&&state){state=world.view();refresh(now)}return}
 if(m.type!=='state')return;
 if(m.r&&!applyRel(m.r,now))return;
 if(world.state(m))applyState(now);else if(!world.synced)resync(now);
}
// A missing journal batch means projectiles may be wrong; ask the authority for a full sync.
function resync(now){if(!hadSync||now-resyncAt<1000)return;resyncAt=now;send({type:'resync'})}
// Roster changes render once the matching state is applied too; a standalone batch renders on its own.
function applyRel(m,now){if(!world.synced||!world.rel(m,ev=>effect(ev,now))){resync(now);return false}if(m.meta)dirty=true;return true}
function refresh(now){dirty=false;uiAt=now;renderUI()}
const lead=()=>rtt*.06+SNAPSHOT_TICKS+1;
function effect(ev,now){
 if(ev.kind==='hit')hits++;
 // Only the frame loop retires particles, and hidden tabs stop it; skip effects nobody can see.
 if(document.hidden)return;
 if(ev.kind==='burst'){burst(ev.x,ev.y,ev.color,ev.n);return}
 flash.set(ev.target,{until:now+120,color:ev.color});if(ev.slot===world.slot)tone(1200,.025,'triangle',.012);
 // Hits are drawn where the target is drawn, which already runs ahead on the local clock.
 const at=world.locate(ev.target,clock.own(now,lead()));if(!at)return;
 damageText.push({x:at.x,y:at.y,damage:Math.round(ev.damage*10)/10,color:ev.color,life:.5});for(let i=0;i<6;i++)particles.push({x:at.x,y:at.y,vx:random(-80,80),vy:random(-90,20),life:.2,color:ev.color,size:3});
}
function applyState(now){
 const h=world.latest,previous=state;state=world.view();
 const changed=!previous||previous.epoch!==state.epoch;
 // Ticking pauses in the lobby, upgrades and defeat, and always resumes in a new epoch. Re-anchor the
 // clock there instead of reading the pause as lag; the input pipeline's lead carries over.
 if(changed){const lead=clock.lead;clock=new NetClock();clock.lead=lead;pending=[];batch=[];seq=0;stepCarry=0;history=[];world.clearPredictions()}
 clock.observe(h.t,now);
 const mine=state.players.find(p=>p.id===me);
 if(mine){pending=pending.filter(f=>f.seq>mine.ack);
  // Unprocessed local frames, net of how late this snapshot arrived, is how far the local ship runs ahead of the server.
  if(state.phase==='play'&&mine.hp>0&&mine.ack>0&&seq>=mine.ack)clock.observeLead(Math.max(0,Math.min(120,seq-mine.ack-(clock.received(now)-h.t))));
  predicted=reconcile(mine,pending)}
 if(history.at(-1)?.t===h.t)history.pop();history.push({t:h.t,p:h.p});if(history.length>40)history.shift();
 if(dirty||changed||now-uiAt>150||state.phase!==previous?.phase||state.players.length!==previous?.players.length)refresh(now);
}

function error(message){if(!state){const el=$('#neterror');if(el)el.textContent=message;const c=$('#createRoom'),j=$('#joinRoom');if(c)c.disabled=false;if(j)j.disabled=false;return}overlay.classList.remove('hidden');overlay.innerHTML='<div class="eyebrow">CONNECTION INTERRUPTED</div><h2>SIGNAL LOST.</h2><p class="online-note">'+esc(message)+'</p><button id="netReturn">RETURN TO LOBBY</button>';$('#netReturn').onclick=leave;}
function leave(){session++;rawSend({type:'leave'});peer?.close();peer=null;socket?.close();socket=null;state=null;me=null;world.reset();keys={};particles=[];openOnline()}
function renderUI(){if(!state||!me)return;const p=state.players.find(p=>p.id===me);if(!p)return;const html='<span>ROOM <b>'+esc(state.code)+'</b> · '+(peer?'DIRECT':'SERVER')+' · '+rtt+' ms</span><div class="roster">'+state.players.map(a=>'<span style="color:'+a.color+'">'+esc(a.name)+(a.id===me?' (YOU)':'')+' '+(a.hp>0?a.hp+'/'+a.max:'DOWN')+'</span>').join('')+'</div><button id="leaveRoom">LEAVE ROOM</button>';if(html!==barHTML){barHTML=html;bar.innerHTML=html;$('#leaveRoom').onclick=leave}
$('#wave').textContent=String(state.wave).padStart(2,'0');$('#hull').textContent=p.hp+' / '+p.max;$('#hull').style.color=p.color;$('#score').textContent=String(state.score).padStart(6,'0');$('#time').textContent=formatTime(state.time);$('#status').textContent=p.hp<=0?'DOWNED / TEAMMATE NEEDED':'SQUAD ONLINE';$('#build').textContent=state.players.length+' PILOTS';$('#modcount').textContent=p.mods.length+' INSTALLED';const mods=p.mods.map(n=>'<span class="mod">'+esc(n)+'</span>').join('')||'<span class="emptymod">Survive a sector to choose your upgrade</span>';if(mods!==modsHTML){modsHTML=mods;$('#mods').innerHTML=mods}
const key=[state.phase,state.host,state.players.map(a=>a.id+':'+a.chosen).join(','),p.chosen,state.wave].join('/');if(key===uiKey)return;uiKey=key;
if(state.phase==='play'){overlay.classList.add('hidden');return}overlay.classList.remove('hidden');
if(state.phase==='lobby'){overlay.innerHTML='<div class="eyebrow">SQUAD ASSEMBLING / '+state.players.length+' OF 4</div><h2>ROOM '+esc(state.code)+'</h2><p>Share this code and the server address with your squad.</p><div class="squad">'+state.players.map(a=>'<div class="pilotcard" style="border-color:'+a.color+'"><b style="color:'+a.color+'">'+esc(a.name)+'</b>'+(a.id===me?'YOU · ':'')+(a.id===state.host?'HOST':'READY')+'</div>').join('')+'</div>'+(state.host===me?'<button class="primary" id="startSquad">LAUNCH SQUAD</button>':'<p>Waiting for the host to launch.</p>')+'<p style="margin-top:20px">Stay near a downed teammate for 3 seconds to revive.'+(peer?' Host: keep this tab visible.':'')+'</p>';if($('#startSquad'))$('#startSquad').onclick=()=>send({type:'start'})}
if(state.phase==='upgrade'){overlay.innerHTML='<div class="eyebrow">SECTOR CLEARED</div><h2>UPGRADE YOUR SHIP.</h2>'+(p.chosen?'<p>Upgrade installed. Waiting for your squad.</p>':'<p>Choose one. The next sector starts when everyone is ready.</p><div class="choices">'+p.offers.map((id,i)=>'<button class="choice" data-netchoice="'+i+'"><small>0'+(i+1)+'</small><b>'+descriptions[id][0]+'</b><span>'+descriptions[id][1]+'</span></button>').join('')+'</div>');document.querySelectorAll('[data-netchoice]').forEach(b=>b.onclick=()=>send({type:'choose',index:+b.dataset.netchoice}))}
if(state.phase==='dead'){overlay.innerHTML='<div class="eyebrow">SQUAD LOST</div><h2>THE VOID TAKES EVERYONE.</h2><p>Sector '+state.wave+' · '+state.score+' points · '+formatTime(state.time)+'</p>'+(state.host===me?'<button id="restartSquad" class="primary">RUN IT BACK</button>':'<p>Waiting for the host to restart.</p>');if($('#restartSquad'))$('#restartSquad').onclick=()=>send({type:'start'})}}
window.netHelp=()=>{if(state?.phase==='play')announce('ARROWS + SPACE / STAY NEAR DOWNED PILOTS TO REVIVE / ONLINE DOES NOT PAUSE')};
window.netUpdate=dt=>{
 for(const s of stars)s.y=(s.y+s.z*25*dt)%H;
 for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt}particles=particles.filter(p=>p.life>0);shake=Math.max(0,shake-dt*30);
 damageText=damageText.filter(d=>(d.life-=dt)>0);for(const d of damageText)d.y-=35*dt;muzzle=Math.max(0,muzzle-dt);
 const now=performance.now();for(const [id,f] of flash)if(f.until<now)flash.delete(id);
 // On WebRTC a new roster can arrive before the new epoch's state; frames sent in between would be rejected.
 if(state?.phase==='play'&&world.meta?.epoch===state.epoch&&predicted?.hp>0&&pending.length<120&&!document.hidden){stepCarry+=dt;const steps=Math.floor(stepCarry/STEP),own=steps?clock.own(now,lead()):0;stepCarry-=steps*STEP;
  for(let n=0;n<steps;n++){const input={left:!!keys.ArrowLeft,right:!!keys.ArrowRight,up:!!keys.ArrowUp,down:!!keys.ArrowDown,fire:!!keys.Space};const frame={seq:++seq,input};pending.push(frame);batch.push(frame);
   // Same per-frame cooldown as the authority, so the volley shown now is the one the server will fire.
   if(stepShip(predicted,input)){muzzle=.06;tone(780,.04);world.predict(seq,predicted.x,predicted.y-20,predicted.spread,own-(steps-1-n))}}}else stepCarry=0;
 inputTime+=dt;if(inputTime>=1/30){inputTime=0;if(batch.length)send(encodeFrames(state.epoch,batch.splice(0,12)))}
 peer?.pulse();
 if(now-pingAt>1000){pingAt=now;send({type:'ping',sent:now})}
};
// Remote pilots are interpolated between snapshots; the local pilot is the prediction.
function pilots(tick){
 if(!history.length)return state.players;let a=history[0],b=a;for(const h of history){if(h.t<=tick)a=h;if(h.t>=tick){b=h;break}b=h}const f=b.t>a.t?Math.max(0,Math.min(1,(tick-a.t)/(b.t-a.t))):0;
 return state.players.map(p=>{if(p.id===me&&predicted)return predicted;const sa=a.p.find(s=>s[0]===p.slot);if(!sa)return p;const sb=b.p.find(s=>s[0]===p.slot)??sa;return {...p,x:sa[1]+(sb[1]-sa[1])*f,y:sa[2]+(sb[2]-sa[2])*f,hp:sa[3],inv:sa[4],revive:sa[5]}});
}
// Enemies and shots are drawn on the local clock (own); other pilots and their bullets on the interpolation clock.
// Outside play the authority stops ticking, so both clocks hold at its last tick.
window.netDraw=()=>{ctx.fillStyle='#080c18';ctx.fillRect(0,0,W,H);ctx.save();if(shake)ctx.translate(random(-shake,shake),random(-shake,shake));for(const s of stars){ctx.fillStyle=s.z>1.1?'#7e93ad':'#293b55';ctx.fillRect(s.x|0,s.y|0,2,2)}if(state&&world.latest){const now=performance.now(),live=state.phase==='play',own=live?clock.own(now,lead()):world.latest.t,interp=live?clock.interp(now):world.latest.t;for(const p of pilots(interp)){if(p.hp<=0){ctx.strokeStyle=p.color;ctx.strokeRect(p.x-17,p.y-17,34,34);ctx.fillStyle=p.color;ctx.fillRect(p.x-20,p.y+25,40*p.revive/3,4);ctx.font='12px monospace';ctx.textAlign='center';ctx.fillText('REVIVE',p.x,p.y-26);continue}if(p.inv<=0||Math.floor(p.inv*12)%2===0){ctx.fillStyle='#ffb35f';ctx.fillRect(p.x-5,p.y+15,8,random(8,18));sprite('ship',p.x,p.y,3,[p.color,'#e8f4ff'])}ctx.fillStyle=p.color;ctx.textAlign='center';ctx.font='bold 12px monospace';ctx.fillText(p.name+(p.id===me?' · YOU':''),p.x,p.y+40);if(p.id===me){ctx.strokeStyle=p.color;ctx.strokeRect(p.x-20,p.y-21,40,47)}}for(const e of world.enemies.values()){const at=world.enemyAt(e,own);sprite(e.type,at.x,at.y,e.type==='boss'?8:e.type==='tank'?4:3,flash.get(e.id)?.until>now?['#ffffff',flash.get(e.id).color]:e.type==='boss'?['#986148','#ffc16f']:['#9e405a','#ff8790']);if(e.type==='boss'){ctx.fillStyle='#402c32';ctx.fillRect(260,18,440,7);ctx.fillStyle='#ff9272';ctx.fillRect(260,18,440*e.hp/e.max,7)}}for(const b of world.bullets.values()){const k=((b.slot===world.slot?own:interp)-b.t)*STEP;if(k<0)continue;const x=b.x+b.vx*k,y=b.y+b.vy*k;if(!bulletAlive(x,y)){world.bullets.delete(b.id);continue}ctx.fillStyle=COLORS[b.slot];ctx.fillRect(x-2,y-8,4,13)}ctx.fillStyle='#ff799a';for(const s of world.shots.values()){const k=(own-s.t)*STEP;if(k<0)continue;const x=s.x+s.vx*k,y=s.y+s.vy*k;if(!shotAlive(x,y)){world.shots.delete(s.id);continue}ctx.fillRect(x-3,y-3,6,6)}}for(const p of particles){ctx.globalAlpha=Math.min(1,p.life*3);ctx.fillStyle=p.color;ctx.fillRect(p.x|0,p.y|0,p.size|0,p.size|0)}ctx.globalAlpha=1;ctx.font='bold 14px monospace';ctx.textAlign='center';for(const d of damageText){ctx.fillStyle=d.color;ctx.fillText('-'+d.damage,d.x,d.y)}if(muzzle>0&&predicted){ctx.fillStyle=predicted.color;ctx.fillRect(predicted.x-5,predicted.y-30,10,10)}ctx.restore();};
window.addEventListener('keydown',e=>{if(!window.netActive||e.repeat||['INPUT','TEXTAREA'].includes(e.target.tagName))return;if(['Digit1','Digit2','Digit3'].includes(e.code)&&state?.phase==='upgrade')send({type:'choose',index:+e.code.slice(-1)-1})});window.addEventListener('blur',()=>{keys={};send({type:'input',input:{}})});document.addEventListener('visibilitychange',()=>{if(document.hidden){keys={};send({type:'input',input:{}})}});window.netDiagnostics=()=>({transport:peer?'peer':'server',phase:state?.phase,players:state?.players.map(p=>({id:p.id,x:p.x,y:p.y,hp:p.hp})),predicted:predicted?{x:predicted.x,y:predicted.y}:null,me,rtt,hits,synced:world.synced,bullets:world.bullets.size,shots:world.shots.size,lead:clock.lead,buffer:clock.buffer});$('#online').onclick=openOnline;
})();
