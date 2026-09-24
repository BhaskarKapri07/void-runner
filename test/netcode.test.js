import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';
import { Room } from '../shared/engine.js';
import { STEP, stepShip, reconcile } from '../shared/netcode.js';
import { PROTOCOL, encodeFrames, decodeFrames } from '../shared/protocol.js';
import { Match, Ticker, applyCommand } from '../shared/match.js';
import { ClientWorld, NetClock, CLAIM_WINDOW } from '../shared/world.js';
import { MatchClient } from '../shared/client.js';
import { PeerSession } from '../peer.js';
import { BUILDS, simulate } from '../scripts/netbench.js';

// A started one-pilot room whose Match feeds a ClientWorld. `publish()` returns what the client was
// sent, so each test decides when (and whether) the world receives it.
function pilotRoom() {
  const room = new Room('TEST'), pilot = room.add('A'), match = new Match(room), world = new ClientWorld();
  room.start(pilot.id);
  let sent = null;
  match.add({ deliver(out, full) { sent = full ? { sync: out.sync } : { rel: out.rel, state: out.state }; return true; } });
  const publish = () => { sent = null; match.publish(); return sent ?? {}; };
  world.setMe(pilot.id);
  world.sync(publish().sync);
  return { room, pilot, world, publish };
}
// One input frame through the authority, then a publish.
function play(r, seq, input) {
  r.room.frames(r.pilot.id, [{ seq, input }], r.room.epoch);
  r.room.tick(STEP);
  return r.publish();
}
const shipOf = world => reconcile(world.view().players[0], []);
const fireSeqs = room => room.log.filter(e => e.kind === 'fire').map(e => e.seq);

test('bandwidth stays small and flat as builds and swarms grow', () => {
  for (const scenario of Object.values(BUILDS)) {
    const r = simulate(scenario);
    // Measured: 0.4-1.4 KB per message on average and under 2.7 KB at peak.
    assert(r.average < 2048, `${scenario.label}: ${r.average.toFixed(0)} B average`);
    assert(r.peak < 6144, `${scenario.label}: ${r.peak} B peak`);
    assert(r.legacy / r.average > 20, `${scenario.label}: only ${(r.legacy / r.average).toFixed(1)}x smaller than v1`);
  }
});

test('client projectiles match the authority, including across lost deliveries', () => {
  for (const scenario of Object.values(BUILDS)) {
    assert(simulate(scenario, { check: true }).worst < .5, scenario.label);
    const lossy = simulate(scenario, { check: true, seconds: 12, drop: n => n % 11 === 0 });
    assert(lossy.recoveries > 0, 'a lost journal batch led to a resync');
    assert(lossy.worst < .5, scenario.label + ' with loss');
  }
});

test('a missing journal batch is detected instead of silently diverging', () => {
  const r = pilotRoom();
  r.room.fire(r.pilot);
  r.publish(); // lost
  r.room.fire(r.pilot);
  assert.equal(r.world.rel(r.publish().rel), false);
  assert.equal(r.world.synced, false);
});

test('input frames survive encoding, and malformed batches are rejected', () => {
  const frames = [
    { seq: 41, input: { left: true, right: false, up: false, down: false, fire: true } },
    { seq: 42, input: { left: false, right: true, up: true, down: true, fire: false } },
  ];
  assert.deepEqual(decodeFrames(JSON.parse(JSON.stringify(encodeFrames(3, frames)))), { epoch: 3, frames });
  for (const bad of [{ seq: 1, inputs: [32] }, { seq: 1, inputs: [1.5] }, { seq: 1.5, inputs: [1] }, { seq: 1, inputs: Array(13).fill(0) }, { seq: 1, inputs: 'x' }]) {
    assert.equal(decodeFrames(bad), null, JSON.stringify(bad));
  }
});

// 0.2 s, the default fire rate, is exactly 12 frames: the authority's cooldown ends a hair above zero,
// so any mismatch in how the two sides count it moves the predicted shot by a frame.
test('local fire prediction matches the authority volley for volley at any latency', () => {
  for (let latency = 0; latency <= 6; latency++) {
    const r = pilotRoom(), toServer = [], toClient = [], predicted = [], fired = [];
    let pending = [], ship = shipOf(r.world);
    for (let seq = 1; seq <= 600; seq++) {
      const input = { fire: seq % 200 < 150 };
      pending.push({ seq, input });
      if (stepShip(ship, input)) predicted.push(seq);
      toServer.push({ at: seq + latency, frame: { seq, input } });
      while (toServer[0]?.at <= seq) r.room.frames(r.pilot.id, [toServer.shift().frame], r.room.epoch);
      r.room.tick(STEP);
      if (seq % 2) continue;
      fired.push(...fireSeqs(r.room));
      toClient.push({ at: seq + latency, ...r.publish() });
      while (toClient[0]?.at <= seq) {
        const { rel, state } = toClient.shift();
        if (rel) r.world.rel(rel);
        if (!state || !r.world.state(state)) continue;
        const mine = r.world.view().players[0];
        pending = pending.filter(f => f.seq > mine.ack);
        ship = reconcile(mine, pending);
      }
    }
    assert(fired.length > 30);
    assert.deepEqual(predicted.filter(seq => seq <= fired.at(-1)), fired, `latency ${latency} frames`);
  }
});

