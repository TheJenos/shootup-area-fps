/**
 * The map's shape, from the route: every used maze cell becomes a corridor, open into the next
 * cell wherever the route passes, then open areas (blobs) grow out round parts of the path and the
 * base, and everything else is solid (buildings or cliffs, edge.ts).
 *
 * The shape is a grid of BLOCK-sized blocks. A maze cell is CELL blocks: a corridor CORRIDOR blocks
 * wide down its middle and a block of wall on each side, so two corridors side by side are always
 * two blocks apart unless the route joins them. Blobs keep it that way: every open block carries
 * how far along the route it is, and a blob never opens a block next to one much further along or
 * further back, so it can't join two parts of the path into a shortcut (the loops are the only ones).
 *
 * Red's half is laid out, then copied under the map's symmetry.
 */

import { len, type Rect } from './dmath';
import { KIND, type Route } from './route';
import type { Rng } from './rng';
import type { SizeParams } from './spec';
import type { Symmetry } from './symmetry';

/** Block size (m) */
export const BLOCK = 2;
/** Blocks per maze cell, and the corridor's width in it */
export const CELL = 6;
const CORRIDOR = 4;
/** Solid blocks round the maze */
const RING = 2;
/** Biggest difference in route steps between two open blocks that touch */
const STEP_LIMIT = 2;

export interface Outline {
  /** Block size (m) */
  cell: number;
  /** Blocks per side (even, so block edges run along the middle line) */
  n: number;
  half: number;
  /** n² flags, row by row along z (row 0 at z = -half), each row along x: 1 = inside */
  inside: Uint8Array;
}

/** What each block is */
export const TAG = { outside: 0, core: 1, corridor: 2, blob: 3, yard: 4, band: 5 } as const;
export type Tag = (typeof TAG)[keyof typeof TAG];

export interface Layout {
  sym: Symmetry;
  outline: Outline;
  /** Per block: TAG. `core` is the middle strip of every corridor, kept clear so there's always a way through. */
  tag: Uint8Array;
  /** Per block: steps along the route from the base (-1 outside) */
  step: Float32Array;
  /** Red's flag */
  base: { x: number; z: number };
  /** Blobs in red's half: their blocks */
  blobs: { cells: number[]; x: number; z: number }[];
  route: Route;
}

/** Half the map's width for a size */
export const mapHalf = (P: SizeParams): number => ((P.cols * CELL + RING * 2) * BLOCK) / 2;

/** Centre of maze cell c (red's half) */
export function cellCentre(P: SizeParams, c: number): [number, number] {
  const half = mapHalf(P);
  const x = c % P.cols;
  const r = (c - x) / P.cols;
  return [-half + (RING + x * CELL + CELL / 2) * BLOCK, (r * CELL + CELL / 2) * BLOCK];
}

/** The other team's copy of block (i, k) */
export const tBlock = (sym: Symmetry, n: number, i: number, k: number): number =>
  sym === 'rotate' ? (n - 1 - k) * n + (n - 1 - i) : (n - 1 - k) * n + i;

