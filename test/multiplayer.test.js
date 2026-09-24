import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';
import { Room } from '../server/engine.js';
import { sweptHit, reconcile } from '../shared/netcode.js';
import { PROTOCOL } from '../shared/protocol.js';
import { MatchClient } from '../shared/client.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  const app = createGameServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, port: app.server.address().port };
}

// A WebSocket pilot that decodes the match through MatchClient, like the game does.
function pilot(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), messages = [], client = new MatchClient(() => {});
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      messages.push(m);
      if (m.type === 'joined') client.joined(m.id);
      else client.receive(m, Date.now());
    });
    ws.once('error', reject);
    ws.once('open', () => resolve({
      ws, client,
      send: m => ws.send(JSON.stringify({ v: PROTOCOL, ...m })),
      async wait(fn) {
        for (const start = Date.now(); Date.now() - start < 2500; await sleep(10)) {
          const m = messages.find(fn);
          if (m) return m;
        }
        throw Error('Timed out waiting for message');
      },
    }));
  });
}

test('four real clients share a room, enforce authority, reject a fifth, and hand over host', async () => {
  const { app, port } = await startServer();
  try {
    const pilots = [];
    for (let i = 0; i < 5; i++) pilots.push(await pilot('ws://127.0.0.1:' + port));
    pilots[0].send({ type: 'create', name: 'Alpha' });
    const { code } = await pilots[0].wait(m => m.type === 'joined');
    for (let i = 1; i < 4; i++) {
      pilots[i].send({ type: 'join', code, name: 'Pilot ' + i });
      await pilots[i].wait(m => m.type === 'joined');
    }
    pilots[4].send({ type: 'join', code, name: 'Fifth' });
    assert.match((await pilots[4].wait(m => m.type === 'error')).message, /full/);

    const room = app.hub.matches.get(code).room;
    pilots[1].send({ type: 'start' });
    await sleep(80);
    assert.equal(room.phase, 'lobby', 'only the host can launch');
    pilots[0].send({ type: 'start' });
    await Promise.all(pilots.slice(0, 4).map(p => p.wait(() => p.client.view?.phase === 'play' && p.client.view.players.length === 4)));

    // Clients send controls only; claimed positions and health are ignored.
    const guest = room.players[1], startX = guest.x;
    pilots[1].send({ type: 'input', input: { right: true, fire: true }, x: 999999, hp: 99999 });
    await sleep(180);
    assert(guest.x > startX && guest.x < 940);
    assert.equal(guest.hp, 5);
    assert(room.bullets.some(b => b.owner === guest.id));

    pilots[0].ws.close();
    await sleep(100);
    assert.equal(room.host, guest.id);
    assert.equal(room.players.length, 3);
    for (const p of pilots) p.ws.close();
    await sleep(100);
    assert.equal(app.hub.matches.size, 0, 'empty rooms are deleted');
  } finally {
    await app.close();
  }
});

test('revive, squad defeat, per-player upgrades, boss scaling, restart', () => {
  const room = new Room('ABC123'), a = room.add('A'), b = room.add('B');
  room.start(a.id);
  Object.assign(b, { hp: 0, x: a.x, y: a.y });
  for (let i = 0; i < 91; i++) room.tick(1 / 30);
  assert.equal(b.hp, 3, 'revived after 3 s beside a teammate');
  a.hp = b.hp = 0;
  room.tick(1 / 30);
  assert.equal(room.phase, 'dead');
  room.start(a.id);
  assert.equal(a.hp, 5);

  room.salvage();
  assert.equal(a.offers.length, 3);
  assert.equal(new Set(a.offers).size, 3);
  room.choose(a.id, 999);
  assert.equal(a.chosen, false);
  room.choose(a.id, 0);
  assert.equal(room.phase, 'upgrade', 'waits for every pilot');
  const mods = a.mods.length;
  room.choose(a.id, 1);
  assert.equal(a.mods.length, mods, 'one upgrade per pilot');
  room.choose(b.id, 0);
  assert.equal(room.phase, 'play');
  assert.equal(room.wave, 2);

  Object.assign(room, { wave: 5, spawned: 0, enemies: [] });
  room.spawn();
  assert.equal(room.enemies[0].type, 'boss');
  assert(room.enemies[0].hp > 115, 'boss health scales with squad size');
});

test('stale input stops moving; invalid input cannot teleport; late joins refused', () => {
  const room = new Room('ABC123'), p = room.add('A');
  room.start(p.id);
  assert.throws(() => room.add('Late'), /started/);
  room.input(p.id, { right: true, x: 100000 });
  p.lastInput = Date.now() - 1000;
  const x = p.x;
  room.tick(1 / 30);
  assert.equal(p.x, x);
});

test('server serves game assets and health; never exposes source or traversal', async () => {
  const { app, port } = await startServer();
  const base = 'http://127.0.0.1:' + port;
  try {
    for (const path of ['/', '/game.js', '/online.js', '/style.css', '/config.js', '/shared/client.js', '/health']) assert.equal((await fetch(base + path)).status, 200, path);
    for (const path of ['/server/index.js', '/server/hub.js', '/package.json', '/.git/config', '/../server/engine.js']) assert.equal((await fetch(base + path)).status, 404, path);
  } finally {
    await app.close();
  }
});

test('sequenced prediction reconciles, and duplicate or stale-epoch commands cannot move twice', () => {
  const room = new Room('TEST'), p = room.add('A');
  room.start(p.id);
  const frames = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, input: { right: true } }));
  const predicted = reconcile(p, frames);
  room.frames(p.id, frames, room.epoch);
  for (let i = 0; i < 6; i++) room.tick(1 / 60);
  assert.equal(p.ack, 6);
  assert.equal(p.x, predicted.x);
  const x = p.x;
  room.frames(p.id, frames, room.epoch);
  room.tick(1 / 60);
  assert.equal(p.x, x, 'duplicates are ignored');
  room.frames(p.id, [{ seq: 7, input: { right: true } }], room.epoch - 1);
  room.tick(1 / 60);
  assert.equal(p.x, x, 'frames from an earlier run are ignored');
});

test('swept bullets register between ticks, and hits carry the shooter color', () => {
  assert(sweptHit({ px: 100, py: 150, x: 100, y: 50 }, { x: 100, y: 100 }, 15));
  const room = new Room('TEST'), p = room.add('A');
  room.start(p.id);
  room.enemies = [{ id: 90, type: 'tank', x: 100, y: 100, hp: 20, max: 20, r: 20, age: 0, speed: 0, fire: 99 }];
  // Fast enough to jump from below to above the tank in one tick.
  room.bullets = [{ id: 91, owner: p.id, color: p.color, x: 100, y: 150, vx: 0, vy: -3000, damage: 2, pierce: 0, blast: 0, hit: new Set() }];
  room.tick(1 / 30);
  assert.equal(room.enemies[0].hp, 18);
  const hit = room.log.find(e => e.kind === 'hit');
  assert.equal(hit.owner, p.id);
  assert.equal(hit.color, p.color);
  assert.equal(hit.damage, 2);
});
