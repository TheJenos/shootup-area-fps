/**
 * The map's shape. Maps aren't squares: like a real level's top view, the playable area is designed
 * first as a blocky footprint (a middle band, a yard round each base, bars and streets joining them,
 * wings sticking out, notches cut in, sometimes a block left solid in the middle), and the lanes are
 * then routed inside it (graph.ts). Everything outside is solid: town and refinery maps are walled in
 * by buildings, quarries and highlands by cliffs (edgeMasses), never by a thin perimeter wall.
 *
 * The square grid is split into BLOCK-sized blocks, with a ring that's always outside so the edge
 * masses wrap the whole map. Red's half is designed and copied under the map's symmetry; a mirrored
 * map is also mirrored left to right, so the middle line is the same for both teams.
 */

import { groundRange } from './heightField';
import { len, q, type Rect } from './dmath';
import type { Graph, LaneSample } from './graph';
import type { Rng } from './rng';
import type { SizeParams } from './spec';
import { tPiece, type Symmetry } from './symmetry';
import type { BoxSurface } from '../textures';
import type { Ground, MapBox } from './types';

/** Block size (m) */
export const BLOCK = 4;

export interface Outline {
  /** Block size (m) */
  cell: number;
  /** Blocks per side (even, so block edges run along the middle line) */
  n: number;
  half: number;
  /** n² flags, row by row along z (row 0 at z = -half), each row along x: 1 = inside */
  inside: Uint8Array;
}

/** What stands outside a map's shape */
export interface EdgeStyle {
  kind: 'buildings' | 'cliffs';
  surfaces: readonly BoxSurface[];
  colors: readonly number[];
  /** Height above the highest ground under each block of it (m) */
  height: [number, number];
}

/** Half the grid for a map size: the play area plus a ring of at least two blocks, in whole pairs of blocks */
export const gridHalf = (P: SizeParams): number => Math.ceil((P.half + 2 * BLOCK) / (2 * BLOCK)) * 2 * BLOCK;

/** The other team's copy of block (i, k) */
const tBlock = (sym: Symmetry, n: number, i: number, k: number): number =>
  sym === 'rotate' ? (n - 1 - k) * n + (n - 1 - i) : (n - 1 - k) * n + i;

const SIDES: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export interface Footprint {
  outline: Outline;
  /** Red's flag */
  base: { x: number; z: number };
}

