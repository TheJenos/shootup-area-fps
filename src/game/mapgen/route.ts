/**
 * The route through the maze, in red's half: a winding main path from the base to the middle
 * plaza, a few short dead-end pockets off it, and a few loops that reopen maze walls between parts
 * of the path far apart along it, so there are flanks.
 *
 * Cells are on a cols × rows grid; row 0 lies against the middle line and is never part of the maze:
 * it holds the middle plaza (the band), which joins red's path to blue's copy of it. The main path
 * ends in row 1 at the crossing column and steps down into the band.
 */

import { carveMaze, distances, exits, join, joined, around, walkDown, type Maze } from './maze';
import type { Rng } from './rng';
import type { SizeParams } from './spec';
import type { Symmetry } from './symmetry';

/** What each cell is used for */
export const KIND = { none: 0, path: 1, pocket: 2, loop: 3, band: 4 } as const;

export interface Route {
  cols: number;
  rows: number;
  /** The maze over every row, with the band's and the loops' passages opened */
  maze: Maze;
  kind: Uint8Array;
  /** Steps from the base along the route (-1 for unused cells) */
  label: Int32Array;
  /** Main path cells, base first, ending in row 1 */
  main: number[];
  /**
   * The other ways from the base to the middle: each leaves the main path next to the base, takes its
   * own way through the maze (never onto the main path or another lane) and reaches the middle plaza
   * in a column of its own. Base end first.
   */
  lanes: number[][];
  /** Band columns, first to last */
  band: [number, number];
  /** Pocket cells (the dead ends last) and loop cells */
  pockets: number[][];
  loops: { cells: number[] }[];
}

/** How far apart along the route two cells must be for a wall between them to be worth reopening */
const LOOP_SPAN = 4;

/** Longest straight stretch of a path (cells) */
export function longestRun(path: readonly number[]): number {
  let best = path.length ? 1 : 0;
  let run = 1;
  for (let i = 2; i < path.length; i++) {
    run = path[i]! - path[i - 1]! === path[i - 1]! - path[i - 2]! ? run + 1 : 1;
    best = Math.max(best, run + 1);
  }
  return Math.min(best, path.length);
}

/** Plan red's route; null if no maze tried gives a path that fits the size, with a loop */
export function planRoute(rng: Rng, sym: Symmetry, P: SizeParams): Route | null {
  const { cols, rows } = P;
  const row = (c: number) => Math.floor(c / cols);
  const col = (c: number) => c % cols;
  for (let attempt = 0; attempt < 16; attempt++) {
    // The maze fills rows 1.. (row 0 is the band).
    const sub = carveMaze(rng.fork(`maze${attempt}`), cols, rows - 1);
    const maze: Maze = { w: cols, h: rows, open: new Uint8Array(cols * rows) };
    maze.open.set(sub.open, cols);

    // Every crossing and base pair whose path fits: long enough, winding, no endless straights.
    const picks: (readonly [{ path: number[]; ci: number; centred: number }, number])[] = [];
    const centre = (cols - 1) / 2;
    for (let ci = 0; ci < cols; ci++) {
      // Near the middle: a rotated map's band runs from the crossing to its copy's, so it can't span the map.
      if (Math.abs(ci - centre) > cols / 4) continue;
      const cross = cols + ci;
      const d = distances(maze, cross);
      for (let base = (rows - 2) * cols; base < rows * cols; base++) {
        const cells = d[base]! + 1;
        if (cells < P.pathCells[0] || cells > P.pathCells[1]) continue;
        const path = walkDown(maze, base, d);
        if (longestRun(path) > P.maxRun) continue;
        const direct = Math.abs(col(base) - ci) + Math.abs(row(base) - 1) + 1;
        const wind = cells / direct;
        if (wind < 1.3) continue;
        // Paths that wander over the middle of the map rather than hugging one side.
        const spread = path.reduce((sum, c) => sum + col(c), 0) / path.length;
        const centred = 1 - Math.abs(spread - centre) / (cols / 2);
        picks.push([{ path, ci, centred }, wind * wind * centred * centred]);
      }
    }
    const central = picks.filter(([p]) => p.centred > 0.6);
    if (!central.length) continue;
    const { path, ci } = rng.weighted(central);
    const route = build(rng.fork(`route${attempt}`), sym, P, maze, path, ci);
    // A flank loop, and at least one more way to the middle than the main path.
    if (route.loops.length && route.lanes.length) return route;
  }
  return null;
}