/** Value noise on a lattice of seeded random numbers, smoothly interpolated: -1..1 */
export function valueNoise(rng: Rng, size = 32): (x: number, z: number) => number {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next() * 2 - 1;
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

export function buildLayout(rng: Rng, sym: Symmetry, P: SizeParams, route: Route): Layout {
  const half = mapHalf(P);
  const n = (half * 2) / BLOCK;
  const mid = n / 2;
  const tag = new Uint8Array(n * n);
  const step = new Float32Array(n * n).fill(-1);
  const { cols, maze, kind, label } = route;
  const at = (i: number, k: number) => k * n + i;
  /** Block (i, k) of cell c at offset (ox, oz) */
  const blockOf = (c: number, ox: number, oz: number) => at(RING + (c % cols) * CELL + ox, mid + Math.floor(c / cols) * CELL + oz);
  const open = (b: number, t: Tag, s: number) => {
    if (tag[b] === TAG.core || (tag[b] === TAG.corridor && t !== TAG.core)) return;
    tag[b] = t;
    step[b] = step[b]! < 0 ? s : Math.min(step[b]!, s);
  };

  // Corridors through every used cell, and through the walls the route passes.
  const lo = (CELL - CORRIDOR) / 2;
  const hi = lo + CORRIDOR - 1;
  for (let c = cols; c < cols * route.rows; c++) {
    if (kind[c] === KIND.none) continue;
    const s = label[c]!;
    for (let oz = lo; oz <= hi; oz++) for (let ox = lo; ox <= hi; ox++) open(blockOf(c, ox, oz), TAG.corridor, s);
    for (const [e, dx] of [[c + 1, 1], [c + cols, 0]] as const) {
      if (e >= cols * route.rows || (dx && (c % cols) === cols - 1) || kind[e] === KIND.none) continue;
      const joinedTo = dx ? (maze.open[c]! & 1) !== 0 : (maze.open[c]! & 2) !== 0;
      if (!joinedTo) continue;
      const se = Math.min(s, label[e]!) + 0.5;
      for (let a = lo; a <= hi; a++) {
        if (dx) { open(blockOf(c, CELL - 1, a), TAG.corridor, se); open(blockOf(e, 0, a), TAG.corridor, se); }
        else { open(blockOf(c, a, CELL - 1), TAG.corridor, se); open(blockOf(e, a, 0), TAG.corridor, se); }
      }
    }
  }
  // The core: the middle two blocks of each corridor, through the passages too.
  const coreLo = CELL / 2 - 1;
  const coreHi = CELL / 2;
  for (let c = cols; c < cols * route.rows; c++) {
    if (kind[c] === KIND.none) continue;
    const s = label[c]!;
    for (let oz = coreLo; oz <= coreHi; oz++) for (let ox = coreLo; ox <= coreHi; ox++) open(blockOf(c, ox, oz), TAG.core, s);
    for (const e of [c + 1, c - 1, c + cols, c - cols]) {
      if (e < 0 || e >= cols * route.rows || kind[e] === KIND.none) continue;
      if (Math.abs(e - c) === 1 && Math.floor(e / cols) !== Math.floor(c / cols)) continue;
      const a = Math.min(c, e);
      const joinedTo = Math.abs(e - c) === 1 ? (maze.open[a]! & 1) !== 0 : (maze.open[a]! & 2) !== 0;
      if (!joinedTo) continue;
      const dx = e - c === 1 ? 1 : e - c === -1 ? -1 : 0;
      const dz = e - c === cols ? 1 : e - c === -cols ? -1 : 0;
      // From the centre to this cell's edge on that side.
      for (let t = 1; t <= CELL / 2; t++) for (let o = coreLo; o <= coreHi; o++) {
        const ox = dx ? (dx > 0 ? coreHi + t : coreLo - t) : o;
        const oz = dz ? (dz > 0 ? coreHi + t : coreLo - t) : o;
        if (ox < 0 || oz < 0 || ox >= CELL || oz >= CELL) continue;
        open(blockOf(c, ox, oz), TAG.core, s);
      }
    }
  }

  // The band: the middle plaza, from the middle line up to the corridor's far side in row 0, and
  // the passage up into the crossing cell.
  const [a, b] = route.band;
  for (let i = RING + a * CELL + lo; i <= RING + b * CELL + hi; i++) {
    const s = label[Math.min(b, Math.max(a, Math.floor((i - RING) / CELL)))]!;
    for (let k = mid; k <= mid + hi; k++) open(at(i, k), TAG.band, s);
  }
  const cross = route.main[route.main.length - 1]!;
  for (let o = lo; o <= hi; o++) {
    open(blockOf(cross - cols, o, CELL - 1), TAG.corridor, label[cross]!);
    open(blockOf(cross, o, 0), TAG.corridor, label[cross]!);
  }

  /** Whether block (i, k) may open with route step s: in red's half, off the ring, nothing much further along beside it */
  const fits = (i: number, k: number, s: number) => {
    if (i < RING || i >= n - RING || k <= mid || k >= n - RING) return false;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const bi = i + di;
      const bk = k + dk;
      if (bi < 0 || bk < 0 || bi >= n || bk >= n) continue;
      const t = step[at(bi, bk)]!;
      if (t >= 0 && Math.abs(t - s) > STEP_LIMIT) return false;
    }
    return true;
  };

  /** Grow an open area round (x, z) from the blocks of route step s already open there */
  const noise = valueNoise(rng.fork('noise'), 32);
  const grow = (x: number, z: number, radius: number, s: number, t: Tag): number[] => {
    const ci = Math.floor((x + half) / BLOCK);
    const ck = Math.floor((z + half) / BLOCK);
    const seen = new Uint8Array(n * n);
    const queue = [at(ci, ck)];
    seen[at(ci, ck)] = 1;
    const cells: number[] = [];
    for (let h = 0; h < queue.length; h++) {
      const c = queue[h]!;
      const i = c % n;
      const k = (c - i) / n;
      const bx = -half + (i + 0.5) * BLOCK;
      const bz = -half + (k + 0.5) * BLOCK;
      const wobble = t === TAG.yard ? 0 : noise(bx / 9, bz / 9) * 0.45;
      if (len(bx - x, bz - z) > radius * (1 + wobble)) continue;
      if (tag[c] === TAG.outside) {
        if (!fits(i, k, s)) continue;
        open(c, t, s);
        cells.push(c);
      } else if (Math.abs(step[c]! - s) > STEP_LIMIT) continue;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const d = at(i + di, k + dk);
        if (i + di < 0 || k + dk < 0 || i + di >= n || k + dk >= n || seen[d]) continue;
        seen[d] = 1;
        queue.push(d);
      }
    }
    return cells;
  };

  // The base yard, round the flag.
  const baseCell = route.main[0]!;
  const [fx, fz] = cellCentre(P, baseCell);
  grow(fx, fz, P.baseR, label[baseCell]!, TAG.yard);

  // Blobs: round bends of the path, pocket ends and loops, never two in the same place.
  const main = route.main;
  const bends = main.filter((c, i) => i > 0 && i < main.length - 1 && c - main[i - 1]! !== main[i + 1]! - c);
  const seeds = [
    ...rng.shuffle([...bends, main[1]!]),
    ...rng.shuffle(route.pockets.map((p) => p[p.length - 1]!)),
    ...rng.shuffle(route.loops.flatMap((l) => l.cells)),
  ];
  const blobs: Layout['blobs'] = [];
  const want = rng.int(P.blobs[0], P.blobs[1]);
  const taken: [number, number][] = [[fx, fz]];
  for (const c of seeds) {
    if (blobs.length >= want) break;
    const [x, z] = cellCentre(P, c);
    if (taken.some(([tx, tz]) => len(tx - x, tz - z) < CELL * BLOCK * 1.4)) continue;
    const cells = grow(x, z, rng.range(12, 20), label[c]!, TAG.blob);
    if (cells.length < 12) continue;
    taken.push([x, z]);
    blobs.push({ cells, x, z });
  }

  // Copy red's half.
  const inside = new Uint8Array(n * n);
  for (let k = mid; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const r = at(i, k);
      if (tag[r] !== TAG.outside) inside[r] = 1;
      const t = tBlock(sym, n, i, k);
      if (t === r) continue;
      inside[t] = inside[r]!;
      tag[t] = tag[r]!;
      step[t] = step[r]!;
    }
  }

  return { sym, outline: { cell: BLOCK, n, half, inside }, tag, step, base: { x: fx, z: fz }, blobs, route };
}