/** Design a map's shape for red's half (and copy it), with red's base in it. */
export function designFootprint(rng: Rng, sym: Symmetry, P: SizeParams): Footprint {
  const H = P.half;
  const G = gridHalf(P);
  const n = (G * 2) / BLOCK;
  const inside = new Uint8Array(n * n);
  /** Blocks that must stay inside (round the base and the middle): no notch cuts them */
  const keep = new Uint8Array(n * n);
  const blocksOf = (r: Rect) => ({
    i0: Math.max(0, Math.floor((Math.max(r.minX, -H) + G) / BLOCK)),
    i1: Math.min(n - 1, Math.ceil((Math.min(r.maxX, H) + G) / BLOCK) - 1),
    k0: Math.max(0, Math.floor((Math.max(r.minZ, -H) + G) / BLOCK)),
    k1: Math.min(n - 1, Math.ceil((Math.min(r.maxZ, H) + G) / BLOCK) - 1),
  });
  const fill = (r: Rect, into = inside) => {
    const { i0, i1, k0, k1 } = blocksOf(r);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) into[k * n + i] = 1;
  };
  const copy = (a: Uint8Array) => {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        if (!a[k * n + i]) continue;
        a[tBlock(sym, n, i, k)] = 1;
        if (sym === 'mirror') { a[k * n + (n - 1 - i)] = 1; a[tBlock(sym, n, n - 1 - i, k)] = 1; }
      }
    }
  };
  /** The block range of the play area (the ring outside it is never inside) */
  const lo = (G - H) / BLOCK;
  const hi = n - 1 - lo;
  const at = (i: number, k: number) => i >= 0 && k >= 0 && i < n && k < n && inside[k * n + i] === 1;
  /** Set a block in red's half (and its left-right twin on a mirrored map) */
  const set = (i: number, k: number, v: number) => {
    inside[k * n + i] = v;
    if (sym === 'mirror') inside[k * n + (n - 1 - i)] = v;
  };

  // Red's base: further off the middle line under a half turn, on it when mirrored.
  const bx = sym === 'rotate' ? q(rng.range(-0.3, 0.3) * H) : 0;
  const zb = P.baseZ;
  const midR = H * 0.15;

  // The middle band, across the middle line.
  const mw = H * rng.range(0.45, 0.9);
  const md = Math.max(midR + 6, H * rng.range(0.16, 0.3));
  fill({ minX: -mw, maxX: mw, minZ: -md, maxZ: md });
  fill({ minX: -midR - 4, maxX: midR + 4, minZ: -midR - 4, maxZ: midR + 4 }, keep);

  // The base yard.
  const bw = P.baseR + rng.range(5, 14);
  const yard = { minX: bx - bw, maxX: bx + bw, minZ: zb - P.baseR - rng.range(5, 10), maxZ: zb + P.baseR + rng.range(3, 9) };
  fill(yard);
  fill({ minX: bx - P.baseR - 3, maxX: bx + P.baseR + 3, minZ: zb - P.baseR - 3, maxZ: zb + P.baseR + 3 }, keep);

  // Bars from the middle band up to the yard: one wide block, two arms round a solid middle, an S...
  const bars = rng.int(1, 3);
  for (let b = 0; b < bars; b++) {
    const w = rng.range(20, Math.max(24, H * 0.9));
    const cx = rng.range(-0.7, 0.7) * H;
    const bar = { minX: cx - w / 2, maxX: cx + w / 2, minZ: rng.range(0, md * 0.8), maxZ: rng.range(yard.minZ + 4, yard.maxZ) };
    fill(bar);
    // A bar beside the yard reaches it along a street.
    if (bar.maxX < yard.minX || bar.minX > yard.maxX) {
      const sz = rng.range(yard.minZ + 6, Math.min(yard.maxZ, bar.maxZ) - 6);
      fill({ minX: Math.min(bar.minX + 4, bx), maxX: Math.max(bar.maxX - 4, bx), minZ: sz - 6, maxZ: sz + 6 });
    }
  }
  // Cross streets.
  for (let s = rng.int(0, 2); s > 0; s--) {
    const z = rng.range(md, zb);
    const a = rng.range(-0.95, 0.4) * H;
    fill({ minX: a, maxX: a + rng.range(0.4, 1) * H, minZ: z - rng.range(5, 9), maxZ: z + rng.range(5, 9) });
  }
  copy(inside);
  copy(keep);

  // Wings: a rectangle sticking out of the shape somewhere in red's half.
  for (let made = 0, want = rng.int(0, 3), attempt = 0; made < want && attempt < 40; attempt++) {
    const i = rng.int(lo, hi);
    const k = rng.int(n / 2, hi);
    const [di, dk] = rng.pick(SIDES);
    if (!at(i, k) || at(i + di, k + dk)) continue;
    const long = rng.int(2, 5);
    const deep = rng.int(2, 4);
    const shift = rng.int(-(long - 1), 0);
    for (let a = 1; a <= deep; a++) {
      for (let b = shift; b < shift + long; b++) {
        const bi = di ? i + di * a : i + b;
        const bk = dk ? k + dk * a : k + b;
        if (bi >= lo && bk >= n / 2 && bi <= hi && bk <= hi) set(bi, bk, 1);
      }
    }
    made++;
  }
  // Notches: a bite out of an edge, never round the base or the middle.
  for (let made = 0, want = rng.int(0, 3), attempt = 0; made < want && attempt < 40; attempt++) {
    const i = rng.int(lo, hi);
    const k = rng.int(n / 2, hi);
    const [di, dk] = rng.pick(SIDES);
    if (at(i, k) || !at(i - di, k - dk)) continue;
    const long = rng.int(2, 4);
    const deep = rng.int(1, 3);
    const shift = rng.int(-(long - 1), 0);
    const bite: number[] = [];
    for (let a = 0; a < deep; a++) {
      for (let b = shift; b < shift + long; b++) {
        const bi = di ? i - di * a : i + b;
        const bk = dk ? k - dk * a : k + b;
        if (bi >= 0 && bk >= n / 2 && bi < n && bk < n) bite.push(bk * n + bi);
      }
    }
    if (bite.some((c) => keep[c])) continue;
    for (const c of bite) set(c % n, Math.floor(c / n), 0);
    made++;
  }
  // Wings and notches were made in red's half only: rebuild blue's from it.
  for (let k = 0; k < n / 2; k++) for (let i = 0; i < n; i++) inside[k * n + i] = 0;
  copy(inside);
  for (let b = 0; b < n * n; b++) if (keep[b]) inside[b] = 1;

  tidy(inside, keep, n);
  return { outline: { cell: BLOCK, n, half: G, inside }, base: { x: bx, z: zb } };
}

