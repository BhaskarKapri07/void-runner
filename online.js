import { PeerSession } from './peer.js';
import { PROTOCOL } from './shared/protocol.js';
import { MatchClient } from './shared/client.js';
'use strict';
// The online page: lobby, HUD, effects and drawing. Match logic lives in MatchClient (shared/client.js).
// Uses game.js globals: $, ctx, W, H, keys, mode, stars, particles, shake, sprite, tone, burst,
// random, announce and formatTime.
(() => {
const UI_REFRESH_MS = 150;
const CONNECT_TIMEOUT_MS = 65000;
const HIT_FLASH_MS = 120;
const ENEMY_SCALE = { scout: 3, tank: 4, boss: 8 };
const VERSION_MISMATCH = 'This game client and the match host run different versions. Everyone needs the latest voidrunner.html.';
const descriptions = { rapid: ['RAPID FIRE', '20% faster firing'], spread: ['SPLIT SHOT', 'Two more projectiles'], power: ['HEAVY ROUNDS', '+1 projectile damage'], speed: ['ION THRUSTERS', '20% faster movement'],
  repair: ['HULL REPAIR', 'Restore 3 hull'], armor: ['REINFORCED HULL', '+2 max hull and repair 2'], pierce: ['PHASE ROUNDS', 'Pierce one more enemy'], blast: ['VOLATILE AMMO', 'Explosive splash damage'] };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const overlay = $('#overlay');
const bar = document.createElement('div');
bar.id = 'netbar';
bar.className = 'hidden';
$('.arena').before(bar);

// One connection at a time. `session` invalidates handlers of sockets from earlier connections.
let socket = null, peer = null, client = null, session = 0;
// Page state: what was last rendered, and effects in flight.
let uiAt = 0, uiKey = '', barHTML = '', modsHTML = '', flash = new Map(), damageText = [], muzzle = 0;

function rawSend(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function send(message) {
  if (peer) peer.send(message);
  else rawSend(message);
}
function endpoint() {
  const fromQuery = new URLSearchParams(location.search).get('server');
  return fromQuery || window.VOIDRUNNER_SERVER || (!location.hostname.endsWith('github.io') && location.protocol !== 'file:' ? location.origin : '');
}
// The server address as a WebSocket URL, or null if this page can't use it.
function socketUrl(address) {
  let url;
  try { url = new URL(address.trim()); } catch { return null; }
  if (!['https:', 'http:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return null;
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return location.protocol === 'https:' && url.protocol !== 'wss:' ? null : url;
}
function formStatus(message) { $('#neterror').textContent = message; }

function openOnline() {
  window.netActive = true;
  keys = {};
  mode = 'online';
  $('#pause').textContent = '? HELP';
  bar.classList.add('hidden');
  uiKey = '';
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="eyebrow">ONLINE CO-OP / 1–4 PILOTS</div><h2>FORM YOUR SQUAD.</h2><p>One arena. Four ships. Survive together.</p>'
    + '<div class="netform"><label>MATCH HOST<select id="hostmode"><option value="peer">Player browser (direct co-op)</option><option value="server">Dedicated server (fallback)</option></select></label>'
    + '<label>PILOT NAME<input id="pilotname" maxlength="16" value="Pilot" autocomplete="nickname"></label>'
    + '<label>ROOM CODE<input id="roomcode" maxlength="6" placeholder="6-character code" autocapitalize="characters"></label>'
    + '<div class="netrow"><button class="primary" id="createRoom">CREATE ROOM</button><button id="joinRoom">JOIN ROOM</button></div>'
    + '<details id="connection"><summary>Server connection</summary><label>SERVER ADDRESS<input id="serverurl" placeholder="https://your-server.onrender.com" value="' + esc(endpoint()) + '"></label></details></div>'
    + '<div class="neterror" id="neterror" role="status"></div><button id="backSolo">BACK TO SOLO</button>';
  if (!endpoint()) {
    $('#connection').open = true;
    formStatus('A multiplayer server needs to be deployed first. Enter its address here.');
  }
  $('#createRoom').onclick = () => connect('create');
  $('#joinRoom').onclick = () => connect('join');
  $('#backSolo').onclick = () => location.href = location.pathname;
}

function resetSession() {
  socket?.close();
  peer?.close();
  socket = peer = client = null;
  uiKey = barHTML = modsHTML = '';
  flash.clear();
  damageText = [];
}
function connect(action) {
  const code = $('#roomcode').value.toUpperCase(), name = $('#pilotname').value, usePeer = $('#hostmode').value === 'peer';
  if (action === 'join' && !/^[A-Z2-9]{6}$/.test(code)) { formStatus('Enter a six-character room code.'); return; }
  const url = socketUrl($('#serverurl').value);
  if (!url) { formStatus('Enter a valid HTTPS server address (HTTP works locally).'); return; }
  if (usePeer && !window.RTCPeerConnection) { formStatus('WebRTC is unavailable. Choose dedicated server mode.'); return; }
  const current = ++session;
  resetSession();
  client = new MatchClient(send);
  if (usePeer) {
    peer = new PeerSession(rawSend, receive, error);
    peer.name = name;
  }
  const ws = socket = new WebSocket(url);
  formStatus('Connecting… A sleeping server may take a minute.');
  $('#createRoom').disabled = $('#joinRoom').disabled = true;
  const timeout = setTimeout(() => {
    if (current === session && ws.readyState !== WebSocket.OPEN) { ws.close(); error('Connection timed out. Check the server address and try again.'); }
  }, CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    clearTimeout(timeout);
    rawSend({ type: usePeer ? 'peer-' + action : action, name, code, v: PROTOCOL });
  };
  ws.onerror = () => { if (current === session) error('Could not connect. Check the server is running and retry.'); };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (current !== session) return;
    // A direct match outlives its signaling socket once a data channel is up.
    if (peer && (peer.linked() || (peer.isHost && client.view && client.view.phase !== 'lobby'))) return;
    keys = {};
    error(client.view ? 'Connection lost. This pilot left the run. Return to the lobby to create or join a new run.' : 'Connection closed. Check the server address and retry.');
  };
  ws.onmessage = e => {
    if (current !== session) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (peer && (m.type.startsWith('peer-') || m.type === 'signal')) peer.message(m);
    else receive(m);
  };
}
function receive(m) {
  if (!client) return;
  if (m.type === 'joined') {
    if (m.v !== PROTOCOL) { error(VERSION_MISMATCH); return; }
    client.joined(m.id);
    bar.classList.remove('hidden');
    return;
  }
  if (m.type === 'error') { error(m.message); return; }
  const now = performance.now();
  if (client.receive(m, now, showEffect) || now - uiAt > UI_REFRESH_MS) {
    uiAt = now;
    renderUI();
  }
}
function error(message) {
  if (!client?.view) {
    const status = $('#neterror'), create = $('#createRoom'), join = $('#joinRoom');
    if (status) status.textContent = message;
    if (create) create.disabled = false;
    if (join) join.disabled = false;
    return;
  }
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="eyebrow">CONNECTION INTERRUPTED</div><h2>SIGNAL LOST.</h2><p class="online-note">' + esc(message) + '</p><button id="netReturn">RETURN TO LOBBY</button>';
  $('#netReturn').onclick = leave;
}
function leave() {
  session++;
  rawSend({ type: 'leave' });
  resetSession();
  keys = {};
  particles = [];
  openOnline();
}

function renderUI() {
  const state = client?.view, me = client?.me, pilot = client?.mine;
  if (!state || !me || !pilot) return;
  renderBar(state, me);
  renderHud(state, pilot);
  // The overlay is rebuilt only when what it shows changes, so its buttons stay clickable.
  const key = [state.phase, state.host, state.players.map(a => a.id + ':' + a.chosen).join(','), pilot.chosen, state.wave].join('/');
  if (key === uiKey) return;
  uiKey = key;
  if (state.phase === 'play') { overlay.classList.add('hidden'); return; }
  overlay.classList.remove('hidden');
  if (state.phase === 'lobby') renderLobby(state, me);
  if (state.phase === 'upgrade') renderUpgrade(pilot);
  if (state.phase === 'dead') renderDefeat(state, me);
}
function renderBar(state, me) {
  const roster = state.players.map(a => '<span style="color:' + a.color + '">' + esc(a.name) + (a.id === me ? ' (YOU)' : '') + ' ' + (a.hp > 0 ? a.hp + '/' + a.max : 'DOWN') + '</span>').join('');
  const html = '<span>ROOM <b>' + esc(state.code) + '</b> · ' + (peer ? 'DIRECT' : 'SERVER') + ' · ' + client.rtt + ' ms</span><div class="roster">' + roster + '</div><button id="leaveRoom">LEAVE ROOM</button>';
  // Rewriting the bar recreates its button; skip it when nothing changed so clicks aren't lost.
  if (html === barHTML) return;
  barHTML = html;
  bar.innerHTML = html;
  $('#leaveRoom').onclick = leave;
}
function renderHud(state, pilot) {
  $('#wave').textContent = String(state.wave).padStart(2, '0');
  $('#hull').textContent = pilot.hp + ' / ' + pilot.max;
  $('#hull').style.color = pilot.color;
  $('#score').textContent = String(state.score).padStart(6, '0');
  $('#time').textContent = formatTime(state.time);
  $('#status').textContent = pilot.hp <= 0 ? 'DOWNED / TEAMMATE NEEDED' : 'SQUAD ONLINE';
  $('#build').textContent = state.players.length + ' PILOTS';
  $('#modcount').textContent = pilot.mods.length + ' INSTALLED';
  const mods = pilot.mods.map(n => '<span class="mod">' + esc(n) + '</span>').join('') || '<span class="emptymod">Survive a sector to choose your upgrade</span>';
  if (mods !== modsHTML) { modsHTML = mods; $('#mods').innerHTML = mods; }
}
function renderLobby(state, me) {
  const cards = state.players.map(a => '<div class="pilotcard" style="border-color:' + a.color + '"><b style="color:' + a.color + '">' + esc(a.name) + '</b>' + (a.id === me ? 'YOU · ' : '') + (a.id === state.host ? 'HOST' : 'READY') + '</div>').join('');
  overlay.innerHTML = '<div class="eyebrow">SQUAD ASSEMBLING / ' + state.players.length + ' OF 4</div><h2>ROOM ' + esc(state.code) + '</h2><p>Share this code and the server address with your squad.</p>'
    + '<div class="squad">' + cards + '</div>' + (state.host === me ? '<button class="primary" id="startSquad">LAUNCH SQUAD</button>' : '<p>Waiting for the host to launch.</p>')
    + '<p style="margin-top:20px">Stay near a downed teammate for 3 seconds to revive.' + (peer ? ' Host: keep this tab visible.' : '') + '</p>';
  if ($('#startSquad')) $('#startSquad').onclick = () => send({ type: 'start' });
}
function renderUpgrade(pilot) {
  const choices = pilot.offers.map((id, i) => '<button class="choice" data-netchoice="' + i + '"><small>0' + (i + 1) + '</small><b>' + descriptions[id][0] + '</b><span>' + descriptions[id][1] + '</span></button>').join('');
  overlay.innerHTML = '<div class="eyebrow">SECTOR CLEARED</div><h2>UPGRADE YOUR SHIP.</h2>'
    + (pilot.chosen ? '<p>Upgrade installed. Waiting for your squad.</p>' : '<p>Choose one. The next sector starts when everyone is ready.</p><div class="choices">' + choices + '</div>');
  document.querySelectorAll('[data-netchoice]').forEach(b => b.onclick = () => send({ type: 'choose', index: +b.dataset.netchoice }));
}
function renderDefeat(state, me) {
  overlay.innerHTML = '<div class="eyebrow">SQUAD LOST</div><h2>THE VOID TAKES EVERYONE.</h2><p>Sector ' + state.wave + ' · ' + state.score + ' points · ' + formatTime(state.time) + '</p>'
    + (state.host === me ? '<button id="restartSquad" class="primary">RUN IT BACK</button>' : '<p>Waiting for the host to restart.</p>');
  if ($('#restartSquad')) $('#restartSquad').onclick = () => send({ type: 'start' });
}

// Journal effects. Only the frame loop retires particles, and hidden tabs stop it, so effects
// nobody can see are skipped.
function showEffect(e) {
  if (document.hidden) return;
  if (e.kind === 'burst') { burst(e.x, e.y, e.color, e.count); return; }
  flash.set(e.target, { until: performance.now() + HIT_FLASH_MS, color: e.color });
  if (e.mine) tone(1200, .025, 'triangle', .012);
  if (!e.at) return;
  damageText.push({ x: e.at.x, y: e.at.y, damage: Math.round(e.damage * 10) / 10, color: e.color, life: .5 });
  for (let i = 0; i < 6; i++) particles.push({ x: e.at.x, y: e.at.y, vx: random(-80, 80), vy: random(-90, 20), life: .2, color: e.color, size: 3 });
}
function readInput() {
  return { left: !!keys.ArrowLeft, right: !!keys.ArrowRight, up: !!keys.ArrowUp, down: !!keys.ArrowDown, fire: !!keys.Space };
}

window.netHelp = () => {
  if (client?.view?.phase === 'play') announce('ARROWS + SPACE / STAY NEAR DOWNED PILOTS TO REVIVE / ONLINE DOES NOT PAUSE');
};
window.netUpdate = dt => {
  const now = performance.now();
  for (const s of stars) s.y = (s.y + s.z * 25 * dt) % H;
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
  particles = particles.filter(p => p.life > 0);
  shake = Math.max(0, shake - dt * 30);
  damageText = damageText.filter(d => (d.life -= dt) > 0);
  for (const d of damageText) d.y -= 35 * dt;
  muzzle = Math.max(0, muzzle - dt);
  for (const [id, f] of flash) if (f.until < now) flash.delete(id);
  if (!client) return;
  if (client.update(dt, document.hidden ? null : readInput(), now)) { muzzle = .06; tone(780, .04); }
  peer?.pulse(now);
};
window.netDraw = () => {
  ctx.fillStyle = '#080c18';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  if (shake) ctx.translate(random(-shake, shake), random(-shake, shake));
  for (const s of stars) { ctx.fillStyle = s.z > 1.1 ? '#7e93ad' : '#293b55'; ctx.fillRect(s.x | 0, s.y | 0, 2, 2); }
  if (client?.view) {
    const now = performance.now(), scene = client.scene(now);
    for (const p of scene.pilots) drawPilot(p, client.me);
    for (const e of scene.enemies) drawEnemy(e, now);
    for (const b of scene.bullets) { ctx.fillStyle = b.color; ctx.fillRect(b.x - 2, b.y - 8, 4, 13); }
    ctx.fillStyle = '#ff799a';
    for (const s of scene.shots) ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
  }
  for (const p of particles) { ctx.globalAlpha = Math.min(1, p.life * 3); ctx.fillStyle = p.color; ctx.fillRect(p.x | 0, p.y | 0, p.size | 0, p.size | 0); }
  ctx.globalAlpha = 1;
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  for (const d of damageText) { ctx.fillStyle = d.color; ctx.fillText('-' + d.damage, d.x, d.y); }
  const ship = client?.predicted;
  if (muzzle > 0 && ship) { ctx.fillStyle = ship.color; ctx.fillRect(ship.x - 5, ship.y - 30, 10, 10); }
  ctx.restore();
};
function drawPilot(p, me) {
  if (p.hp <= 0) {
    ctx.strokeStyle = p.color;
    ctx.strokeRect(p.x - 17, p.y - 17, 34, 34);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 20, p.y + 25, 40 * p.revive / 3, 4);
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('REVIVE', p.x, p.y - 26);
    return;
  }
  // Blinks while invulnerable.
  if (p.inv <= 0 || Math.floor(p.inv * 12) % 2 === 0) {
    ctx.fillStyle = '#ffb35f';
    ctx.fillRect(p.x - 5, p.y + 15, 8, random(8, 18));
    sprite('ship', p.x, p.y, 3, [p.color, '#e8f4ff']);
  }
  ctx.fillStyle = p.color;
  ctx.textAlign = 'center';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(p.name + (p.id === me ? ' · YOU' : ''), p.x, p.y + 40);
  if (p.id === me) { ctx.strokeStyle = p.color; ctx.strokeRect(p.x - 20, p.y - 21, 40, 47); }
}
function drawEnemy(e, now) {
  const hit = flash.get(e.id);
  const palette = hit?.until > now ? ['#ffffff', hit.color] : e.type === 'boss' ? ['#986148', '#ffc16f'] : ['#9e405a', '#ff8790'];
  sprite(e.type, e.x, e.y, ENEMY_SCALE[e.type], palette);
  if (e.type === 'boss') {
    ctx.fillStyle = '#402c32';
    ctx.fillRect(260, 18, 440, 7);
    ctx.fillStyle = '#ff9272';
    ctx.fillRect(260, 18, 440 * e.hp / e.max, 7);
  }
}

window.addEventListener('keydown', e => {
  if (!window.netActive || e.repeat || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (['Digit1', 'Digit2', 'Digit3'].includes(e.code) && client?.view?.phase === 'upgrade') send({ type: 'choose', index: +e.code.slice(-1) - 1 });
});
// Losing focus releases every key so the ship doesn't keep flying.
const releaseKeys = () => { keys = {}; send({ type: 'input', input: {} }); };
window.addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });
window.netDiagnostics = () => ({ transport: peer ? 'peer' : 'server', ...client?.diagnostics() });
$('#online').onclick = openOnline;
})();
