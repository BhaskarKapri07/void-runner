import { STEP, SNAPSHOT_TICKS, TICKS_PER_MS, MAX_BATCH_FRAMES, INPUT_WINDOW, clamp, stepShip, reconcile } from './netcode.js';
import { encodeFrames } from './protocol.js';
import { ClientWorld, NetClock } from './world.js';

const FLUSH_SECONDS = 1 / 30;  // input frames are sent in batches at 30 Hz
const PING_MS = 1000;
const RESYNC_MS = 1000;        // at most one resync request per second
const HISTORY = 40;            // states kept for interpolating other pilots

// The states around `tick`: the last at or before it and the first at or after it.
function bracket(history, tick) {
  let before = history[0], after = before;
  for (const h of history) {
    if (h.tick <= tick) before = h;
    after = h;
    if (h.tick >= tick) break;
  }
  return [before, after];
}

// One pilot's side of a match, independent of the page: applies authority messages, predicts the
// local ship and its volleys, batches input frames, and says what to draw. `send` delivers a message
// to the authority.
export class MatchClient {
  constructor(send) {
    this.send = send;
    this.world = new ClientWorld();
    this.clock = new NetClock();
    Object.assign(this, { me: null, view: null, predicted: null, history: [], rtt: 0, hits: 0, hadSync: false, resyncAt: -Infinity, pingAt: -Infinity, flushCarry: 0 });
    this.resetInput();
  }
  resetInput() {
    this.pending = []; // frames sent but not yet acknowledged, replayed on every state
    this.batch = [];   // frames waiting for the next send
    this.seq = 0;
    this.stepCarry = 0;
  }
  joined(id) {
    this.me = id;
    this.world.setMe(id);
  }
  get mine() { return this.view?.players.find(p => p.id === this.me) ?? null; }

  // Applies one authority message. Returns true when something the lobby and HUD show has changed.
  // Hit effects passed to `onEffect` carry `at`, where the target is drawn, and `mine`.
  receive(m, now, onEffect) {
    const before = this.signature();
    if (m.type === 'pong') this.rtt = Math.round(now - m.sent);
    else if (m.type === 'sync') {
      this.world.sync(m);
      this.hadSync = true;
      this.afterState(now);
    } else if (m.type === 'rel') this.journal(m, now, onEffect);
    else if (m.type === 'state' && (!m.rel || this.journal(m.rel, now, onEffect))) {
      if (this.world.state(m)) this.afterState(now);
      else if (!this.world.synced) this.requestResync(now);
    }
    return this.signature() !== before;
  }
  signature() {
    const v = this.view;
    return v ? [v.phase, v.epoch, v.host, v.wave, v.players.map(p => p.id + ':' + p.chosen).join()].join('/') : '';
  }
  journal(m, now, onEffect) {
    if (!this.world.synced || !this.world.rel(m, e => onEffect?.(this.effect(e, now)))) {
      this.requestResync(now);
      return false;
    }
    if (m.meta && this.world.latest) this.view = this.world.view();
    return true;
  }
  effect(e, now) {
    if (e.kind !== 'hit') return e;
    this.hits++;
    // Drawn where the target is drawn, which runs ahead on the own clock.
    return { ...e, at: this.world.locate(e.target, this.ownTick(now)), mine: e.slot === this.world.slot };
  }
  requestResync(now) {
    if (!this.hadSync || now - this.resyncAt < RESYNC_MS) return;
    this.resyncAt = now;
    this.send({ type: 'resync' });
  }
  afterState(now) {
    const previous = this.view, latest = this.world.latest;
    this.view = this.world.view();
    if (!previous || previous.epoch !== this.view.epoch) this.startEpoch();
    this.clock.observe(latest.tick, now);
    if (this.history.at(-1)?.tick === latest.tick) this.history.pop();
    this.history.push(latest);
    if (this.history.length > HISTORY) this.history.shift();
    const mine = this.mine;
    if (!mine) return;
    this.pending = this.pending.filter(f => f.seq > mine.ack);
    // Frames not yet processed, net of how late this state arrived, is how far the local ship runs ahead.
    if (this.view.phase === 'play' && mine.hp > 0 && mine.ack > 0 && this.seq >= mine.ack) {
      this.clock.observeLead(clamp(this.seq - mine.ack - (this.clock.received(now) - latest.tick), 0, INPUT_WINDOW));
    }
    this.predicted = reconcile(mine, this.pending);
  }
  // Ticking pauses in the lobby, on upgrades and after defeat, and always resumes in a new epoch.
  // Re-anchor the clock there instead of reading the pause as lag, and restart input numbering as the
  // authority does. The input pipeline's lead carries over.
  startEpoch() {
    this.clock = new NetClock(this.clock.lead);
    this.resetInput();
    this.history = [];
    this.world.clearPredictions();
  }

