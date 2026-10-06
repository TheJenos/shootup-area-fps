/**
 * Terrain from the lane graph: the land is shaped by the design rather than noise laid over it.
 *
 * - Every lane, connector, base plateau, the middle and each overlook pad is a "feature" with a floor
 *   height (graph.ts). Inside a feature the ground is its floor.
 * - Away from the features the ground rises into ridges (with a little noise), so the ridge between
 *   two lanes hides each from the other, and toward the outer walls it rises into a rim.
 * - Some heights are pinned: the plateaus, the middle of every lane, and later the flat pad under
 *   each structure. Pinned heights are kept exactly, and everything else is pulled within reach
 *   of them so no slope is steeper than MAX_SLOPE: the lower and upper envelopes of the pins
 *   (L = max over pins of h - slope × distance, U = min of h + slope × distance), then a sweep
 *   that only lowers. Unlike the old terrain, this raises as well as lowers, so plateaus and ridges
 *   survive.
 *
 * Distances are octile (8-neighbour grid) distances, which the sweeps compute exactly and which
 * have a closed form for a rectangle, so a structure's pad can be added without a full sweep.
 */

import { len, q, smoothstep, type Rect } from './dmath';
import type { Graph, LaneSample } from './graph';
import type { Rng } from './rng';
import { tPoint, tVertex, type Symmetry } from './symmetry';
import { PAINT, type Ground } from './types';

/** Rise per metre along x or z (a triangle's steepest slope is at most √2 × this, ~40°, under the 55° you can climb) */
export const MAX_SLOPE = 0.6;
const CELL = 1;
const SQRT2 = 1.4142135623730951;
/** How far past a feature its influence is computed (beyond that, full ridge) */
const STAMP = 16;
const NONE = -1;

export const ZONE = {
  base: 0, lane: 1, choke: 2, mid: 3, connector: 4, overlook: 5, shoulder: 6, ridge: 7, edge: 8,
} as const;
export type ZoneId = (typeof ZONE)[keyof typeof ZONE];

export interface TerrainOptions {
  /** Ridge height above the neighbouring floor (m) */
  ridge: [number, number];
  /** Distance over which a ridge rises from a lane's edge (m) */
  rise: number;
  /** How much noise varies the ridges (0..1) */
  noise: number;
  /** Rim height at the outer walls, above the lane datum */
  rim: number;
}