/**
 * No spurs a block thin, no one-block slits or holes, and nothing left that isn't joined to the
 * middle. Every step treats both halves alike, so the shape keeps its symmetry.
 */
function tidy(inside: Uint8Array, keep: Uint8Array, n: number): void {
  const at = (i: number, k: number) => i >= 0 && k >= 0 && i < n && k < n && inside[k * n + i] === 1;
  // Spurs (deleting can only thin others, so the result doesn't depend on the order).
  for (let pruned = true; pruned;) {
    pruned = false;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const b = k * n + i;
      if (!inside[b] || keep[b]) continue;
      if ((!at(i - 1, k) && !at(i + 1, k)) || (!at(i, k - 1) && !at(i, k + 1))) { inside[b] = 0; pruned = true; }
    }
  }
  // Slits: an outside block between two inside ones, across or along.
  for (let filled = true; filled;) {
    filled = false;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const b = k * n + i;
      if (inside[b]) continue;
      if ((at(i - 1, k) && at(i + 1, k)) || (at(i, k - 1) && at(i, k + 1))) { inside[b] = 1; filled = true; }
    }
  }
  // Small holes are filled; a big one stays, a solid block in the middle of the map.
  const region = new Int32Array(n * n).fill(-1);
  for (let s = 0; s < n * n; s++) {
    if (inside[s] || region[s]! >= 0) continue;
    const cells = [s];
    region[s] = s;
    let edge = false;
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h]!;
      const i = c % n;
      const k = (c - i) / n;
      if (i === 0 || k === 0 || i === n - 1 || k === n - 1) edge = true;
      for (const [di, dk] of SIDES) {
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
        const d = nk * n + ni;
        if (inside[d] || region[d]! >= 0) continue;
        region[d] = s;
        cells.push(d);
      }
    }
    if (!edge && cells.length < 4) for (const c of cells) inside[c] = 1;
  }
  // Only what's joined to the middle.
  const joined = new Uint8Array(n * n);
  const queue = [(n / 2) * n + n / 2];
  joined[queue[0]!] = 1;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    const i = c % n;
    const k = (c - i) / n;
    for (const [di, dk] of SIDES) {
      const ni = i + di;
      const nk = k + dk;
      if (!at(ni, nk) || joined[nk * n + ni]) continue;
      joined[nk * n + ni] = 1;
      queue.push(nk * n + ni);
    }
  }
  for (let b = 0; b < n * n; b++) if (!joined[b]) inside[b] = 0;
}

/**
 * Solid blocks in the dead ground between the lanes, once they're routed: a building or a crag in
 * the middle of the map, with the lanes going round it. Only where every feature stays at least
 * `clear` metres away, and only with the shape all round it.
 */
export function carveBlocks(o: Outline, g: Graph, rng: Rng, clear = 3): void {
  const { n, cell, half, inside } = o;
  const discs: [number, number, number][] = [];
  const path = (samples: readonly LaneSample[]) => { for (const p of samples) discs.push([p.x, p.z, p.w / 2]); };
  for (const l of g.lanes) path(l.samples);
  for (const c of g.connectors) path(c.samples);
  discs.push([g.base.x, g.base.z, g.base.r], [0, 0, g.mid.r]);
  for (const ov of g.overlooks) discs.push([ov.x, ov.z, 5]);
  // Red's features only: a block in red's half is clear of blue's by the middle line's margin.
  const free = new Uint8Array(n * n);
  for (let k = n / 2; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!inside[k * n + i]) continue;
      const x0 = -half + i * cell;
      const z0 = -half + k * cell;
      free[k * n + i] = discs.every(([x, z, r]) => len(Math.max(x0 - x, 0, x - x0 - cell), Math.max(z0 - z, 0, z - z0 - cell)) >= r + clear) ? 1 : 0;
    }
  }
  const sym = g.sym;
  const twin = (i: number) => (sym === 'mirror' ? n - 1 - i : i);
  const ok = (i: number, k: number) => k >= n / 2 && i >= 0 && i < n && k < n && free[k * n + i] === 1 && free[k * n + twin(i)] === 1;
  const isIn = (i: number, k: number) => i >= 0 && k >= 0 && i < n && k < n && inside[k * n + i] === 1;
  for (let made = 0, want = rng.int(0, 2), attempt = 0; made < want && attempt < 60; attempt++) {
    const w = rng.int(2, 3);
    const d = rng.int(2, 3);
    const i = rng.int(0, n - w);
    const k = rng.int(n / 2 + 1, n - d);
    let fits = true;
    for (let b = -1; b <= d && fits; b++) {
      for (let a = -1; a <= w && fits; a++) {
        const core = a >= 0 && b >= 0 && a < w && b < d;
        if (core ? !ok(i + a, k + b) : !isIn(i + a, k + b)) fits = false;
      }
    }
    if (!fits) continue;
    for (let b = 0; b < d; b++) {
      for (let a = 0; a < w; a++) {
        for (const bi of [i + a, twin(i + a)]) {
          free[(k + b) * n + bi] = 0;
          inside[(k + b) * n + bi] = 0;
          inside[tBlock(sym, n, bi, k + b)] = 0;
        }
      }
    }
    made++;
  }
}

