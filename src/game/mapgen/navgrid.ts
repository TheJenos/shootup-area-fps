/**
 * Where a player can walk, on a 0.5 m grid with more than one level: the ground, the tops of boxes
 * and the surfaces of ramps. From one standing spot you can step to a neighbouring one up to
 * STEP_UP higher, or drop down any distance, as long as your body (RADIUS wide, HEADROOM tall)
 * fits there. Used to check every map after the terrain and everything on it are final.
 */

import { HEADROOM, RADIUS, STEP_UP } from '../playerDims';
import { rampHeightAt } from '../rampMath';
import { groundHeight } from './heightField';
import type { Ground, MapBox } from './types';

const CELL = 0.5;

export class NavGrid {
  readonly n: number;
  readonly half: number;
  /** Surfaces of cell c are heights[offsets[c] .. offsets[c + 1]) */
  readonly offsets: Int32Array;
  readonly heights: Float32Array;

  constructor(readonly ground: Ground | null, half: number, boxes: readonly MapBox[]) {
    this.half = half - 0.5;
    const n = Math.ceil((this.half * 2) / CELL);
    this.n = n;
    const centre = (i: number) => -this.half + (i + 0.5) * CELL;
    const blockers = new Map<number, number[]>();
    const tops = new Map<number, number[]>();
    const push = (m: Map<number, number[]>, c: number, ...v: number[]) => {
      const list = m.get(c);
      if (list) list.push(...v);
      else m.set(c, v);
    };
    for (const b of boxes) {
      if (b.blocks === 'shots') continue;
      const x0 = b.x - b.w / 2;
      const x1 = b.x + b.w / 2;
      const z0 = b.z - b.d / 2;
      const z1 = b.z + b.d / 2;
      const i0 = Math.max(0, Math.floor((x0 - RADIUS + this.half) / CELL));
      const i1 = Math.min(n - 1, Math.floor((x1 + RADIUS + this.half) / CELL));
      const k0 = Math.max(0, Math.floor((z0 - RADIUS + this.half) / CELL));
      const k1 = Math.min(n - 1, Math.floor((z1 + RADIUS + this.half) / CELL));
      for (let k = k0; k <= k1; k++) {
        const cz = centre(k);
        if (cz <= z0 - RADIUS || cz >= z1 + RADIUS) continue;
        for (let i = i0; i <= i1; i++) {
          const cx = centre(i);
          if (cx <= x0 - RADIUS || cx >= x1 + RADIUS) continue;
          const c = k * n + i;
          const inside = cx > x0 && cx < x1 && cz > z0 && cz < z1;
          if (b.ramp) {
            const top = rampHeightAt(b.ramp, x0, x1, z0, z1, b.y, b.y + b.h, cx, cz);
            push(blockers, c, b.y, top);
            if (inside && b.blocks !== 'move') push(tops, c, top);
          } else {
            push(blockers, c, b.y, b.y + b.h);
            if (inside && b.blocks !== 'move') push(tops, c, b.y + b.h);
          }
        }
      }
    }
    const offsets = new Int32Array(n * n + 1);
    const heights: number[] = [];
    const fits = (blocks: number[] | undefined, s: number) => {
      if (!blocks) return true;
      for (let j = 0; j < blocks.length; j += 2) {
        const y0 = blocks[j]!;
        const y1 = blocks[j + 1]!;
        if (y1 > s + STEP_UP && y0 < s + HEADROOM - 0.05) return false;
      }
      return true;
    };
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const c = k * n + i;
        offsets[c] = heights.length;
        const blocks = blockers.get(c);
        const g = groundHeight(ground, centre(i), centre(k));
        const cand = [g, ...(tops.get(c) ?? [])].sort((a, b) => a - b);
        let last = -Infinity;
        for (const s of cand) {
          if (s - last < 0.1) continue;
          if (s < g - 0.01) continue;
          if (!fits(blocks, s)) continue;
          heights.push(s);
          last = s;
        }
      }
    }
    offsets[n * n] = heights.length;
    this.offsets = offsets;
    this.heights = Float32Array.from(heights);
  }

  cellOf(x: number, z: number): number {
    const i = Math.min(this.n - 1, Math.max(0, Math.floor((x + this.half) / CELL)));
    const k = Math.min(this.n - 1, Math.max(0, Math.floor((z + this.half) / CELL)));
    return k * this.n + i;
  }

  /** The standing spot in the cell at (x, z) nearest to height y, or -1 */
  surface(x: number, z: number, y: number): number {
    const c = this.cellOf(x, z);
    let best = -1;
    let bestD = 1.2;
    for (let s = this.offsets[c]!; s < this.offsets[c + 1]!; s++) {
      const d = Math.abs(this.heights[s]! - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Every standing spot reachable from `start`, with the walking distance to it (Infinity if none). */
  walk(start: number): Float32Array {
    const { n, offsets, heights } = this;
    const total = heights.length;
    const distance = new Float32Array(total).fill(Infinity);
    if (start < 0) return distance;
    // Cell of each spot.
    const cellOf = new Int32Array(total);
    for (let c = 0; c < n * n; c++) for (let s = offsets[c]!; s < offsets[c + 1]!; s++) cellOf[s] = c;
    // Breadth-first on unit steps (diagonals count 1.5, close enough for path lengths).
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    distance[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const s = queue[head++]!;
      const c = cellOf[s]!;
      const i = c % n;
      const k = (c / n) | 0;
      const h = heights[s]!;
      const here = distance[s]!;
      for (const [di, dk] of NEIGHBOURS) {
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
        const nc = nk * n + ni;
        // Diagonal moves need both side cells open at this level too (no cutting corners).
        if (di && dk && (!this.near(k * n + ni, h) || !this.near(nk * n + i, h))) continue;
        for (let t = offsets[nc]!; t < offsets[nc + 1]!; t++) {
          const dh = heights[t]! - h;
          if (dh > STEP_UP) continue;
          const step = here + (di && dk ? 1.5 : 1) * CELL;
          if (step < distance[t]!) {
            if (distance[t] === Infinity) queue[tail++] = t;
            distance[t] = step;
          }
        }
      }
    }
    return distance;
  }

  /** Whether cell c has a spot within a step of height h */
  private near(c: number, h: number): boolean {
    for (let s = this.offsets[c]!; s < this.offsets[c + 1]!; s++) if (Math.abs(this.heights[s]! - h) <= STEP_UP) return true;
    return false;
  }

  /** Whether (x, z) at about height y was reached in `walked` (looking up to `radius` around it) */
  reached(walked: Float32Array, x: number, z: number, y: number, radius = 0.5): number {
    let best = Infinity;
    for (let dz = -radius; dz <= radius + 1e-6; dz += CELL) {
      for (let dx = -radius; dx <= radius + 1e-6; dx += CELL) {
        const c = this.cellOf(x + dx, z + dz);
        for (let s = this.offsets[c]!; s < this.offsets[c + 1]!; s++) {
          if (Math.abs(this.heights[s]! - y) < 0.6 && walked[s]! < best) best = walked[s]!;
        }
      }
    }
    return best;
  }

  /** Share of cells with somewhere to stand on the ground that was reached */
  walkable(walked: Float32Array): number {
    let open = 0;
    for (let c = 0; c < this.n * this.n; c++) {
      for (let s = this.offsets[c]!; s < this.offsets[c + 1]!; s++) if (walked[s]! < Infinity) { open++; break; }
    }
    return open / (this.n * this.n);
  }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
