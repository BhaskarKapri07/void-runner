import { STEP, SNAPSHOT_TICKS, COLORS, bulletAlive, shotAlive, volleyVelocity, shotVelocity } from './netcode.js';
// Wire format v2. The authority sends two kinds of messages:
//   rel    reliable, ordered, sent exactly once: projectile spawns and removals, effects, roster changes
//   state  latest-only: ships, enemies, score. Losing one is harmless.
// Projectiles fly in straight lines, so clients compute their positions instead of receiving them
// every snapshot. A client that misses a rel batch asks for a full sync.
export const PROTOCOL = 2;
const FIRE = 0, VOLLEY = 1, GONE = 2, CLEAR = 3, BURST = 4, HIT = 5;
const FX_COLORS = [...COLORS, '#ff9b65', '#ffbf68'];
const ENEMY_TYPES = ['scout', 'tank', 'boss'];
const INPUT_KEYS = ['left', 'right', 'up', 'down', 'fire'];
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 1e4) / 1e4;
const slotOf = color => Math.max(0, COLORS.indexOf(color));
const colorCode = color => { const i = FX_COLORS.indexOf(color); return i < 0 ? color : i; };

// Input frames travel as one bitmask per frame; sequence numbers are consecutive within a batch.
export function encodeFrames(epoch, frames) {
  return { type: 'frames', e: epoch, s: frames[0].seq, i: frames.map(f => INPUT_KEYS.reduce((bits, key, n) => f.input[key] ? bits | 1 << n : bits, 0)) };
}
export function decodeFrames(m) {
  if (!Number.isSafeInteger(m.s) || !Array.isArray(m.i) || m.i.length > 12) return null;
  const frames = [];
  for (let n = 0; n < m.i.length; n++) {
    const bits = m.i[n];
    if (!Number.isInteger(bits) || bits < 0 || bits > 31) return null;
    const input = {};
    for (let b = 0; b < INPUT_KEYS.length; b++) input[INPUT_KEYS[b]] = (bits >> b & 1) === 1;
    frames.push({ seq: m.s + n, input });
  }
  return { epoch: m.e, frames };
}

function encodeMeta(room) {
  return { code: room.code, host: room.host, phase: room.phase, wave: room.wave, epoch: room.epoch,
    players: room.players.map(p => ({ id: p.id, slot: p.slot, name: p.name, max: p.max, speed: p.speed, rate: p.rate, damage: p.damage, spread: p.spread, pierce: p.pierce, blast: p.blast, mods: p.mods, offers: p.offers, chosen: p.chosen })) };
}
// `q` is the journal batch this state follows. `cool` goes unrounded: at 0.2 s (exactly 12 frames) the
// authority's cooldown ends a hair above zero, and any rounding moves the predicted shot by a frame.
function encodeState(room, q) {
  return { type: 'state', t: room.tickId, e: room.epoch, q, s: room.score, tm: r1(room.time),
    p: room.players.map(p => [p.slot, r1(p.x), r1(p.y), p.hp, r2(Math.max(0, p.inv)), r2(p.revive), p.ack, Math.max(0, p.cool)]),
    n: room.enemies.map(e => e.type === 'boss' ? [e.id, 2, r1(e.x), r1(e.y), r1(e.hp), r1(e.max)] : [e.id, e.type === 'tank' ? 1 : 0, r1(e.x), r1(e.y)]) };
}
function encodeEntries(entries) {
  const out = [];
  for (const e of entries) {
    if (e.k === 'fire') out.push([FIRE, e.slot, r1(e.x), r1(e.y), e.t, e.n, e.id, e.seq]);
    else if (e.k === 'volley') out.push([VOLLEY, r1(e.x), r1(e.y), r4(e.a), e.n, e.speed, e.t, e.id]);
    else if (e.k === 'gone') { const last = out.at(-1); if (last?.[0] === GONE) last.push(e.id); else out.push([GONE, e.id]); }
    else if (e.k === 'clear') out.push([CLEAR, (e.bullets ? 1 : 0) | (e.shots ? 2 : 0)]);
    // Hits are drawn on the target, so they need no position of their own.
    else if (e.k === 'fx') out.push(e.kind === 'hit' ? [HIT, e.target, slotOf(e.color), r1(e.damage)] : [BURST, Math.round(e.x), Math.round(e.y), colorCode(e.color), e.n]);
  }
  return out;
}

