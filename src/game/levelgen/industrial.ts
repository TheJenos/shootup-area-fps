/**
 * Industrial maps: a gantry, tank farm or shed in the middle, a warehouse in each quarter with a
 * catwalk under high windows, rows of shipping containers you can climb (some stacked two high,
 * some joined by a bridge), and barrels, pallets and barriers between them.
 */

import { building, openingsFor } from './building';
import { GAP, INNER, Placer, rectOf, round } from './core';
import { fillCover } from './pieces';
import { carveOutline } from './outline';
import { propPiece, propSize } from './props';
import type { MapBox, MapLayout, Piece } from './types';

/** ISO-ish 20 ft container */
const BOX = { len: 6, h: 2.6, w: 2.4 };
const CONTAINER_COLORS = [0xb5482f, 0x2f6fa8, 0x3f8a4a, 0xd08a2a, 0x7d8597, 0x8a3f5f];
const CRATE = 1.3;

/** Crate steps up to a top at `topY`, ending at `edge` and heading away from it along `dir`. */
function stepsTo(axis: 'x' | 'z', edge: number, cross: number, dir: 1 | -1, y: number, color: number): MapBox[] {
  // Two crates: 0.9 m and 1.8 m above `y`, then the top 0.8 m above that — all within a jump.
  const near = edge + dir * (CRATE / 2);
  const far = edge + dir * (CRATE * 1.5);
  const at = (along: number, h: number): MapBox => (axis === 'x'
    ? { x: round(along), z: round(cross), w: CRATE, d: CRATE, h, y: round(y), color, surface: 'crate' }
    : { x: round(cross), z: round(along), w: CRATE, d: CRATE, h, y: round(y), color, surface: 'crate' });
  return [at(near, 1.8), at(far, 0.9)];
}

/** A row of 1–3 containers along `axis` from (x, z), maybe with a second layer, plus crate steps. */
function containerRow(p: Placer, x: number, z: number, axis: 'x' | 'z'): Piece {
  const n = 1 + Math.floor(p.rand() * 3);
  const gap = p.range(1.8, 2.4);
  const boxes: MapBox[] = [];
  const at = (along: number, y: number, color: number): MapBox => (axis === 'x'
    ? { x: round(x + along), z: round(z), w: BOX.len, d: BOX.w, h: BOX.h, y, color, surface: 'container', step: 'hard' }
    : { x: round(x), z: round(z + along), w: BOX.w, d: BOX.len, h: BOX.h, y, color, surface: 'container', step: 'hard' });
  const centers: number[] = [];
  for (let i = 0; i < n; i++) centers.push(i * (BOX.len + gap));
  for (const c of centers) boxes.push(at(c, 0, p.pick(CONTAINER_COLORS)));
  const start = (centers[0] ?? 0) - BOX.len / 2;
  const cross = axis === 'x' ? z : x;
  const base = axis === 'x' ? x : z;
  const crate = p.color();
  // Up onto the first layer from the start end of the row.
  boxes.push(...stepsTo(axis, base + start, cross, -1, 0, crate));
  if (n >= 2 && p.chance(0.5)) {
    // Second layer straddling the first gap, with steps up on the free part of the first container.
    const mid = ((centers[0] ?? 0) + (centers[1] ?? 0)) / 2;
    boxes.push(at(mid, BOX.h, p.pick(CONTAINER_COLORS)));
    boxes.push(...stepsTo(axis, base + mid - BOX.len / 2, cross, -1, BOX.h, crate));
  }
  return { boxes };
}

/** Two parallel container rows with a metal bridge between their tops. */
function containerYard(p: Placer, x: number, z: number, axis: 'x' | 'z'): Piece {
  const a = containerRow(p, x, z, axis);
  const spacing = BOX.w + p.range(3, 4.5);
  const b = containerRow(p, axis === 'x' ? x : x + spacing, axis === 'x' ? z + spacing : z, axis);
  const bridge: MapBox = axis === 'x'
    ? { x: round(x), z: round(z + spacing / 2), w: 1.6, d: round(spacing - BOX.w), h: 0.2, y: BOX.h - 0.2, color: 0x7d8597, surface: 'metal', step: 'hard' }
    : { x: round(x + spacing / 2), z: round(z), w: round(spacing - BOX.w), d: 1.6, h: 0.2, y: BOX.h - 0.2, color: 0x7d8597, surface: 'metal', step: 'hard' };
  return { boxes: [...a.boxes, ...b.boxes, bridge] };
}

