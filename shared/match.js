import { STEP, SNAPSHOT_TICKS } from './netcode.js';
import { Broadcaster, decodeFrames } from './protocol.js';

// Authority-side pieces shared by every host: the Node server and the Durable Object (through
// server/hub.js) and the browser host (peer.js).

// Seconds of simulation one late timer may catch up; beyond that the match slows instead.
const MAX_CATCH_UP = .1;

// One room and the clients watching it. A client is any object with
//   deliver(out, full) → boolean
// which sends either a full sync (full = true) or this publish's journal batch and state from `out`,
// and returns false if the journal batch could not be sent. That client gets a sync next publish.
export class Match {
  constructor(room) {
    this.room = room;
    this.broadcaster = new Broadcaster(room);
    this.clients = new Set();
  }
  add(client) {
    client.needSync = true;
    this.clients.add(client);
  }
  remove(client) {
    this.clients.delete(client);
  }
  publish() {
    const out = new Outbox(this.broadcaster);
    for (const client of this.clients) {
      if (client.needSync || out.resync) client.needSync = !client.deliver(out, true);
      else if (!out.empty && !client.deliver(out, false) && out.rel) client.needSync = true;
    }
  }
}

// What one publish sends. Each encoding is built at most once and shared by every client.
export class Outbox {
  constructor(broadcaster) {
    Object.assign(this, broadcaster.frame());
    this.broadcaster = broadcaster;
    this.cache = new Map();
  }
  get empty() { return !this.rel && !this.state; }
  get sync() { return this.memo('sync', () => this.broadcaster.sync()); }
  // Over WebSocket the journal batch rides inside the state message.
  get combined() { return this.state ? (this.rel ? { ...this.state, rel: this.rel } : this.state) : this.rel; }
  // JSON for 'sync', 'rel', 'state' or 'combined'.
  json(part) { return this.memo('json:' + part, () => JSON.stringify(this[part])); }
  memo(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }
}

// Turns wall-clock time into fixed simulation steps and publishes after every SNAPSHOT_TICKS
// steps, so snapshots stay evenly spaced in ticks even when a late timer runs several steps.
export class Ticker {
  constructor(step, publish) {
    this.step = step;
    this.publish = publish;
    this.reset();
  }
  reset() {
    this.last = null;
    this.carry = 0;
    this.steps = 0;
  }
  advance(now) {
    this.carry += Math.min(MAX_CATCH_UP, (now - (this.last ?? now)) / 1000);
    this.last = now;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      this.step();
      if (++this.steps === SNAPSHOT_TICKS) {
        this.steps = 0;
        this.publish();
      }
    }
  }
}

// Pilot commands every authority accepts, whatever the transport. Returns false for other messages.
export function applyCommand(room, player, m) {
  if (m.type === 'frames') {
    const batch = decodeFrames(m);
    if (batch) room.frames(player, batch.frames, batch.epoch);
  } else if (m.type === 'input') room.input(player, m.input);
  else if (m.type === 'start') room.start(player);
  else if (m.type === 'choose') room.choose(player, m.index);
  else return false;
  return true;
}
