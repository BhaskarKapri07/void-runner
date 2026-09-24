import { COLORS, MAX_BATCH_FRAMES } from './netcode.js';

// Wire format, version 2.
//
// Authority → client
//   sync   { type, batch, meta, state, bullets, shots }   full state, on join and on recovery
//   rel    { type, batch, entries, meta? }                reliable, ordered, each batch sent once
//   state  { type, tick, epoch, batch, score, time, ships, enemies, rel? }
//          latest only; losing one is harmless. Over WebSocket the publish's `rel` rides inside it.
// Client → authority
//   frames { type, epoch, seq, inputs }   `inputs` holds one bitmask per frame, from `seq` upward
//   also ping, resync, start, choose, leave, and create/join/hello carrying `v: PROTOCOL`
//
// `batch` numbers journal batches: a state's batch is the last one sent before it, and a client
// that sees a gap asks for a sync. `meta` (roster, phase, upgrades) is only sent when it changes.
// High-volume records are positional arrays; each has exactly one encoder and one decoder below.
export const PROTOCOL = 2;

const INPUT_KEYS = ['left', 'right', 'up', 'down', 'fire'];
const ENEMY_TYPES = ['scout', 'tank', 'boss'];
const ENTRY = { fire: 0, volley: 1, gone: 2, clear: 3, burst: 4, hit: 5 };
const ENTRY_KINDS = Object.keys(ENTRY);
// Colors effects use, sent as an index; any other color is sent as its string.
const EFFECT_COLORS = [...COLORS, '#ff9b65', '#ffbf68'];

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const slotOf = color => Math.max(0, COLORS.indexOf(color));

// ship: [slot, x, y, hp, inv, revive, ack, cool]. `cool` stays unrounded: at 0.2 s (exactly 12 frames)
// the authority's cooldown ends a hair above zero, and rounding it moves the predicted shot by a frame.
const encodeShip = p => [p.slot, round(p.x, 1), round(p.y, 1), p.hp, round(Math.max(0, p.inv), 2), round(p.revive, 2), p.ack, Math.max(0, p.cool)];
export const decodeShip = ([slot, x, y, hp, inv, revive, ack, cool]) => ({ slot, x, y, hp, inv, revive, ack, cool });

// enemy: [id, type, x, y] plus [hp, max] for bosses, the only enemies whose health is drawn.
const encodeEnemy = e => {
  const base = [e.id, ENEMY_TYPES.indexOf(e.type), round(e.x, 1), round(e.y, 1)];
  return e.type === 'boss' ? [...base, round(e.hp, 1), round(e.max, 1)] : base;
};
export const decodeEnemy = ([id, type, x, y, hp, max]) => ({ id, type: ENEMY_TYPES[type], x, y, hp, max });

// Sync projectiles, at the sync's tick: bullet [id, x, y, vx, vy, slot], shot [id, x, y, vx, vy].
const encodeBullet = b => [b.id, round(b.x, 1), round(b.y, 1), round(b.vx, 1), round(b.vy, 1), slotOf(b.color)];
const encodeShot = s => [s.id, round(s.x, 1), round(s.y, 1), round(s.vx, 1), round(s.vy, 1)];
export const decodeBullet = ([id, x, y, vx, vy, slot]) => ({ id, x, y, vx, vy, slot });
export const decodeShot = ([id, x, y, vx, vy]) => ({ id, x, y, vx, vy });