/** Barrels in a tight cluster: low cover you can't see through. */
function barrels(p: Placer, x: number, z: number): Piece {
  const color = p.pick([0x3f6fa8, 0xb5482f, 0x5c6b4a, 0xc9a23a]);
  const r = 0.62;
  const spots: [number, number][] = [[0, 0], [r, 0], [0, r], [r, r]].slice(0, 2 + Math.floor(p.rand() * 3)) as [number, number][];
  return {
    boxes: spots.map(([dx, dz]) => ({
      x: round(x + dx), z: round(z + dz), w: 0.6, d: 0.6, h: 0.95, y: 0, color, surface: 'metal', shape: 'cylinder', step: 'hard',
    })),
  };
}

/** A stack of pallets (crate texture), waist or chest high. */
function pallets(p: Placer, x: number, z: number): Piece {
  const h = p.pick([0.6, 1.1, 1.3]);
  return { boxes: [{ x: round(x), z: round(z), w: 1.4, d: 1.2, h, y: 0, color: p.pick([0xa07a4f, 0x8a6a45]), surface: 'crate' }] };
}

/** Concrete jersey barrier: knee-to-chest cover. */
function barrier(p: Placer, x: number, z: number): Piece {
  const along = p.chance(0.5);
  return { boxes: [{ x: round(x), z: round(z), w: along ? 2.4 : 0.7, d: along ? 0.7 : 2.4, h: 1.05, y: 0, color: 0xb9b6ad, surface: 'concrete' }] };
}

function warehouse(p: Placer, x: number, z: number, w: number, d: number): Piece {
  const t = 0.35;
  const wallH = 6.5;
  const catY = 3.25;
  const long: 'n' | 's' | 'e' | 'w' = w >= d ? p.pick(['n', 's'] as const) : p.pick(['e', 'w'] as const);
  const openings = openingsFor(p.rand, w, d, t, {
    doors: 3, doorWidth: 3, doorTop: 3.4, windowsPerSide: [0, 1],
    // High window strip at catwalk height: sniper spots looking out.
    upperY: catY,
  });
  const piece = building({
    x, z, w, d, wallH, t,
    wall: p.pick(['metal', 'brick'] as const), wallColor: p.color(),
    floor: 'metal', floorColor: 0x7d8597,
    roof: 'metal', roofColor: 0x6b7563,
    openings,
    catwalk: { y: catY, side: long, width: 1.8, color: 0x7d8597 },
    skylight: true,
  });
  piece.ground = [{ x: round(x), z: round(z), w: round(w + 3), d: round(d + 3), kind: 'concrete' }];
  // A few crates inside for cover.
  for (let i = 0; i < 3; i++) {
    const cx = x + (p.rand() - 0.5) * (w - 5);
    const cz = z + (p.rand() - 0.5) * (d - 5);
    piece.boxes.push({ x: round(cx), z: round(cz), w: 1.4, d: 1.4, h: 1.4, y: 0, color: p.color(), surface: 'crate' });
  }
  return piece;
}

/** A symmetric piece in the middle of the map. */
function centerpiece(p: Placer): void {
  const kind = p.pick(['gantry', 'tanks', 'shed', 'open'] as const);
  if (kind === 'gantry') {
    // An elevated bridge across the middle along x, ramps up at both ends, railings you shoot through.
    const y = 3.4;
    const half = round(p.range(5, 7));
    const run = round(y * 1.5);
    const color = 0x7d8597;
    const boxes: MapBox[] = [
      { x: 0, z: 0, w: half * 2, d: 2.2, h: 0.25, y: y - 0.25, color, surface: 'metal', step: 'hard' },
      { x: round(half + run / 2), z: 0, w: run, d: 2.2, h: y, y: 0, color, surface: 'metal', ramp: 'x-', step: 'hard' },
      { x: round(-half - run / 2), z: 0, w: run, d: 2.2, h: y, y: 0, color, surface: 'metal', ramp: 'x+', step: 'hard' },
    ];
    for (const sz of [1, -1]) boxes.push({ x: 0, z: sz * 1.05, w: half * 2, d: 0.1, h: 1, y, color, surface: 'metal', blocks: 'move' });
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      boxes.push({ x: round(sx * (half - 1)), z: sz * 0.9, w: 0.4, d: 0.4, h: y - 0.25, y: 0, color, surface: 'metal' });
    }
    p.placeAsIs({ boxes, ground: [{ x: 0, z: 0, w: round(half * 2 + run * 2 + 2), d: 5, kind: 'hazard' }] });
  } else if (kind === 'tanks') {
    const r = round(p.range(2, 2.6));
    const off = round(r + p.range(1.4, 2.4));
    const h = round(p.range(4.5, 6.5));
    const color = p.pick([0xc9c9c0, 0x8fbf3f, 0xb9b6ad]);
    const tank = (x: number): MapBox => ({ x, z: off, w: r * 2, d: r * 2, h, y: 0, color, surface: 'metal', shape: 'cylinder' });
    p.place({ boxes: [tank(off), tank(-off)] });
  } else if (kind === 'shed') {
    const s = round(p.range(9, 11));
    const openings = (['n', 's', 'e', 'w'] as const).map((side) => ({ side, at: 0, width: 2.4, bottom: 0, top: 2.6 }));
    p.placeAsIs(building({
      x: 0, z: 0, w: s, d: s, wallH: 3.4, t: 0.35, wall: 'concrete', wallColor: p.color(), floor: 'concrete', floorColor: 0x9a9a92,
      roof: 'metal', roofColor: 0x6b7563, openings, skylight: true,
    }));
  }
}

