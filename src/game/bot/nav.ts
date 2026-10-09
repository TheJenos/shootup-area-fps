import type { NavGrid } from '../mapgen/navgrid';
import { STEP_UP } from '../playerDims';

/*
 * Finding the way for bots on the map's NavGrid (mapgen/navgrid.ts): a distance field per target,
 * walked backwards (how far is it from every spot *to* the target, respecting that you can drop
 * down anything but only step up so far), then followed downhill a few metres to get the next
 * waypoint. Fields are cached per target spot, so fixed targets (bases, the middle) cost one search.
 */

const CELL = 0.5;
/** How far ahead along the path a waypoint is (grid steps) */
const LOOKAHEAD = 8;
/** Path searches kept (bases, the middle, patrol points, followed carriers) */
const MAX_FIELDS = 24;

const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** Walking distance left to the target (m) */
  dist: number;
}

export class BotNav {
  private readonly spotCell: Int32Array;
  private readonly fields = new Map<number, Float32Array>();

  constructor(readonly grid: NavGrid) {
    const { n, offsets, heights } = grid;
    this.spotCell = new Int32Array(heights.length);
    for (let c = 0; c < n * n; c++) for (let s = offsets[c]!; s < offsets[c + 1]!; s++) this.spotCell[s] = c;
  }

  /** The standing spot under (x, y, z): the highest one at most a little above the feet, or -1. */
  spotAt(x: number, y: number, z: number): number {
    const { offsets, heights } = this.grid;
    const c = this.grid.cellOf(x, z);
    let best = -1;
    let bestH = -Infinity;
    for (let s = offsets[c]!; s < offsets[c + 1]!; s++) {
      const h = heights[s]!;
      if (h <= y + 0.6 && h > bestH) { bestH = h; best = s; }
    }
    if (best < 0 && offsets[c + 1]! > offsets[c]!) best = offsets[c]!;
    return best;
  }

  /** Walking distance from every spot to `target` (Infinity where it can't be reached). */
  field(target: number): Float32Array {
    const cached = this.fields.get(target);
    if (cached) {
      // Most recently used last.
      this.fields.delete(target);
      this.fields.set(target, cached);
      return cached;
    }
    const field = this.search(target);
    this.fields.set(target, field);
    if (this.fields.size > MAX_FIELDS) this.fields.delete(this.fields.keys().next().value!);
    return field;
  }

  private search(target: number): Float32Array {
    const { n, offsets, heights } = this.grid;
    const total = heights.length;
    const distance = new Float32Array(total).fill(Infinity);
    if (target < 0) return distance;
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    distance[target] = 0;
    queue[tail++] = target;
    while (head < tail) {
      const s = queue[head++]!;
      const c = this.spotCell[s]!;
      const i = c % n;
      const k = (c / n) | 0;
      const h = heights[s]!;
      const here = distance[s]!;
      for (const [di, dk] of NEIGHBOURS) {
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
        const nc = nk * n + ni;
        for (let u = offsets[nc]!; u < offsets[nc + 1]!; u++) {
          const hu = heights[u]!;
          // Walking from u to s: at most a step up.
          if (h - hu > STEP_UP) continue;
          if (di && dk && (!this.near(k * n + ni, hu) || !this.near(nk * n + i, hu))) continue;
          const step = here + (di && dk ? 1.5 : 1) * CELL;
          if (step < distance[u]!) {
            if (distance[u] === Infinity) queue[tail++] = u;
            distance[u] = step;
          }
        }
      }
    }
    return distance;
  }

  private near(c: number, h: number): boolean {
    const { offsets, heights } = this.grid;
    for (let s = offsets[c]!; s < offsets[c + 1]!; s++) if (Math.abs(heights[s]! - h) <= STEP_UP) return true;
    return false;
  }

  /** A point a few metres along the way from (x, y, z) to the target, or null if there's no way. */
  waypoint(x: number, y: number, z: number, tx: number, ty: number, tz: number): Waypoint | null {
    const target = this.spotAt(tx, ty + 0.3, tz);
    let cur = this.spotAt(x, y, z);
    if (target < 0 || cur < 0) return null;
    const field = this.field(target);
    if (field[cur] === Infinity) return null;
    const { n, offsets, heights } = this.grid;
    for (let step = 0; step < LOOKAHEAD; step++) {
      const c = this.spotCell[cur]!;
      const i = c % n;
      const k = (c / n) | 0;
      const h = heights[cur]!;
      let best = cur;
      for (const [di, dk] of NEIGHBOURS) {
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
        if (di && dk && (!this.near(k * n + ni, h) || !this.near(nk * n + i, h))) continue;
        const nc = nk * n + ni;
        for (let u = offsets[nc]!; u < offsets[nc + 1]!; u++) {
          if (heights[u]! - h > STEP_UP) continue;
          if (field[u]! < field[best]!) best = u;
        }
      }
      if (best === cur) break;
      cur = best;
    }
    const c = this.spotCell[cur]!;
    const half = this.grid.half;
    return {
      x: -half + ((c % n) + 0.5) * CELL,
      y: heights[cur]!,
      z: -half + (((c / n) | 0) + 0.5) * CELL,
      dist: field[this.spotAt(x, y, z)]!,
    };
  }
}