// One per room. Every client receives the same bytes, so each message is encoded once per publish.
export class Broadcaster {
  constructor(room) { this.room = room; this.q = 0; this.metaKey = ''; this.tick = -1; }
  frame() {
    const room = this.room, entries = room.log.splice(0), resync = room.logDropped;
    room.logDropped = false;
    const meta = encodeMeta(room), key = JSON.stringify(meta);
    let rel = null;
    if (entries.length || key !== this.metaKey) {
      rel = { type: 'rel', q: ++this.q, l: encodeEntries(entries) };
      if (key !== this.metaKey) { rel.meta = meta; this.metaKey = key; }
    }
    const hot = rel || room.tickId !== this.tick ? encodeState(room, this.q) : null;
    this.tick = room.tickId;
    return { rel, hot, resync };
  }
  // Full state for a joining or recovering client. Call after frame() in the same publish.
  sync() {
    const room = this.room;
    return { type: 'sync', q: this.q, meta: encodeMeta(room), state: encodeState(room, this.q),
      b: room.bullets.map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), slotOf(b.color)]),
      s: room.shots.map(s => [s.id, r1(s.x), r1(s.y), r1(s.vx), r1(s.vy)]) };
  }
}

// Client-side mirror of the match. Projectiles are stored as {x, y, vx, vy, t}: their position at
// the end of tick t plus a per-second velocity.
export class ClientWorld {
  constructor() { this.me = null; this.reset(); }
  reset() {
    Object.assign(this, { synced: false, q: 0, meta: null, latest: null, mark: null, slot: -1, bullets: new Map(), shots: new Map(), enemies: new Map(), fallen: new Map(), predicted: new Map() });
  }
  setMe(id) { this.me = id; if (this.meta) this.setMeta(this.meta); }
  setMeta(meta) { this.meta = meta; this.slot = meta.players.find(p => p.id === this.me)?.slot ?? -1; }
  sync(m) {
    this.reset();
    this.setMeta(m.meta);
    this.q = m.q;
    this.synced = true;
    const t = m.state.t;
    for (const [id, x, y, vx, vy, slot] of m.b) this.bullets.set(id, { id, x, y, vx, vy, t, slot });
    for (const [id, x, y, vx, vy] of m.s) this.shots.set(id, { id, x, y, vx, vy, t });
    this.state(m.state);
  }
  // Returns false when a batch is missing; the caller must request a sync.
  rel(m, fx) {
    if (!this.synced) return true;
    if (m.q !== this.q + 1) { this.synced = false; return false; }
    this.q = m.q;
    if (m.meta) this.setMeta(m.meta);
    for (const e of m.l) this.entry(e, fx);
    this.expire();
    return true;
  }
  entry(e, fx) {
    const kind = e[0];
    if (kind === FIRE) {
      const [, slot, sx, sy, t, n, id, seq] = e, guess = slot === this.slot ? this.claim(seq, n) : null;
      for (let i = 0; i < n; i++) {
        let b = guess?.[i];
        if (b) b.id = id + i;
        else { const [vx, vy] = volleyVelocity(i, n); b = { id: id + i, x: sx + vx * STEP, y: sy + vy * STEP, vx, vy, t, slot }; }
        this.bullets.set(b.id, b);
      }
    } else if (kind === VOLLEY) {
      const [, sx, sy, a, n, speed, t, id] = e;
      for (let i = 0; i < n; i++) { const [vx, vy] = shotVelocity(a, i, n, speed); this.shots.set(id + i, { id: id + i, x: sx + vx * STEP, y: sy + vy * STEP, vx, vy, t }); }
    } else if (kind === GONE) {
      for (let i = 1; i < e.length; i++) if (!this.bullets.delete(e[i])) this.shots.delete(e[i]);
    } else if (kind === CLEAR) {
      if (e[1] & 1) { this.bullets.clear(); this.predicted.clear(); }
      if (e[1] & 2) this.shots.clear();
    } else if (kind === BURST) fx?.({ kind: 'burst', x: e[1], y: e[2], color: typeof e[3] === 'number' ? FX_COLORS[e[3]] : e[3], n: e[4] });
    else if (kind === HIT) fx?.({ kind: 'hit', target: e[1], slot: e[2], color: COLORS[e[2]], damage: e[3] });
  }
  state(h) {
    if (!this.synced || (this.latest && h.t < this.latest.t)) return false;
    const seen = new Set();
    for (const [id, type, x, y, hp, max] of h.n) {
      seen.add(id);
      const e = this.enemies.get(id);
      if (!e) this.enemies.set(id, { id, type: ENEMY_TYPES[type], x, y, t: h.t, vx: 0, vy: 0, hp, max });
      else {
        if (h.t > e.t) { e.vx = (x - e.x) / (h.t - e.t); e.vy = (y - e.y) / (h.t - e.t); e.t = h.t; }
        Object.assign(e, { x, y, hp, max });
      }
    }
    for (const [id, e] of this.enemies) if (!seen.has(id)) { this.enemies.delete(id); e.gone = h.t; this.fallen.set(id, e); }
    for (const [id, e] of this.fallen) if (h.t - e.gone > 60) this.fallen.delete(id);
    // Cull well behind every render clock so memory stays bounded even when nothing is drawn.
    const cull = h.t - 20;
    for (const [id, b] of this.bullets) { const k = (cull - b.t) * STEP; if (k >= 0 && !bulletAlive(b.x + b.vx * k, b.y + b.vy * k)) this.bullets.delete(id); }
    for (const [id, s] of this.shots) { const k = (cull - s.t) * STEP; if (k >= 0 && !shotAlive(s.x + s.vx * k, s.y + s.vy * k)) this.shots.delete(id); }
    this.latest = h;
    const mine = h.p.find(p => p[0] === this.slot);
    if (mine) this.mark = { ack: mine[6], q: h.q };
    this.expire();
    return true;
  }
  // A predicted volley is wrong once the authority has processed frames past it and every journal
  // batch up to that state has arrived. Waiting for the journal matters on WebRTC, where state can
  // overtake a delayed reliable batch. The margin covers claim()'s seq tolerance.
  expire() {
    const mark = this.mark;
    if (!mark || this.q < mark.q) return;
    for (const [seq, volley] of this.predicted) if (seq + 6 <= mark.ack) this.drop(seq, volley);
  }
  // Own volleys appear the moment the local frame fires; the authority's entry later adopts them.
  predict(seq, sx, sy, n, t) {
    const volley = [];
    for (let i = 0; i < n; i++) {
      const [vx, vy] = volleyVelocity(i, n), b = { id: -(seq * 16 + i + 1), x: sx + vx * STEP, y: sy + vy * STEP, vx, vy, t, slot: this.slot };
      this.bullets.set(b.id, b);
      volley.push(b);
    }
    this.predicted.set(seq, volley);
  }
  claim(seq, n) {
    let best = null, gap = 4;
    for (const [s, v] of this.predicted) { const d = Math.abs(s - seq); if (d < gap && v.length === n) { best = s; gap = d; } }
    if (best === null) return null;
    const volley = this.predicted.get(best);
    this.drop(best, volley);
    return volley;
  }
  drop(seq, volley) { this.predicted.delete(seq); for (const b of volley) this.bullets.delete(b.id); }
  clearPredictions() { for (const [seq, volley] of this.predicted) this.drop(seq, volley); }
  enemyAt(e, tick) {
    if (e.gone !== undefined) return { x: e.x, y: e.y };
    const k = Math.max(0, Math.min(30, tick - e.t));
    return { x: e.x + e.vx * k, y: e.y + e.vy * k };
  }
  locate(id, tick) { const e = this.enemies.get(id) ?? this.fallen.get(id); return e ? this.enemyAt(e, tick) : null; }
  view() {
    const h = this.latest, m = this.meta, ships = new Map(h.p.map(p => [p[0], p])), players = [];
    for (const p of m.players) {
      const s = ships.get(p.slot);
      if (s) players.push({ ...p, color: COLORS[p.slot], x: s[1], y: s[2], hp: s[3], inv: s[4], revive: s[5], ack: s[6], cool: s[7] });
    }
    return { tick: h.t, epoch: h.e, code: m.code, host: m.host, phase: m.phase, wave: m.wave, score: h.s, time: h.tm, players };
  }
}

