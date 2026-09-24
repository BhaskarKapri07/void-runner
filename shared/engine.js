import { STEP, COLORS, MAX_BATCH_FRAMES, INPUT_WINDOW, MUZZLE_OFFSET, moveShip, stepShip, sweptHit, bulletAlive, shotAlive, volleyVelocity, shotVelocity } from './netcode.js';
const randomUUID=()=>globalThis.crypto.randomUUID();
const randomInt=n=>Math.floor(Math.random()*n);
export const UPGRADES=[
{id:'rapid',name:'RAPID FIRE',desc:'20% faster firing',apply:p=>p.rate=Math.max(.06,p.rate*.8)},
{id:'spread',name:'SPLIT SHOT',desc:'Two more projectiles',apply:p=>p.spread=Math.min(9,p.spread+2)},
{id:'power',name:'HEAVY ROUNDS',desc:'+1 projectile damage',apply:p=>p.damage++},
{id:'speed',name:'ION THRUSTERS',desc:'20% faster movement',apply:p=>p.speed=Math.min(500,p.speed*1.2)},
{id:'repair',name:'HULL REPAIR',desc:'Restore 3 hull',apply:p=>p.hp=Math.min(p.max,p.hp+3)},
{id:'armor',name:'REINFORCED HULL',desc:'+2 maximum hull and repair 2',apply:p=>{p.max=Math.min(15,p.max+2);p.hp=Math.min(p.max,p.hp+2)}},
{id:'pierce',name:'PHASE ROUNDS',desc:'Pierce one more enemy',apply:p=>p.pierce++},
{id:'blast',name:'VOLATILE AMMO',desc:'Explosive splash damage',apply:p=>p.blast+=.7}];
const rand=(a,b)=>a+Math.random()*(b-a),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export class Room {
 constructor(code){Object.assign(this,{code,host:null,players:[],phase:'lobby',wave:1,score:0,time:0,enemies:[],bullets:[],shots:[],log:[],logDropped:false,serial:0,spawned:0,spawnTimer:1,clear:0,pause:false,tickId:0,epoch:0});}
 // Change journal read by the network (protocol.js encodes each kind). Entries:
 //   fire {slot,x,y,tick,count,id,seq}   a pilot's volley; ids id..id+count-1, seq is the input frame
 //   volley {x,y,aim,count,speed,tick,id}   an enemy's shot spread
 //   gone {id}   a projectile removed by a hit (leaving the arena is not journaled; clients cull that)
 //   clear {bullets,shots}   bulk removal
 //   burst {x,y,color,count} and hit {x,y,color,count,target,owner,damage}   effects
 // Undrained entries are capped; overflow marks the journal so every client resyncs.
 record(entry){this.log.push(entry);if(this.log.length>4096){this.log.splice(0,this.log.length-4096);this.logDropped=true}}
 drain(){const entries=this.log,dropped=this.logDropped;this.log=[];this.logDropped=false;return {entries,dropped}}
 event(x,y,color,count=24,extra={}){this.record({kind:'burst',x,y,color,count,...extra})}
 add(name){if(this.players.length>=4)throw Error('Room is full (4/4).');if(this.phase!=='lobby')throw Error('This run has started. Join a new room.');const slot=[0,1,2,3].find(i=>!this.players.some(p=>p.slot===i));const p={id:randomUUID(),slot,name:String(name||'Pilot').replace(/[<>]/g,'').slice(0,16),color:COLORS[slot],input:{},lastInput:0,mods:[],offers:[],chosen:false};this.resetPlayer(p);this.players.push(p);this.host??=p.id;return p;}
 resetPlayer(p){Object.assign(p,{x:240+p.slot*160,y:515,hp:5,max:5,speed:280,rate:.2,cool:0,damage:1,spread:1,pierce:0,blast:0,inv:2,revive:0,mods:[],input:{},queue:[],ack:0,lastSeq:0,commands:false,budget:6})}
 remove(id){this.players=this.players.filter(p=>p.id!==id);if(this.host===id)this.host=this.players[0]?.id??null;if(this.phase==='upgrade')this.advanceIfReady();if(this.phase==='play'&&this.players.length&&!this.players.some(p=>p.hp>0))this.phase='dead';}
 start(id){if(id!==this.host||!['lobby','dead'].includes(this.phase))return;this.epoch++;for(const p of this.players)this.resetPlayer(p);Object.assign(this,{phase:'play',wave:1,score:0,time:0,enemies:[],bullets:[],shots:[],spawned:0,spawnTimer:1,clear:0});this.record({kind:'clear',bullets:true,shots:true});}
 input(id,v){const p=this.players.find(p=>p.id===id);if(!p||!v||typeof v!=='object')return;p.input={left:v.left===true,right:v.right===true,up:v.up===true,down:v.down===true,fire:v.fire===true};p.lastInput=Date.now()}
 frames(id,frames,epoch){const p=this.players.find(p=>p.id===id);if(!p||epoch!==this.epoch||this.phase!=='play'||!Array.isArray(frames)||frames.length>MAX_BATCH_FRAMES)return;p.commands=true;p.lastInput=Date.now();for(const f of frames){if(!Number.isSafeInteger(f.seq)||f.seq<=p.lastSeq||f.seq>p.lastSeq+INPUT_WINDOW||!f.input||p.queue.length>=INPUT_WINDOW)continue;p.lastSeq=f.seq;p.queue.push({seq:f.seq,input:{left:f.input.left===true,right:f.input.right===true,up:f.input.up===true,down:f.input.down===true,fire:f.input.fire===true}})}}
 fire(p,seq=0){const id=this.serial+1,y=p.y-MUZZLE_OFFSET;for(let i=0;i<p.spread;i++){const [vx,vy]=volleyVelocity(i,p.spread);this.bullets.push({id:++this.serial,owner:p.id,color:p.color,x:p.x,y,vx,vy,damage:p.damage,pierce:p.pierce,blast:p.blast,hit:new Set()})}this.record({kind:'fire',slot:p.slot,x:p.x,y,tick:this.tickId,count:p.spread,id,seq})}
 choose(id,index){const p=this.players.find(p=>p.id===id);if(this.phase!=='upgrade'||!p||p.chosen||!Number.isInteger(index)||index<0||index>=p.offers.length)return;const u=UPGRADES.find(u=>u.id===p.offers[index]);u.apply(p);p.mods.push(u.name);p.chosen=true;this.advanceIfReady()}
 advanceIfReady(){if(this.players.length&&this.players.every(p=>p.chosen)){this.wave++;this.epoch++;this.phase='play';this.spawned=0;this.spawnTimer=1;this.clear=0;this.shots=[];this.bullets=[];this.record({kind:'clear',bullets:true,shots:true});for(const p of this.players){p.offers=[];p.input={};p.inv=2;p.queue=[];p.ack=0;p.lastSeq=0;p.budget=6;}}}
 salvage(){this.phase='upgrade';this.shots=[];this.record({kind:'clear',shots:true});for(const p of this.players){if(p.hp<=0)p.hp=Math.min(3,p.max);p.revive=0;p.chosen=false;p.input={};const pool=UPGRADES.filter(u=>u.id!=='spread'||p.spread<9);p.offers=[];while(p.offers.length<3){const i=randomInt(pool.length);p.offers.push(pool.splice(i,1)[0].id)}}}
 hurt(p){if(p.hp<=0||p.inv>0)return;p.hp--;p.inv=1.5;this.event(p.x,p.y,p.color,p.hp?15:45)}
 kill(e){if(e.dead)return;e.dead=true;this.score+=e.type==='boss'?1500:e.type==='tank'?150:75;this.event(e.x,e.y,'#ff9b65',e.type==='boss'?70:25)}
 spawn(){const boss=this.wave%5===0,tank=!boss&&Math.random()<.25;const hp=(boss?55+this.wave*12:tank?4+Math.floor(this.wave/2):1+Math.floor(this.wave/3))*(1+(this.players.length-1)*.55);this.enemies.push({id:++this.serial,x:boss?480:rand(40,920),y:-40,hp,max:hp,type:boss?'boss':tank?'tank':'scout',r:boss?58:tank?20:15,age:rand(0,6),speed:boss?35:tank?45+this.wave*3:65+this.wave*5,fire:rand(1,3)});this.spawned++}
 tick(dt){if(this.phase!=='play')return;this.time+=dt;this.tickId++;const live=this.players.filter(p=>p.hp>0);if(!live.length){this.phase='dead';return;}for(const p of this.players){p.inv-=dt;if(p.hp<=0){const near=live.some(a=>dist(p,a)<55);p.revive=near?p.revive+dt:Math.max(0,p.revive-dt);if(p.revive>=3){p.hp=Math.min(3,p.max);p.inv=3;p.revive=0;this.event(p.x,p.y,p.color,35)}continue;}p.px=p.x;p.py=p.y;
 if(p.commands){p.budget=Math.min(6,p.budget+dt/STEP);const count=Math.min(p.queue.length,Math.floor(p.budget),Math.ceil(dt/STEP)+1);for(let i=0;i<count;i++){const f=p.queue.shift();p.ack=f.seq;p.budget--;if(stepShip(p,f.input))this.fire(p,f.seq)}}else{p.cool-=dt;if(Date.now()-p.lastInput>500)p.input={};moveShip(p,p.input,dt);if(p.input.fire&&p.cool<=0){p.cool=p.rate;this.fire(p)}}}

 const total=this.wave%5===0?1:8+this.wave*3+(this.players.length-1)*3;this.spawnTimer-=dt;if(this.spawned<total&&this.spawnTimer<=0){this.spawn();this.spawnTimer=Math.max(.25,.95-this.wave*.035)}
 for(const b of this.bullets){b.px=b.x;b.py=b.y;b.x+=b.vx*dt;b.y+=b.vy*dt}
 for(const e of this.enemies){if(e.dead)continue;e.px=e.x;e.py=e.y;e.age+=dt;e.y+=e.speed*dt;if(e.type==='boss'&&e.y>95){e.y=95;e.x=480+Math.sin(e.age*.65)*310}else e.x+=Math.sin(e.age*2)*25*dt;e.fire-=dt;if(e.fire<=0&&e.y>0){const target=live.reduce((a,b)=>dist(e,a)<dist(e,b)?a:b),a=Math.atan2(target.y-e.y,target.x-e.x),count=e.type==='boss'?9:e.type==='tank'?3:1,speed=130+this.wave*5,id=this.serial+1;for(let i=0;i<count;i++){const [vx,vy]=shotVelocity(a,i,count,speed);this.shots.push({id:++this.serial,x:e.x,y:e.y,vx,vy})}this.record({kind:'volley',x:e.x,y:e.y,aim:a,count,speed,tick:this.tickId,id});e.fire=e.type==='boss'?.8:rand(1.8,3.2)}for(const p of live)if(dist(e,p)<e.r+11){this.hurt(p);if(e.type!=='boss')e.dead=true}if(e.y>650)e.dead=true;
 for(const b of this.bullets){if(e.dead||b.dead||b.hit.has(e.id)||!sweptHit(b,e,e.r+5))continue;b.hit.add(e.id);e.hp-=b.damage;this.event(e.x,e.y,b.color,5,{kind:'hit',target:e.id,owner:b.owner,damage:b.damage});if(b.blast){this.event(b.x,b.y,'#ffbf68',6);for(const other of this.enemies)if(other!==e&&!other.dead&&dist(e,other)<65){other.hp-=b.blast;this.event(other.x,other.y,b.color,4,{kind:'hit',target:other.id,owner:b.owner,damage:b.blast});if(other.hp<=0)this.kill(other)}}if(b.pierce--<=0){b.dead=true;this.record({kind:'gone',id:b.id})}if(e.hp<=0)this.kill(e)}}
 for(const s of this.shots){s.px=s.x;s.py=s.y;s.x+=s.vx*dt;s.y+=s.vy*dt;for(const p of live)if(!s.dead&&sweptHit(s,p,13)){s.dead=true;this.record({kind:'gone',id:s.id});this.hurt(p)}}
 this.bullets=this.bullets.filter(b=>!b.dead&&bulletAlive(b.x,b.y));this.shots=this.shots.filter(s=>!s.dead&&shotAlive(s.x,s.y));this.enemies=this.enemies.filter(e=>!e.dead);
 if(!this.players.some(p=>p.hp>0)){this.phase='dead';return}if(this.spawned>=total&&!this.enemies.length){this.clear+=dt;if(this.clear>1.1)this.salvage()}}
}
