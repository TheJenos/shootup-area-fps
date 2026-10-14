/**
 * The map's shape, from the route: every used maze cell becomes a corridor, open into the next
 * cell wherever the route passes, then open areas (blobs) grow out round parts of the path and the
 * base, and everything else is solid (buildings or cliffs, edge.ts).
 *
 * The shape is a grid of BLOCK-sized blocks. A maze cell is CELL blocks. Corridors run CORRIDOR blocks
 * wide along the route's centre lines, smoothed so every bend is a curve, which leaves two blocks of
 * wall between corridors side by side unless the route joins them. Blobs keep it that way: every open block carries
 * how far along the route it is, and a blob never opens a block next to one much further along or
 * further back, so it can't join two parts of the path into a shortcut (the loops are the only ones).
 *
 * Red's half is laid out, then copied under the map's symmetry.
 */

import { len, segDistance, type Rect } from './dmath';
import { around, joined } from './maze';
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
  /** The route's smoothed centre lines in red's half: [x, z, steps along the route] */
  lines: RouteLine[];
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

export interface RouteLine {
  role: 'main' | 'lane' | 'pocket' | 'loop';
  points: [number, number, number][];
}

/** Corner cutting (Chaikin): each pass replaces every corner with two points a quarter of the way along its sides */
function smooth(points: [number, number, number][], passes = 3): [number, number, number][] {
  let pts = points;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) return pts;
    const out: [number, number, number][] = [pts[0]!];
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1]!;
      const b = pts[j]!;
      const mix = (t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (j > 1) out.push(mix(0.25));
      if (j < pts.length - 1) out.push(mix(0.75));
    }
    out.push(pts[pts.length - 1]!);
    pts = out;
  }
  return pts;
}

/** The route's centre lines through the cell centres, smoothed: the main path and each lane into the band, each pocket from where it leaves the path, each loop */
export function routeLines(P: SizeParams, route: Route): RouteLine[] {
  const at = (c: number): [number, number, number] => [...cellCentre(P, c), route.label[c]!];
  const main = route.main.map(at);
  const cross = route.main[route.main.length - 1]!;
  main.push([cellCentre(P, cross)[0], 0, route.label[cross]!]);
  const lines: RouteLine[] = [{ role: 'main', points: smooth(main) }];
  // Each lane from where it leaves the main path, down into the band.
  for (const lane of route.lanes) {
    const from = route.main.find((c) => around(route.maze, lane[0]!).includes(c) && joined(route.maze, c, lane[0]!));
    const end = lane[lane.length - 1]!;
    const pts = [...(from !== undefined ? [at(from)] : []), ...lane.map(at), [cellCentre(P, end)[0], 0, route.label[end]!] as [number, number, number]];
    lines.push({ role: 'lane', points: smooth(pts) });
  }
  for (const p of route.pockets) {
    const from = around(route.maze, p[0]!).find((c) => route.kind[c] !== KIND.none && route.kind[c] !== KIND.pocket && joined(route.maze, c, p[0]!));
    lines.push({ role: 'pocket', points: smooth([...(from !== undefined ? [at(from)] : []), ...p.map(at)]) });
  }
  for (const l of route.loops) lines.push({ role: 'loop', points: smooth(l.cells.map(at)) });
  return lines;
}

export function buildLayout(rng: Rng, sym: Symmetry, P: SizeParams, route: Route): Layout {
  const half = mapHalf(P);
  const n = (half * 2) / BLOCK;
  const mid = n / 2;
  const tag = new Uint8Array(n * n);
  const step = new Float32Array(n * n).fill(-1);
  const { label } = route;
  const at = (i: number, k: number) => k * n + i;
  const open = (b: number, t: Tag, s: number) => {
    if (tag[b] === TAG.core || (tag[b] === TAG.corridor && t !== TAG.core)) return;
    tag[b] = t;
    step[b] = step[b]! < 0 ? s : Math.min(step[b]!, s);
  };

  // Corridors along the route's smoothed centre lines: CORRIDOR blocks wide, the middle strip (core)
  // half that, so every bend is a curve rather than a corner.
  const lines = routeLines(P, route);
  const halfWidth = (CORRIDOR * BLOCK) / 2;
  const coreHalf = halfWidth / 2;
  const [a, b_] = route.band;
  const [bandA] = cellCentre(P, a);
  const [bandB] = cellCentre(P, b_);
  // Up to the last block short of row 1's wall.
  const bandR = (CELL - 1) * BLOCK - 1;
  // Each segment stamps the blocks within reach of it: the nearest line decides a block's step.
  const nearest = new Float64Array(n * n).fill(Infinity);
  const nearStep = new Float32Array(n * n);
  for (const l of lines) {
    const pts = l.points;
    for (let j = 1; j < pts.length; j++) {
      const [ax, az, as] = pts[j - 1]!;
      const [cx, cz, cs] = pts[j]!;
      const i0 = Math.max(0, Math.floor((Math.min(ax, cx) - halfWidth + half) / BLOCK));
      const i1 = Math.min(n - 1, Math.floor((Math.max(ax, cx) + halfWidth + half) / BLOCK));
      const k0 = Math.max(mid, Math.floor((Math.min(az, cz) - halfWidth + half) / BLOCK));
      const k1 = Math.min(n - 1, Math.floor((Math.max(az, cz) + halfWidth + half) / BLOCK));
      for (let k = k0; k <= k1; k++) {
        const bz = -half + (k + 0.5) * BLOCK;
        for (let i = i0; i <= i1; i++) {
          const hit = segDistance(-half + (i + 0.5) * BLOCK, bz, ax, az, cx, cz);
          const b = at(i, k);
          if (hit.d < nearest[b]!) { nearest[b] = hit.d; nearStep[b] = as + (cs - as) * hit.t; }
        }
      }
    }
  }
  for (let k = mid; k < n; k++) {
    const bz = -half + (k + 0.5) * BLOCK;
    for (let i = 0; i < n; i++) {
      const b = at(i, k);
      if (nearest[b]! <= coreHalf) open(b, TAG.core, nearStep[b]!);
      else if (nearest[b]! <= halfWidth) open(b, TAG.corridor, nearStep[b]!);
      // The band: a rounded plaza across the middle line, from the crossing to its copy's.
      if (bz > bandR) continue;
      const toBand = segDistance(-half + (i + 0.5) * BLOCK, bz, bandA, 0, bandB, 0);
      if (toBand.d <= bandR) open(b, TAG.band, label[Math.round(a + (b_ - a) * toBand.t)]!);
    }
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

  // Blobs: along every route, not just the main path. Each route offers its bends first, then the
  // rest of its cells; the routes take turns, so every lane, loop and pocket opens up somewhere.
  const bendsOf = (cells: readonly number[]) => cells.filter((c, i) => i > 0 && i < cells.length - 1 && c - cells[i - 1]! !== cells[i + 1]! - c);
  const offers = (cells: readonly number[]) => {
    const bends = bendsOf(cells);
    return [...rng.shuffle([...bends]), ...rng.shuffle(cells.filter((c) => !bends.includes(c)))];
  };
  const queues = [
    offers(route.main.slice(1)),
    ...route.lanes.map((lane) => offers(lane)),
    ...route.loops.map((l) => offers(l.cells)),
    ...route.pockets.map((p) => [p[p.length - 1]!]),
  ];
  const seeds: number[] = [];
  for (let round = 0; queues.some((q) => round < q.length); round++) for (const q of queues) if (round < q.length) seeds.push(q[round]!);
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

  return { sym, outline: { cell: BLOCK, n, half, inside }, tag, step, base: { x: fx, z: fz }, lines, blobs, route };
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