// Maps local time (ms) to server ticks. `received` follows the earliest-arrival envelope,
// the interpolation buffer adapts to measured jitter, and `own` leads by the input pipeline
// so enemies and projectiles line up with the locally predicted ship.
export class NetClock {
  constructor() { this.offset = null; this.jitter = 1; this.buffer = SNAPSHOT_TICKS + 3; this.lead = null; this.last = -Infinity; this.floorInterp = -Infinity; this.floorOwn = -Infinity; }
  // Only advancing ticks are timing samples; repeats (lobby roster updates) say nothing about latency.
  observe(tick, now) {
    if (tick <= this.last) return;
    this.last = tick;
    const sample = tick - now * .06;
    if (this.offset === null || Math.abs(sample - this.offset) > 60) { this.offset = sample; this.floorInterp = this.floorOwn = -Infinity; return; }
    const late = Math.max(0, this.offset - sample);
    this.offset += (sample - this.offset) * (sample > this.offset ? .5 : .01);
    this.jitter += (late - this.jitter) * .05;
    this.buffer += (Math.min(15, Math.max(3, SNAPSHOT_TICKS + 1 + 2 * this.jitter)) - this.buffer) * .05;
  }
  // Ticks between the frame being generated now and the newest tick the server has shown us.
  observeLead(sample) { this.lead = this.lead === null ? sample : this.lead + (sample - this.lead) * .1; }
  received(now) { return now * .06 + this.offset; }
  interp(now) { return this.floorInterp = Math.max(this.floorInterp, this.received(now) - this.buffer); }
  own(now, fallback) { return this.floorOwn = Math.max(this.floorOwn, this.received(now) + (this.lead ?? fallback)); }
}
