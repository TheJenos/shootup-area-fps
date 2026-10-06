/**
 * The map's outline. Instead of a plain square, walls are pushed in from the edges: corner blocks
 * (L-shaped corners), notches along the sides, stepped bends, and sometimes a pinched waist across
 * the middle. They're mirrored between the team halves like everything else, and the two sides
 * (east and west) are carved differently. The outer square walls are still there behind them.
 *
 * Every wall is a right angle, so collision stays axis-aligned boxes. Separate walls either touch
 * (making one bent wall) or leave at least GAP between them, so there are no slots to get stuck in.
 */

import { ARENA_HALF, GAP, Placer, gapBetween, round, type Rect } from './core';
import { propsTagged } from './props';
import type { MapBox, MapStyle, Piece } from './types';

const WALL_H = 6;
/** Keep the outline this far from the flags (x and z) */
const FLAG_KEEP_X = 12;
const FLAG_KEEP_Z = 34;
/** Never push in further than this from an edge, so the middle stays open */
const MAX_DEPTH = 25;

/**
 * Rectangles for one side of the north half (east if sx = 1, west if sx = -1). Each side picks its
 * own corner: a staircase that reads as a cut or rounded corner, a big block (a plus-shaped map),
 * or a smaller L, plus notches along its walls.
 */
function sideShapes(p: Placer, sx: 1 | -1): Rect[] {
  const E = ARENA_HALF;
  const out: Rect[] = [];
  // In east-side coordinates (x ≥ 0), flipped at the end for the west.
  const add = (x0: number, x1: number, z0: number, z1: number) => out.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 });
  const corner = p.pick(['stairs', 'stairs', 'block', 'l', 'none'] as const);
  let cornerSize = 0;
  if (corner === 'stairs') {
    // Steps cut diagonally across the corner: from far off it reads as a bevelled or rounded edge.
    const size = p.range(16, 25);
    const steps = 3 + Math.floor(p.rand() * 3);
    const curve = p.chance(0.5);
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      // A rounded corner bulges: its steps follow a quarter circle instead of a straight line.
      const along = curve ? size * (1 - Math.sqrt(1 - t1 * t1)) : size * t1;
      const depth = size - (curve ? size * (1 - Math.sqrt(1 - t0 * t0)) : size * t0);
      add(E - depth, E, E - Math.max(1.6, along), E);
    }
    cornerSize = size;
  } else if (corner === 'block') {
    const w = p.range(16, 24);
    const d = p.range(16, 24);
    add(E - w, E, E - d, E);
    cornerSize = Math.max(w, d);
  } else if (corner === 'l') {
    const w = p.range(8, 15);
    const d = p.range(8, 15);
    add(E - w, E, E - d, E);
    if (p.chance(0.5)) add(E - w - p.range(3, 5), E - w, E - p.range(3, Math.max(3.5, d - 2)), E);
    cornerSize = Math.max(w, d);
  }
  // Notches along the side wall (x = E), between the middle and the corner.
  const notches = p.chance(0.85) ? 1 + (p.chance(0.5) ? 1 : 0) : 0;
  for (let i = 0; i < notches; i++) {
    const len = p.range(7, 16);
    const room = E - cornerSize - 3 - len;
    if (room < 3) break;
    const z0 = p.range(3, room);
    const depth = p.range(5, 19);
    add(E - depth, E, z0, z0 + len);
    if (p.chance(0.4)) {
      // A step on one end: a bent wall.
      const step = p.range(2, 6);
      add(E - depth - step, E - depth, z0, z0 + p.range(2.5, len - 1));
    }
  }
  // A notch in the back wall (z = E) between the flag and the corner.
  if (p.chance(0.6)) {
    const len = p.range(7, 15);
    const room = E - Math.max(cornerSize, 3) - len - 1;
    if (room > FLAG_KEEP_X) {
      const x0 = p.range(FLAG_KEEP_X, room);
      const depth = p.range(4, 12);
      add(x0, x0 + len, E - depth, E);
    }
  }
  return out.map((r) => (sx === 1 ? r : { minX: -r.maxX, maxX: -r.minX, minZ: r.minZ, maxZ: r.maxZ }));
}

