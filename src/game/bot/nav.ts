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
const MAX_FIELDS = 32;
/** A jump up costs this much extra walking (m): taken when it saves a real detour, not for a shortcut of a step */
const JUMP_COST = 3;
/** A ledge within this many grid steps ahead is worth jumping now */
const JUMP_LOOK = 3;
/**
 * Where to walk: the furthest point along the path the bot can walk to in a straight line with room for
 * its body, checked every this often along the line (m), this far to either side of it (m). Walking at the
 * waypoint itself cut corners, and bots caught on them (stuck 9% of the time they were walking on maze maps).
 */
const LINE_STEP = 0.25;
const LINE_SIDE = 0.2;

/** Something standing on the map that isn't part of it (a deployed barrier): its footprint and height */
export interface NavBlock {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/**
 * Jumps up go two cells straight on: a body's width keeps the grid point next to a crate free, so the
 * ground beside it and its top are never next to each other.
 */
const JUMPS: readonly (readonly [number, number])[] = [[2, 0], [-2, 0], [0, 2], [0, -2]];

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** Walking distance left to the target (m) */
  dist: number;
  /** The way goes up a ledge in the next metre or so: jump now */
  jump?: boolean;
  /**
   * Where to walk to now: the furthest point along the way that's a clear straight walk (x, z is further,
   * and walking straight at it cuts corners). The policy is shown (x, z), as it was trained; feet walk here.
   */
  walkX: number;
  walkZ: number;
}

export class BotNav {
  private readonly spotCell: Int32Array;
  private readonly fields = new Map<number, Float32Array>();
  /** Stand-ins for targets that can't be reached: target cell → the nearest spot that can */
  private readonly standIns = new Map<number, number>();
  /** Spots a deployed barrier stands on (1 = no way through) */
  private readonly blocked: Uint8Array;
  private blockKey = '';
  /** Highest ledge a path may jump up (m); STEP_UP means no jumping (the training simulator's default) */
  private climb = STEP_UP;

  constructor(readonly grid: NavGrid) {
    const { n, offsets, heights } = grid;
    this.spotCell = new Int32Array(heights.length);
    this.blocked = new Uint8Array(heights.length);
    for (let c = 0; c < n * n; c++) for (let s = offsets[c]!; s < offsets[c + 1]!; s++) this.spotCell[s] = c;
  }

  /** Let paths jump up ledges up to `height` (m), at a cost. The live game's bots press jump there; see Waypoint.jump. */
  allowJumps(height: number): void {
    const climb = Math.max(STEP_UP, height);
    if (climb === this.climb) return;
    this.climb = climb;
    this.forget();
  }

