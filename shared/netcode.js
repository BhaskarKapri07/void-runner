// Constants and physics shared by the authority (engine.js) and the predicting client (client.js).
// Anything both sides compute must come from here so the two can't drift apart.
export const STEP = 1 / 60;
export const TICKS_PER_MS = 1 / (STEP * 1000);
// Authorities publish once every SNAPSHOT_TICKS simulation steps (30 Hz).
export const SNAPSHOT_TICKS = 2;
// Most input frames one message may carry.
export const MAX_BATCH_FRAMES = 12;
// How far input may run ahead of the last frame the authority processed.
export const INPUT_WINDOW = 120;
export const COLORS = ['#c5ff61', '#65d9ff', '#ff83bd', '#ffd16a'];
export const BULLET_SPEED = 520;
export const BULLET_SPREAD = .14;
export const SHOT_SPREAD = .19;
// Volleys leave the ship this far above its centre.
export const MUZZLE_OFFSET = 20;

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const bulletAlive = (x, y) => y > -30 && x > -30 && x < 990;
export const shotAlive = (x, y) => y < 630 && y > -50 && x > -30 && x < 990;

export function volleyVelocity(i, count) {
  const a = (i - (count - 1) / 2) * BULLET_SPREAD;
  return [Math.sin(a) * BULLET_SPEED, -Math.cos(a) * BULLET_SPEED];
}

export function shotVelocity(aim, i, count, speed) {
  const a = aim + (i - (count - 1) / 2) * SHOT_SPREAD;
  return [Math.cos(a) * speed, Math.sin(a) * speed];
}

export function moveShip(p, input, dt = STEP) {
  const x = Number(!!input.right) - Number(!!input.left);
  const y = Number(!!input.down) - Number(!!input.up);
  const n = Math.hypot(x, y) || 1;
  p.x = clamp(p.x + x / n * p.speed * dt, 20, 940);
  p.y = clamp(p.y + y / n * p.speed * dt, 30, 575);
  return p;
}

// One input frame in the order the authority processes it: cool down, move, then fire if ready.
// Returns true when the frame fires; the caller spawns the volley.
export function stepShip(p, input) {
  p.cool -= STEP;
  moveShip(p, input);
  if (!input.fire || p.cool > 0) return false;
  p.cool = p.rate;
  return true;
}

// Collision along relative motion catches projectiles crossing a target between ticks.
export function sweptHit(a, b, radius) {
  const x = (a.px ?? a.x) - (b.px ?? b.x), y = (a.py ?? a.y) - (b.py ?? b.y);
  const vx = a.x - b.x - x, vy = a.y - b.y - y;
  const t = clamp(-(x * vx + y * vy) / (vx * vx + vy * vy || 1), 0, 1);
  return Math.hypot(x + vx * t, y + vy * t) <= radius;
}

// The authoritative ship with every unacknowledged local frame replayed on top.
export function reconcile(authority, pending) {
  const p = { ...authority };
  if (p.hp > 0) for (const frame of pending) if (frame.seq > (p.ack ?? 0)) stepShip(p, frame.input);
  return p;
}