/** A pinch across the middle on one side (centred on z = 0, so it's its own mirror image). */
function waist(p: Placer, sx: 1 | -1): Rect | null {
  if (!p.chance(0.45)) return null;
  const depth = p.range(8, 21);
  const half = p.range(4, 9);
  const E = ARENA_HALF;
  return sx === 1 ? { minX: E - depth, maxX: E, minZ: -half, maxZ: half } : { minX: -E, maxX: -E + depth, minZ: -half, maxZ: half };
}

/** Is a rectangle allowed: inside the depth limit, clear of the flags, and not making a thin slot? */
function allowed(r: Rect, kept: Rect[]): boolean {
  const E = ARENA_HALF;
  const depthX = Math.min(r.maxX + E, E - r.minX);
  const depthZ = Math.min(r.maxZ + E, E - r.minZ);
  if (Math.min(depthX, depthZ) > MAX_DEPTH) return false;
  // The flag spots at (0, ±45) and the ground in front of them stay open.
  if (r.minX < FLAG_KEEP_X && r.maxX > -FLAG_KEEP_X && Math.max(Math.abs(r.minZ), Math.abs(r.maxZ)) > FLAG_KEEP_Z) return false;
  for (const k of kept) {
    const g = gapBetween(k, r);
    if (g > 0.001 && g < GAP + 0.4) return false;
  }
  return true;
}

const SURFACE: Record<MapStyle, MapBox['surface']> = { arena: 'perimeter', industrial: 'perimeter', town: 'brick', outdoor: 'rock' };

/**
 * Carve the outline into the map: places the walls (before anything else, so all other pieces keep
 * their distance) and moves spawns that ended up too close to them.
 */
export function carveOutline(p: Placer, style: MapStyle): void {
  const north: Rect[] = [];
  for (const sx of [1, -1] as const) {
    for (const r of sideShapes(p, sx)) if (allowed(r, north)) north.push(r);
  }
  const middle: Rect[] = [];
  for (const sx of [1, -1] as const) {
    const w = waist(p, sx);
    if (w && allowed(w, [...north, ...north.map((r) => ({ ...r, minZ: -r.maxZ, maxZ: -r.minZ }))])) middle.push(w);
  }

  const surface = SURFACE[style];
  const color = p.theme.wall;
  const box = (r: Rect): MapBox => ({
    x: round((r.minX + r.maxX) / 2), z: round((r.minZ + r.maxZ) / 2), w: round(r.maxX - r.minX), d: round(r.maxZ - r.minZ),
    h: WALL_H, y: 0, color, surface, step: 'hard',
  });
  const trees = style === 'outdoor' ? propsTagged('tree').filter((id) => id !== 'tree-street') : [];
  const dress = (r: Rect): Piece['props'] => {
    // Trees along the top of outdoor cliffs, so the edge of the map reads as a ridge.
    if (!trees.length) return [];
    const out: NonNullable<Piece['props']> = [];
    const n = Math.floor(((r.maxX - r.minX) * (r.maxZ - r.minZ)) / 22);
    for (let i = 0; i < n; i++) {
      out.push({
        id: p.pick(trees), x: round(p.range(r.minX + 1, r.maxX - 1)), z: round(p.range(r.minZ + 1, r.maxZ - 1)),
        y: WALL_H, rot: p.pick([0, 1, 2, 3] as const), scale: round(p.range(0.8, 1.2)),
      });
    }
    return out;
  };

  for (const r of north) p.place({ boxes: [box(r)], props: dress(r) });
  for (const r of middle) p.placeAsIs({ boxes: [box(r)], props: dress(r) });

  const all = [...north, ...north.map((r) => ({ ...r, minZ: -r.maxZ, maxZ: -r.minZ })), ...middle];
  p.moveSpawns(all);
}
