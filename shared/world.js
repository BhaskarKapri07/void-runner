import { STEP, TICKS_PER_MS, SNAPSHOT_TICKS, COLORS, MUZZLE_OFFSET, clamp, bulletAlive, shotAlive, volleyVelocity, shotVelocity } from './netcode.js';
import { decodeShip, decodeEnemy, decodeEntry, decodeBullet, decodeShot } from './protocol.js';

// Input frames of slack when matching a predicted volley to the authority's.
export const CLAIM_WINDOW = 3;
// Ticks behind the newest state at which projectiles are culled: behind every render clock.
const CULL_LAG = 20;
// Ticks a removed enemy's last position is kept for hit effects that arrive after it.
const FALLEN_TICKS = 60;
// Ticks an enemy may be drawn beyond its newest sample.
const MAX_EXTRAPOLATION = 30;

// Projectiles fly in straight lines. Each is stored as its position at the end of tick `t` plus a
// per-second velocity, which gives its position at any tick.
export function projectileAt(p, tick) {
  const k = (tick - p.t) * STEP;
  return { x: p.x + p.vx * k, y: p.y + p.vy * k };
}
// A projectile spawned at `origin` during tick `origin.tick`; it moves once in that tick, like the engine's.
const launched = (id, origin, vx, vy) => ({ id, x: origin.x + vx * STEP, y: origin.y + vy * STEP, vx, vy, t: origin.tick });

function cullLeft(store, tick, alive) {
  for (const [id, p] of store) {
    if (tick < p.t) continue;
    const at = projectileAt(p, tick);
    if (!alive(at.x, at.y)) store.delete(id);
  }
}

// The client's mirror of a match, rebuilt from sync, journal batches and states.
export class ClientWorld {
  constructor() {
    this.me = null;
    this.reset();
  }
  reset() {
    Object.assign(this, { synced: false, batch: 0, meta: null, latest: null, slot: -1, mark: null, provisional: 0 });
    this.bullets = new Map();
    this.shots = new Map();
    this.enemies = new Map();
    this.fallen = new Map();
    this.predicted = new Map(); // input seq → provisional bullets of a locally predicted volley
  }
  setMe(id) {
    this.me = id;
    if (this.meta) this.setMeta(this.meta);
  }
  setMeta(meta) {
    this.meta = meta;
    this.slot = meta.players.find(p => p.id === this.me)?.slot ?? -1;
  }