/** Value noise on a lattice of seeded random numbers, smoothly interpolated. Returns -1..1. */
function valueNoise(rng: Rng, size: number): (x: number, z: number) => number {
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

/** Octile distance for gaps of dx and dz cells */
const octile = (dx: number, dz: number) => (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx);

export class Terrain {
  readonly n: number;
  readonly side: number;
  readonly half: number;
  readonly sym: Symmetry;
  /** The shape the ground wants (before the pins and slope limit) */
  readonly sculpt: Float64Array;
  /** Pinned heights (NaN = free) */
  readonly pin: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly heights: Float64Array;
  readonly zone: Uint8Array;
  /** Which lane each vertex belongs to (-1 none) */
  readonly lane: Int8Array;
  /** Distance outside the nearest feature (negative inside) */
  readonly excess: Float64Array;
  /** Floor height of the nearest feature */
  readonly floor: Float64Array;
  /** The middle strip of every lane and connector, kept clear of cover so there's always a way through */
  readonly core: Uint8Array;

  constructor(readonly graph: Graph, rng: Rng, o: TerrainOptions) {
    const half = graph.half;
    this.half = half;
    this.sym = graph.sym;
    const n = Math.round((half * 2) / CELL);
    this.n = n;
    const side = n + 1;
    this.side = side;
    const count = side * side;
    this.sculpt = new Float64Array(count);
    this.pin = new Float64Array(count).fill(NaN);
    this.lo = new Float64Array(count);
    this.hi = new Float64Array(count);
    this.heights = new Float64Array(count);
    this.zone = new Uint8Array(count);
    this.lane = new Int8Array(count).fill(NONE);
    this.excess = new Float64Array(count).fill(STAMP);
    this.floor = new Float64Array(count).fill(graph.datum);
    this.core = new Uint8Array(count);
    const radius = new Float64Array(count);
    const kind = new Uint8Array(count).fill(ZONE.ridge);

    // Stamp every feature in red's half; blue's half is copied at the end.
    const stamp = (x: number, z: number, r: number, h: number, k: ZoneId, laneId: number) => {
      const reach = r + STAMP;
      const i0 = Math.max(0, Math.floor((x - reach + half) / CELL));
      const i1 = Math.min(n, Math.ceil((x + reach + half) / CELL));
      const k0 = Math.max(0, Math.floor((z - reach + half) / CELL));
      const k1 = Math.min(n, Math.ceil((z + reach + half) / CELL));
      for (let iz = k0; iz <= k1; iz++) {
        const vz = -half + iz * CELL;
        for (let ix = i0; ix <= i1; ix++) {
          const vx = -half + ix * CELL;
          const e = len(vx - x, vz - z) - r;
          const v = iz * side + ix;
          if (e < this.excess[v]!) {
            this.excess[v] = e;
            this.floor[v] = h;
            kind[v] = k;
            this.lane[v] = laneId;
            radius[v] = r;
          }
        }
      }
    };
    const both = (x: number, z: number, fn: (x: number, z: number) => void) => {
      fn(x, z);
      const [tx, tz] = tPoint(graph.sym, x, z);
      fn(tx, tz);
    };
    const stampPath = (samples: readonly LaneSample[], k: ZoneId, laneId: number, chokeS = -1) => {
      for (const p of samples) {
        const isChoke = chokeS >= 0 && Math.abs(p.s - chokeS) < 5;
        both(p.x, p.z, (x, z) => stamp(x, z, p.w / 2, p.h, isChoke ? ZONE.choke : k, laneId));
      }
    };
    for (const l of graph.lanes) stampPath(l.samples, ZONE.lane, l.id, l.chokeS);
    for (const c of graph.connectors) stampPath(c.samples, ZONE.connector, NONE);
    stamp(0, 0, graph.mid.r, graph.mid.h, ZONE.mid, NONE);
    both(graph.base.x, graph.base.z, (x, z) => stamp(x, z, graph.base.r, graph.base.h, ZONE.base, NONE));
    for (const ov of graph.overlooks) both(ov.x, ov.z, (x, z) => stamp(x, z, 3.4, ov.h, ZONE.overlook, ov.lane));

    // The shape: floors inside features, ridges between them, a rim at the edge.
    const noise = valueNoise(rng.fork('noise'), 64);
    const ridgeH = rng.range(o.ridge[0], o.ridge[1]);
    const shoulder = 2.5;
    for (let iz = 0; iz < side; iz++) {
      const vz = -half + iz * CELL;
      for (let ix = 0; ix < side; ix++) {
        const vx = -half + ix * CELL;
        const v = iz * side + ix;
        const e = this.excess[v]!;
        const f = this.floor[v]!;
        const nz = noise(vx / 13, vz / 13) * 0.7 + noise(vx / 5, vz / 5) * 0.3;
        let h = f;
        if (e > 0) {
          // Near a base the ridges rise from the plateau, not the lanes below it, so the base is
          // walled in rather than looking out over everything.
          const nearBase = Math.min(len(vx - graph.base.x, vz - graph.base.z), len(vx + (graph.sym === 'rotate' ? graph.base.x : -graph.base.x), vz + graph.base.z));
          const ref = Math.max(f, f + (graph.base.h - f) * (1 - smoothstep(graph.base.r + 4, graph.base.r + 16, nearBase)));
          h = ref + ridgeH * (1 + o.noise * nz) * smoothstep(0, o.rise, e);
        }
        const toEdge = half - Math.max(Math.abs(vx), Math.abs(vz));
        if (e > 0) h = Math.max(h, graph.datum + o.rim * (1 - smoothstep(0, 7, toEdge)));
        this.sculpt[v] = Math.max(0, h);
        // Zones
        if (e > 0) kind[v] = toEdge < 6 ? ZONE.edge : e <= shoulder ? ZONE.shoulder : ZONE.ridge;
        this.zone[v] = kind[v]!;
        const path = kind[v] === ZONE.lane || kind[v] === ZONE.choke || kind[v] === ZONE.connector;
        if (path && e <= -(radius[v]! - 1.1)) this.core[v] = 1;
        // Pins: plateaus, the middle, overlook pads and the inside of lanes.
        const k = kind[v]!;
        if (k === ZONE.base || k === ZONE.mid || k === ZONE.overlook) {
          if (e <= -0.5) this.pin[v] = f;
        } else if ((k === ZONE.lane || k === ZONE.choke || k === ZONE.connector) && e <= -1) {
          this.pin[v] = f;
        }
      }
    }
    this.symmetrize([this.sculpt, this.pin, this.excess, this.floor]);
    this.symmetrizeInt([this.zone, this.lane, this.core]);
    this.envelopes();
    this.resolve();
  }

  /** Copy red's half (z > 0, and x ≥ 0 on the middle row) onto blue's. */
  private symmetrize(arrays: Float64Array[]): void {
    const { n, side } = this;
    for (let iz = 0; iz < side; iz++) {
      for (let ix = 0; ix < side; ix++) {
        if (iz * 2 > n || (iz * 2 === n && ix * 2 >= n)) continue;
        const t = tVertex(this.sym, n, ix, iz);
        const v = iz * side + ix;
        for (const a of arrays) a[v] = a[t]!;
      }
    }
  }

  private symmetrizeInt(arrays: (Uint8Array | Int8Array)[]): void {
    const { n, side } = this;
    for (let iz = 0; iz < side; iz++) {
      for (let ix = 0; ix < side; ix++) {
        if (iz * 2 > n || (iz * 2 === n && ix * 2 >= n)) continue;
        const t = tVertex(this.sym, n, ix, iz);
        const v = iz * side + ix;
        for (const a of arrays) a[v] = a[t]!;
      }
    }
  }

  /** Lower and upper envelopes of all pins (chamfer sweeps until nothing changes). */
  private envelopes(): void {
    const { lo, hi, pin, side, n } = this;
    for (let v = 0; v < pin.length; v++) {
      const p = pin[v]!;
      lo[v] = Number.isNaN(p) ? -Infinity : p;
      hi[v] = Number.isNaN(p) ? Infinity : p;
    }
    const s1 = MAX_SLOPE * CELL;
    const s2 = MAX_SLOPE * CELL * SQRT2;
    for (let changed = true; changed;) {
      changed = false;
      const relax = (v: number, u: number, step: number) => {
        const a = lo[u]! - step;
        if (a > lo[v]! + 1e-7) { lo[v] = a; changed = true; }
        const b = hi[u]! + step;
        if (b < hi[v]! - 1e-7) { hi[v] = b; changed = true; }
      };
      for (let iz = 0; iz < side; iz++) {
        for (let ix = 0; ix < side; ix++) {
          const v = iz * side + ix;
          if (ix > 0) relax(v, v - 1, s1);
          if (iz > 0) {
            relax(v, v - side, s1);
            if (ix > 0) relax(v, v - side - 1, s2);
            if (ix < n) relax(v, v - side + 1, s2);
          }
        }
      }
      for (let iz = n; iz >= 0; iz--) {
        for (let ix = n; ix >= 0; ix--) {
          const v = iz * side + ix;
          if (ix < n) relax(v, v + 1, s1);
          if (iz < n) {
            relax(v, v + side, s1);
            if (ix < n) relax(v, v + side + 1, s2);
            if (ix > 0) relax(v, v + side - 1, s2);
          }
        }
      }
    }
  }

  /** The ground: the sculpt held within the envelopes, then no slope steeper than MAX_SLOPE. */
  resolve(): void {
    const { heights, sculpt, lo, hi, side, n } = this;
    for (let v = 0; v < heights.length; v++) {
      let h = sculpt[v]!;
      const a = lo[v]!;
      const b = hi[v]!;
      if (a <= b) h = h < a ? a : h > b ? b : h;
      else h = a; // conflicting pins: the higher wins, the sweep below settles it
      heights[v] = Math.max(0, h);
    }
    const s1 = MAX_SLOPE * CELL;
    const s2 = MAX_SLOPE * CELL * SQRT2;
    for (let changed = true; changed;) {
      changed = false;
      const lower = (v: number, u: number, step: number) => {
        const c = heights[u]! + step;
        if (c < heights[v]! - 1e-7) { heights[v] = c; changed = true; }
      };
      for (let iz = 0; iz < side; iz++) {
        for (let ix = 0; ix < side; ix++) {
          const v = iz * side + ix;
          if (ix > 0) lower(v, v - 1, s1);
          if (iz > 0) {
            lower(v, v - side, s1);
            if (ix > 0) lower(v, v - side - 1, s2);
            if (ix < n) lower(v, v - side + 1, s2);
          }
        }
      }
      for (let iz = n; iz >= 0; iz--) {
        for (let ix = n; ix >= 0; ix--) {
          const v = iz * side + ix;
          if (ix < n) lower(v, v + 1, s1);
          if (iz < n) {
            lower(v, v + side, s1);
            if (ix < n) lower(v, v + side + 1, s2);
            if (ix > 0) lower(v, v + side - 1, s2);
          }
        }
      }
    }
    // Exactly symmetric (the lower of each pair: still within the slope limit), on the centimetre.
    for (let iz = 0; iz < side; iz++) {
      for (let ix = 0; ix < side; ix++) {
        const v = iz * side + ix;
        const t = tVertex(this.sym, n, ix, iz);
        if (t < v) continue;
        const h = q(Math.min(heights[v]!, heights[t]!));
        heights[v] = h;
        heights[t] = h;
      }
    }
  }

  /** Vertices of every cell a rectangle touches (so every triangle under it is pinned) */
  cells(r: Rect): { i0: number; i1: number; k0: number; k1: number } {
    const { half, n } = this;
    return {
      i0: Math.max(0, Math.floor((r.minX + half) / CELL)),
      i1: Math.min(n, Math.ceil((r.maxX + half) / CELL)),
      k0: Math.max(0, Math.floor((r.minZ + half) / CELL)),
      k1: Math.min(n, Math.ceil((r.maxZ + half) / CELL)),
    };
  }

  /**
   * The height a flat pad under `r` (and its copy) could have, or null if there's none: within every
   * pin's reach, and cutting or filling at most `maxCut` against the current ground.
   */
  padHeight(r: Rect, maxCut: number, prefer?: number): number | null {
    let lo = -Infinity;
    let hi = Infinity;
    let sum = 0;
    let count = 0;
    let gLo = Infinity;
    let gHi = -Infinity;
    for (const rect of [r, this.tRect(r)]) {
      const { i0, i1, k0, k1 } = this.cells(rect);
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const v = k * this.side + i;
          lo = Math.max(lo, this.lo[v]!);
          hi = Math.min(hi, this.hi[v]!);
          const g = this.heights[v]!;
          sum += g;
          count++;
          gLo = Math.min(gLo, g);
          gHi = Math.max(gHi, g);
        }
      }
    }
    if (!count || lo > hi + 1e-6) return null;
    let h = prefer ?? sum / count;
    h = Math.min(hi, Math.max(lo, h, 0));
    if (gHi - h > maxCut || h - gLo > maxCut) return null;
    return q(h);
  }

  /** Pin a flat pad at height h under `r` and its copy, and update the envelopes around it. */
  addPad(r: Rect, h: number): void {
    const s = MAX_SLOPE * CELL;
    for (const rect of [r, this.tRect(r)]) {
      const { i0, i1, k0, k1 } = this.cells(rect);
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.pin[k * this.side + i] = h;
      // The pad's reach: L = max(L, h - s·d), U = min(U, h + s·d), d the octile distance to the pad.
      const reach = 24;
      for (let k = Math.max(0, k0 - reach); k <= Math.min(this.n, k1 + reach); k++) {
        const dz = k < k0 ? k0 - k : k > k1 ? k - k1 : 0;
        for (let i = Math.max(0, i0 - reach); i <= Math.min(this.n, i1 + reach); i++) {
          const dx = i < i0 ? i0 - i : i > i1 ? i - i1 : 0;
          const d = octile(dx, dz) * s;
          const v = k * this.side + i;
          if (h - d > this.lo[v]!) this.lo[v] = h - d;
          if (h + d < this.hi[v]!) this.hi[v] = h + d;
        }
      }
    }
  }

  /** The other team's copy of a rectangle */
  tRect(r: Rect): Rect {
    return this.sym === 'rotate'
      ? { minX: -r.maxX, maxX: -r.minX, minZ: -r.maxZ, maxZ: -r.minZ }
      : { minX: r.minX, maxX: r.maxX, minZ: -r.maxZ, maxZ: -r.minZ };
  }

  /** Nearest vertex to (x, z) */
  vertex(x: number, z: number): number {
    const ix = Math.min(this.n, Math.max(0, Math.round((x + this.half) / CELL)));
    const iz = Math.min(this.n, Math.max(0, Math.round((z + this.half) / CELL)));
    return iz * this.side + ix;
  }

  zoneAt(x: number, z: number): ZoneId {
    return this.zone[this.vertex(x, z)]! as ZoneId;
  }

  /** The finished ground, painted. */
  toGround(): Ground {
    const { n, side, half, heights } = this;
    const paint = new Uint8Array(side * side);
    for (let iz = 0; iz < side; iz++) {
      for (let ix = 0; ix < side; ix++) {
        const v = iz * side + ix;
        const z = this.zone[v]!;
        const h = heights[v]!;
        const gx = (heights[iz * side + Math.min(n, ix + 1)]! - heights[iz * side + Math.max(0, ix - 1)]!) / 2;
        const gz = (heights[Math.min(n, iz + 1) * side + ix]! - heights[Math.max(0, iz - 1) * side + ix]!) / 2;
        const steep = gx * gx + gz * gz > 0.3 * 0.3;
        let p: number = PAINT.floor;
        if ((z === ZONE.lane || z === ZONE.choke || z === ZONE.connector) && this.excess[v]! < -0.6) p = PAINT.path;
        else if (steep) p = PAINT.rock;
        else if ((z === ZONE.ridge || z === ZONE.edge) && h - this.floor[v]! > 1.2) p = PAINT.rough;
        paint[v] = p;
      }
    }
    return { n, cell: CELL, half, heights: Float32Array.from(heights), paint };
  }

  /** Highest ground along the map's edge */
  rimHeight(): number {
    const { n, side, heights } = this;
    let top = 0;
    for (let i = 0; i <= n; i++) {
      top = Math.max(top, heights[i]!, heights[n * side + i]!, heights[i * side]!, heights[i * side + n]!);
    }
    return top;
  }
}