/** The band's columns: from the crossing to its copy's (a rotated map), or round the crossing (mirrored) */
function bandSpan(sym: Symmetry, cols: number, ci: number): [number, number] {
  const other = sym === 'rotate' ? cols - 1 - ci : ci;
  let a = Math.min(ci, other);
  let b = Math.max(ci, other);
  if (b - a < 2) {
    a = Math.max(0, a - 1);
    b = Math.min(cols - 1, b + 1);
  }
  return [a, b];
}

/**
 * Another way from the base to the middle: a run of the maze that starts beside the base end of the
 * main path, ends in row 1 over the band in a column nobody else uses, and touches no used cell on the
 * way. The maze is a tree, so the main path often cuts every such run off; then a few of the walls
 * between unused cells are knocked through (which can't shorten the main path: it isn't touched) and
 * it's tried again. Null if there's still none of a fitting length.
 */
function findLane(
  rng: Rng, P: SizeParams, maze: Maze, kind: Uint8Array, main: readonly number[], band: [number, number], takenCols: Set<number>,
): { cells: number[]; from: number } | null {
  const { cols, rows } = P;
  const row = (c: number) => Math.floor(c / cols);
  const col = (c: number) => c % cols;
  const free = (c: number) => kind[c] === KIND.none && row(c) >= 1;
  const meanCol = (p: readonly number[]) => p.reduce((s, c) => s + col(c), 0) / p.length;
  const mainCol = meanCol(main);
  // Where it may leave the main path: next to its first three cells (the base and the way out of it).
  const starts: [number, number][] = [];
  for (const m of main.slice(0, 3)) for (const c of around(maze, m)) if (free(c)) starts.push([c, m]);
  // Where it may meet the middle: over the band, or anywhere in the middle third (the band grows to meet it).
  const centre = (cols - 1) / 2;
  const ends: number[] = [];
  for (let x = 0; x < cols; x++) {
    const near = (x >= band[0] && x <= band[1]) || Math.abs(x - centre) <= cols / 3;
    // Not right beside another way into the middle: then it'd be the same way in.
    if (near && ![-1, 0, 1].some((dx) => takenCols.has(x + dx)) && free(cols + x)) ends.push(cols + x);
  }
  if (!starts.length || !ends.length) return null;
  const minLen = Math.max(4, Math.ceil(main.length * 0.6));
  const maxLen = Math.ceil(main.length * 1.5) + 2;
  for (let braid = 0; braid < 12; braid++) {
    const picks: (readonly [{ cells: number[]; from: number }, number])[] = [];
    for (const end of ends) {
      const d = distances(maze, end, free);
      for (const [start, from] of starts) {
        if (d[start]! < 0) continue;
        const cells = walkDown(maze, start, d);
        if (cells.length < minLen || cells.length > maxLen || longestRun(cells) > P.maxRun + 1) continue;
        // Away from the main path rather than alongside it: the further its middle, the better.
        picks.push([{ cells, from }, 1 + Math.abs(meanCol(cells) - mainCol)]);
      }
    }
    if (picks.length) return rng.weighted(picks);
    // Knock through a few walls between unused cells and look again.
    const walls: [number, number][] = [];
    for (let c = cols; c < cols * rows; c++) {
      if (!free(c)) continue;
      for (const e of around(maze, c)) if (e > c && free(e) && !joined(maze, c, e)) walls.push([c, e]);
    }
    if (!walls.length) return null;
    for (const [c, e] of rng.shuffle(walls).slice(0, Math.max(2, Math.floor(cols / 3)))) join(maze, c, e);
  }
  return null;
}

