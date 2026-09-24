import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL } from '../shared/protocol.js';
import { Hub } from './hub.js';

// The files the game needs. Everything else is a 404, so server code and config are never served.
const PUBLIC_FILES = ['index.html', 'style.css', 'game.js', 'online.js', 'config.js', 'peer.js', 'downloads/voidrunner.html',
  'shared/netcode.js', 'shared/engine.js', 'shared/protocol.js', 'shared/match.js', 'shared/world.js', 'shared/client.js'];
const ROUTES = Object.fromEntries([['/', 'index.html'], ...PUBLIC_FILES.map(file => ['/' + file, file])]);
const MAX_SOCKETS = 200;
const MAX_BUFFERED_BYTES = 262144; // a socket this backed up skips sends; the hub resyncs it later
const HEARTBEAT_MS = 15000;

const contentType = file => file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript';

async function serve(req, res, hub) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: hub.matches.size, protocol: PROTOCOL }));
  }
  const file = ROUTES[path];
  if (!file) {
    res.writeHead(404);
    return res.end('Not found');
  }
  try {
    const data = await readFile(new URL('../' + file, import.meta.url));
    const download = file === 'downloads/voidrunner.html' ? { 'Content-Disposition': 'attachment; filename="voidrunner.html"' } : {};
    res.writeHead(200, { 'Content-Type': contentType(file), 'X-Content-Type-Options': 'nosniff', ...download });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end('Unable to load game');
  }
}

export function createGameServer() {
  const hub = new Hub();
  const server = http.createServer((req, res) => serve(req, res, hub));
  const wss = new WebSocketServer({ server, maxPayload: 16384 });
  wss.on('connection', ws => {
    if (wss.clients.size > MAX_SOCKETS) {
      ws.close(1013, 'Server full');
      return;
    }
    const conn = hub.connect({
      send(text) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= MAX_BUFFERED_BYTES) return false;
        ws.send(text);
        return true;
      },
      close: (code, reason) => ws.close(code, reason),
    });
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => hub.disconnect(conn));
    ws.on('message', (data, binary) => hub.message(conn, binary ? null : data.toString()));
  });
  const loop = setInterval(() => hub.advance(performance.now()), 1000 / 60);
  // Socket-level pings find dead connections without relying on game traffic.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const close = () => new Promise(resolve => {
    clearInterval(loop);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(resolve));
  });
  return { server, wss, hub, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createGameServer();
  app.server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('VOIDRUNNER server listening'));
  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
}
