/**
 * Terrain: rolling ground in the open spaces of a finished layout.
 *
 * Heights come from seeded value noise (a few octaves), folded so the map stays mirrored between the
 * team halves (z → -z). They're pushed down to 0 near everything that needs flat ground (boxes,
 * ramps, buildings, streets and other ground patches, spawns, flags, doors, the outer walls), so the
 * generators keep placing pieces on flat ground and only the space between them rises. Natural
 * things (trees, rocks, bushes: MapProp.settle) stand on the hillside instead, each on a small flat
 * pad cut into it so nothing pokes through. Finally the slope is limited, so every hill can be
 * walked up.
 *
 * Pure data like the rest of levelgen: every client builds the same terrain from the seed.
 */

import { PROPS, type PropId } from '../propManifest';
import { FLAG_CLEARANCE, round } from './core';
import type { MapLayout, Terrain } from './types';

/** Grid spacing (m) */
const CELL = 1;
/** Ground within this of anything standing on the floor stays flat (more than a cell's diagonal) */
const FLAT_MARGIN = 1.6;
/** Beyond FLAT_MARGIN, the hills come up to full height over this distance */
const RISE = 5;
/** Steepest slope (rise per metre): about 24°, well under what the player climbs (player.ts MAX_SLOPE) */
const MAX_SLOPE = 0.45;
/** Spawns and the area in front of the flags stay this flat */
const SPAWN_FLAT = 3;
/** Boxes starting higher than this don't touch the floor (upper storeys, canopies) */
const GROUND_BOX_Y = 0.5;
/** A natural thing's flat pad reaches this far past its footprint */
const PAD_MARGIN = 0.4;

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

const spot = (x: number, z: number) => `${x},${z}`;

/**
 * The ground each natural thing (MapProp.settle) covers, by its spot: the model's footprint, but
 * only the trunk for a tree (the canopy is overhead), so forests don't flatten the hills.
 */
export function settledFootprints(layout: MapLayout): Map<string, Rect> {
  const trunks = new Map<string, Rect>();
  for (const b of layout.boxes) {
    if (!b.rest || b.blocks === 'shots') continue;
    const k = spot(b.rest.x, b.rest.z);
    const f = trunks.get(k) ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    f.minX = Math.min(f.minX, b.x - b.w / 2);
    f.maxX = Math.max(f.maxX, b.x + b.w / 2);
    f.minZ = Math.min(f.minZ, b.z - b.d / 2);
    f.maxZ = Math.max(f.maxZ, b.z + b.d / 2);
    trunks.set(k, f);
  }
  const out = new Map<string, Rect>();
  for (const p of layout.props) {
    if (!p.settle) continue;
    const k = spot(p.x, p.z);
    const info = PROPS[p.id as PropId];
    const trunk = trunks.get(k);
    if (info?.tags.includes('tree') && trunk) {
      out.set(k, trunk);
      continue;
    }
    // The model's own footprint (centred on its spot), plus any collision box sticking out of it.
    const s = p.scale ?? 1;
    const odd = p.rot % 2 === 1;
    const hw = ((odd ? info?.d : info?.w) ?? 1) * s / 2;
    const hd = ((odd ? info?.w : info?.d) ?? 1) * s / 2;
    const f = { minX: p.x - hw, maxX: p.x + hw, minZ: p.z - hd, maxZ: p.z + hd };
    if (trunk) {
      f.minX = Math.min(f.minX, trunk.minX);
      f.maxX = Math.max(f.maxX, trunk.maxX);
      f.minZ = Math.min(f.minZ, trunk.minZ);
      f.maxZ = Math.max(f.maxZ, trunk.maxZ);
    }
    out.set(k, f);
  }
  return out;
}

export interface TerrainOptions {
  /** Tallest a hill gets (m) */
  height: number;
  /** Size of the biggest bumps (m) */
  scale: number;
}

/** Value noise on a lattice of seeded random numbers, smoothly interpolated. Returns -1..1. */
function valueNoise(rand: () => number, size: number): (x: number, z: number) => number {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
  const at = (ix: number, iz: number) => lattice[(((iz % size) + size) % size) * size + (((ix % size) + size) % size)]!;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, z) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = fade(x - ix);
    const fz = fade(z - iz);
    const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * fx;
    const b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * fx;
    return a + (b - a) * fz;
  };
}