/** The tag of the block under (x, z) */
export function tagAt(l: Layout, x: number, z: number): number {
  const o = l.outline;
  const i = Math.floor((x + o.half) / o.cell);
  const k = Math.floor((z + o.half) / o.cell);
  return i < 0 || k < 0 || i >= o.n || k >= o.n ? TAG.outside : l.tag[k * o.n + i]!;
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

/** Whether any block under `r` has one of `tags` */
export function rectTouches(l: Layout, r: Rect, tags: readonly number[]): boolean {
  const o = l.outline;
  const i0 = Math.max(0, Math.floor((r.minX + o.half) / o.cell));
  const i1 = Math.min(o.n - 1, Math.floor((r.maxX + o.half - 1e-6) / o.cell));
  const k0 = Math.max(0, Math.floor((r.minZ + o.half) / o.cell));
  const k1 = Math.min(o.n - 1, Math.floor((r.maxZ + o.half - 1e-6) / o.cell));
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (tags.includes(l.tag[k * o.n + i]!)) return true;
  return false;
}

/** Everything outside the shape as rectangles (runs along rows, merged with identical runs below), for an invisible boundary */
export function outsideRects(o: Outline): Rect[] {
  const { n, cell, half } = o;
  const out: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let k = 0; k < n; k++) {
    const next = new Map<string, Rect>();
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const outside = i < n && o.inside[k * n + i] === 0;
      if (outside && start < 0) start = i;
      if (!outside && start >= 0) {
        const key = `${start}:${i}`;
        const prev = open.get(key);
        if (prev) {
          prev.maxZ = -half + (k + 1) * cell;
          next.set(key, prev);
          open.delete(key);
        } else {
          next.set(key, { minX: -half + start * cell, maxX: -half + i * cell, minZ: -half + k * cell, maxZ: -half + (k + 1) * cell });
        }
        start = -1;
      }
    }
    out.push(...open.values());
    open = next;
  }
  out.push(...open.values());
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
      for (let k = bk - reach; k <= bk + reach; k++) {
        for (let i = bi - reach; i <= bi + reach; i++) {
          if (!outAt(i, k)) continue;
          const x0 = -half + i * cell;
          const z0 = -half + k * cell;
          best = Math.min(best, len(Math.max(x0 - x, 0, x - x0 - cell), Math.max(z0 - z, 0, z - z0 - cell)));
        }
      }
      d[iz * side + ix] = best;
    }
  }
  return d;
}
