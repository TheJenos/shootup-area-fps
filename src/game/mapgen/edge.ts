/**
 * What stands outside the map's shape: buildings (town and refinery maps) or cliffs (quarries and
 * highlands) over every outside block next to the play area, including the walls between corridors,
 * and filling every pocket the play area walls in, detailed on the faces the players see.
 */

import { groundRange } from './heightField';
import { q } from './dmath';
import type { Outline } from './layout';
import type { Rng } from './rng';
import { tPiece, type Symmetry } from './symmetry';
import type { BoxSurface } from '../textures';
import type { Ground, MapBox } from './types';

/** What stands outside a map's shape */
export interface EdgeStyle {
  kind: 'buildings' | 'cliffs';
  surfaces: readonly BoxSurface[];
  colors: readonly number[];
  /** Height above the highest ground under each block of it (m) */
  height: [number, number];
}

/** How deep the walls round the play area are (blocks): further out is hidden behind them, and left bare */
const REACH = 1;

/** Outside blocks the grid's edge can't reach through other outside blocks: pockets walled in by the play area */
function enclosed(o: Outline): Uint8Array {
  const { n } = o;
  const out = new Uint8Array(n * n);
  for (let c = 0; c < n * n; c++) if (!o.inside[c]) out[c] = 1;
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const c of [i, (n - 1) * n + i, i * n, i * n + n - 1]) if (out[c] === 1) { out[c] = 0; queue.push(c); }
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    const i = c % n;
    const k = (c - i) / n;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const bi = i + di;
      const bk = k + dk;
      if (bi < 0 || bk < 0 || bi >= n || bk >= n) continue;
      const d = bk * n + bi;
      if (out[d] === 1) { out[d] = 0; queue.push(d); }
    }
  }
  return out;
}

/** Blocks from each block to the nearest inside one (Chebyshev), capped at REACH + 1 */
function nearInside(o: Outline): Uint8Array {
  const { n } = o;
  const d = new Uint8Array(n * n).fill(REACH + 1);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    if (!o.inside[k * n + i]) continue;
    for (let b = -REACH; b <= REACH; b++) for (let a = -REACH; a <= REACH; a++) {
      const bi = i + a;
      const bk = k + b;
      if (bi < 0 || bk < 0 || bi >= n || bk >= n) continue;
      const v = Math.max(Math.abs(a), Math.abs(b));
      if (v < d[bk * n + bi]!) d[bk * n + bi] = v;
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
export function edgeMasses(o: Outline, ground: Ground, sym: Symmetry | 'none', style: EdgeStyle, rng: Rng): MapBox[] {
  const { n, cell, half } = o;
  const mid = n / 2;
  const taken = new Uint8Array(n * n);
  const near = nearInside(o);
  // Pockets walled in by the play area are filled solid, in big pieces; elsewhere just the band round it.
  const pocket = enclosed(o);
  // An asymmetric map ('none') is walled in over both halves as it stands, nothing copied; a mass never
  // reaches across the middle line, so each half's wear their own team's colour.
  const both = sym === 'none';
  const sameHalf = (k: number, k2: number) => !both || (k < mid) === (k2 < mid);
  const free = (i: number, k: number) => i < n && k < n && !o.inside[k * n + i] && !taken[k * n + i] && (near[k * n + i]! <= REACH || pocket[k * n + i] === 1);
  const boxes: MapBox[] = [];
  for (let k = both ? 0 : mid; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!free(i, k)) continue;
      // Grow along x, then along z while the whole row is free.
      let w = 1;
      const big = pocket[k * n + i] === 1;
      const maxW = big ? 16 : rng.int(3, 7);
      while (w < maxW && free(i + w, k)) w++;
      let d = 1;
      const maxD = big ? 16 : rng.int(3, 7);
      while (d < maxD && k + d < n && sameHalf(k, k + d) && Array.from({ length: w }, (_, a) => free(i + a, k + d)).every(Boolean)) d++;
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
      if (w * d >= 6 && rng.chance(style.kind === 'cliffs' ? 0.6 : 0.35)) {
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
      if (sym === 'none') {
        boxes.push(...part, ...(k >= mid ? accents : accents.map((b) => ({ ...b, color: TEAM_ACCENT.blue }))));
        continue;
      }
      boxes.push(...part, ...accents, ...tPiece(sym, { boxes: part }).boxes);
      boxes.push(...tPiece(sym, { boxes: accents }).boxes.map((b) => ({ ...b, color: TEAM_ACCENT.blue })));
    }
  }
  return boxes;
}