  // Called every animation frame; `input` is null while the pilot can't steer (hidden tab).
  // Returns true when the local ship fired.
  update(dt, input, now) {
    let fired = false;
    if (this.canSteer(input)) fired = this.steer(dt, input, now);
    else this.stepCarry = 0;
    this.flushCarry += dt;
    if (this.flushCarry >= FLUSH_SECONDS) {
      this.flushCarry = 0;
      if (this.batch.length) this.send(encodeFrames(this.view.epoch, this.batch.splice(0, MAX_BATCH_FRAMES)));
    }
    if (now - this.pingAt >= PING_MS) {
      this.pingAt = now;
      this.send({ type: 'ping', sent: now });
    }
    return fired;
  }
  // On WebRTC a new roster can arrive before the new epoch's state; frames sent in between would be rejected.
  canSteer(input) {
    const v = this.view;
    return !!input && v?.phase === 'play' && this.world.meta?.epoch === v.epoch && this.predicted?.hp > 0 && this.pending.length < INPUT_WINDOW;
  }
  // Generates 60 Hz input frames for `dt`, stepping the predicted ship with the authority's own rules
  // so any volley shown now is the one the authority will fire.
  steer(dt, input, now) {
    this.stepCarry += dt;
    const steps = Math.floor(this.stepCarry / STEP), own = this.ownTick(now);
    this.stepCarry -= steps * STEP;
    let fired = false;
    for (let n = 0; n < steps; n++) {
      const frame = { seq: ++this.seq, input };
      this.pending.push(frame);
      this.batch.push(frame);
      if (stepShip(this.predicted, input)) {
        fired = true;
        this.world.predict(frame.seq, this.predicted, own - (steps - 1 - n));
      }
    }
    return fired;
  }
  // Before the first lead sample, assume one round trip plus a snapshot interval.
  ownTick(now) { return this.clock.own(now, this.rtt * TICKS_PER_MS + SNAPSHOT_TICKS + 1); }

  // What to draw at `now`. Outside play the authority stops ticking, so both clocks hold at its last tick.
  scene(now) {
    const live = this.view.phase === 'play', last = this.world.latest.tick;
    const own = live ? this.ownTick(now) : last, interp = live ? this.clock.interp(now) : last;
    return { pilots: this.pilots(interp), enemies: this.world.enemiesAt(own), bullets: this.world.visibleBullets(own, interp), shots: this.world.visibleShots(own) };
  }
  // Other pilots are interpolated between states; the local pilot is the prediction.
  pilots(tick) {
    const [a, b] = bracket(this.history, tick), f = b.tick > a.tick ? clamp((tick - a.tick) / (b.tick - a.tick), 0, 1) : 0;
    return this.view.players.map(p => {
      if (p.id === this.me && this.predicted) return this.predicted;
      const from = a.ships.find(s => s.slot === p.slot);
      if (!from) return p;
      const to = b.ships.find(s => s.slot === p.slot) ?? from;
      return { ...p, x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, hp: from.hp, inv: from.inv, revive: from.revive };
    });
  }
  diagnostics() {
    const v = this.view, p = this.predicted;
    return { phase: v?.phase, players: v?.players.map(({ id, x, y, hp }) => ({ id, x, y, hp })), predicted: p ? { x: p.x, y: p.y } : null, me: this.me, rtt: this.rtt, hits: this.hits,
      synced: this.world.synced, bullets: this.world.bullets.size, shots: this.world.shots.size, lead: this.clock.lead, buffer: this.clock.buffer };
  }
}