type SkylineKind = 'smokestack' | 'spire' | 'watertower' | 'mast' | 'lighthouse' | 'crag';

/**
 * Skyline landmarks: one tall, unmistakable thing standing outside the shape behind each team's
 * side, different on the two sides (a smokestack over one half, a water tower over the other), each
 * with a bright top to draw the eye. The map plays the same for both teams, but wherever you stand
 * you can tell which half you're in and which way you face. Out of reach, so they change nothing in play.
 */
export function skyline(o: Outline, ground: Ground, style: EdgeStyle, rng: Rng): MapBox[] {
  const { n, cell, half } = o;
  const kinds: SkylineKind[] = style.kind === 'buildings' ? ['smokestack', 'spire', 'watertower', 'mast'] : ['lighthouse', 'mast', 'crag', 'watertower'];
  rng.shuffle(kinds);
  const deep = (i: number, k: number) => {
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const bi = i + a;
      const bk = k + b;
      if (bi >= 0 && bk >= 0 && bi < n && bk < n && o.inside[bk * n + bi]) return false;
    }
    return true;
  };
  const boxes: MapBox[] = [];
  for (const [side, kind] of [[1, kinds[0]!], [-1, kinds[1]!]] as const) {
    const spots: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const z = -half + (k + 0.5) * cell;
        // Behind the team's side of the map, not out level with the middle.
        if (z * side > half * 0.3 && deep(i, k)) spots.push([-half + (i + 0.5) * cell, z]);
      }
    }
    if (!spots.length) continue;
    const [x, z] = rng.pick(spots);
    const g = groundRange(ground, x - 2, x + 2, z - 2, z + 2);
    const y = Math.max(0, g.lo - 0.3);
    const h = g.hi + rng.range(26, 34) - y;
    const box = (w: number, by: number, bh: number, color: number, surface: BoxSurface, round = false): MapBox => ({
      x: q(x), z: q(z), w: q(w), d: q(w), y: q(by), h: q(bh), color, surface, ...(round ? { shape: 'cylinder' as const } : {}),
    });
    switch (kind) {
      case 'smokestack':
        boxes.push(box(3.4, y, h, 0x8a6a5a, 'brick', true), box(3.6, y + h - 4.5, 1.6, 0xe8e4dc, 'concrete', true), box(3.6, y + h - 1.4, 1.4, 0xd8402e, 'metal', true));
        break;
      case 'spire':
        boxes.push(box(4.5, y, h * 0.62, 0xd8cdb8, 'plaster'), box(2.8, y + h * 0.62, h * 0.26, 0xc9b79a, 'plaster'), box(1.2, y + h * 0.88, h * 0.12 + 1, 0xe0b040, 'metal'));
        break;
      case 'watertower':
        boxes.push(box(1.8, y, h * 0.75, 0x7d8597, 'metal', true), box(7.5, y + h * 0.75, h * 0.2, 0xe07a2e, 'metal', true), box(4, y + h * 0.95, 1.2, 0x9aa3ad, 'metal', true));
        break;
      case 'mast':
        boxes.push(box(1.3, y, h + 4, 0xb0b4b8, 'metal'), box(4.5, y + h * 0.55, 0.4, 0xb0b4b8, 'metal'), box(1.9, y + h + 4, 1.4, 0xe0302a, 'metal'));
        break;
      case 'lighthouse':
        boxes.push(box(4.6, y, h * 0.8, 0xe8e4dc, 'plaster', true), box(4.8, y + h * 0.4, 2.6, 0xc23b2e, 'plaster', true), box(3.4, y + h * 0.8, 2.6, 0xf2d24a, 'metal', true), box(4.2, y + h * 0.8 + 2.6, 1.2, 0xc23b2e, 'metal', true));
        break;
      case 'crag':
        boxes.push(box(9, y, h * 0.45, 0x8d8a80, 'rock'), box(6, y + h * 0.45, h * 0.3, 0x96907f, 'rock'), box(3.4, y + h * 0.75, h * 0.25, 0x7f7c72, 'rock'), box(0.5, y + h, 3, 0xe0302a, 'metal'));
        break;
    }
  }
  return boxes;
}

