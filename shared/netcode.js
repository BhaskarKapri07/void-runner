export const STEP = 1 / 60;
// Authorities publish once every SNAPSHOT_TICKS simulation steps (30 Hz).
export const SNAPSHOT_TICKS = 2;
export const COLORS = ['#c5ff61','#65d9ff','#ff83bd','#ffd16a'];
export const BULLET_SPEED = 520;
export const BULLET_SPREAD = .14;
export const SHOT_SPREAD = .19;
export const bulletAlive = (x, y) => y > -30 && x > -30 && x < 990;
export const shotAlive = (x, y) => y < 630 && y > -50 && x > -30 && x < 990;
// Clients rebuild whole volleys from one journal entry, so both sides must share this math.
export function volleyVelocity(i, n) {
  const a = (i - (n - 1) / 2) * BULLET_SPREAD;
  return [Math.sin(a) * BULLET_SPEED, -Math.cos(a) * BULLET_SPEED];
}
export function shotVelocity(aim, i, n, speed) {
  const a = aim + (i - (n - 1) / 2) * SHOT_SPREAD;
  return [Math.cos(a) * speed, Math.sin(a) * speed];
}
export function moveShip(p, input, dt = STEP) {
  const x = Number(!!input.right) - Number(!!input.left);
  const y = Number(!!input.down) - Number(!!input.up);
  const n = Math.hypot(x, y) || 1;
  p.x = Math.max(20, Math.min(940, p.x + x / n * p.speed * dt));
  p.y = Math.max(30, Math.min(575, p.y + y / n * p.speed * dt));
  return p;
}
// One input frame: cool down, move, then report whether this frame fires.
// The authority and the predicting client both run exactly this per frame.
export function stepShip(p, input) {
  if (typeof p.cool === 'number') p.cool -= STEP;
  moveShip(p, input);
  if (!input.fire || !(p.cool <= 0)) return false;
  p.cool = p.rate;
  return true;
}
// Collision along relative motion catches projectiles crossing a target between ticks.
export function sweptHit(a, b, radius) {
  const x = (a.px ?? a.x) - (b.px ?? b.x), y = (a.py ?? a.y) - (b.py ?? b.y);
  const vx = a.x - b.x - x, vy = a.y - b.y - y;
  const t = Math.max(0, Math.min(1, -(x * vx + y * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x + vx * t, y + vy * t) <= radius;
}
export function reconcile(authority, pending) {
  const p = { ...authority };
  if (p.hp > 0) for (const frame of pending) if (frame.seq > (p.ack ?? 0)) stepShip(p, frame.input);
  return p;
}