test('a confirmed prediction takes the authority ids instead of doubling the volley', () => {
  const r = pilotRoom(), ship = shipOf(r.world);
  assert(stepShip(ship, { fire: true }));
  r.world.predict(1, ship, r.room.tickId + 1);
  const { rel, state } = play(r, 1, { fire: true });
  r.world.rel(rel);
  r.world.state(state);
  assert.equal(r.world.predicted.size, 0);
  assert.deepEqual([...r.world.bullets.keys()].sort(), r.room.bullets.map(b => b.id).sort());
});

test('a mispredicted volley disappears once the authority is past it', () => {
  const r = pilotRoom();
  r.world.predict(1, shipOf(r.world), r.room.tickId); // the authority will see frame 1 without fire
  for (let seq = 1; seq <= 1 + CLAIM_WINDOW; seq++) {
    const { rel, state } = play(r, seq, {});
    if (rel) r.world.rel(rel);
    if (state) r.world.state(state);
  }
  assert.equal(r.world.bullets.size, 0);
});

test('a prediction survives while its journal batch is still in flight (WebRTC)', () => {
  const r = pilotRoom(), ship = shipOf(r.world), held = [];
  stepShip(ship, { fire: true });
  r.world.predict(1, ship, r.room.tickId + 1);
  // The unordered state channel keeps delivering while the reliable channel holds the batches back.
  for (let seq = 1; seq <= 20; seq++) {
    const { rel, state } = play(r, seq, { fire: seq === 1 });
    if (rel) held.push(rel);
    if (state) r.world.state(state);
  }
  assert.equal(r.world.predicted.size, 1);
  for (const rel of held) assert(r.world.rel(rel));
  assert.equal(r.world.predicted.size, 0);
  assert(r.room.bullets.every(b => r.world.bullets.has(b.id)));
});

test('network clock never runs backwards and widens its buffer under jitter', () => {
  const steady = new NetClock(), jittery = new NetClock();
  let interp = -Infinity, own = -Infinity;
  for (let i = 0; i < 300; i++) {
    const sent = i * 1000 / 30;
    steady.observe(i * 2, sent + 40);
    jittery.observe(i * 2, sent + 40 + (i % 3 ? 0 : 45));
    const now = sent + 45;
    assert(jittery.interp(now) >= interp && jittery.own(now, 6) >= own);
    interp = jittery.interp(now);
    own = jittery.own(now, 6);
  }
  assert(jittery.buffer > steady.buffer + 1, `buffer ${jittery.buffer.toFixed(2)} vs ${steady.buffer.toFixed(2)}`);
  // Lobby roster updates repeat the last tick ever later; that is not lag.
  const buffer = steady.buffer;
  for (let i = 0; i < 50; i++) steady.observe(598, 20000 + i * 100);
  assert.equal(steady.buffer, buffer);
});

// A MatchClient wired to a Match through a message queue, with a controllable clock.
function wiredClient(room, pilot, latencyMs) {
  const match = new Match(room), ticker = new Ticker(() => room.tick(STEP), () => match.publish()), inbox = [];
  const net = { now: 0, sent: [] };
  net.client = new MatchClient(m => { net.sent.push(m); if (m.type !== 'ping') applyCommand(room, pilot.id, m); });
  net.client.joined(pilot.id);
  match.add({ deliver(out, full) { for (const m of full ? [out.sync] : [out.rel, out.state]) if (m) inbox.push({ at: net.now + latencyMs, m }); return true; } });
  net.run = (ms, input) => {
    for (const end = net.now + ms; net.now < end; net.now += 1000 / 60) {
      ticker.advance(net.now);
      while (inbox[0]?.at <= net.now) net.client.receive(inbox.shift().m, net.now);
      net.client.update(1 / 60, input, net.now);
    }
  };
  net.match = match;
  net.inbox = inbox;
  return net;
}

test('input does not start before the new epoch\'s state when the roster arrives first (WebRTC)', () => {
  const room = new Room('EPOCH'), pilot = room.add('A'), net = wiredClient(room, pilot, 0);
  net.run(100, { right: true });
  room.start(pilot.id);
  net.match.publish();
  const [rel, state] = net.inbox.splice(0).map(d => d.m);
  net.client.receive(rel, net.now); // the reliable channel is first: the roster already says play
  net.client.update(1 / 30, { right: true }, net.now);
  assert(!net.sent.some(m => m.type === 'frames'), 'no frames for the old epoch');
  net.client.receive(state, net.now);
  net.client.update(1 / 30, { right: true }, net.now);
  const frames = net.sent.filter(m => m.type === 'frames');
  assert(frames.length > 0 && frames.every(f => f.epoch === room.epoch));
});

