/**
 * The maze every map starts from: a grid of cells joined into a perfect maze (one way between any
 * two cells) by a randomised depth-first walk. The walk prefers to keep going the way it was going
 * and to run across the map rather than along it, so the maze is long snaking runs rather than a
 * tangle, which is what the main path (route.ts) is cut from.
 */

import type { Rng } from './rng';

/** Passage bits: to the next cell along x, and along z */
export const EAST = 1;
export const NORTH = 2;

export interface Maze {
  w: number;
  h: number;
  /** Per cell (row by row along z, each row along x): EAST | NORTH passages to the next cell */
  open: Uint8Array;
}

const STEPS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Whether cells a and b (neighbours) are joined */
export function joined(m: Maze, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi - lo === 1 ? (m.open[lo]! & EAST) !== 0 : (m.open[lo]! & NORTH) !== 0;
}

/** Join cells a and b (neighbours) */
export function join(m: Maze, a: number, b: number): void {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  m.open[lo] = m.open[lo]! | (hi - lo === 1 ? EAST : NORTH);
}

/** The cells next to c on the grid, joined or not */
export function around(m: Maze, c: number): number[] {
  const x = c % m.w;
  const z = (c - x) / m.w;
  const out: number[] = [];
  for (const [dx, dz] of STEPS) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx >= 0 && nz >= 0 && nx < m.w && nz < m.h) out.push(nz * m.w + nx);
  }
  return out;
}

/** The cells joined to c */
export const exits = (m: Maze, c: number): number[] => around(m, c).filter((d) => joined(m, c, d));

/** Steps from `from` to every cell, through joined cells only (-1 = can't get there) */
export function distances(m: Maze, from: number, allowed?: (c: number) => boolean): Int32Array {
  const d = new Int32Array(m.w * m.h).fill(-1);
  d[from] = 0;
  const queue = [from];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    for (const e of exits(m, c)) {
      if (d[e] !== -1 || (allowed && !allowed(e))) continue;
      d[e] = d[c]! + 1;
      queue.push(e);
    }
  }
  return d;
}

/** The cells from `from` to `to` (inclusive), following `dist` (distances from `to`) downhill */
export function walkDown(m: Maze, from: number, dist: Int32Array): number[] {
  const out = [from];
  let c = from;
  while (dist[c]! > 0) {
    c = exits(m, c).find((e) => dist[e] === dist[c]! - 1)!;
    out.push(c);
  }
  return out;
}

/** A perfect maze over w × h cells */
export function carveMaze(rng: Rng, w: number, h: number): Maze {
  const m: Maze = { w, h, open: new Uint8Array(w * h) };
  const seen = new Uint8Array(w * h);
  const start = rng.int(0, w * h - 1);
  seen[start] = 1;
  const stack: [number, number][] = [[start, -1]];
  while (stack.length) {
    const [c, came] = stack[stack.length - 1]!;
    const next = around(m, c).filter((d) => !seen[d]);
    if (!next.length) {
      stack.pop();
      continue;
    }
    const d = rng.weighted(next.map((n) => {
      const across = Math.abs(n - c) === 1;
      const straight = came >= 0 && n - c === c - came;
      return [n, (across ? 2 : 1) * (straight ? 1.6 : 1)] as const;
    }));
    join(m, c, d);
    seen[d] = 1;
    stack.push([d, c]);
  }
  return m;
}
