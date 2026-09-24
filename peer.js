import { Room } from './shared/engine.js';
import { STEP } from './shared/netcode.js';
import { PROTOCOL } from './shared/protocol.js';
import { Match, Ticker, applyCommand } from './shared/match.js';

// Direct mode. The signaling server only introduces browsers (room discovery, SDP and ICE); the
// host's browser runs the match. Journal batches and syncs use each guest's reliable `control`
// channel, and latest-only state the unordered `state` channel.

const CONNECT_TIMEOUT_MS = 15000;
const KEEPALIVE_MS = 20000;               // the Durable Object closes signaling sockets idle for 45 s
const MAX_BUFFERED_BYTES = 131072;        // a channel this backed up skips sends
const MAX_CHANNEL_MESSAGE = 262144;
const VERSION_MISMATCH = 'This game client and the host run different versions. Everyone needs the latest voidrunner.html.';
const NEEDS_RELAY = 'Try server mode; this network may need a TURN relay.';

export class PeerSession {
  // `signal` sends to the signaling server, `receive` hands authority messages to the local client,
  // `fail` reports a fatal error.
  constructor(signal, receive, fail) {
    Object.assign(this, { signal, receive, fail, name: 'Pilot', peers: new Map(), id: null, host: null, code: null, match: null, local: null, ticker: null, timer: null, keepAt: 0, closed: false, signaling: Promise.resolve() });
  }
  get isHost() { return this.match !== null; }
  // True while a reliable channel is open: to the host for a guest, to any guest for the host.
  linked() {
    return this.isHost ? [...this.peers.keys()].some(id => this.isOpen(id)) : this.isOpen(this.host);
  }
  isOpen(id) { return this.peers.get(id)?.control?.readyState === 'open'; }

  // Signaling messages are handled one at a time; WebRTC negotiation must not interleave.
  message(m) {
    this.signaling = this.signaling.then(() => this.handle(m));
    return this.signaling;
  }
  async handle(m) {
    try {
      if (m.type === 'peer-ready') this.ready(m);
      else if (m.type === 'peer-new') await this.link(m.peer, true);
      else if (m.type === 'signal') await this.negotiate(m);
      // Signaling sockets can drop while data channels stay open; only a closed channel means a pilot left.
      else if (m.type === 'peer-left' && !this.isOpen(m.peer)) this.drop(m.peer);
      else if (m.type === 'peer-ended' && !this.linked()) this.fail(m.message);
    } catch {
      this.fail('Peer connection failed. ' + NEEDS_RELAY);
    }
  }
  ready(m) {
    Object.assign(this, { id: m.peer, host: m.host, code: m.code });
    if (this.id !== this.host) {
      this.startTimer(1000);
      return;
    }
    this.match = new Match(new Room(this.code));
    this.local = { player: this.match.room.add(this.name).id, deliver: (out, full) => this.deliverLocal(out, full) };
    this.match.add(this.local);
    this.ticker = new Ticker(() => this.match.room.tick(STEP), () => this.match.publish());
    this.receive({ type: 'joined', id: this.local.player, code: this.code, v: PROTOCOL });
    this.match.publish();
    this.startTimer(1000 / 60);
  }

