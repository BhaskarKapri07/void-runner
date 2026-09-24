import { Room } from '../shared/engine.js';
import { STEP } from '../shared/netcode.js';
import { PROTOCOL } from '../shared/protocol.js';
import { Match, Ticker, applyCommand } from '../shared/match.js';

// Everything a message can change on a multiplayer server: dedicated-server rooms, direct-mode
// signaling lobbies, and the rules for joining them. The Node server (index.js) and the Durable
// Object (cloudflare/worker.js) are thin adapters that own only sockets, timers and HTTP. Each socket
// is wrapped as { send(text) → boolean, close(code, reason) }.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 50;             // of each kind
const MAX_PILOTS = 4;
const MAX_MESSAGE_BYTES = 16384;
const MAX_MESSAGES_PER_SECOND = 90;

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.match = null;   // dedicated-server room
    this.player = null;
    this.lobby = null;   // direct-mode signaling lobby
    this.peerId = null;
    this.needSync = false;
    this.lastSeen = Date.now();
    this.windowStart = this.lastSeen;
    this.count = 0;
  }
  send(message) { return this.socket.send(typeof message === 'string' ? message : JSON.stringify(message)); }
  // Match client: one WebSocket message per publish, the journal batch inside the state.
  deliver(out, full) { return this.send(out.json(full ? 'sync' : 'combined')); }
  allow(now) {
    if (now - this.windowStart > 1000) { this.windowStart = now; this.count = 0; }
    return ++this.count <= MAX_MESSAGES_PER_SECOND;
  }
}

export class Hub {
  constructor() {
    this.matches = new Map();  // code → Match
    this.lobbies = new Map();  // code → { code, host, peers: Map(peerId → Connection), started }
    this.connections = new Set();
    this.ticker = new Ticker(() => { for (const m of this.matches.values()) m.room.tick(STEP); }, () => { for (const m of this.matches.values()) m.publish(); });
  }
  connect(socket) {
    const conn = new Connection(socket);
    this.connections.add(conn);
    return conn;
  }
  disconnect(conn) {
    if (this.connections.delete(conn)) this.leaveAll(conn);
  }
  advance(now) { this.ticker.advance(now); }
  // Closes connections silent for longer than `ms`. The Durable Object needs this; Node pings sockets instead.
  closeIdle(now, ms) {
    for (const conn of this.connections) if (now - conn.lastSeen > ms) this.drop(conn, 1001, 'Connection idle');
  }

  message(conn, raw) {
    // A socket being closed can still deliver messages; they must not create rooms or pilots.
    if (!this.connections.has(conn)) return;
    conn.lastSeen = Date.now();
    if (typeof raw !== 'string') return this.drop(conn, 1003, 'Text messages only');
    if (raw.length > MAX_MESSAGE_BYTES) return this.drop(conn, 1009, 'Message too large');
    if (!conn.allow(conn.lastSeen)) return this.drop(conn, 1008, 'Too many messages');
    let m;
    try { m = JSON.parse(raw); } catch { conn.send({ type: 'error', message: 'Invalid message.' }); return; }
    if (!m || typeof m !== 'object') return;
    try { this.handle(conn, m); } catch (e) { conn.send({ type: 'error', message: e.message }); }
  }
  handle(conn, m) {
    switch (m.type) {
      case 'ping': conn.send({ type: 'pong', sent: m.sent }); return;
      case 'keepalive': return; // direct-mode clients are otherwise silent; receiving it refreshes lastSeen
      case 'leave': this.leaveAll(conn); conn.send({ type: 'left' }); return;
      case 'peer-create': case 'peer-join': this.joinLobby(conn, m); return;
      case 'signal': this.relay(conn, m); return;
      case 'peer-started': if (conn.lobby?.host === conn.peerId) conn.lobby.started = true; return;
      case 'create': case 'join': this.joinMatch(conn, m); return;
      case 'resync': if (conn.match) conn.needSync = true; return;
      default: if (conn.match) applyCommand(conn.match.room, conn.player, m);
    }
  }
  drop(conn, code, reason) {
    conn.socket.close(code, reason);
    this.disconnect(conn);
  }

  joinLobby(conn, m) {
    if (conn.match || conn.lobby) throw Error('Leave your current room first.');
    let lobby;
    if (m.type === 'peer-create') {
      if (this.lobbies.size >= MAX_ROOMS) throw Error('Too many rooms.');
      lobby = { code: newCode(this.lobbies, 'P'), host: null, peers: new Map(), started: false };
      this.lobbies.set(lobby.code, lobby);
    } else {
      lobby = this.lobbies.get(String(m.code || '').toUpperCase());
      if (!lobby) throw Error('Peer room not found. Select browser-hosted mode and check the code.');
      if (lobby.started) throw Error('This match has started.');
      if (lobby.peers.size >= MAX_PILOTS) throw Error(`Room is full (${MAX_PILOTS}/${MAX_PILOTS}).`);
    }
    conn.peerId = crypto.randomUUID();
    conn.lobby = lobby;
    lobby.host ??= conn.peerId;
    lobby.peers.set(conn.peerId, conn);
    conn.send({ type: 'peer-ready', peer: conn.peerId, code: lobby.code, host: lobby.host });
    if (conn.peerId !== lobby.host) lobby.peers.get(lobby.host).send({ type: 'peer-new', peer: conn.peerId });
  }
  // Guests may only signal the host; the host may signal anyone in its lobby.
  relay(conn, m) {
    const lobby = conn.lobby, target = lobby?.peers.get(m.to);
    if (!target || (conn.peerId !== lobby.host && m.to !== lobby.host)) return;
    target.send({ type: 'signal', from: conn.peerId, data: m.data });
  }
  joinMatch(conn, m) {
    if (conn.match || conn.lobby) throw Error('Leave your current room first.');
    if (m.v !== PROTOCOL) throw Error('This game client is out of date. Reload the page or download the latest voidrunner.html.');
    let match;
    if (m.type === 'create') {
      if (this.matches.size >= MAX_ROOMS) throw Error('Server is full. Try again later.');
      match = new Match(new Room(newCode(this.matches)));
      this.matches.set(match.room.code, match);
    } else {
      match = this.matches.get(String(m.code || '').toUpperCase());
      if (!match) throw Error('Room not found. Check the code.');
    }
    const player = match.room.add(m.name); // throws when the room is full or has started
    conn.match = match;
    conn.player = player.id;
    match.add(conn);
    conn.send({ type: 'joined', id: player.id, code: match.room.code, v: PROTOCOL });
  }
  leaveAll(conn) {
    const lobby = conn.lobby;
    if (lobby) {
      lobby.peers.delete(conn.peerId);
      if (lobby.host === conn.peerId) {
        this.lobbies.delete(lobby.code);
        for (const peer of lobby.peers.values()) {
          peer.lobby = null;
          peer.send({ type: 'peer-ended', message: 'Host left. Create a new room.' });
        }
      } else lobby.peers.get(lobby.host)?.send({ type: 'peer-left', peer: conn.peerId });
      conn.lobby = null;
    }
    const match = conn.match;
    if (match) {
      match.room.remove(conn.player);
      match.remove(conn);
      if (!match.room.players.length) this.matches.delete(match.room.code);
      conn.match = null;
      conn.player = null;
    }
  }
}

// Six characters, unique among `taken`; direct-mode lobby codes start with P.
function newCode(taken, prefix = '') {
  let code;
  do code = prefix + Array.from(crypto.getRandomValues(new Uint8Array(6 - prefix.length)), n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
  while (taken.has(code));
  return code;
}
