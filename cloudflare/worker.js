import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL } from '../shared/protocol.js';
import { Hub } from '../server/hub.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const OPEN = 1; // WebSocket.readyState
const MAX_SOCKETS = 200;
const IDLE_MS = 45000;
const IDLE_CHECK_MS = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
    if (!['/', '/health', '/location'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    const id = env.ARENA.idFromName(env.ARENA_INSTANCE || 'india-v1');
    // Only first access honors this hint. Region placement on the Worker is separate.
    return env.ARENA.get(id, { locationHint: 'apac' }).fetch(request);
  },
};

// One Durable Object hosts every room. The hub holds the game state; this class owns sockets and timers.
export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = new Hub();
    this.clock = null; // 60 Hz simulation, only while a dedicated-server room exists
    this.idle = null;  // idle sweep, only while anyone is connected
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return this.health();
    if (url.pathname === '/location') return this.location(request);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('VOIDRUNNER multiplayer backend. Use the local HTML client with this HTTPS address. See /health and /location.', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (this.hub.connections.size >= MAX_SOCKETS) return new Response('Server full', { status: 503 });
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    const conn = this.hub.connect({
      send(text) {
        if (ws.readyState !== OPEN) return false;
        try { ws.send(text); return true; } catch { return false; }
      },
      close: (code, reason) => ws.close(code, reason),
    });
    ws.addEventListener('message', event => { this.hub.message(conn, event.data); this.updateTimers(); });
    const closed = () => { this.hub.disconnect(conn); this.updateTimers(); };
    ws.addEventListener('close', closed);
    ws.addEventListener('error', closed);
    this.updateTimers();
    return new Response(null, { status: 101, webSocket: client });
  }
  updateTimers() {
    if (this.hub.matches.size && !this.clock) {
      this.hub.ticker.reset();
      this.clock = setInterval(() => this.hub.advance(Date.now()), 1000 / 60);
    } else if (!this.hub.matches.size && this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    if (this.hub.connections.size && !this.idle) {
      this.idle = setInterval(() => { this.hub.closeIdle(Date.now(), IDLE_MS); this.updateTimers(); }, IDLE_CHECK_MS);
    } else if (!this.hub.connections.size && this.idle) {
      clearInterval(this.idle);
      this.idle = null;
    }
  }
  health() {
    return Response.json({ ok: true, backend: 'cloudflare-durable-object', protocol: PROTOCOL, rooms: this.hub.matches.size, peerRooms: this.hub.lobbies.size,
      placementTarget: 'near aws:ap-south-1', durableObjectHint: 'apac', indiaGuaranteed: false }, { headers: CORS });
  }
  // Request.cf is ingress metadata, NOT proof of the Durable Object's location.
  async location(request) {
    let egressColo = null;
    try {
      const trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
      egressColo = trace.match(/^colo=(.+)$/m)?.[1] || null;
    } catch {}
    return Response.json({ workerTarget: 'aws:ap-south-1', durableObjectHint: 'apac', ingressColo: request.cf?.colo || null, observedEgressColo: egressColo,
      note: 'Egress observation is diagnostic, not a contractual India location guarantee. Measure in-game RTT.' }, { headers: CORS });
  }
}