export function industrialLayout(seed: string, p: Placer): MapLayout {
  carveOutline(p, 'industrial');
  // Keep the lanes to both flags and the side spawns open.
  p.reserve({ minX: -3, maxX: 3, minZ: 28, maxZ: INNER });
  p.reserve({ minX: 28, maxX: INNER, minZ: -3, maxZ: 3 });
  p.reserve({ minX: -INNER, maxX: -28, minZ: -3, maxZ: 3 });
  centerpiece(p);

  // A warehouse or two on each side of our half (mirrored into the other), if they fit.
  for (const sx of [1, -1, 1, -1].slice(0, 2 + (p.chance(0.6) ? 2 : 0))) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const flip = p.chance(0.5);
      const w = round(flip ? p.range(10, 13) : p.range(14, 17));
      const d = round(flip ? p.range(14, 17) : p.range(10, 13));
      const x = round(sx * p.range(w / 2 + GAP, INNER - GAP - w / 2));
      const z = round(p.range(d / 2 + GAP, INNER - GAP - d / 2));
      const piece = warehouse(p, x, z, w, d);
      if (rectOf(piece.boxes).minZ < GAP) continue;
      if (!p.fits(piece)) continue;
      p.place(piece);
      break;
    }
  }

  // Landmarks: a water tower, chimneys, tanks, or a closed factory block.
  const landmarks = 3 + Math.floor(p.rand() * 4);
  for (let placed = 0, attempt = 0; attempt < 200 && placed < landmarks; attempt++) {
    const id = p.pick(['water-tower', 'chimney', 'chimney-medium', 'tank-large', 'tank', 'factory-c', 'factory-d', 'factory-e'] as const);
    const rot = p.pick([0, 1, 2, 3] as const);
    const s = propSize(id, rot);
    const x = round(p.range(-INNER + GAP + s.w / 2, INNER - GAP - s.w / 2));
    const z = round(p.range(s.d / 2 + GAP, INNER - GAP - s.d / 2));
    const piece = propPiece(id, x, z, rot);
    if (z - s.d / 2 < GAP || !p.fits(piece)) continue;
    p.place(piece);
    placed++;
  }

  // Container rows and yards.
  const rows = 8 + Math.floor(p.rand() * 7);
  for (let placed = 0, attempt = 0; attempt < 400 && placed < rows; attempt++) {
    const axis = p.chance(0.5) ? 'x' : 'z';
    const x = p.range(-INNER + 8, INNER - 8);
    const z = p.range(4, INNER - 8);
    const piece = p.chance(0.35) ? containerYard(p, x, z, axis) : containerRow(p, x, z, axis);
    const r = rectOf(piece.boxes);
    if (r.minZ < GAP) continue;
    if (!p.fits(piece)) continue;
    p.place(piece);
    placed++;
  }

  // Small industrial cover, then the classic pieces to fill the gaps.
  const smalls = 20 + Math.floor(p.rand() * 16);
  for (let placed = 0, attempt = 0; attempt < 700 && placed < smalls; attempt++) {
    const x = p.range(-INNER + 2, INNER - 2);
    const z = p.range(2, INNER - 2);
    const kind = p.rand();
    const piece = kind < 0.4 ? barrels(p, x, z) : kind < 0.7 ? pallets(p, x, z) : barrier(p, x, z);
    const r = rectOf(piece.boxes);
    if (r.minZ < GAP / 2) continue;
    if (!p.fits(piece, { ignoreReserved: true })) continue;
    p.place(piece);
    placed++;
  }
  fillCover(p, 12 + Math.floor(p.rand() * 14), 700);
  return p.result(seed, 'industrial');
}
