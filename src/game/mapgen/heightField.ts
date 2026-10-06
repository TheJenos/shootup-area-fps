/**
 * Reading the ground (types.ts Ground). The drawn mesh, the physics heightfield and the generator's
 * checks all use this one triangle split, so what you see is what you stand on.
 */

import type { Ground } from './types';

/**
 * Height at (x, z). Each cell is two triangles split along the diagonal from (x1, z0) to (x0, z1),
 * the same split as Rapier's heightfield. Outside the grid, the nearest edge.
 */
export function groundHeight(g: Ground | null, x: number, z: number): number {
  if (!g) return 0;
  const n = g.n;
  let fx = (x + g.half) / g.cell;
  let fz = (z + g.half) / g.cell;
  fx = fx < 0 ? 0 : fx > n ? n : fx;
  fz = fz < 0 ? 0 : fz > n ? n : fz;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  if (ix >= n) ix = n - 1;
  if (iz >= n) iz = n - 1;
  const u = fx - ix;
  const v = fz - iz;
  const side = n + 1;
  const h = g.heights;
  const h10 = h[iz * side + ix + 1]!;
  const h01 = h[(iz + 1) * side + ix]!;
  if (u + v <= 1) {
    const h00 = h[iz * side + ix]!;
    return h00 + (h10 - h00) * u + (h01 - h00) * v;
  }
  const h11 = h[(iz + 1) * side + ix + 1]!;
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

/** Slope at (x, z) as rise per metre along x and z (the triangle's gradient). */
export function groundGradient(g: Ground | null, x: number, z: number): [number, number] {
  if (!g) return [0, 0];
  const n = g.n;
  const fx = Math.min(n - 1e-6, Math.max(0, (x + g.half) / g.cell));
  const fz = Math.min(n - 1e-6, Math.max(0, (z + g.half) / g.cell));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const side = n + 1;
  const h = g.heights;
  const h10 = h[iz * side + ix + 1]!;
  const h01 = h[(iz + 1) * side + ix]!;
  if (fx - ix + (fz - iz) <= 1) {
    const h00 = h[iz * side + ix]!;
    return [(h10 - h00) / g.cell, (h01 - h00) / g.cell];
  }
  const h11 = h[(iz + 1) * side + ix + 1]!;
  return [(h11 - h01) / g.cell, (h11 - h10) / g.cell];
}

/** Lowest and highest ground over a rectangle (sampled at the vertices inside it and its corners). */
export function groundRange(g: Ground | null, minX: number, maxX: number, minZ: number, maxZ: number): { lo: number; hi: number } {
  if (!g) return { lo: 0, hi: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  const add = (h: number) => {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  };
  for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ], [(minX + maxX) / 2, (minZ + maxZ) / 2]] as const) {
    add(groundHeight(g, x, z));
  }
  const side = g.n + 1;
  const i0 = Math.max(0, Math.ceil((minX + g.half) / g.cell));
  const i1 = Math.min(g.n, Math.floor((maxX + g.half) / g.cell));
  const k0 = Math.max(0, Math.ceil((minZ + g.half) / g.cell));
  const k1 = Math.min(g.n, Math.floor((maxZ + g.half) / g.cell));
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) add(g.heights[k * side + i]!);
  return { lo, hi };
}

/**
 * The heights in the order Rapier's heightfield wants them: a (n+1) × (n+1) matrix whose rows run
 * along z and columns along x, stored column by column.
 */
export function rapierHeights(g: Ground): Float32Array {
  const side = g.n + 1;
  const out = new Float32Array(side * side);
  for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) out[ix * side + iz] = g.heights[iz * side + ix]!;
  return out;
}
