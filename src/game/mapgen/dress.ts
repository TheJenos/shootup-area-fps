/**
 * Dressing: turns the lane graph and its terrain into a map you play on.
 *
 * Structures first, each on a flat pad cut into the terrain: the landmark in the middle, overlook
 * platforms, footbridges over the chokes, buildings and big models on the ridges, houses with
 * walkable roofs, a raised post at each base. Then the terrain is final, and the rest stands on
 * it: cover along every lane at a steady rhythm (alternating sides, never in the lane's middle
 * strip), landing cover past each choke, cover round the middle and the bases, rocks and trees
 * on the ridges. Last, sightlines that are still too long get a tall piece of cover across them.
 */

import { groundHeight } from './heightField';
import { dist, len, q } from './dmath';
import type { Biome, Cover } from './biomes';
import type { Graph, Lane, LaneSample } from './graph';
import {
  building, bridge, doorsOf, landmark, openingsFor, pillar, platform, propPiece, roofRampRect, roofRampRun,
  type BuildingSpec, type KitContext, type PlatformSpec, type Side,
} from './kits';
import { GAP, Placer, WALK_ZONES } from './placer';
import type { Rng } from './rng';
import { Occlusion, exposure, longSightlines, pathPoints, type Sight } from './sightlines';
import type { SizeParams } from './spec';
import { tPoint } from './symmetry';
import { ZONE, type Terrain, type ZoneId } from './terrain';
import type { Ground, MapBox, MapTheme, Piece, PickupSpot, PropRot, Spawn } from './types';

export interface Dressed {
  ground: Ground;
  boxes: MapBox[];
  props: Piece['props'] & object;
  patches: NonNullable<Piece['patches']>;
  spawns: Spawn[];
  pickupSpots: PickupSpot[];
  /** Spots that must be reachable on foot: [x, y, z] (doors, platform tops, bridge decks) */
  targets: [number, number, number][];
  sight: SightReport;
}

export interface SightReport {
  /** Longest remaining sightline along each lane, over its budget (0 = within) */
  laneOver: number;
  /** Enemy-half spots that see a flag from further than the limit */
  flagSeen: number;
  /** Enemy-half spots that see a spawn */
  spawnSeen: number;
  breakers: number;
  /** The worst remaining sightlines (for scripts/check-maps.ts pictures) */
  lines: Sight[];
}

/** 16 directions with rational-ish components (no trig), for rings of candidate spots */
const DIRS: [number, number][] = (() => {
  const raw: [number, number][] = [[1, 0], [12, 5], [4, 3], [5, 12], [0, 1], [-5, 12], [-3, 4], [-12, 5], [-1, 0], [-12, -5], [-4, -3], [-5, -12], [0, -1], [5, -12], [3, -4], [12, -5]];
  return raw.map(([x, z]) => { const l = len(x, z); return [x / l, z / l] as [number, number]; });
})();

const ZONES_RIDGE: readonly ZoneId[] = [ZONE.ridge, ZONE.edge, ZONE.shoulder];

