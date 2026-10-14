/**
 * Filling the layout, in red's half (then copied): the flag, spawns round it and pickup spots in
 * the pockets, loops and blobs come first and are kept clear. Then the middle plaza's centrepiece,
 * cover along every corridor (alternating sides, never in its middle strip), huts and a scatter of
 * the biome's things through the open areas, each with room to walk round it, and low cover round
 * the base yard.
 */

import { dist, distanceToRect, gapBetween, len, q, type Rect } from './dmath';
import { groundHeight, groundRange } from './heightField';
import type { Biome } from './biomes';
import { BLOCK, CELL, TAG, cellCentre, rectInside, rectTouches, tagAt, type Layout } from './layout';
import { hut, landmark, lift, type KitContext } from './objects';
import { KIND } from './route';
import type { Rng } from './rng';
import type { SizeParams } from './spec';
import { tPiece, tPoint } from './symmetry';
import type { Ground, MapBox, MapProp, MapTheme, Piece, PickupSpot, Spawn } from './types';

/** Room to walk between two things */
export const GAP = 1.6;
const FLAG_CLEAR = 4.5;
const SPAWN_CLEAR = 1.6;
const PICKUP_CLEAR = 1.6;
/** Most the ground may fall away under something set on it */
const MAX_TILT = 1;

/** 16 directions with rational-ish components (no trig), for rings of candidate spots */
const DIRS: [number, number][] = (() => {
  const raw: [number, number][] = [[1, 0], [12, 5], [4, 3], [5, 12], [0, 1], [-5, 12], [-3, 4], [-12, 5], [-1, 0], [-12, -5], [-4, -3], [-5, -12], [0, -1], [5, -12], [3, -4], [12, -5]];
  return raw.map(([x, z]) => { const l = len(x, z); return [x / l, z / l] as [number, number]; });
})();

export interface Filled {
  /**
   * The same things by side, for a map put together from two designs (generate.ts): red's pieces,
   * their copies in blue's half, the middle's centrepiece, and how many of `pickupSpots` and `targets`
   * are red's (they come first).
   */
  sides: { red: Piece[]; blue: Piece[]; centre: Piece; redPickups: number; redTargets: number };
  boxes: MapBox[];
  props: MapProp[];
  patches: NonNullable<Piece['patches']>;
  flags: { red: [number, number, number]; blue: [number, number, number] };
  spawns: Spawn[];
  pickupSpots: PickupSpot[];
  /** Spots that must be reachable on foot (outside hut doors) */
  targets: [number, number, number][];
}

const rectOfBox = (b: MapBox): Rect => ({ minX: b.x - b.w / 2, maxX: b.x + b.w / 2, minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2 });