/** Whether (x, z) is inside the shape (null outline: the whole square) */
export function insideOutline(o: Outline | null, half: number, x: number, z: number): boolean {
  if (!o) return Math.abs(x) <= half && Math.abs(z) <= half;
  const i = Math.floor((x + o.half) / o.cell);
  const k = Math.floor((z + o.half) / o.cell);
  return i >= 0 && k >= 0 && i < o.n && k < o.n && o.inside[k * o.n + i] === 1;
}

/** Whether all of `r`, grown by `by`, is inside the shape */
export function rectInside(o: Outline, r: Rect, by: number): boolean {
  const i0 = Math.floor((r.minX - by + o.half) / o.cell);
  const i1 = Math.floor((r.maxX + by + o.half - 1e-6) / o.cell);
  const k0 = Math.floor((r.minZ - by + o.half) / o.cell);
  const k1 = Math.floor((r.maxZ + by + o.half - 1e-6) / o.cell);
  if (i0 < 0 || k0 < 0 || i1 >= o.n || k1 >= o.n) return false;
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (!o.inside[k * o.n + i]) return false;
  return true;
}

/** Share of the play area (the square inside the ring) inside the shape */
export function insideShare(o: Outline, playHalf: number): number {
  const lo = Math.floor((o.half - playHalf) / o.cell);
  const hi = o.n - lo;
  let count = 0;
  for (let k = lo; k < hi; k++) for (let i = lo; i < hi; i++) count += o.inside[k * o.n + i]!;
  return count / ((hi - lo) * (hi - lo));
}

/** A shape filling more of the square than this is too close to a square, and is redrawn */
export const MAX_SHARE = 0.8;