/** The nearest lane sample to (x, z) in red's half */
function nearestSample(g: Graph, x: number, z: number): LaneSample {
  let best: LaneSample = g.lanes[0]!.samples[0]!;
  let bestD = Infinity;
  for (const l of g.lanes) for (const p of l.samples) {
    const d = dist(p.x, p.z, x, z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Turn whose front (+z of the model) faces (dx, dz) */
function faceRot(dx: number, dz: number): PropRot {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}

const sampleAt = (l: Lane, s: number): LaneSample =>
  l.samples.reduce((best, p) => (Math.abs(p.s - s) < Math.abs(best.s - s) ? p : best));

export function dress(rng: Rng, g: Graph, t: Terrain, biome: Biome, theme: MapTheme, P: SizeParams): Dressed {
  const sym = g.sym;
  const flagRed: [number, number] = [g.base.x, g.base.z];
  const flagBlue = tPoint(sym, g.base.x, g.base.z);
  const place = rng.fork('place');
  const p = new Placer(place, t, theme, sym, [flagRed, flagBlue]);
  const k: KitContext = { rng: rng.fork('kits'), theme, color: () => p.color() };
  const targets: [number, number, number][] = [];
  const rampFeet: [number, number][] = [];
  const view: Ground = { n: t.n, cell: 1, half: t.half, heights: t.heights, paint: new Uint8Array(0) };
  const hNow = (x: number, z: number) => groundHeight(view, x, z);
  const H = g.half;
  const scale = H / 54;

  // ---------------------------------------------------------------- spawns, on the base plateau
  {
    const want = P.spawnsPerTeam;
    const cands: [number, number, number][] = [];
    for (const [dx, dz] of DIRS) {
      for (const r of [5.5, 7.5, g.base.r - 1.2]) {
        const x = q(g.base.x + dx * r);
        const z = q(g.base.z + dz * r);
        if (t.excess[t.vertex(x, z)]! > -0.8 || t.zone[t.vertex(x, z)] !== ZONE.base) continue;
        // Behind and beside the flag first.
        cands.push([x, z, dz * 2 + rng.next()]);
      }
    }
    cands.sort((a, b) => b[2] - a[2] || a[0] - b[0]);
    const chosen: [number, number][] = [];
    for (const minGap of [3.4, 2.6]) {
      for (const [x, z] of cands) {
        if (chosen.length >= want) break;
        if (chosen.some(([cx, cz]) => dist(cx, cz, x, z) < minGap)) continue;
        chosen.push([x, z]);
      }
    }
    p.spawns = chosen;
  }

  // ---------------------------------------------------------------- the middle's landmark
  {
    const id = rng.weighted(biome.landmarks);
    const piece = landmark(id, k, g.mid.r);
    const at = p.check(piece, { mode: 'pad', self: true, padH: g.mid.h, maxCut: 3, core: true, gap: 0 });
    if (at) {
      p.commit(piece, at.dy, at.rect, { mode: 'pad', self: true });
      for (const b of piece.boxes) if (b.ramp) targets.push([b.x, at.dy + b.y + b.h, b.z]);
    }
  }

  // ---------------------------------------------------------------- overlooks
  for (const ov of g.overlooks) {
    const face: PlatformSpec['parapet'] = Math.abs(ov.nx) >= Math.abs(ov.nz) ? (ov.nx > 0 ? 'x+' : 'x-') : (ov.nz > 0 ? 'z+' : 'z-');
    const across: PlatformSpec['ramp'][] = face[0] === 'x' ? ['z+', 'z-'] : ['x+', 'x-'];
    const opposite = (face[0] + (face[1] === '+' ? '-' : '+')) as PlatformSpec['ramp'];
    const h = q(rng.range(2.6, 3.2));
    for (const ramp of [...rng.shuffle(across), opposite]) {
      const spec: PlatformSpec = {
        h, w: 4.6, d: 4.6, ramp, parapet: face, legs: biome.overlook.legs,
        body: biome.overlook.body, bodyColor: biome.overlook.bodyColor, top: biome.overlook.top, topColor: biome.overlook.topColor,
      };
      const piece = platform(spec, ov.x, ov.z);
      const at = p.check(piece, { mode: 'pad', padH: ov.h, maxCut: 2.6 });
      if (!at) continue;
      p.commit(piece, at.dy, at.rect, { mode: 'pad' });
      targets.push([ov.x, at.dy + h, ov.z]);
      const rr = piece.boxes.find((b) => b.ramp)!;
      const foot = ramp === 'x+' ? [rr.x + rr.w / 2 + 1, rr.z] : ramp === 'x-' ? [rr.x - rr.w / 2 - 1, rr.z] : ramp === 'z+' ? [rr.x, rr.z + rr.d / 2 + 1] : [rr.x, rr.z - rr.d / 2 - 1];
      rampFeet.push([q(foot[0]!), q(foot[1]!)]);
      break;
    }
  }

  // ---------------------------------------------------------------- footbridges over chokes
  for (const lane of g.lanes) {
    if (!rng.chance(biome.bridge.chance)) continue;
    const c = sampleAt(lane, lane.chokeS);
    const alongZ = Math.abs(c.dz) >= 0.92;
    const alongX = Math.abs(c.dx) >= 0.92;
    if (!alongX && !alongZ) continue;
    const deck = q(c.h + 3.3);
    // March out either side until the ground reaches the deck.
    const end = (sign: number): number | null => {
      for (let d = c.w / 2 + 1.5; d <= 15; d += 0.5) {
        const x = alongZ ? c.x + sign * d : c.x;
        const z = alongZ ? c.z : c.z + sign * d;
        if (hNow(x, z) >= deck - 0.4) return d;
      }
      return null;
    };
    const a = end(-1);
    const b = end(1);
    if (a === null || b === null) continue;
    // A landing slab at each end: the ground is pinned at deck height there, the slab's top 2 cm above.
    const padAt = (sign: number, d: number): Piece => {
      const x = alongZ ? c.x + sign * (d + 1.2) : c.x;
      const z = alongZ ? c.z : c.z + sign * (d + 1.2);
      return { boxes: [{ x: q(x), z: q(z), w: 2.4, h: 0.32, d: 2.4, y: -0.3, color: biome.bridge.color, surface: biome.bridge.surface }] };
    };
    const padA = padAt(-1, a);
    const padB = padAt(1, b);
    const atA = p.check(padA, { mode: 'pad', padH: deck, maxCut: 1, zones: ZONES_RIDGE, gap: 1 });
    const atB = atA && p.check(padB, { mode: 'pad', padH: deck, maxCut: 1, zones: ZONES_RIDGE, gap: 1 });
    if (!atA || !atB || Math.abs(atA.dy - deck) > 0.01 || Math.abs(atB.dy - deck) > 0.01) continue;
    p.commit(padA, deck, atA.rect, { mode: 'pad' });
    p.commit(padB, deck, atB.rect, { mode: 'pad' });
    const ax = alongZ ? c.x - a - 1.2 : c.x;
    const az = alongZ ? c.z : c.z - a - 1.2;
    const bx = alongZ ? c.x + b + 1.2 : c.x;
    const bz = alongZ ? c.z : c.z + b + 1.2;
    const span = bridge(ax, az, bx, bz, deck, 2.4, biome.bridge.color, biome.bridge.surface);
    p.commit(span, 0, null);
    targets.push([q((ax + bx) / 2), deck, q((az + bz) / 2)]);
  }

  // ---------------------------------------------------------------- big models on the ridges
  const ridgeVerts: [number, number][] = [];
  for (let iz = Math.ceil(t.n / 2) + 2; iz <= t.n; iz++) {
    for (let ix = 0; ix <= t.n; ix++) {
      const z = t.zone[iz * t.side + ix]!;
      if (z === ZONE.ridge || z === ZONE.edge) ridgeVerts.push([-t.half + ix, -t.half + iz]);
    }
  }
  if (biome.ridgeModels.length && ridgeVerts.length) {
    const want = Math.round(rng.int(biome.ridgeModelCount[0], biome.ridgeModelCount[1]) * scale * scale);
    let placed = 0;
    for (let attempt = 0; attempt < want * 25 && placed < want; attempt++) {
      const [x, z] = rng.pick(ridgeVerts);
      const id = rng.pick(biome.ridgeModels);
      const near = nearestSample(g, x, z);
      const rot = faceRot(near.x - x, near.z - z);
      const piece = propPiece(id, x, z, rot);
      if (p.place(piece, { mode: 'pad', zones: [ZONE.ridge, ZONE.edge, ZONE.shoulder], maxCut: 2.8, gap: GAP })) placed++;
    }
  }

  // ---------------------------------------------------------------- houses with walkable roofs
  {
    const want = rng.int(biome.houses[0], biome.houses[1]) + (H >= 70 ? 1 : 0);
    let placed = 0;
    for (let attempt = 0; attempt < 60 && placed < want; attempt++) {
      const lane = rng.pick(g.lanes);
      const at = sampleAt(lane, lane.length * rng.range(0.25, 0.8));
      if (Math.abs(at.s - lane.chokeS) < 7) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      const nx = -at.dz * side;
      const nz = at.dx * side;
      // Square to the lane: the lane-facing wall, which the roof ramp runs along, is the long one.
      const facingX = Math.abs(nx) >= Math.abs(nz);
      const long = q(Math.max(rng.range(8.6, 10.5), roofRampRun(biome.house.wallH) + 1.2));
      const short = q(rng.range(6, 7.5));
      const w = facingX ? short : long;
      const d = facingX ? long : short;
      const depth = short;
      const off = at.w / 2 + 3.2 + depth / 2;
      const x = q(at.x + nx * off);
      const z = q(at.z + nz * off);
      const roofAccess: Side = facingX ? (nx > 0 ? 'w' : 'e') : (nz > 0 ? 's' : 'n');
      const t0 = 0.3;
      const spec: BuildingSpec = {
        x, z, w, d, wallH: biome.house.wallH, t: t0, wall: biome.house.wall, wallColor: rng.pick(biome.house.colors),
        floor: biome.house.floor, floorColor: 0xa07a4f, roof: biome.house.roof, roofColor: 0x6f6a66,
        openings: openingsFor(rng, w, d, t0, { doors: 2, avoid: roofAccess }), roofAccess,
      };
      const piece = building(spec);
      piece.patches = [{ x, z, w: q(w + 2), d: q(d + 2), kind: biome.path === 'dirt' ? 'dirt' : 'concrete', y: 0 }];
      const fit = p.check(piece, { mode: 'pad', zones: [ZONE.shoulder, ZONE.ridge, ZONE.lane, ZONE.edge, ZONE.connector], maxCut: 2.2 });
      if (!fit) continue;
      p.commit(piece, fit.dy, fit.rect, { mode: 'pad' });
      // Keep the doors and the ramp's foot clear.
      for (const [dx, dz] of doorsOf(spec)) {
        p.keepClear.push({ x: dx, z: dz, r: 1.2 });
        const [tx, tz] = tPoint(sym, dx, dz);
        p.keepClear.push({ x: tx, z: tz, r: 1.2 });
        targets.push([dx, fit.dy, dz]);
      }
      const rr = roofRampRect(spec)!;
      targets.push([x, fit.dy + spec.wallH + 0.3, z]);
      const foot: [number, number] = rr.dir === 'x+' ? [rr.x - rr.w / 2 - 1, rr.z] : rr.dir === 'x-' ? [rr.x + rr.w / 2 + 1, rr.z] : rr.dir === 'z+' ? [rr.x, rr.z - rr.d / 2 - 1] : [rr.x, rr.z + rr.d / 2 + 1];
      p.keepClear.push({ x: q(foot[0]), z: q(foot[1]), r: 1.4 });
      const [fx, fz] = tPoint(sym, foot[0], foot[1]);
      p.keepClear.push({ x: fx, z: fz, r: 1.4 });
      placed++;
    }
  }

  // ---------------------------------------------------------------- a raised post at each base
  {
    const sides = rng.shuffle([1, -1]);
    for (const sx of sides) {
      const x = q(g.base.x + sx * (g.base.r - 3.2));
      const z = q(g.base.z - 1.5);
      const spec: PlatformSpec = {
        h: 2.2, w: 3.6, d: 3.6, ramp: 'z+', parapet: 'z-', legs: false,
        body: theme.wallSurface, bodyColor: p.color(), top: 'concrete', topColor: 0x8a8f99,
      };
      const piece = platform(spec, x, z);
      const at = p.check(piece, { mode: 'pad', padH: g.base.h, maxCut: 1.5, flagClear: 4.5 });
      if (!at) continue;
      p.commit(piece, at.dy, at.rect, { mode: 'pad' });
      targets.push([x, at.dy + 2.2, z]);
      break;
    }
  }

  // ---------------------------------------------------------------- the terrain is final
  t.resolve();
  const ground = t.toGround();
  p.ground = ground;

  const pickCover = (classes: readonly Cover['cls'][]): Cover => {
    const list = biome.cover.filter((c) => classes.includes(c.cls));
    return rng.weighted(list.map((c) => [c, c.weight] as const));
  };
  const laneAxis = (s: LaneSample): 'x' | 'z' => (Math.abs(s.dx) >= Math.abs(s.dz) ? 'x' : 'z');
  const crossAxis = (s: LaneSample): 'x' | 'z' => (laneAxis(s) === 'x' ? 'z' : 'x');
  /** Try to put cover beside a lane point, `side` first */
  const coverBeside = (s: LaneSample, side: number, classes: readonly Cover['cls'][], spread: [number, number] = [0.3, 0.85]): boolean => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const sd = attempt % 2 ? -side : side;
      const c = pickCover(classes);
      const lateral = sd * (s.w / 2) * rng.range(spread[0], spread[1]);
      const x = q(s.x - s.dz * lateral);
      const z = q(s.z + s.dx * lateral);
      const piece = c.kit(k, x, z, c.along ? laneAxis(s) : crossAxis(s));
      if (p.place(piece, { zones: WALK_ZONES, maxStep: 0.5 })) return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- cover along the lanes
  for (const lane of g.lanes) {
    let side = rng.chance(0.5) ? 1 : -1;
    const stride = P.coverGap * 0.8;
    for (let s = g.base.r * 0.6; s < lane.length - 2; s += stride * rng.range(0.8, 1.15)) {
      if (Math.abs(s - lane.chokeS) < 4) continue;
      const at = sampleAt(lane, s);
      coverBeside(at, side, rng.chance(0.22) ? ['tall'] : ['low', 'mid']);
      side = -side;
    }
    // Landing spots past the choke, and one before it.
    coverBeside(sampleAt(lane, lane.chokeS + 7), 1, ['low', 'mid']);
    coverBeside(sampleAt(lane, lane.chokeS + 8), -1, ['low', 'mid', 'tall']);
    coverBeside(sampleAt(lane, lane.chokeS - 7), rng.chance(0.5) ? 1 : -1, ['low', 'mid']);
  }
  for (const con of g.connectors) {
    const mid = con.samples[Math.floor(con.samples.length / 2)]!;
    if (mid.z > 2) coverBeside(mid, rng.chance(0.5) ? 1 : -1, ['low', 'mid'], [0.5, 1.1]);
  }

  // ---------------------------------------------------------------- round the middle
  {
    let placed = 0;
    for (let attempt = 0; attempt < 30 && placed < 3; attempt++) {
      const [dx, dz] = rng.pick(DIRS);
      if (dz < 0.2) continue;
      const r = g.mid.r + rng.range(0.5, 4);
      const c = pickCover(['low', 'mid', 'tall']);
      if (p.place(c.kit(k, q(dx * r), q(dz * r), Math.abs(dx) > Math.abs(dz) ? 'z' : 'x'), { zones: WALK_ZONES, maxStep: 0.5 })) placed++;
    }
  }

  // ---------------------------------------------------------------- base defences
  {
    let placed = 0;
    for (let attempt = 0; attempt < 30 && placed < 3; attempt++) {
      const [dx, dz] = rng.pick(DIRS);
      if (dz > 0.3) continue;
      const r = rng.range(5.5, g.base.r - 0.5);
      const c = pickCover(['low', 'mid']);
      const x = q(g.base.x + dx * r);
      const z = q(g.base.z + dz * r);
      if (p.place(c.kit(k, x, z, Math.abs(dx) > Math.abs(dz) ? 'z' : 'x'), { zones: [ZONE.base, ZONE.shoulder, ZONE.lane], maxStep: 0.4, flagClear: 4 })) placed++;
    }
  }

  // ---------------------------------------------------------------- lamps along the lanes
  if (biome.lamps) {
    for (const lane of g.lanes) {
      for (let s = g.base.r; s < lane.length - 4; s += 11) {
        const at = sampleAt(lane, s);
        const side = Math.round(s / 11) % 2 ? 1 : -1;
        const lateral = side * (at.w / 2 + 0.4);
        const x = q(at.x - at.dz * lateral);
        const z = q(at.z + at.dx * lateral);
        p.place(propPiece(biome.lamps, x, z, faceRot(at.dz * side, -at.dx * side)), { zones: [ZONE.shoulder, ZONE.lane], gap: 0.8, maxStep: 0.6 });
      }
    }
  }

  // ---------------------------------------------------------------- the ridges and the rim
  if (ridgeVerts.length) {
    const want = Math.round((ridgeVerts.length / 100) * biome.ridgeDensity);
    let placed = 0;
    for (let attempt = 0; attempt < want * 4 && placed < want; attempt++) {
      const [x0, z0] = rng.pick(ridgeVerts);
      const x = q(x0 + rng.range(-0.5, 0.5));
      const z = q(z0 + rng.range(-0.5, 0.5));
      const c = rng.weighted(biome.ridge.map((r) => [r, r.weight] as const));
      const piece = c.kit(k, x, z, rng.chance(0.5) ? 'x' : 'z');
      if (p.place(piece, { zones: ZONES_RIDGE, maxStep: 1.4, gap: 1.2 })) placed++;
    }
  }

  // ---------------------------------------------------------------- sightlines
  const sight = breakSightlines(rng.fork('sight'), g, p, ground, biome, k, P);

  // ---------------------------------------------------------------- pickups and spawns
  const occ = new Occlusion(ground, H, p.boxes);
  const open = (x: number, z: number) => !occ.blocked(x, z) && p.rects.every((r) => x < r.minX - 1 || x > r.maxX + 1 || z < r.minZ - 1 || z > r.maxZ + 1);
  const pickupSpots: PickupSpot[] = [];
  const addSpot = (x: number, z: number, tier: PickupSpot['tier']) => {
    if (!open(x, z)) return;
    for (const [sx, sz] of [[x, z], tPoint(sym, x, z)] as const) pickupSpots.push({ x: q(sx), y: q(groundHeight(ground, sx, sz)), z: q(sz), tier });
  };
  for (const lane of g.lanes) {
    for (const f of [0.35, 0.7]) {
      const at = sampleAt(lane, lane.length * f);
      for (const lateral of [0, at.w / 4, -at.w / 4]) {
        const x = at.x - at.dz * lateral;
        const z = at.z + at.dx * lateral;
        if (open(x, z) && z > 1.5) { addSpot(x, z, 'weapon'); break; }
      }
    }
  }
  for (const con of g.connectors) {
    const mid = con.samples[Math.floor(con.samples.length / 2)]!;
    if (mid.z > 1.5) addSpot(mid.x, mid.z, 'ability');
  }
  for (const [x, z] of rampFeet) addSpot(x, z, 'ability');
  for (const [dx, dz] of DIRS) {
    if (dz < 0.3) continue;
    const x = g.mid.r * 0.8 * dx;
    const z = g.mid.r * 0.8 * dz;
    if (open(x, z)) { addSpot(x, z, 'any'); break; }
  }

  const spawns: Spawn[] = [];
  for (const [x, z] of p.spawns) {
    spawns.push({ x, y: q(groundHeight(ground, x, z)), z, team: 'red' });
    const [tx, tz] = tPoint(sym, x, z);
    spawns.push({ x: tx, y: q(groundHeight(ground, tx, tz)), z: tz, team: 'blue' });
  }
  // Free-for-all also spawns at the connectors and overlook ramps.
  for (const [x, z] of [...g.connectors.map((c) => { const m = c.samples[Math.floor(c.samples.length / 2)]!; return [m.x, m.z] as [number, number]; }), ...rampFeet]) {
    if (z < 3 || !open(x, z)) continue;
    for (const [sx, sz] of [[x, z], tPoint(sym, x, z)] as const) spawns.push({ x: q(sx), y: q(groundHeight(ground, sx, sz)), z: q(sz), team: null });
  }

  return {
    ground, boxes: p.boxes, props: p.props, patches: p.patches, spawns, pickupSpots,
    targets: targets.flatMap(([x, y, z]) => {
      const [tx, tz] = tPoint(sym, x, z);
      return x === tx && z === tz ? [[x, y, z]] : [[x, y, z], [tx, y, tz]];
    }) as [number, number, number][],
    sight,
  };
}

/**
 * Measure the sightlines and break the worst with tall cover: along each lane (base to base), at
 * each flag from the enemy half, and at the spawns.
 */
function breakSightlines(rng: Rng, g: Graph, p: Placer, ground: Ground, biome: Biome, k: KitContext, P: SizeParams): SightReport {
  const sym = g.sym;
  const H = g.half;
  const occ = new Occlusion(ground, H, p.boxes);
  const tall = biome.cover.filter((c) => c.cls === 'tall');
  const lanes = g.lanes.map((lane) => {
    const partner = sym === 'rotate' ? g.lanes.find((l) => l.cross === -lane.cross) ?? lane : lane;
    const red = lane.samples.map((s) => [s.x, s.z] as [number, number]);
    const blue = partner.samples.map((s) => tPoint(sym, s.x, s.z)).reverse();
    return { points: pathPoints([...red, ...blue.slice(1)], 2.5, lane.width / 3), budget: lane.role === 'main' ? P.laneSight.main : P.laneSight.flank };
  });
  // Where the enemy might stand: anywhere in their half but the rim along the walls.
  const enemy: [number, number][] = [];
  for (let z = -H + 3; z <= -4; z += 2.5) {
    for (let x = -H + 3; x <= H - 3; x += 2.5) if (p.terrain.zoneAt(x, z) !== ZONE.edge) enemy.push([x, z]);
  }
  const flagRange = Math.max(26, P.baseZ * 0.75);

  /** Put a tall piece across the sightline, nearest its middle that fits. */
  /** Put tall cover across a sightline, nearest its middle, until it's blocked (at most three pieces). */
  const breakOne = (s: Sight): boolean => {
    const axis: 'x' | 'z' = Math.abs(s.bx - s.ax) >= Math.abs(s.bz - s.az) ? 'z' : 'x';
    const l = Math.sqrt((s.bx - s.ax) * (s.bx - s.ax) + (s.bz - s.az) * (s.bz - s.az)) || 1;
    const nx = -(s.bz - s.az) / l;
    const nz = (s.bx - s.ax) / l;
    let placed = 0;
    for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86]) {
      for (const side of [0, 0.8, -0.8, 1.6, -1.6]) {
        let x = s.ax + (s.bx - s.ax) * f + nx * side;
        let z = s.az + (s.bz - s.az) * f + nz * side;
        if (z < 0) [x, z] = tPoint(sym, x, z);
        if (z < 2.5) continue;
        // The biome's own tall cover first; a plain pillar only if none of it fits.
        for (const kit of [...rng.shuffle(tall.map((c) => c.kit)), pillar]) {
          const piece = kit(k, q(x), q(z), axis);
          const before = p.boxes.length;
          if (!p.place(piece, { core: true, zones: [...WALK_ZONES, ZONE.ridge], maxStep: 1.3, gap: 1.2 })) continue;
          occ.add(p.boxes.slice(before));
          placed++;
          if (!occ.sees(s.ax, s.az, s.bx, s.bz)) return true;
          if (placed >= 3) return false;
          break;
        }
      }
    }
    return false;
  };

  // Every sightline that's too long, found once; after each breaker only those are checked again.
  const still = (list: Sight[]) => list.filter((x) => occ.sees(x.ax, x.az, x.bx, x.bz));
  let lanePairs = lanes.map((l) => longSightlines(occ, l.points, l.budget));
  let flagPairs: Sight[] | null = null;
  let breakers = 0;
  for (let round = 0; round < 24; round++) {
    let worst: Sight | null = null;
    let over = 0;
    lanePairs.forEach((pairs, i) => {
      const s = pairs[0];
      if (s && s.d - lanes[i]!.budget > over) { worst = s; over = s.d - lanes[i]!.budget; }
    });
    if (!worst) {
      flagPairs ??= exposure(occ, g.base.x, g.base.z, enemy, flagRange);
      const f = flagPairs[0];
      if (f) worst = { ...f, ax: f.ax + (f.bx - f.ax) * 0.15, az: f.az + (f.bz - f.az) * 0.15 };
    }
    if (!worst) break;
    const before = p.boxes.length;
    const ok = breakOne(worst);
    if (p.boxes.length > before) {
      breakers++;
      lanePairs = lanePairs.map(still);
      if (flagPairs) flagPairs = still(flagPairs);
    }
    if (!ok) {
      // Can't break this one: stop trying it.
      const w = worst as Sight;
      lanePairs = lanePairs.map((pairs) => pairs.filter((x) => x !== w));
      if (flagPairs) flagPairs = flagPairs.filter((x) => x.bx !== w.bx || x.bz !== w.bz);
    }
  }

  let laneOver = 0;
  const lines: Sight[] = [];
  for (const l of lanes) {
    const s = longSightlines(occ, l.points, l.budget)[0];
    if (s) {
      laneOver = Math.max(laneOver, s.d - l.budget);
      lines.push(s);
    }
  }
  const flag = exposure(occ, g.base.x, g.base.z, enemy, flagRange);
  lines.push(...flag.slice(0, 6));
  let spawnSeen = 0;
  for (const [x, z] of p.spawns) {
    const seen = exposure(occ, x, z, enemy, 0);
    spawnSeen += seen.length;
    lines.push(...seen.slice(0, 2));
  }
  return { laneOver: q(laneOver), flagSeen: flag.length, spawnSeen, breakers, lines };
}