export function fill(rng: Rng, l: Layout, g: Ground, biome: Biome, theme: MapTheme, P: SizeParams): Filled {
  const o = l.outline;
  const kit: KitContext = { rng, theme, color: () => rng.pick(theme.palette) };
  const red: Piece[] = [];
  const rects: Rect[] = [];
  const keep: [number, number, number][] = [];
  const at = (x: number, z: number) => groundHeight(g, x, z);

  /** Set a piece on the ground if it fits: inside the shape, off the corridors' middle strip, clear of everything else */
  const place = (piece: Piece, opts: { edge?: number; core?: boolean; gap?: number; red?: boolean } = {}): boolean => {
    const solid = piece.boxes.filter((b) => b.blocks !== 'shots');
    if (!solid.length) return false;
    const rs = solid.map(rectOfBox);
    for (const r of rs) {
      if (opts.red !== false && r.minZ < 1) return false;
      if (!rectInside(o, r, opts.edge ?? 0)) return false;
      if (!opts.core && rectTouches(l, r, [TAG.core])) return false;
      for (const e of rects) if (gapBetween(r, e) < (opts.gap ?? GAP)) return false;
      for (const [x, z, rad] of keep) if (distanceToRect(r, x, z) < rad) return false;
    }
    const minX = Math.min(...rs.map((r) => r.minX));
    const maxX = Math.max(...rs.map((r) => r.maxX));
    const minZ = Math.min(...rs.map((r) => r.minZ));
    const maxZ = Math.max(...rs.map((r) => r.maxZ));
    const range = groundRange(g, minX, maxX, minZ, maxZ);
    if (range.hi - range.lo > MAX_TILT) return false;
    red.push(lift(piece, range.lo));
    rects.push(...rs);
    return true;
  };

  // The flag.
  const [fx, fz] = [l.base.x, l.base.z];
  const flagY = q(at(fx, fz));
  keep.push([fx, fz, FLAG_CLEAR]);

  // Spawns round the flag, spread out.
  const spawnSpots: [number, number][] = [];
  const ringSpots = rng.shuffle([3.5, 5, 6.5, 8, 9.5].flatMap((r) => DIRS.map(([dx, dz]) => [q(fx + dx * r), q(fz + dz * r)] as [number, number])));
  for (const [x, z] of ringSpots) {
    if (spawnSpots.length >= P.spawnsPerTeam) break;
    if (!rectInside(o, { minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 }, 1) || z < 2) continue;
    if (spawnSpots.some(([sx, sz]) => dist(sx, sz, x, z) < 2.4)) continue;
    const r = groundRange(g, x - 0.6, x + 0.6, z - 0.6, z + 0.6);
    if (r.hi - r.lo > 0.5) continue;
    spawnSpots.push([x, z]);
  }
  for (const [x, z] of spawnSpots) keep.push([x, z, SPAWN_CLEAR]);

  // Pickup spots: pocket ends, loop cells, the blobs, and along the path.
  const P_ = P;
  const route = l.route;
  const centre = (c: number) => cellCentre(P_, c);
  const pickCandidates: [number, number, PickupSpot['tier']][] = [
    ...route.pockets.map((p) => [...centre(p[p.length - 1]!), 'weapon'] as [number, number, PickupSpot['tier']]),
    ...route.loops.flatMap((lp) => lp.cells.filter((c) => route.kind[c] === KIND.loop).map((c) => [...centre(c), 'ability'] as [number, number, PickupSpot['tier']])),
    ...l.blobs.map((b) => [b.x, b.z, 'any'] as [number, number, PickupSpot['tier']]),
    ...[0.4, 0.7, 0.55, 0.85].map((f) => [...centre(route.main[Math.floor(f * (route.main.length - 1))]!), 'any'] as [number, number, PickupSpot['tier']]),
  ];
  const pickups: PickupSpot[] = [];
  for (const [x, z, tier] of pickCandidates) {
    if (pickups.length >= P.pickups) break;
    if (!rectInside(o, { minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 }, 0.5)) continue;
    if (dist(x, z, fx, fz) < P.baseR || pickups.some((p) => dist(p.x, p.z, x, z) < 10)) continue;
    pickups.push({ x: q(x), y: q(at(x, z)), z: q(z), tier });
    keep.push([x, z, PICKUP_CLEAR]);
  }

  // The middle's centrepiece, once for both teams.
  const [a, b] = route.band;
  const lo = (CELL - 4) / 2;
  const bandX = q(-o.half + ((2 + a * CELL + lo) + (2 + b * CELL + lo + 3) + 1) * BLOCK / 2);
  const mark = landmark(rng.weighted(biome.landmarks), kit, bandX);
  const markRange = groundRange(g, bandX - 6, bandX + 6, -6, 6);
  const centrepiece = lift(mark, markRange.lo);
  rects.push(...centrepiece.boxes.filter((bx) => bx.blocks !== 'shots').map(rectOfBox));

  // Cover along every corridor: the main path into the plaza, the pockets and the loops.
  const lines = l.lines.map((line) => line.points.map(([x, z]) => [x, z] as [number, number]));
  for (const line of lines) {
    let side = rng.chance(0.5) ? 1 : -1;
    let carry = P.coverGap / 2;
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1]!;
      const [bx, bz] = line[i]!;
      const span = dist(ax, az, bx, bz);
      if (span === 0) continue;
      const ux = (bx - ax) / span;
      const uz = (bz - az) / span;
      let t = carry;
      for (; t < span; t += P.coverGap) {
        const x = ax + ux * t - uz * side * 2.9;
        const z = az + uz * t + ux * side * 2.9;
        side = -side;
        if (dist(x, z, fx, fz) < P.baseR - 1) continue;
        const axis = Math.abs(ux) > Math.abs(uz) ? 'x' : 'z';
        for (let tries = 0; tries < 3; tries++) if (place(rng.weighted(biome.cover)(kit, q(x), q(z), axis))) break;
      }
      carry = t - span;
    }
  }

  // Cover round the plaza.
  const bandBlocks: [number, number][] = [];
  for (let k = o.n / 2 + 1; k < o.n / 2 + 5; k++) {
    for (let i = 0; i < o.n; i++) if (l.tag[k * o.n + i] === TAG.band) bandBlocks.push([-o.half + (i + 0.5) * BLOCK, -o.half + (k + 0.5) * BLOCK]);
  }
  let plaza = rng.int(2, 4);
  for (let tries = 0; tries < 30 && plaza > 0 && bandBlocks.length; tries++) {
    const [x, z] = rng.pick(bandBlocks);
    if (place(rng.weighted(biome.cover)(kit, q(x), q(z), rng.chance(0.5) ? 'x' : 'z'), { edge: 0.5 })) plaza--;
  }

  // Huts in the open areas, with room all round and a door at each end.
  const targets: [number, number, number][] = [];
  const blobBlocks = l.blobs.flatMap((bl) => bl.cells);
  let huts = rng.int(biome.huts[0], biome.huts[1]);
  for (let tries = 0; tries < 40 && huts > 0 && blobBlocks.length; tries++) {
    const c = rng.pick(blobBlocks);
    const x = -o.half + ((c % o.n) + 0.5) * BLOCK;
    const z = -o.half + (Math.floor(c / o.n) + 0.5) * BLOCK;
    const h = hut(rng, biome.hut, q(x), q(z), rng.chance(0.5) ? 'x' : 'z');
    if (!h.doors.every(([dx, dz]) => rectInside(o, { minX: dx - 0.8, maxX: dx + 0.8, minZ: dz - 0.8, maxZ: dz + 0.8 }, 0.4))) continue;
    if (!place(h.piece, { edge: 1.8, gap: 2.2 })) continue;
    for (const [dx, dz] of h.doors) targets.push([dx, q(at(dx, dz)), dz]);
    huts--;
  }

  // The open areas: a scatter of the biome's things, with room to walk between.
  for (const bl of l.blobs) {
    const want = Math.round(((bl.cells.length * BLOCK * BLOCK) / 100) * biome.density);
    let placed = 0;
    for (let tries = 0; tries < want * 6 && placed < want; tries++) {
      const c = rng.pick(bl.cells);
      const x = -o.half + ((c % o.n) + rng.range(0.1, 0.9)) * BLOCK;
      const z = -o.half + (Math.floor(c / o.n) + rng.range(0.1, 0.9)) * BLOCK;
      if (place(rng.weighted(biome.fill)(kit, q(x), q(z), rng.chance(0.5) ? 'x' : 'z'))) placed++;
    }
  }

  // Low cover round the edge of the base yard.
  let yard = rng.int(2, 3);
  for (let tries = 0; tries < 24 && yard > 0; tries++) {
    const [dx, dz] = rng.pick(DIRS);
    const r = rng.range(P.baseR - 2.5, P.baseR);
    const x = q(fx + dx * r);
    const z = q(fz + dz * r);
    if (tagAt(l, x, z) === TAG.outside) continue;
    if (place(rng.weighted(biome.cover)(kit, x, z, Math.abs(dx) > Math.abs(dz) ? 'z' : 'x'), { edge: 0.5 })) yard--;
  }

  // Copy red's half.
  const sym = l.sym;
  const blue = red.map((p) => tPiece(sym, p));
  const pieces = [...red, ...blue, centrepiece];
  const [bx, bz] = tPoint(sym, fx, fz);
  return {
    sides: { red, blue, centre: centrepiece, redPickups: pickups.length, redTargets: targets.length },
    boxes: pieces.flatMap((p) => p.boxes),
    props: pieces.flatMap((p) => p.props ?? []),
    patches: pieces.flatMap((p) => p.patches ?? []),
    flags: { red: [q(fx), flagY, q(fz)], blue: [bx, flagY, bz] },
    spawns: [
      ...spawnSpots.map(([x, z]) => ({ x, y: q(at(x, z)), z, team: 'red' as const })),
      ...spawnSpots.map(([x, z]) => { const [tx, tz] = tPoint(sym, x, z); return { x: tx, y: q(at(x, z)), z: tz, team: 'blue' as const }; }),
    ],
    pickupSpots: [...pickups, ...pickups.map((p) => { const [tx, tz] = tPoint(sym, p.x, p.z); return { ...p, x: tx, z: tz }; })],
    targets: [...targets, ...targets.map(([x, y, z]) => { const [tx, tz] = tPoint(sym, x, z); return [tx, y, tz] as [number, number, number]; })],
  };
}