/** Everything outside the shape as rectangles (runs of outside blocks along each row), for an invisible boundary */
export function outsideRects(o: Outline): Rect[] {
  const { n, cell, half } = o;
  const out: Rect[] = [];
  for (let k = 0; k < n; k++) {
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const outside = i < n && o.inside[k * n + i] === 0;
      if (outside && start < 0) start = i;
      if (!outside && start >= 0) {
        out.push({ minX: -half + start * cell, maxX: -half + i * cell, minZ: -half + k * cell, maxZ: -half + (k + 1) * cell });
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Distance from each vertex of a 1 m grid over the square to the nearest outside block (0 on the
 * edge of the shape or outside it), up to `cap`.
 */
export function edgeDistance(o: Outline, cap: number): Float64Array {
  const { n, cell, half } = o;
  const side = Math.round(half * 2) + 1;
  const d = new Float64Array(side * side);
  const reach = Math.ceil(cap / cell) + 1;
  const outAt = (i: number, k: number) => i < 0 || k < 0 || i >= n || k >= n || o.inside[k * n + i] === 0;
  // The nearest outside spot is always on an outside block beside an inside one, so each block
  // keeps a list of those within reach (the ring round the grid keeps its edge further away).
  const rim: number[] = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (outAt(i, k) && (!outAt(i - 1, k) || !outAt(i + 1, k) || !outAt(i, k - 1) || !outAt(i, k + 1))) rim.push(k * n + i);
    }
  }
  const near: number[][] = Array.from({ length: n * n }, () => []);
  for (const r of rim) {
    const ri = r % n;
    const rk = (r - ri) / n;
    for (let k = Math.max(0, rk - reach); k <= Math.min(n - 1, rk + reach); k++) {
      for (let i = Math.max(0, ri - reach); i <= Math.min(n - 1, ri + reach); i++) near[k * n + i]!.push(r);
    }
  }
  for (let iz = 0; iz < side; iz++) {
    const z = -half + iz;
    const bk = Math.min(n - 1, Math.floor(iz / cell));
    for (let ix = 0; ix < side; ix++) {
      const x = -half + ix;
      const bi = Math.min(n - 1, Math.floor(ix / cell));
      // On or in an outside block (a vertex on a block's corner touches up to four).
      const ei = ix % cell === 0 ? bi - 1 : bi;
      const ek = iz % cell === 0 ? bk - 1 : bk;
      if (outAt(bi, bk) || outAt(ei, bk) || outAt(bi, ek) || outAt(ei, ek)) continue;
      let best = cap;
      for (const r of near[bk * n + bi]!) {
        const x0 = -half + (r % n) * cell;
        const z0 = -half + Math.floor(r / n) * cell;
        best = Math.min(best, len(Math.max(x0 - x, 0, x - x0 - cell), Math.max(z0 - z, 0, z - z0 - cell)));
      }
      d[iz * side + ix] = best;
    }
  }
  return d;
}

/** Team colors on the edge: each half wears its team's, the same way everywhere, so players always know whose side they're on */
export const TEAM_ACCENT = { red: 0xc0392b, blue: 0x2e6fd8 } as const;

/** A face of an edge mass that looks into the map: the line it's on, its span, and which way it faces */
interface Face { axis: 'x' | 'z'; at: number; from: number; to: number; out: 1 | -1 }

/**
 * What a face shows the players. Buildings: ribbon windows on every storey, sometimes a door, and a
 * stripe in the team's color, so they read as real buildings lining the streets. Cliffs: now and
 * then a banner in the team's color. Details stand a few centimetres proud of the face.
 */
function faceDetails(f: Face, ground: Ground, top: number, style: EdgeStyle, rng: Rng): { boxes: MapBox[]; accents: MapBox[] } {
  const boxes: MapBox[] = [];
  const accents: MapBox[] = [];
  const along = (from: number, to: number, y: number, h: number, depth: number, color: number, surface: BoxSurface): MapBox => {
    const mid = (from + to) / 2;
    const c = f.at + (f.out * depth) / 2;
    return f.axis === 'x'
      ? { x: q(c), z: q(mid), w: q(depth), d: q(to - from), y: q(y), h: q(h), color, surface }
      : { x: q(mid), z: q(c), w: q(to - from), d: q(depth), y: q(y), h: q(h), color, surface };
  };
  const groundAt = (a: number, b: number) => (f.axis === 'x'
    ? groundRange(ground, f.at - 0.5, f.at + 0.5, a, b)
    : groundRange(ground, a, b, f.at - 0.5, f.at + 0.5));
  const span = f.to - f.from;
  const g = groundAt(f.from, f.to);
  if (style.kind === 'buildings') {
    for (let y = g.hi + 1.3; y + 1.1 < top - 0.8; y += 3.4) boxes.push(along(f.from + 0.6, f.to - 0.6, y, 1.1, 0.12, 0x2a3440, 'metal'));
    if (span >= 4 && rng.chance(0.5)) {
      const at = rng.range(f.from + 1.2, f.to - 1.2);
      const dg = groundAt(at - 0.8, at + 0.8);
      boxes.push(along(at - 0.8, at + 0.8, Math.max(0, dg.lo - 0.1), dg.hi - Math.max(0, dg.lo - 0.1) + 2.4, 0.16, 0x5a4330, 'planks'));
    }
    if (rng.chance(0.6) && top - g.hi > 4) accents.push(along(f.from + 0.2, f.to - 0.2, g.hi + 2.75, 0.4, 0.18, TEAM_ACCENT.red, 'concrete'));
  } else if (span >= 4 && rng.chance(0.35) && top - g.hi > 6) {
    const at = rng.range(f.from + 1, f.to - 1);
    accents.push(along(at - 0.7, at + 0.7, g.hi + 2, 3.2, 0.15, TEAM_ACCENT.red, 'plaster'));
  }
  return { boxes, accents };
}

/**
 * What stands outside the shape: buildings or cliffs over every outside block, in rectangles of up
 * to a few blocks (so the skyline varies), each standing clear of the highest ground under it and
 * sometimes with a smaller, taller part on top, and detailed on the faces the players see. Built in
 * red's half and copied, with blue's half in blue's color.
 */
export function edgeMasses(o: Outline, ground: Ground, sym: Symmetry, style: EdgeStyle, rng: Rng): MapBox[] {
  const { n, cell, half } = o;
  const taken = new Uint8Array(n * n);
  const free = (i: number, k: number) => i < n && k < n && !o.inside[k * n + i] && !taken[k * n + i];
  const boxes: MapBox[] = [];
  for (let k = n / 2; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!free(i, k)) continue;
      // Grow along x, then along z while the whole row is free.
      let w = 1;
      const maxW = rng.int(1, 4);
      while (w < maxW && free(i + w, k)) w++;
      let d = 1;
      const maxD = rng.int(1, 4);
      while (d < maxD && k + d < n && Array.from({ length: w }, (_, a) => free(i + a, k + d)).every(Boolean)) d++;
      for (let b = 0; b < d; b++) for (let a = 0; a < w; a++) taken[(k + b) * n + i + a] = 1;
      const minX = -half + i * cell;
      const minZ = -half + k * cell;
      const g = groundRange(ground, minX, minX + w * cell, minZ, minZ + d * cell);
      const top = g.hi + rng.range(style.height[0], style.height[1]) * (style.kind === 'cliffs' ? rng.range(0.8, 1.15) : 1);
      const surface = rng.pick(style.surfaces);
      const color = rng.pick(style.colors);
      const part: MapBox[] = [{
        x: q(minX + (w * cell) / 2), z: q(minZ + (d * cell) / 2), w: q(w * cell), d: q(d * cell),
        y: q(Math.max(0, g.lo - 0.3)), h: q(top - Math.max(0, g.lo - 0.3)), color, surface,
      }];
      // A tier on top, set back from the sides: a roof storey, or a cliff's second step.
      if (w * d >= 2 && rng.chance(style.kind === 'cliffs' ? 0.6 : 0.35)) {
        const inset = style.kind === 'cliffs' ? rng.range(1, 2.5) : rng.range(0.8, 1.6);
        const tw = w * cell - inset * 2;
        const td = d * cell - inset * 2;
        if (tw > 2 && td > 2) {
          part.push({
            x: q(minX + (w * cell) / 2 + rng.range(-0.5, 0.5)), z: q(minZ + (d * cell) / 2 + rng.range(-0.5, 0.5)), w: q(tw), d: q(td),
            y: q(top), h: q(rng.range(2, style.kind === 'cliffs' ? 5 : 4)), color: style.kind === 'cliffs' ? color : rng.pick(style.colors), surface,
          });
        }
      }
      // The faces that look into the map.
      const inAt = (bi: number, bk: number) => bi >= 0 && bk >= 0 && bi < n && bk < n && o.inside[bk * n + bi] === 1;
      const anyIn = (cells: [number, number][]) => cells.some(([bi, bk]) => inAt(bi, bk));
      const rows = Array.from({ length: d }, (_, b) => k + b);
      const cols = Array.from({ length: w }, (_, a) => i + a);
      const faces: Face[] = [];
      if (anyIn(rows.map((bk) => [i - 1, bk]))) faces.push({ axis: 'x', at: minX, from: minZ, to: minZ + d * cell, out: -1 });
      if (anyIn(rows.map((bk) => [i + w, bk]))) faces.push({ axis: 'x', at: minX + w * cell, from: minZ, to: minZ + d * cell, out: 1 });
      if (anyIn(cols.map((bi) => [bi, k - 1]))) faces.push({ axis: 'z', at: minZ, from: minX, to: minX + w * cell, out: -1 });
      if (anyIn(cols.map((bi) => [bi, k + d]))) faces.push({ axis: 'z', at: minZ + d * cell, from: minX, to: minX + w * cell, out: 1 });
      const accents: MapBox[] = [];
      for (const f of faces) {
        const det = faceDetails(f, ground, top, style, rng);
        part.push(...det.boxes);
        accents.push(...det.accents);
      }
      boxes.push(...part, ...accents, ...tPiece(sym, { boxes: part }).boxes);
      boxes.push(...tPiece(sym, { boxes: accents }).boxes.map((b) => ({ ...b, color: TEAM_ACCENT.blue })));
    }
  }
  return boxes;
}