/**
 * Add terrain to `layout` (in place) and lift the props that stand on the open floor onto it.
 * Call on a layout that already passed its checks: the terrain is walkable by construction.
 */
export function addTerrain(layout: MapLayout, rand: () => number, o: TerrainOptions): void {
  const half = layout.half;
  const n = Math.round((half * 2) / CELL);
  const side = n + 1;
  const coord = (i: number) => -half + i * CELL;

  // Three octaves; each is folded across the middle line (averaged with its mirror image) so the
  // two halves match without a crease along z = 0.
  const octaves = [
    { noise: valueNoise(rand, 64), freq: 1 / o.scale, amp: 1 },
    { noise: valueNoise(rand, 64), freq: 2 / o.scale, amp: 0.45 },
    { noise: valueNoise(rand, 64), freq: 4 / o.scale, amp: 0.18 },
  ];
  const total = octaves.reduce((s, oct) => s + oct.amp, 0);
  const shape = (x: number, z: number) => {
    let v = 0;
    for (const oct of octaves) v += oct.amp * (oct.noise(x * oct.freq, z * oct.freq) + oct.noise(x * oct.freq, -z * oct.freq)) * 0.5;
    // Folding narrows the spread: stretch it back out, then keep mounds only (0..1), with some
    // flat low ground between them.
    const t = Math.min(1, Math.max(0, (v / total) * 1.8 + 0.4));
    return t * t * (3 - 2 * t);
  };

  // How far each vertex is from anything that needs flat ground.
  const flat: { minX: number; maxX: number; minZ: number; maxZ: number; pad: number }[] = [];
  for (const b of layout.boxes) {
    if (b.blocks === 'shots' || b.rest || b.y > GROUND_BOX_Y) continue;
    flat.push({ minX: b.x - b.w / 2, maxX: b.x + b.w / 2, minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2, pad: 0 });
  }
  for (const g of layout.ground) flat.push({ minX: g.x - g.w / 2, maxX: g.x + g.w / 2, minZ: g.z - g.d / 2, maxZ: g.z + g.d / 2, pad: 0 });
  const point = (x: number, z: number, pad: number) => flat.push({ minX: x, maxX: x, minZ: z, maxZ: z, pad });
  for (const [x, z] of layout.spawnPoints) point(x, z, SPAWN_FLAT);
  for (const [x, z] of layout.doors) point(x, z, 1);
  for (const [x, z] of layout.flags) point(x, z, FLAG_CLEARANCE + 2);

  const heights = new Float32Array(side * side);
  for (let iz = 0; iz < side; iz++) {
    const z = coord(iz);
    for (let ix = 0; ix < side; ix++) {
      const x = coord(ix);
      let d = half - Math.max(Math.abs(x), Math.abs(z)) - 0.5; // the outer walls
      for (const r of flat) {
        const dx = Math.max(r.minX - x, 0, x - r.maxX);
        const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
        if (dx >= d || dz >= d) continue;
        d = Math.min(d, Math.hypot(dx, dz) - r.pad);
      }
      if (d <= FLAT_MARGIN) continue;
      const t = Math.min(1, (d - FLAT_MARGIN) / RISE);
      heights[iz * side + ix] = o.height * shape(x, z) * t * t * (3 - 2 * t);
    }
  }

  // A flat pad under each natural thing (its whole model, or a tree's trunk), at the lowest ground
  // there: nothing pokes through it on the uphill side. The slope pass below then eases the hillside
  // down to the pad.
  const cells = (f: Rect) => ({
    i0: Math.max(0, Math.floor((f.minX - PAD_MARGIN + half) / CELL)),
    i1: Math.min(n, Math.ceil((f.maxX + PAD_MARGIN + half) / CELL)),
    k0: Math.max(0, Math.floor((f.minZ - PAD_MARGIN + half) / CELL)),
    k1: Math.min(n, Math.ceil((f.maxZ + PAD_MARGIN + half) / CELL)),
  });
  const lowestUnder = (h: ArrayLike<number>, f: Rect) => {
    const { i0, i1, k0, k1 } = cells(f);
    let low = Infinity;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) low = Math.min(low, h[k * side + i]!);
    return low === Infinity ? 0 : low;
  };
  const settled = settledFootprints(layout);
  const carvePads = () => {
    let changed = false;
    for (const f of settled.values()) {
      const low = lowestUnder(heights, f);
      const { i0, i1, k0, k1 } = cells(f);
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          if (heights[k * side + i]! > low + 1e-6) {
            heights[k * side + i] = low;
            changed = true;
          }
        }
      }
    }
    return changed;
  };

  // Limit the slope: no vertex more than MAX_SLOPE × distance above a neighbour. Sweeps in both
  // directions (a chamfer distance transform) only ever lower heights, so flat ground stays flat.
  // Repeated until nothing changes, so the result doesn't depend on the sweep order.
  const step = MAX_SLOPE * CELL;
  const diag = MAX_SLOPE * CELL * Math.SQRT2;
  const limitSlope = () => {
    let any = false;
    for (let changed = true; changed;) {
      changed = false;
      const lower = (i: number, h: number) => {
        if (h < heights[i]! - 1e-6) {
          heights[i] = h;
          changed = any = true;
        }
      };
      for (let iz = 0; iz < side; iz++) {
        for (let ix = 0; ix < side; ix++) {
          const i = iz * side + ix;
          let h = heights[i]!;
          if (ix > 0) h = Math.min(h, heights[i - 1]! + step);
          if (iz > 0) {
            h = Math.min(h, heights[i - side]! + step);
            if (ix > 0) h = Math.min(h, heights[i - side - 1]! + diag);
            if (ix < n) h = Math.min(h, heights[i - side + 1]! + diag);
          }
          lower(i, h);
        }
      }
      for (let iz = n; iz >= 0; iz--) {
        for (let ix = n; ix >= 0; ix--) {
          const i = iz * side + ix;
          let h = heights[i]!;
          if (ix < n) h = Math.min(h, heights[i + 1]! + step);
          if (iz < n) {
            h = Math.min(h, heights[i + side]! + step);
            if (ix < n) h = Math.min(h, heights[i + side + 1]! + diag);
            if (ix > 0) h = Math.min(h, heights[i + side - 1]! + diag);
          }
          lower(i, h);
        }
      }
    }
    return any;
  };

  // Lowering a pad's edge to ease the slope tilts the pad, so flatten and ease again until both hold.
  carvePads();
  while (limitSlope() && carvePads());

  let any = false;
  const out: number[] = new Array(side * side);
  for (let i = 0; i < out.length; i++) {
    const h = round(heights[i]!);
    out[i] = h;
    if (h > 0) any = true;
  }
  if (!any) return;
  const terrain: Terrain = { n, cell: CELL, heights: out };
  layout.terrain = terrain;

  // Stand each natural thing on its pad.
  const lift = new Map<string, number>();
  for (const p of layout.props) {
    const f = p.settle ? settled.get(spot(p.x, p.z)) : undefined;
    if (!f) continue;
    const y = lowestUnder(out, f);
    lift.set(spot(p.x, p.z), y);
    p.y = round(p.y + y);
  }
  for (const b of layout.boxes) {
    const y = b.rest ? lift.get(spot(b.rest.x, b.rest.z)) : undefined;
    if (y) b.y = round(b.y + y);
  }
}

/**
 * Ground height at (x, z), exactly as the terrain mesh draws it: each cell is split into two
 * triangles along the diagonal from (x0, z0) to (x1, z1). 0 outside the grid or with no terrain.
 */
export function terrainHeight(t: Terrain | undefined, half: number, x: number, z: number): number {
  if (!t) return 0;
  const fx = (x + half) / t.cell;
  const fz = (z + half) / t.cell;
  if (fx < 0 || fz < 0 || fx >= t.n || fz >= t.n) return 0;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const side = t.n + 1;
  const h = t.heights;
  const h00 = h[iz * side + ix]!;
  const h11 = h[(iz + 1) * side + ix + 1]!;
  if (u >= v) {
    const h10 = h[iz * side + ix + 1]!;
    return h00 + (h10 - h00) * u + (h11 - h10) * v;
  }
  const h01 = h[(iz + 1) * side + ix]!;
  return h00 + (h01 - h00) * v + (h11 - h01) * u;
}