// Journal entries (see Room.record for their meaning):
//   fire [0, slot, x, y, tick, count, id, seq]      volley [1, x, y, aim, count, speed, tick, id]
//   gone [2, ...ids]                                clear  [3, 1 bullets | 2 shots]
//   burst [4, x, y, color, count]                   hit    [5, target, slot, damage]
function encodeEntry(e) {
  switch (e.kind) {
    case 'fire': return [ENTRY.fire, e.slot, round(e.x, 1), round(e.y, 1), e.tick, e.count, e.id, e.seq];
    case 'volley': return [ENTRY.volley, round(e.x, 1), round(e.y, 1), round(e.aim, 4), e.count, e.speed, e.tick, e.id];
    case 'gone': return [ENTRY.gone, e.id];
    case 'clear': return [ENTRY.clear, (e.bullets ? 1 : 0) | (e.shots ? 2 : 0)];
    case 'burst': { const color = EFFECT_COLORS.indexOf(e.color); return [ENTRY.burst, Math.round(e.x), Math.round(e.y), color < 0 ? e.color : color, e.count]; }
    // A hit is drawn on its target, so it needs no position of its own.
    case 'hit': return [ENTRY.hit, e.target, slotOf(e.color), round(e.damage, 1)];
    default: throw Error('Unknown journal entry: ' + e.kind);
  }
}
export function decodeEntry(e) {
  switch (ENTRY_KINDS[e[0]]) {
    case 'fire': { const [, slot, x, y, tick, count, id, seq] = e; return { kind: 'fire', slot, x, y, tick, count, id, seq }; }
    case 'volley': { const [, x, y, aim, count, speed, tick, id] = e; return { kind: 'volley', x, y, aim, count, speed, tick, id }; }
    case 'gone': return { kind: 'gone', ids: e.slice(1) };
    case 'clear': return { kind: 'clear', bullets: (e[1] & 1) !== 0, shots: (e[1] & 2) !== 0 };
    case 'burst': return { kind: 'burst', x: e[1], y: e[2], color: typeof e[3] === 'number' ? EFFECT_COLORS[e[3]] : e[3], count: e[4] };
    case 'hit': return { kind: 'hit', target: e[1], slot: e[2], color: COLORS[e[2]], damage: e[3] };
    default: throw Error('Unknown journal entry: ' + e[0]);
  }
}
function encodeEntries(entries) {
  const out = [];
  for (const e of entries) {
    // Consecutive removals share one record.
    if (e.kind === 'gone' && out.at(-1)?.[0] === ENTRY.gone) out.at(-1).push(e.id);
    else out.push(encodeEntry(e));
  }
  return out;
}

const encodeInput = input => INPUT_KEYS.reduce((bits, key, i) => input[key] ? bits | 1 << i : bits, 0);
const decodeInput = bits => Object.fromEntries(INPUT_KEYS.map((key, i) => [key, (bits >> i & 1) === 1]));
const validInput = bits => Number.isInteger(bits) && bits >= 0 && bits < 1 << INPUT_KEYS.length;

// Frames in one batch have consecutive sequence numbers, so only the first is sent.
export function encodeFrames(epoch, frames) {
  return { type: 'frames', epoch, seq: frames[0].seq, inputs: frames.map(f => encodeInput(f.input)) };
}
// Returns null for anything malformed; frames come straight from untrusted clients.
export function decodeFrames(m) {
  if (!Number.isSafeInteger(m.seq) || !Array.isArray(m.inputs) || m.inputs.length > MAX_BATCH_FRAMES || !m.inputs.every(validInput)) return null;
  return { epoch: m.epoch, frames: m.inputs.map((bits, i) => ({ seq: m.seq + i, input: decodeInput(bits) })) };
}

function encodeMeta(room) {
  const players = room.players.map(({ id, slot, name, max, speed, rate, damage, spread, pierce, blast, mods, offers, chosen }) =>
    ({ id, slot, name, max, speed, rate, damage, spread, pierce, blast, mods, offers, chosen }));
  return { code: room.code, host: room.host, phase: room.phase, wave: room.wave, epoch: room.epoch, players };
}
function encodeState(room, batch) {
  return { type: 'state', tick: room.tickId, epoch: room.epoch, batch, score: room.score, time: round(room.time, 1),
    ships: room.players.map(encodeShip), enemies: room.enemies.map(encodeEnemy) };
}

// Encodes one room for the network. Every client receives the same messages.
export class Broadcaster {
  constructor(room) { this.room = room; this.batch = 0; this.metaKey = ''; this.tick = -1; }
  // Once per publish: the journal batch (null if nothing happened), the latest state (null if the
  // room hasn't changed), and whether journal overflow forces every client to resync.
  frame() {
    const { entries, dropped } = this.room.drain(), meta = encodeMeta(this.room), metaKey = JSON.stringify(meta);
    let rel = null;
    if (entries.length || metaKey !== this.metaKey) {
      rel = { type: 'rel', batch: ++this.batch, entries: encodeEntries(entries) };
      if (metaKey !== this.metaKey) { rel.meta = meta; this.metaKey = metaKey; }
    }
    const state = rel || this.room.tickId !== this.tick ? encodeState(this.room, this.batch) : null;
    this.tick = this.room.tickId;
    return { rel, state, resync: dropped };
  }
  // Full state for a joining or recovering client; call it after frame() in the same publish.
  sync() {
    const room = this.room;
    return { type: 'sync', batch: this.batch, meta: encodeMeta(room), state: encodeState(room, this.batch),
      bullets: room.bullets.map(encodeBullet), shots: room.shots.map(encodeShot) };
  }
}