  /** The barriers standing now: no path through them. `key` names the set, so an unchanged one costs nothing. */
  setBlocks(key: string, blocks: readonly NavBlock[]): void {
    if (key === this.blockKey) return;
    this.blockKey = key;
    this.blocked.fill(0);
    const { n, offsets, heights, half } = this.grid;
    // A little margin round each one: a body is wider than a grid point.
    const pad = 0.35;
    for (const b of blocks) {
      const i0 = Math.max(0, Math.floor((b.min.x - pad + half) / CELL));
      const i1 = Math.min(n - 1, Math.floor((b.max.x + pad + half) / CELL));
      const k0 = Math.max(0, Math.floor((b.min.z - pad + half) / CELL));
      const k1 = Math.min(n - 1, Math.floor((b.max.z + pad + half) / CELL));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const c = k * n + i;
        for (let s = offsets[c]!; s < offsets[c + 1]!; s++) {
          // Only spots the barrier stands on or towers over (not a roof high above it).
          if (heights[s]! >= b.min.y - 0.5 && heights[s]! < b.max.y) this.blocked[s] = 1;
        }
      }
    }
    this.forget();
  }

  /** Every path search is stale (the barriers or the rules changed) */
  private forget(): void {
    this.fields.clear();
    this.standIns.clear();
  }

  /** How far up a move from a spot at `from` to one at `to` may go: a step, or (straight on, not diagonally) a jump */
  private canClimb(from: number, to: number, diagonal: boolean): boolean {
    return to - from <= (diagonal ? STEP_UP : this.climb);
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
          if (this.blocked[u]) continue;
          // Walking from u to s: at most a step up (or, where allowed, a jump).
          const diagonal = !!(di && dk);
          if (!this.canClimb(hu, h, diagonal)) continue;
          if (diagonal && (!this.near(k * n + ni, hu) || !this.near(nk * n + i, hu))) continue;
          const step = here + (diagonal ? 1.5 : 1) * CELL + (h - hu > STEP_UP ? JUMP_COST : 0);
          if (step < distance[u]!) {
            if (distance[u] === Infinity) queue[tail++] = u;
            distance[u] = step;
          }
        }
      }
      if (this.climb <= STEP_UP) continue;
      // Jumping from u, two cells away and lower, up onto s.
      for (const [di, dk] of JUMPS) {
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
        const nc = nk * n + ni;
        for (let u = offsets[nc]!; u < offsets[nc + 1]!; u++) {
          const rise = h - heights[u]!;
          if (this.blocked[u] || rise <= STEP_UP || rise > this.climb) continue;
          const step = here + 2 * CELL + JUMP_COST;
          if (step < distance[u]!) {
            if (distance[u] === Infinity) queue[tail++] = u;
            distance[u] = step;
          }
        }
      }
    }
    return distance;
  }

  /** Whether a body can walk straight from (x, z) at height y to `spot`: standing room all along the line, and a little to its sides. */
  private clearWalk(x: number, z: number, y: number, spot: number): boolean {
    const { n, heights, half } = this.grid;
    const c = this.spotCell[spot]!;
    const tx = -half + ((c % n) + 0.5) * CELL;
    const tz = -half + (((c / n) | 0) + 0.5) * CELL;
    const th = heights[spot]!;
    const len = Math.hypot(tx - x, tz - z);
    if (len < 1e-6) return true;
    const sx = -(tz - z) / len * LINE_SIDE;
    const sz = (tx - x) / len * LINE_SIDE;
    const steps = Math.ceil(len / LINE_STEP);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = x + (tx - x) * f;
      const pz = z + (tz - z) * f;
      const h = y + (th - y) * f;
      if (!this.standable(px, pz, h) || !this.standable(px + sx, pz + sz, h) || !this.standable(px - sx, pz - sz, h)) return false;
    }
    return true;
  }

  /** Somewhere to stand at (x, z) within a step of height h */
  private standable(x: number, z: number, h: number): boolean {
    const { n, half, offsets, heights } = this.grid;
    const i = Math.floor((x + half) / CELL);
    const k = Math.floor((z + half) / CELL);
    if (i < 0 || k < 0 || i >= n || k >= n) return false;
    const c = k * n + i;
    // (A deployed barrier's footprint is no way through.)
    for (let s = offsets[c]!; s < offsets[c + 1]!; s++) if (!this.blocked[s] && Math.abs(heights[s]! - h) <= STEP_UP + 0.1) return true;
    return false;
  }

  private near(c: number, h: number): boolean {
    const { offsets, heights } = this.grid;
    for (let s = offsets[c]!; s < offsets[c + 1]!; s++) if (Math.abs(heights[s]! - h) <= STEP_UP) return true;
    return false;
  }

  /** The spot nearest (x, z) that `from` can walk to (-1 if none) */
  private reachableNear(x: number, z: number, from: number): number {
    const key = this.grid.cellOf(x, z);
    const known = this.standIns.get(key);
    if (known !== undefined && this.field(known)[from] !== Infinity) return known;
    const { n, offsets } = this.grid;
    const toFrom = this.field(from);
    const ci = key % n;
    const ck = (key / n) | 0;
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r < n && best < 0; r++) {
      for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dk)) !== r) continue;
        const i = ci + di;
        const k = ck + dk;
        if (i < 0 || k < 0 || i >= n || k >= n) continue;
        const c = k * n + i;
        for (let s = offsets[c]!; s < offsets[c + 1]!; s++) {
          if (toFrom[s] === Infinity) continue;
          const d = di * di + dk * dk;
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    if (best >= 0) this.standIns.set(key, best);
    return best;
  }

  /** A point a few metres along the way from (x, y, z) to the target, or null if there's no way. */
  waypoint(x: number, y: number, z: number, tx: number, ty: number, tz: number): Waypoint | null {
    let target = this.spotAt(tx, ty + 0.3, tz);
    let cur = this.spotAt(x, y, z);
    if (cur < 0) return null;
    // A target inside a wall, or somewhere sealed off (a spot picked on the straight line between
    // bases, on a maze map): head for the nearest place that can be reached instead.
    if (target < 0 || this.field(target)[cur] === Infinity) target = this.reachableNear(tx, tz, cur);
    if (target < 0) return null;
    const field = this.field(target);
    if (field[cur] === Infinity) return null;
    const { n, offsets, heights } = this.grid;
    let jump = false;
    const path: number[] = [];
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
          if (!this.canClimb(h, heights[u]!, !!(di && dk))) continue;
          if (field[u]! < field[best]!) best = u;
        }
      }
      if (this.climb > STEP_UP) {
        for (const [di, dk] of JUMPS) {
          const ni = i + di;
          const nk = k + dk;
          if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
          const nc = nk * n + ni;
          for (let u = offsets[nc]!; u < offsets[nc + 1]!; u++) {
            const rise = heights[u]! - h;
            if (rise <= STEP_UP || rise > this.climb) continue;
            if (field[u]! < field[best]!) best = u;
          }
        }
      }
      if (best === cur) break;
      if (step < JUMP_LOOK && heights[best]! - h > STEP_UP) jump = true;
      cur = best;
      path.push(cur);
    }
    // Where to walk: the furthest point along the way that's a clear straight walk (the next spot, if none is).
    let walk = cur;
    for (let i = path.length - 1; i >= 0; i--) {
      walk = path[i]!;
      if (i === 0 || this.clearWalk(x, z, y, walk)) break;
    }
    const c = this.spotCell[cur]!;
    const wc = this.spotCell[walk]!;
    const half = this.grid.half;
    return {
      x: -half + ((c % n) + 0.5) * CELL,
      y: heights[cur]!,
      z: -half + (((c / n) | 0) + 0.5) * CELL,
      walkX: -half + ((wc % n) + 0.5) * CELL,
      walkZ: -half + (((wc / n) | 0) + 0.5) * CELL,
      dist: field[this.spotAt(x, y, z)]!,
      ...(jump ? { jump } : {}),
    };
  }
}
