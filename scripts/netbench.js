// Measures bytes per publish for a four-pilot fight and checks that a client fed those messages
// reconstructs the authority's projectiles. Run with `npm run bench:net`.
import { fileURLToPath } from 'node:url';
import { Room } from '../shared/engine.js';
import { STEP, SNAPSHOT_TICKS, bulletAlive, shotAlive } from '../shared/netcode.js';
import { Broadcaster, ClientWorld } from '../shared/protocol.js';

export const BUILDS = {
  fresh: { label: 'Wave 1, no upgrades', wave: 1, build: {} },
  mid: { label: 'Wave 8, mid build', wave: 8, build: { spread: 5, rate: .13, pierce: 1 } },
  late: { label: 'Wave 14, all-offense build', wave: 14, build: { spread: 9, rate: .06, pierce: 2, blast: 1.4 } },
  swarm: { label: 'Wave 20, no upgrades (swarm)', wave: 20, build: {} },
};

// The pre-v2 wire format: every entity and the last 160 effects, 30 times a second. Kept only
// so the benchmark can report before and after from the same simulation.
function legacySnapshot(room, effects) {
  return { type: 'state', tick: room.tickId, epoch: room.epoch, code: room.code, host: room.host, phase: room.phase, wave: room.wave, score: room.score, time: room.time,
    players: room.players.map(({ input, lastInput, queue, budget, lastSeq, commands, ...p }) => p), enemies: room.enemies, bullets: room.bullets.map(({ hit, ...b }) => b), shots: room.shots, events: effects };
}

// Deterministic pseudo-random source so budgets and assertions are stable across runs.
function seeded(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

export function simulate({ wave, build }, { seconds = 20, seed = 7, check = false, drop = null } = {}) {
  const random = Math.random;
  Math.random = seeded(seed);
  try {
    const room = new Room('BENCH1'), players = [0, 1, 2, 3].map(i => room.add('P' + i));
    room.start(room.host);
    room.wave = wave;
    for (const p of players) { Object.assign(p, build); p.hp = p.max = 999; }
    const broadcaster = new Broadcaster(room), world = new ClientWorld(), seqs = new Map(players.map(p => [p.id, 0]));
    world.setMe(players[0].id);
    world.sync(broadcaster.sync());
    let total = 0, peak = 0, count = 0, worst = 0, resyncs = 0, legacy = 0, serial = 0, enemies = 0, needSync = false;
    const effects = [];
    for (let t = 1; t <= seconds * 60; t++) {
      for (const p of players) {
        const seq = seqs.get(p.id) + 1;
        seqs.set(p.id, seq);
        room.frames(p.id, [{ seq, input: { fire: true, left: t % 120 < 60, right: t % 120 >= 60 } }], room.epoch);
      }
      room.tick(STEP);
      // Keep the sector going so the build stays under steady fire.
      room.spawned = 0;
      for (const p of players) { p.hp = 999; p.inv = 5; }
      if (t % SNAPSHOT_TICKS) continue;
      for (const e of room.log) if (e.k === 'fx') { const { k, ...fx } = e; effects.push({ id: ++serial, ...fx }); if (effects.length > 160) effects.shift(); }
      legacy += JSON.stringify(legacySnapshot(room, effects)).length;
      enemies += room.enemies.length;
      const { rel, hot } = broadcaster.frame(), message = hot ? (rel ? { ...hot, r: rel } : hot) : rel;
      if (!message) continue;
      const bytes = JSON.stringify(message).length;
      total += bytes; count++; peak = Math.max(peak, bytes);
      // Like the servers: a message lost with a journal batch in it is replaced by a full sync.
      if (needSync) { needSync = false; resyncs++; world.sync(broadcaster.sync()); }
      else if (drop?.(count)) { needSync = !!rel; continue; }
      else {
        if (rel && !world.rel(rel)) throw Error('journal gap on an in-order stream');
        if (hot) world.state(hot);
      }
      if (check) worst = Math.max(worst, divergence(room, world));
    }
    return { average: total / count, peak, perSecond: total / count * 60 / SNAPSHOT_TICKS, legacy: legacy / count, enemies: enemies / count, worst, resyncs, bullets: room.bullets.length, shots: room.shots.length };
  } finally { Math.random = random; }
}

// Largest position error between the authority and the client's computed projectiles at the
// current tick. Missing projectiles count as infinite error; extras must be ones the authority
// culled for leaving the arena (one tick of slack covers float rounding exactly on the edge).
export function divergence(room, world) {
  const tick = room.tickId;
  let worst = 0;
  const compare = (list, store, alive) => {
    const live = new Set();
    for (const a of list) {
      live.add(a.id);
      const b = store.get(a.id);
      if (!b) return Infinity;
      const k = (tick - b.t) * STEP;
      worst = Math.max(worst, Math.hypot(b.x + b.vx * k - a.x, b.y + b.vy * k - a.y));
    }
    for (const b of store.values()) {
      if (live.has(b.id)) continue;
      const k = (tick + 1 - b.t) * STEP;
      if (alive(b.x + b.vx * k, b.y + b.vy * k)) return Infinity;
    }
    return worst;
  };
  return Math.max(compare(room.bullets, world.bullets, bulletAlive), compare(room.shots, world.shots, shotAlive));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const scenario of Object.values(BUILDS)) {
    const r = simulate(scenario, { check: true });
    const kb = v => (v / 1024).toFixed(2).padStart(6) + ' KB', mbit = v => (v * 60 / SNAPSHOT_TICKS * 8 / 1e6).toFixed(2).padStart(5) + ' Mbit/s';
    console.log(`${scenario.label.padEnd(30)} before ${kb(r.legacy)} ${mbit(r.legacy)} | after ${kb(r.average)} ${mbit(r.average)} peak ${kb(r.peak)} | ${(r.legacy / r.average).toFixed(0).padStart(3)}x smaller | ${r.enemies.toFixed(1)} enemies avg | max error ${r.worst.toFixed(2)} px`);
  }
}