  sync(m) {
    this.reset();
    this.setMeta(m.meta);
    this.batch = m.batch;
    this.synced = true;
    const t = m.state.tick;
    for (const raw of m.bullets) { const b = decodeBullet(raw); this.bullets.set(b.id, { ...b, t }); }
    for (const raw of m.shots) { const s = decodeShot(raw); this.shots.set(s.id, { ...s, t }); }
    this.state(m.state);
  }
  // Applies a journal batch. Returns false when a batch is missing; the caller must ask for a sync.
  rel(m, onEffect) {
    if (!this.synced) return true;
    if (m.batch !== this.batch + 1) {
      this.synced = false;
      return false;
    }
    this.batch = m.batch;
    if (m.meta) this.setMeta(m.meta);
    for (const raw of m.entries) this.apply(decodeEntry(raw), onEffect);
    this.expire();
    return true;
  }
  apply(e, onEffect) {
    if (e.kind === 'fire') this.addVolley(e);
    else if (e.kind === 'volley') {
      for (let i = 0; i < e.count; i++) this.shots.set(e.id + i, launched(e.id + i, e, ...shotVelocity(e.aim, i, e.count, e.speed)));
    } else if (e.kind === 'gone') {
      for (const id of e.ids) if (!this.bullets.delete(id)) this.shots.delete(id);
    } else if (e.kind === 'clear') {
      if (e.bullets) { this.bullets.clear(); this.predicted.clear(); }
      if (e.shots) this.shots.clear();
    } else onEffect?.(e);
  }
  // An authority volley. If it is ours and was predicted, the predicted bullets are already on
  // screen, so they keep flying and just take the authority's ids.
  addVolley(e) {
    const predicted = e.slot === this.slot ? this.claim(e) : null;
    for (let i = 0; i < e.count; i++) {
      const id = e.id + i;
      this.bullets.set(id, predicted ? { ...predicted[i], id } : { ...launched(id, e, ...volleyVelocity(i, e.count)), slot: e.slot });
    }
  }
  state(h) {
    if (!this.synced || (this.latest && h.tick < this.latest.tick)) return false;
    this.updateEnemies(h);
    // Culling here keeps memory bounded even when nothing is drawn (hidden tabs).
    cullLeft(this.bullets, h.tick - CULL_LAG, bulletAlive);
    cullLeft(this.shots, h.tick - CULL_LAG, shotAlive);
    this.latest = { tick: h.tick, epoch: h.epoch, batch: h.batch, score: h.score, time: h.time, ships: h.ships.map(decodeShip) };
    const mine = this.latest.ships.find(s => s.slot === this.slot);
    if (mine) this.mark = { ack: mine.ack, batch: h.batch };
    this.expire();
    return true;
  }
  updateEnemies(h) {
    const seen = new Set();
    for (const raw of h.enemies) {
      const next = decodeEnemy(raw), e = this.enemies.get(next.id);
      seen.add(next.id);
      if (!e) { this.enemies.set(next.id, { ...next, t: h.tick, vx: 0, vy: 0 }); continue; }
      // Velocity from the last two samples lets enemies be drawn ahead of the newest state.
      if (h.tick > e.t) {
        e.vx = (next.x - e.x) / (h.tick - e.t);
        e.vy = (next.y - e.y) / (h.tick - e.t);
        e.t = h.tick;
      }
      Object.assign(e, next);
    }
    for (const [id, e] of this.enemies) {
      if (seen.has(id)) continue;
      this.enemies.delete(id);
      e.gone = h.tick;
      this.fallen.set(id, e);
    }
    for (const [id, e] of this.fallen) if (h.tick - e.gone > FALLEN_TICKS) this.fallen.delete(id);
  }

  // Shows our volley the moment the local frame fires. `ship` is the predicted ship after that frame.
  predict(seq, ship, tick) {
    const origin = { x: ship.x, y: ship.y - MUZZLE_OFFSET, tick }, volley = [];
    for (let i = 0; i < ship.spread; i++) {
      const b = { ...launched(--this.provisional, origin, ...volleyVelocity(i, ship.spread)), slot: this.slot };
      this.bullets.set(b.id, b);
      volley.push(b);
    }
    this.predicted.set(seq, volley);
  }
  // The predicted volley closest in seq to an authority fire entry, removed from the predictions.
  claim({ seq, count }) {
    let best = null;
    for (const [s, volley] of this.predicted) {
      const gap = Math.abs(s - seq);
      if (volley.length === count && gap <= CLAIM_WINDOW && (best === null || gap < Math.abs(best - seq))) best = s;
    }
    if (best === null) return null;
    const volley = this.predicted.get(best);
    this.drop(best);
    return volley;
  }
  // A prediction is wrong once the authority has processed frames beyond the claim window and every
  // journal batch up to that state has arrived. On WebRTC a state can overtake a delayed batch.
  expire() {
    const mark = this.mark;
    if (!mark || this.batch < mark.batch) return;
    for (const seq of this.predicted.keys()) if (seq + CLAIM_WINDOW <= mark.ack) this.drop(seq);
  }
  drop(seq) {
    for (const b of this.predicted.get(seq)) this.bullets.delete(b.id);
    this.predicted.delete(seq);
  }
  clearPredictions() {
    for (const seq of this.predicted.keys()) this.drop(seq);
  }