function build(rng: Rng, sym: Symmetry, P: SizeParams, maze: Maze, main: number[], ci: number): Route {
  const { cols, rows } = P;
  const row = (c: number) => Math.floor(c / cols);
  const kind = new Uint8Array(cols * rows);
  for (const c of main) kind[c] = KIND.path;
  const base = main[0]!;
  const used = (c: number) => kind[c] !== KIND.none;
  const routeFrom = () => distances(maze, base, used);
  const band = bandSpan(sym, cols, ci);

  // Lanes: more ways from the base to the middle (several paths to the same objective).
  const lanes: number[][] = [];
  const takenCols = new Set([ci]);
  const laneCount = rng.int(P.lanes[0], P.lanes[1]);
  for (let n = 0; n < laneCount; n++) {
    const lane = findLane(rng.fork(`lane${n}`), P, maze, kind, main, band, takenCols);
    if (!lane) break;
    for (const c of lane.cells) kind[c] = KIND.path;
    join(maze, lane.from, lane.cells[0]!);
    const endCol = lane.cells[lane.cells.length - 1]! % cols;
    takenCols.add(endCol);
    // The middle plaza reaches out to wherever it comes in, and (a rotated map) to where its copy does,
    // so the plaza stays the same shape either side of the middle line.
    const copyCol = sym === 'rotate' ? cols - 1 - endCol : endCol;
    band[0] = Math.min(band[0], endCol, copyCol);
    band[1] = Math.max(band[1], endCol, copyCol);
    lanes.push(lane.cells);
  }

  // Pockets: a cell or two off the path, down a side branch of the maze.
  const pockets: number[][] = [];
  const pocketCount = rng.int(P.pockets[0], P.pockets[1]);
  const starts = rng.shuffle(Array.from({ length: cols * rows }, (_, c) => c)
    .filter((c) => row(c) >= 1 && !used(c) && exits(maze, c).some((e) => kind[e] === KIND.path)));
  for (const c of starts) {
    if (pockets.length >= pocketCount) break;
    if (used(c) || around(maze, c).some((e) => kind[e] === KIND.pocket)) continue;
    const cells = [c];
    const further = exits(maze, c).filter((e) => row(e) >= 1 && !used(e) && !around(maze, e).some((f) => used(f) && f !== c));
    if (further.length && rng.chance(0.5)) cells.push(rng.pick(further));
    for (const p of cells) kind[p] = KIND.pocket;
    pockets.push(cells);
  }

  // Loops: reopen a wall between two parts of the route far apart along it, directly or through one
  // spare cell, as long as the walk from base to the middle stays long enough.
  const loops: { cells: number[] }[] = [];
  const loopCount = rng.int(P.loops[0], P.loops[1]);
  const minWalk = Math.ceil(main.length * 0.65);
  const cross = main[main.length - 1]!;
  for (let tries = 0; tries < 12 && loops.length < loopCount; tries++) {
    const d = routeFrom();
    const far = (a: number, b: number) => d[a]! >= 0 && d[b]! >= 0 && Math.abs(d[a]! - d[b]!) >= LOOP_SPAN;
    const direct: number[][] = [];
    const detour: number[][] = [];
    for (let c = cols; c < cols * rows; c++) {
      for (const e of around(maze, c)) {
        if (e < c || row(e) < 1) continue;
        if (used(c) && used(e) && !joined(maze, c, e) && far(c, e)) direct.push([c, e]);
      }
      if (used(c)) continue;
      const near = around(maze, c).filter((e) => row(e) >= 1 && used(e));
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        if (far(near[i]!, near[j]!)) detour.push([near[i]!, c, near[j]!]);
      }
    }
    const pool = rng.chance(0.65) && detour.length ? detour : direct.length ? direct : detour;
    if (!pool.length) break;
    const cells = rng.pick(pool);
    const before = { open: maze.open.slice(), kind: kind.slice() };
    for (let i = 1; i < cells.length; i++) join(maze, cells[i - 1]!, cells[i]!);
    if (cells.length === 3) kind[cells[1]!] = KIND.loop;
    if (routeFrom()[cross]! < minWalk - 1) {
      maze.open.set(before.open);
      kind.set(before.kind);
      continue;
    }
    loops.push({ cells });
  }

  // The band: from the crossing to its copy's column (a rotated map), or round the crossing (mirrored).
  const [a, b] = band;
  for (let c = a; c <= b; c++) {
    kind[c] = KIND.band;
    if (c > a) join(maze, c - 1, c);
  }
  join(maze, ci, cols + ci);
  // Each lane steps down into it too.
  for (const lane of lanes) {
    const end = lane[lane.length - 1]!;
    join(maze, end % cols, end);
  }

  return { cols, rows, maze, kind, label: routeFrom(), main, lanes, band: [a, b], pockets, loops };
}
