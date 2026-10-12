/**
 * The ground under the layout: gentle hills from smooth noise, scaled by the biome, flattening to
 * the base yard round each flag and to the middle line (so the plaza lies flat across it). Then no
 * slope is left steeper than MAX_SLOPE, and blue's half is an exact copy of red's.
 */

import { smoothstep } from './dmath';
import { edgeDistance, tagAt, valueNoise, TAG, type Layout } from './layout';
import type { Rng } from './rng';
import { tVertex } from './symmetry';
import { PAINT, type Ground } from './types';

/** Rise per metre along x or z (a triangle's steepest slope is at most √2 × this, ~40°, under the 55° you can climb) */
export const MAX_SLOPE = 0.6;

export interface GroundOptions {
  /** Height of the hills (m) */
  amp: number;
  /** Distance between hills (m) */
  period: number;
}

/** Pull every height down until no neighbour along x or z is more than MAX_SLOPE lower */
function limitSlopes(h: Float64Array, side: number): void {
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
      const v = iz * side + ix;
      let m = h[v]!;
      if (ix > 0) m = Math.min(m, h[v - 1]! + MAX_SLOPE);
      if (iz > 0) m = Math.min(m, h[v - side]! + MAX_SLOPE);
      if (m < h[v]!) { h[v] = m; changed = true; }
    }
    for (let iz = side - 1; iz >= 0; iz--) for (let ix = side - 1; ix >= 0; ix--) {
      const v = iz * side + ix;
      let m = h[v]!;
      if (ix < side - 1) m = Math.min(m, h[v + 1]! + MAX_SLOPE);
      if (iz < side - 1) m = Math.min(m, h[v + side]! + MAX_SLOPE);
      if (m < h[v]!) { h[v] = m; changed = true; }
    }
    if (!changed) break;
  }
}

export function buildGround(rng: Rng, l: Layout, o: GroundOptions, baseR: number): Ground {
  const half = l.outline.half;
  const n = half * 2;
  const side = n + 1;
  const mid = n / 2;
  const hills = valueNoise(rng.fork('hills'), 64);
  const h = new Float64Array(side * side);
  const raw = (x: number, z: number) => (o.amp * (hills(x / o.period, z / o.period) + 1)) / 2;
  const baseH = raw(l.base.x, l.base.z);
  for (let iz = mid; iz < side; iz++) {
    const z = iz - half;
    for (let ix = 0; ix < side; ix++) {
      const x = ix - half;
      let y = raw(x, z) * smoothstep(4, 18, z);
      const toBase = Math.sqrt((x - l.base.x) * (x - l.base.x) + (z - l.base.z) * (z - l.base.z));
      const flat = 1 - smoothstep(baseR - 2, baseR + 6, toBase);
      y = y + (baseH * smoothstep(4, 18, l.base.z) - y) * flat;
      h[iz * side + ix] = y;
    }
  }
  for (let iz = 0; iz < mid; iz++) for (let ix = 0; ix < side; ix++) h[iz * side + ix] = h[tVertex(l.sym, n, ix, iz)]!;
  limitSlopes(h, side);

  // Exactly the same both sides (the middle line is all at 0, so only the halves are copied).
  const heights = new Float32Array(side * side);
  for (let v = 0; v < heights.length; v++) heights[v] = h[v]!;
  for (let iz = 0; iz < mid; iz++) for (let ix = 0; ix < side; ix++) heights[iz * side + ix] = heights[tVertex(l.sym, n, ix, iz)]!;

  // Paint: the path along corridors, rough ground in the blobs, rock against the edge.
  const toEdge = edgeDistance(l.outline, 3);
  const paint = new Uint8Array(side * side);
  for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
    const v = iz * side + ix;
    const t = tagAt(l, ix - half + 0.01, iz - half + 0.01);
    paint[v] = toEdge[v]! < 1.2 ? PAINT.rock
      : t === TAG.core || t === TAG.corridor ? PAINT.path
      : t === TAG.blob ? PAINT.rough
      : PAINT.floor;
  }
  return { n, cell: 1, half, heights, paint };
}
