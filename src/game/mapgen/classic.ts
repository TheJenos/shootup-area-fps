/**
 * The original hand-built arena (seed CLASSIC): flat, smaller, the same on every version. The
 * end-to-end tests play on it, so it must never change (the unit tests check its boxes).
 */

import type { BoxSurface } from '../textures';
import { THEMES } from './themes';
import type { MapBox, MapData, MapTheme, Spawn } from './types';

export const CLASSIC_SEED = 'CLASSIC';
export const CLASSIC_HALF = 40;

/** Spawns for an arena: corners, two flanking each corner, and one on each axis near the wall. */
function spawnsFor(corner: number, near: number, far: number, axis: number): [number, number][] {
  const out: [number, number][] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) out.push([sx * corner, sz * corner], [sx * near, sz * far], [sx * far, sz * near]);
    out.push([0, sx * axis], [sx * axis, 0]);
  }
  return out;
}

export const CLASSIC_SPAWNS: [number, number][] = spawnsFor(35, 17, 26, 34);

export function classicMap(): MapData {
  const boxes: MapBox[] = [];
  const add = (x: number, z: number, w: number, h: number, d: number, color: number, surface: BoxSurface, y = 0) =>
    boxes.push({ x, z, w, h, d, y, color, surface });

  add(0, 0, 6, 1.2, 6, 0x7d8597, 'concrete');
  add(1.8, 1.8, 1.4, 1, 1.4, 0xc28a4a, 'crate', 1.2);
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    add(sx * 3.6, sz * 3.6, sx ? 1.2 : 2, 0.6, sz ? 1.2 : 2, 0x7d8597, 'concrete');
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(sx * 14, sz * 8, 8, 3, 1, 0x9a6b4f, 'brick');
      add(sx * 8, sz * 14, 1, 3, 8, 0x9a6b4f, 'brick');
      add(sx * 20, sz * 20, 2, 2, 2, 0xc28a4a, 'crate');
      add(sx * 22.2, sz * 20, 2, 1, 2, 0xc28a4a, 'crate');
      add(sx * 20, sz * 20, 1.2, 1, 1.2, 0xb5793d, 'crate', 2);
      add(sx * 30, sz * 30, 3, 4, 3, 0x6f7d8c, 'metal');
      add(sx * 6, sz * 22, 1.5, 1.5, 1.5, 0xc28a4a, 'crate');
      add(sx * 22, sz * 6, 1.5, 1.5, 1.5, 0xc28a4a, 'crate');
      add(sx * 32, sz * 14, 4, 2.2, 1, 0x4f7a6a, 'concrete');
      add(sx * 14, sz * 32, 1, 2.2, 4, 0x4f7a6a, 'concrete');
    }
    add(0, sx * 24, 12, 2, 1, 0x4f6a7a, 'concrete');
    add(sx * 24, 0, 1, 2, 12, 0x4f6a7a, 'concrete');
  }
  // Red spawns on +z, blue on -z; the ones on the middle line only in free-for-all.
  const spawns: Spawn[] = CLASSIC_SPAWNS.map(([x, z]) => ({ x, y: 0, z, team: z > 0 ? 'red' : z < 0 ? 'blue' : null }));
  const theme = THEMES[0] as MapTheme;
  return {
    spec: { seed: CLASSIC_SEED, size: 'm', gen: 0 },
    hash: 0,
    name: theme.name,
    biome: 'Classic',
    theme,
    indoor: false,
    half: CLASSIC_HALF,
    ground: null,
    boxes,
    props: [],
    patches: [],
    flags: { red: [0, 0, 32], blue: [0, 0, -32] },
    spawns,
    pickupSpots: [],
    graph: null,
    edge: { height: 0 },
    path: 'concrete',
  };
}