  // Draw queries. Our own bullets and enemy shots are drawn on the own clock, other pilots' bullets on
  // the interpolation clock. A projectile that has left the arena at the tick it is drawn is gone for good.
  visibleBullets(own, interp) {
    const out = [];
    for (const [id, b] of this.bullets) {
      const tick = b.slot === this.slot ? own : interp;
      if (tick < b.t) continue; // not fired yet at the time it is drawn
      const at = projectileAt(b, tick);
      if (bulletAlive(at.x, at.y)) out.push({ ...at, color: COLORS[b.slot] });
      else this.bullets.delete(id);
    }
    return out;
  }
  visibleShots(own) {
    const out = [];
    for (const [id, s] of this.shots) {
      if (own < s.t) continue;
      const at = projectileAt(s, own);
      if (shotAlive(at.x, at.y)) out.push(at);
      else this.shots.delete(id);
    }
    return out;
  }
  enemiesAt(tick) {
    return [...this.enemies.values()].map(e => ({ ...e, ...this.enemyAt(e, tick) }));
  }
  enemyAt(e, tick) {
    if (e.gone !== undefined) return { x: e.x, y: e.y };
    const k = clamp(tick - e.t, 0, MAX_EXTRAPOLATION);
    return { x: e.x + e.vx * k, y: e.y + e.vy * k };
  }
  // Where an enemy is drawn at `tick`, including one removed moments ago; null if unknown.
  locate(id, tick) {
    const e = this.enemies.get(id) ?? this.fallen.get(id);
    return e ? this.enemyAt(e, tick) : null;
  }
  // Roster from meta merged with the newest ships. A pilot whose ship hasn't arrived yet is left out.
  view() {
    const { latest, meta } = this, ships = new Map(latest.ships.map(s => [s.slot, s]));
    const players = meta.players.filter(p => ships.has(p.slot)).map(p => ({ ...p, ...ships.get(p.slot), color: COLORS[p.slot] }));
    return { tick: latest.tick, epoch: latest.epoch, code: meta.code, host: meta.host, phase: meta.phase, wave: meta.wave, score: latest.score, time: latest.time, players };
  }
}

// Clock tuning, in ticks.
const REANCHOR_TICKS = 60;  // a sample this far off means the connection stalled; start over
const MIN_BUFFER = 3;
const MAX_BUFFER = 15;

// Maps local time (ms) to server ticks. `received` follows the earliest-arrival envelope of states,
// the interpolation buffer adapts to measured jitter, and `own` leads by the input pipeline so enemies
// and projectiles line up with the locally predicted ship. Both render clocks never run backwards.
export class NetClock {
  constructor(lead = null) {
    Object.assign(this, { offset: null, jitter: 1, buffer: SNAPSHOT_TICKS + 3, lead, last: -Infinity, floorInterp: -Infinity, floorOwn: -Infinity });
  }
  // Only advancing ticks are timing samples; repeats (lobby roster updates) say nothing about latency.
  observe(tick, now) {
    if (tick <= this.last) return;
    this.last = tick;
    const sample = tick - now * TICKS_PER_MS;
    if (this.offset === null || Math.abs(sample - this.offset) > REANCHOR_TICKS) {
      this.offset = sample;
      this.floorInterp = this.floorOwn = -Infinity;
      return;
    }
    const late = Math.max(0, this.offset - sample);
    // Early samples pull the envelope forward quickly; late ones drag it back slowly.
    this.offset += (sample - this.offset) * (sample > this.offset ? .5 : .01);
    this.jitter += (late - this.jitter) * .05;
    this.buffer += (clamp(SNAPSHOT_TICKS + 1 + 2 * this.jitter, MIN_BUFFER, MAX_BUFFER) - this.buffer) * .05;
  }
  // Ticks between the frame being generated now and the newest tick the server has shown us.
  observeLead(sample) {
    this.lead = this.lead === null ? sample : this.lead + (sample - this.lead) * .1;
  }
  received(now) { return now * TICKS_PER_MS + this.offset; }
  interp(now) { return this.floorInterp = Math.max(this.floorInterp, this.received(now) - this.buffer); }
  own(now, fallbackLead) { return this.floorOwn = Math.max(this.floorOwn, this.received(now) + (this.lead ?? fallbackLead)); }
}