test('the own clock re-anchors when ticking resumes after an upgrade pause', () => {
  const room = new Room('PAUSE'), pilot = room.add('A'), net = wiredClient(room, pilot, 30);
  room.start(pilot.id);
  Object.assign(pilot, { hp: 999, max: 999 });
  net.run(2000, { right: true });
  room.salvage(); // sector cleared: the authority stops ticking for the upgrade screen
  net.run(700, null);
  room.choose(pilot.id, 0); // the last pilot chose: a new epoch starts
  net.run(300, { left: true });
  const ahead = net.client.ownTick(net.now) - net.client.world.latest.tick;
  assert(ahead < 15, `own clock ${ahead.toFixed(1)} ticks ahead of the newest state`);
});

function socket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    ws.once('error', reject);
    ws.once('open', () => resolve({
      ws, messages,
      send: m => ws.send(JSON.stringify(m)),
      count: type => messages.filter(m => m.type === type).length,
      async wait(fn) {
        for (const start = Date.now(); Date.now() - start < 2500; await new Promise(r => setTimeout(r, 10))) {
          const m = messages.find(fn);
          if (m) return m;
        }
        throw Error('Timed out waiting for message');
      },
    }));
  });
}

test('server rejects out-of-date clients and answers a resync request with a full sync', async () => {
  const app = createGameServer();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + app.server.address().port;
  try {
    const old = await socket(url);
    old.send({ type: 'create', name: 'Old' });
    assert.match((await old.wait(m => m.type === 'error')).message, /out of date/);
    const pilot = await socket(url);
    pilot.send({ type: 'create', name: 'New', v: PROTOCOL });
    assert.equal((await pilot.wait(m => m.type === 'joined')).v, PROTOCOL);
    await pilot.wait(m => m.type === 'sync');
    pilot.send({ type: 'resync' });
    await pilot.wait(() => pilot.count('sync') === 2);
    for (const s of [old, pilot]) s.ws.close();
  } finally {
    await app.close();
  }
});

// A host PeerSession with one guest whose data channels are fakes recording what was sent on them.
async function hostWithGuest() {
  const host = new PeerSession(() => {}, () => {}, () => {});
  await host.message({ type: 'peer-ready', peer: 'H', host: 'H', code: 'PABCDE' });
  const channel = () => ({ readyState: 'open', bufferedAmount: 0, sent: [], send(text) { this.sent.push(JSON.parse(text).type); } });
  const guest = host.track('G', { close() {} });
  Object.assign(guest, { control: channel(), state: channel() });
  host.command(guest, { type: 'hello', name: 'Guest', v: PROTOCOL });
  return { host, guest };
}

test('direct mode: a dropped signaling socket does not remove a pilot whose data channel is open', async () => {
  const { host, guest } = await hostWithGuest();
  await host.message({ type: 'peer-left', peer: 'G' });
  assert.equal(host.match.room.players.length, 2);
  guest.control.readyState = 'closed';
  await host.message({ type: 'peer-left', peer: 'G' });
  assert.equal(host.match.room.players.length, 1);
  host.close();

  const failures = [], guestSide = new PeerSession(() => {}, () => {}, m => failures.push(m));
  await guestSide.message({ type: 'peer-ready', peer: 'G', host: 'H', code: 'PABCDE' });
  const link = guestSide.track('H', { close() {} });
  link.control = { readyState: 'open' };
  await guestSide.message({ type: 'peer-ended', message: 'Host left.' });
  assert.deepEqual(failures, []);
  link.control.readyState = 'closed';
  await guestSide.message({ type: 'peer-ended', message: 'Host left.' });
  assert.deepEqual(failures, ['Host left.']);
  guestSide.close();
});

// With ticks frozen in the lobby, the state carrying a new pilot's ship is the only one sent.
test('direct mode: a roster change travels with its state on the reliable channel', async () => {
  const { host, guest } = await hostWithGuest();
  assert.deepEqual(guest.control.sent, ['joined', 'sync']);
  guest.control.sent = [];
  host.command(host.track('B', { close() {} }), { type: 'hello', name: 'Second', v: PROTOCOL });
  assert.deepEqual(guest.control.sent, ['rel', 'state']);
  assert.deepEqual(guest.state.sent, []);
  host.send({ type: 'start' });
  host.match.publish();
  guest.control.sent = [];
  host.match.room.tick(STEP);
  host.match.publish();
  assert.deepEqual(guest.state.sent, ['state'], 'ordinary play states stay on the unreliable channel');
  host.close();
});