  // A guest's (or, for a guest, the host's) connection. Its `deliver` makes it a Match client.
  track(id, pc) {
    const entry = { pc, ice: [], control: null, state: null, player: null, needSync: false };
    entry.deliver = (out, full) => this.deliverPeer(entry, out, full);
    this.peers.set(id, entry);
    return entry;
  }
  async link(id, offer) {
    const pc = new RTCPeerConnection({ iceServers: window.VOIDRUNNER_ICE_SERVERS || [{ urls: 'stun:stun.l.google.com:19302' }] });
    const entry = this.track(id, pc);
    pc.onicecandidate = ev => { if (ev.candidate) this.signal({ type: 'signal', to: id, data: { candidate: ev.candidate } }); };
    const deadline = setTimeout(() => {
      if (!this.closed && pc.connectionState !== 'connected') this.fail('Direct connection timed out. ' + NEEDS_RELAY);
    }, CONNECT_TIMEOUT_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') clearTimeout(deadline);
      if (pc.connectionState === 'failed') { clearTimeout(deadline); this.lost(id); }
    };
    pc.ondatachannel = ev => this.attach(id, entry, ev.channel);
    if (offer) {
      this.attach(id, entry, pc.createDataChannel('control'));
      this.attach(id, entry, pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
      await pc.setLocalDescription(await pc.createOffer());
      this.signal({ type: 'signal', to: id, data: { description: pc.localDescription } });
    }
    return entry;
  }
  async negotiate(m) {
    const entry = this.peers.get(m.from) || await this.link(m.from, false), { pc } = entry;
    if (m.data?.description) {
      await pc.setRemoteDescription(m.data.description);
      for (const candidate of entry.ice.splice(0)) await pc.addIceCandidate(candidate);
      if (m.data.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal({ type: 'signal', to: m.from, data: { description: pc.localDescription } });
      }
    }
    // Candidates can arrive before the description they belong to.
    if (m.data?.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(m.data.candidate);
      else entry.ice.push(m.data.candidate);
    }
  }
  attach(id, entry, channel) {
    entry[channel.label] = channel;
    channel.onmessage = ev => {
      if (ev.data.length > MAX_CHANNEL_MESSAGE) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (this.isHost) this.command(entry, m);
      else this.receive(m);
    };
    if (channel.label !== 'control') return;
    // The reliable channel closing is the fastest sign that the other browser left.
    channel.onclose = () => this.lost(id);
    // A guest introduces itself once the control channel is open, which it may already be.
    const hello = () => { if (!this.isHost) channel.send(JSON.stringify({ type: 'hello', name: this.name, v: PROTOCOL })); };
    if (channel.readyState === 'open') hello();
    else channel.onopen = hello;
  }
  lost(id) {
    if (this.closed || !this.peers.has(id)) return;
    if (this.isHost) this.drop(id);
    else this.fail('Host connection lost. Return to the lobby.');
  }
  drop(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    if (entry.player) {
      this.match?.room.remove(entry.player);
      this.match?.remove(entry);
    }
    entry.pc.close();
    this.peers.delete(id);
  }

  // Host: a message from a guest's channel.
  command(guest, m) {
    if (m.type === 'hello') this.welcome(guest, m);
    else if (!guest.player) return;
    else if (m.type === 'ping') this.write(guest.control, { type: 'pong', sent: m.sent });
    else if (m.type === 'resync') guest.needSync = true;
    else applyCommand(this.match.room, guest.player, m);
  }
  welcome(guest, m) {
    if (guest.player) return;
    if (m.v !== PROTOCOL) { this.write(guest.control, { type: 'error', message: VERSION_MISMATCH }); return; }
    try {
      guest.player = this.match.room.add(m.name).id;
    } catch (err) {
      this.write(guest.control, { type: 'error', message: err.message });
      return;
    }
    this.write(guest.control, { type: 'joined', id: guest.player, code: this.code, v: PROTOCOL });
    this.match.add(guest);
    this.match.publish();
  }
  // A message from the local client: handled here on the host, forwarded to the host by a guest.
  send(m) {
    if (!this.isHost) { this.write(this.peers.get(this.host)?.control, m); return; }
    if (m.type === 'ping') this.receive({ type: 'pong', sent: m.sent });
    else if (m.type === 'resync') this.local.needSync = true;
    else if (applyCommand(this.match.room, this.local.player, m) && m.type === 'start') this.signal({ type: 'peer-started' });
  }

  // Match clients. Return false when the journal batch could not be sent, so the Match resyncs.
  deliverLocal(out, full) {
    if (full) this.receive(out.sync);
    else {
      if (out.rel) this.receive(out.rel);
      if (out.state) this.receive(out.state);
    }
    return true;
  }
  deliverPeer(guest, out, full) {
    if (full) return this.write(guest.control, out.json('sync'));
    if (out.rel && !this.write(guest.control, out.json('rel'))) return false;
    // With ticks frozen (lobby, upgrades) the state sent with a roster change is the only one, so it can't be lossy.
    if (out.state) this.write(out.rel?.meta ? guest.control : guest.state, out.json('state'));
    return true;
  }
  write(channel, message) {
    if (channel?.readyState !== 'open' || channel.bufferedAmount >= MAX_BUFFERED_BYTES) return false;
    channel.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  // Hidden tabs stop requestAnimationFrame, so a worker timer also calls pulse(): the host's simulation
  // and everyone's signaling keepalive. The page calls it every animation frame too; the Ticker only
  // advances by real elapsed time, so extra calls cost nothing.
  startTimer(ms) {
    if (this.timer || typeof Worker === 'undefined') return;
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' }));
      this.timer = new Worker(url);
      this.timer.onmessage = () => {
        URL.revokeObjectURL(url);
        this.timer.onmessage = () => this.pulse();
        this.pulse();
      };
    } catch {
      this.timer = null;
    }
  }
  pulse(now = performance.now()) {
    if (this.closed) return;
    if (now - this.keepAt > KEEPALIVE_MS) {
      this.keepAt = now;
      this.signal({ type: 'keepalive' });
    }
    this.ticker?.advance(now);
  }
  close() {
    this.closed = true;
    this.timer?.terminate();
    this.timer = null;
    for (const entry of this.peers.values()) entry.pc.close();
    this.peers.clear();
    this.match = null;
  }
}
