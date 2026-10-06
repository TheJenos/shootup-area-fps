/**
 * Deterministic maths for the generator. Every client must build bit-identical maps, so decisions
 * only use + - * /, Math.sqrt (correctly rounded everywhere), floor/round/min/max/abs/sign/imul.
 * Banned in src/game/mapgen (scripts/check-maps.ts fails on them): Math.hypot, sin, cos, tan, the
 * inverse and hyperbolic functions, exp, log, pow, cbrt and Math.random, whose results may differ
 * in the last bits between engines.
 */

/** Length of (dx, dz) */
export const len = (dx: number, dz: number): number => Math.sqrt(dx * dx + dz * dz);

export const dist = (ax: number, az: number, bx: number, bz: number): number => len(bx - ax, bz - az);

/** Round to the centimetre: every coordinate the generator outputs goes through this. */
export const q = (n: number): number => Math.round(n * 100) / 100;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0 below e0, 1 above e1, smooth in between */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Distance from (px, pz) to the segment a–b, and how far along it the closest point is (0..1). */
export function segDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  return { d: dist(px, pz, ax + dx * t, az + dz * t), t };
}

/** Whether segments a–b and c–d cross (touching ends don't count). */
export function segIntersect(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number,
): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = o(ax, az, bx, bz, cx, cz);
  const d2 = o(ax, az, bx, bz, dx, dz);
  const d3 = o(cx, cz, dx, dz, ax, az);
  const d4 = o(cx, cz, dx, dz, bx, bz);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

/** Gap between two rectangles (negative when they overlap). */
export const gapBetween = (a: Rect, b: Rect): number =>
  Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minZ - b.maxZ, b.minZ - a.maxZ);

/** Distance from a point to a rectangle (0 inside). */
export const distanceToRect = (r: Rect, x: number, z: number): number =>
  len(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

export const rectOf = (boxes: readonly { x: number; z: number; w: number; d: number }[]): Rect => {
  const r = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of boxes) {
    r.minX = Math.min(r.minX, b.x - b.w / 2);
    r.maxX = Math.max(r.maxX, b.x + b.w / 2);
    r.minZ = Math.min(r.minZ, b.z - b.d / 2);
    r.maxZ = Math.max(r.maxZ, b.z + b.d / 2);
  }
  return r;
};

export const grow = (r: Rect, by: number): Rect => ({ minX: r.minX - by, maxX: r.maxX + by, minZ: r.minZ - by, maxZ: r.maxZ + by });
