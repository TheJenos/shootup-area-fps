import { GUNS } from '../gunStats';
import type { GunKind, Stance } from '../../types';

/*
 * Bullets for bots, without three.js: a ray against the same hitboxes other players have
 * (remotePlayer.ts: a capsule r 0.3, 0.9 long, centred 0.75 up, and a 0.16 m head), and the same
 * spread the player's gun has (game.ts shoot()). Walls are the caller's: a function returning the
 * distance to the first one.
 */

const BODY_R = 0.3;
const BODY_BOTTOM = 0.3;
/** Top of the capsule's straight part, standing and crouched */
const BODY_TOP: Record<Stance, number> = { stand: 1.2, crouch: 0.8, slide: 0.6 };
const HEAD_R = 0.17;
/** Centre of the head above the feet */
export const HEAD_Y: Record<Stance, number> = { stand: 1.62, crouch: 1.15, slide: 0.95 };
/** How far the head's centre sits above the neck, which a bigger head grows from (remotePlayer.ts' HEAD_HIT_OFFSET) */
const HEAD_LIFT = 0.18;
/** Where to aim at someone's body, above their feet */
export const CHEST_Y: Record<Stance, number> = { stand: 1.15, crouch: 0.8, slide: 0.65 };

export interface Target {
  id: string;
  x: number;
  y: number;
  z: number;
  stance: Stance;
}

export interface Ray {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
}

/** Distance along the ray to the sphere, or Infinity */
function raySphere(r: Ray, cx: number, cy: number, cz: number, radius: number): number {
  const lx = r.ox - cx;
  const ly = r.oy - cy;
  const lz = r.oz - cz;
  const b = lx * r.dx + ly * r.dy + lz * r.dz;
  const c = lx * lx + ly * ly + lz * lz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -b + Math.sqrt(disc) >= 0 ? 0 : Infinity;
}

/** Distance along the ray to an upright capsule (segment y0..y1 at x, z), or Infinity */
function rayCapsule(r: Ray, x: number, z: number, y0: number, y1: number, radius: number): number {
  // The side: an infinite upright cylinder, kept where it's between the caps.
  const lx = r.ox - x;
  const lz = r.oz - z;
  const a = r.dx * r.dx + r.dz * r.dz;
  let best = Infinity;
  if (a > 1e-9) {
    const b = lx * r.dx + lz * r.dz;
    const c = lx * lx + lz * lz - radius * radius;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = r.oy + r.dy * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  return Math.min(best, raySphere(r, x, y0, z, radius), raySphere(r, x, y1, z, radius));
}

/** Where the ray first hits the player, if it does within `max`. `headSize`: big-head modes' heads (rules.ts) */
export function hitPlayer(r: Ray, t: Target, max: number, headSize = 1): { dist: number; head: boolean } | null {
  // Cheap reject: too far from the ray to touch anything.
  const cx = t.x - r.ox;
  const cy = t.y + 0.9 - r.oy;
  const cz = t.z - r.oz;
  const along = cx * r.dx + cy * r.dy + cz * r.dz;
  if (along < -1.2 || along > max + 1.2) return null;
  const px = cx - r.dx * along;
  const py = cy - r.dy * along;
  const pz = cz - r.dz * along;
  const reach = 1.6 + 0.4 * (headSize - 1);
  if (px * px + py * py + pz * pz > reach * reach) return null;

  const head = raySphere(r, t.x, t.y + HEAD_Y[t.stance] + HEAD_LIFT * (headSize - 1), t.z, HEAD_R * headSize);
  const body = rayCapsule(r, t.x, t.z, t.y + BODY_BOTTOM, t.y + BODY_TOP[t.stance], BODY_R);
  const dist = Math.min(head, body);
  if (dist > max) return null;
  return { dist, head: head <= body };
}

/** Spread (radians) for a shot, as the player's gun has it; `aim` is how far the sights are up (0..1). */
export function spreadOf(gun: GunKind, moving: boolean, onGround: boolean, stance: Stance, burst: number, aim = 0): number {
  const def = GUNS[gun];
  // As the player's (game.ts shoot): crouching steadies, aiming down the sights (0..1 up) tightens it far more.
  const steady = (stance === 'crouch' ? 0.6 : 1) * (1 + (def.adsSpread - 1) * aim);
  return (def.spread
    + (moving ? def.movingSpread : 0)
    + (onGround ? 0 : def.airSpread)
    + (def.auto ? Math.min(burst, 10) * 0.0015 : 0)) * steady;
}

/** Unit look direction for a yaw and pitch (the camera's: -z forward at yaw 0, up at positive pitch) */
export function lookDir(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/**
 * `dir` turned off by up to `spread` radians: a random point, evenly spread, on the disc the cone
 * cuts (so shots aren't crowded at the edge, which adding a random 3D vector does: that piles a
 * sphere's surface onto the rim). Shared by the player's shots and the bots', so both scatter alike.
 */
export function scatter(dir: readonly [number, number, number], spread: number, rand: () => number = Math.random): [number, number, number] {
  const [dx, dy, dz] = dir;
  // A basis across the direction: `right` and `up` perpendicular to it (and to each other)
  const ux = Math.abs(dy) < 0.99 ? 0 : 1;
  const uy = Math.abs(dy) < 0.99 ? 1 : 0;
  let rx = dy * 0 - dz * uy;
  let ry = dz * ux - dx * 0;
  let rz = dx * uy - dy * ux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const px = ry * dz - rz * dy;
  const py = rz * dx - rx * dz;
  const pz = rx * dy - ry * dx;
  // sqrt for even density over the disc; the azimuth all round
  const theta = spread * Math.sqrt(rand());
  const phi = rand() * Math.PI * 2;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const a = s * Math.cos(phi);
  const b = s * Math.sin(phi);
  const x = dx * c + rx * a + px * b;
  const y = dy * c + ry * a + py * b;
  const z = dz * c + rz * a + pz * b;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Yaw and pitch that look from (ax, ay, az) at (bx, by, bz) */
export function aimAngles(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [yaw: number, pitch: number] {
  const dx = bx - ax;
  const dz = bz - az;
  return [Math.atan2(-dx, -dz), Math.atan2(by - ay, Math.hypot(dx, dz))];
}

/** An angle wrapped to -π..π */
export function wrapAngle(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}
