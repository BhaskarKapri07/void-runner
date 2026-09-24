// Measures what a four-pilot fight costs on the wire and checks that a client fed through the real
// Match reconstructs the authority's projectiles. Run with `npm run bench:net`.
import { fileURLToPath } from 'node:url';
import { Room } from '../shared/engine.js';
import { STEP, SNAPSHOT_TICKS, bulletAlive, shotAlive } from '../shared/netcode.js';
import { Match } from '../shared/match.js';
import { ClientWorld, projectileAt } from '../shared/world.js';

export const BUILDS = {
  fresh: { label: 'Wave 1, no upgrades', wave: 1, build: {} },
  mid: { label: 'Wave 8, mid build', wave: 8, build: { spread: 5, rate: .13, pierce: 1 } },
  late: { label: 'Wave 14, all-offense build', wave: 14, build: { spread: 9, rate: .06, pierce: 2, blast: 1.4 } },
  swarm: { label: 'Wave 20, no upgrades (swarm)', wave: 20, build: {} },
};

// Protocol v1 sent every entity plus the last 160 effects in every snapshot. Rebuilt here only so the
// benchmark reports before and after from the same simulation.
class LegacySnapshot {
  constructor() { this.effects = []; this.serial = 0; }
  bytes(room) {
    for (const e of room.log) {
      if (e.kind !== 'burst' && e.kind !== 'hit') continue;
      this.effects.push({ id: ++this.serial, ...e });
      if (this.effects.length > 160) this.effects.shift();
    }
    const players = room.players.map(({ input, lastInput, queue, budget, lastSeq, commands, ...p }) => p);
    return JSON.stringify({ type: 'state', tick: room.tickId, epoch: room.epoch, code: room.code, host: room.host, phase: room.phase, wave: room.wave, score: room.score, time: room.time,
      players, enemies: room.enemies, bullets: room.bullets.map(({ hit, ...b }) => b), shots: room.shots, events: this.effects }).length;
  }
}

// Math.random drives spawns and aim; a fixed sequence keeps budgets and assertions stable.
function withSeed(seed, run) {
  const random = Math.random;
  Math.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  try { return run(); } finally { Math.random = random; }
}

// Runs `seconds` of four immortal pilots holding fire while strafing. `drop(n)` loses the n-th
// delivery the way a backed-up socket skips a send; the Match must then resync the client.
export function simulate({ wave, build }, { seconds = 20, seed = 7, check = false, drop = null } = {}) {
  return withSeed(seed, () => {
    const room = new Room('BENCH1'), players = [0, 1, 2, 3].map(i => room.add('P' + i));
    room.start(room.host);
    room.wave = wave;
    for (const p of players) Object.assign(p, build, { hp: 999, max: 999 });
    const match = new Match(room), world = new ClientWorld(), legacy = new LegacySnapshot();
    const stats = { bytes: 0, messages: 0, peak: 0, syncs: 0, legacy: 0, enemies: 0, publishes: 0, worst: 0 };
    let behind = false; // a journal batch was lost and the resync hasn't arrived yet
    world.setMe(players[0].id);
    match.add({
      deliver(out, full) {
        if (full) { stats.syncs++; behind = false; world.sync(out.sync); return true; }
        const bytes = out.json('combined').length;
        stats.bytes += bytes;
        stats.peak = Math.max(stats.peak, bytes);
        stats.messages++;
        if (drop?.(stats.messages)) { behind ||= !!out.rel; return false; }
        if (out.rel && !world.rel(out.rel)) throw Error('journal gap on an in-order stream');
        if (out.state) world.state(out.state);
        return true;
      },
    });
    for (let tick = 1; tick <= seconds * 60; tick++) {
      for (const p of players) room.frames(p.id, [{ seq: tick, input: { fire: true, left: tick % 120 < 60, right: tick % 120 >= 60 } }], room.epoch);
      room.tick(STEP);
      // Keep the sector going and the pilots alive so the build stays under steady fire.
      room.spawned = 0;
      for (const p of players) { p.hp = 999; p.inv = 5; }
      if (tick % SNAPSHOT_TICKS) continue;
      stats.legacy += legacy.bytes(room); // reads the journal before the publish drains it
      stats.enemies += room.enemies.length;
      stats.publishes++;
      match.publish();
      if (check && !behind) stats.worst = Math.max(stats.worst, divergence(room, world));
    }
    return { average: stats.bytes / stats.messages, peak: stats.peak, legacy: stats.legacy / stats.publishes, enemies: stats.enemies / stats.publishes,
      worst: stats.worst, recoveries: stats.syncs - 1, bullets: room.bullets.length, shots: room.shots.length };
  });
}

// Largest distance between an authority projectile and the client's computed one at the current tick.
// A missing projectile counts as infinite; an extra one must be leaving the arena, which the authority
// culls without journaling (one tick of slack covers float rounding exactly on the edge).
export function divergence(room, world) {
  const tick = room.tickId;
  const compare = (authority, store, alive) => {
    let worst = 0;
    for (const a of authority) {
      const p = store.get(a.id);
      if (!p) return Infinity;
      const at = projectileAt(p, tick);
      worst = Math.max(worst, Math.hypot(at.x - a.x, at.y - a.y));
    }
    const live = new Set(authority.map(a => a.id));
    for (const p of store.values()) {
      if (live.has(p.id)) continue;
      const at = projectileAt(p, tick + 1);
      if (alive(at.x, at.y)) return Infinity;
    }
    return worst;
  };
  return Math.max(compare(room.bullets, world.bullets, bulletAlive), compare(room.shots, world.shots, shotAlive));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kb = bytes => (bytes / 1024).toFixed(2).padStart(6) + ' KB';
  const mbit = bytes => (bytes * 60 / SNAPSHOT_TICKS * 8 / 1e6).toFixed(2).padStart(5) + ' Mbit/s';
  for (const scenario of Object.values(BUILDS)) {
    const r = simulate(scenario, { check: true });
    console.log(`${scenario.label.padEnd(30)} before ${kb(r.legacy)} ${mbit(r.legacy)} | after ${kb(r.average)} ${mbit(r.average)} peak ${kb(r.peak)} | ${(r.legacy / r.average).toFixed(0).padStart(3)}x smaller | ${r.enemies.toFixed(1)} enemies avg | max error ${r.worst.toFixed(2)} px`);
  }
}
