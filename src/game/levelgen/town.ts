/**
 * Town maps: streets on both axes (they run past every spawn and both flags), a cross street and
 * a side street in each quarter, and blocks between them. Blocks are split into lots: one
 * enterable building per quarter (some with an upstairs), shops and houses (Kenney models) facing
 * the street, and small plazas. Barriers, dumpsters and parked-car-sized cover break up the
 * streets so they aren't long sniper lanes; lamps line the sidewalks.
 */

import { building, openingsFor } from './building';
import { GAP, INNER, Placer, round, type Rect } from './core';
import { carveOutline } from './outline';
import { PROPS, propPiece, propSize, propsTagged, type PropId } from './props';
import type { GroundPatch, MapLayout, Piece, PropRot } from './types';

const SIDEWALK = 1;

type Front = 'n' | 's' | 'e' | 'w';

/** Turns that point a model's front (+z) at a side. */
const FACE: Record<Front, PropRot> = { s: 2, n: 0, e: 1, w: 3 };

/** Shops and houses whose footprint, turned to face `front`, fits `length` × `depth`. */
function fitting(front: Front, length: number, depth: number): PropId[] {
  const rot = FACE[front];
  const alongX = front === 'n' || front === 's';
  return propsTagged('building').filter((id) => {
    if (PROPS[id].tags.includes('factory')) return false;
    const s = propSize(id, rot);
    return (alongX ? s.w : s.d) <= length && (alongX ? s.d : s.w) <= depth;
  });
}

/** An enterable building `length` wide along the row and `depth` deep, maybe with an upstairs. */
function enterable(p: Placer, x: number, z: number, w: number, d: number, twoFloors: boolean): Piece {
  const t = 0.3;
  const upperY = 3.25;
  const stairs = w >= d ? p.pick(['n', 's'] as const) : p.pick(['e', 'w'] as const);
  const wallColor = p.pick([0xd8cdb8, 0xc9b79a, 0xb8c4c9, 0xd9b8a0, 0xa9b8a0]);
  return building({
    x: round(x), z: round(z), w: round(w), d: round(d), wallH: twoFloors ? 6.5 : 3.4, t,
    wall: p.pick(['plaster', 'brick'] as const), wallColor,
    floor: 'planks', floorColor: 0xa07a4f,
    roof: 'concrete', roofColor: 0x6f6a66,
    openings: openingsFor(p.rand, w, d, t, { doors: 2 + (p.chance(0.5) ? 1 : 0), windowsPerSide: [1, 2], ...(twoFloors ? { upperY } : {}) }),
    ...(twoFloors ? { upper: { y: upperY, stairs, railColor: 0x6f5a45 } } : {}),
  });
}

/**
 * A row of buildings along one side of a block, fronts on the street: shops and houses side by
 * side with alleys between, the first slot maybe an enterable building, gaps filled with cover.
 */
function fillRow(p: Placer, r: Rect, front: Front, withEnterable: { twoFloors: boolean } | null): boolean {
  const alongX = front === 'n' || front === 's';
  const length = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
  const depth = alongX ? r.maxZ - r.minZ : r.maxX - r.minX;
  const start = alongX ? r.minX : r.minZ;
  const at = (along: number, across: number): [number, number] => {
    // `across` is measured from the street edge of the row, inward.
    const edge = front === 'n' ? r.maxZ - across : front === 's' ? r.minZ + across : front === 'e' ? r.maxX - across : r.minX + across;
    return alongX ? [along, edge] : [edge, along];
  };
  let cursor = start;
  let placedEnterable = false;
  while (cursor < start + length - 4) {
    const room = start + length - cursor;
    let piece: Piece | null = null;
    let used = 0;
    if (withEnterable && !placedEnterable && room >= 9 && depth >= 7) {
      const w = Math.min(room, p.range(9, 12));
      const d = Math.min(depth, p.range(7, 9));
      const [x, z] = at(cursor + w / 2, d / 2);
      piece = alongX ? enterable(p, x, z, w, d, withEnterable.twoFloors) : enterable(p, x, z, d, w, withEnterable.twoFloors);
      used = w;
      placedEnterable = true;
    } else {
      const options = fitting(front, room, depth);
      if (options.length && p.chance(0.85)) {
        const id = p.pick(options);
        const s = propSize(id, FACE[front]);
        const len = alongX ? s.w : s.d;
        const dep = alongX ? s.d : s.w;
        const [x, z] = at(cursor + len / 2, dep / 2);
        piece = propPiece(id, x, z, FACE[front]);
        used = len;
      } else {
        // A gap with a bit of cover in it.
        const [x, z] = at(cursor + 1.5, p.range(1, Math.max(1.2, depth - 1)));
        piece = streetCover(p, x, z);
        used = 3;
      }
    }
    if (piece && p.fits(piece)) p.place(piece);
    cursor += used + p.range(GAP + 0.1, GAP + 1.2);
  }
  return placedEnterable;
}

/** Cover for a plaza or a street: barriers, dumpsters, planters, crates. */
function streetCover(p: Placer, x: number, z: number): Piece {
  const k = p.rand();
  if (k < 0.3) {
    const along = p.chance(0.5);
    return { boxes: [{ x: round(x), z: round(z), w: along ? 2.4 : 0.7, d: along ? 0.7 : 2.4, h: 1.05, y: 0, color: 0xb9b6ad, surface: 'concrete' }] };
  }
  const id: PropId = k < 0.55 ? 'dumpster' : k < 0.75 ? 'planter' : k < 0.9 ? 'barrier' : 'fence-low';
  return propPiece(id, x, z, p.pick([0, 1, 2, 3] as const));
}

/** Mirror a rectangle to the west side (x → -x) when sx = -1. */
const sideRect = (r: Rect, sx: 1 | -1): Rect => (sx === 1 ? r : { minX: -r.maxX, maxX: -r.minX, minZ: r.minZ, maxZ: r.maxZ });
const sideFront = (f: Front, sx: 1 | -1): Front => (sx === 1 ? f : f === 'e' ? 'w' : f === 'w' ? 'e' : f);

/**
 * One side (east or west) of our half: a cross street and a side street at their own positions,
 * the blocks between them filled with buildings, lamps and street cover. The two sides differ.
 */
function townSide(p: Placer, sx: 1 | -1, a: number, enterableHere: boolean, twoFloors: boolean): void {
  const cross = round(p.range(6, 8));
  const side = round(p.range(6, 8));
  const atZ = round(p.range(29, 40));
  const atX = round(p.range(28, 40));
  const c0 = round(atZ - cross / 2);
  const c1 = round(atZ + cross / 2);
  const s0 = round(atX - side / 2);
  const s1 = round(atX + side / 2);
  const roads: Rect[] = [
    { minX: a, maxX: INNER, minZ: c0, maxZ: c1 },
    { minX: s0, maxX: s1, minZ: a, maxZ: c0 },
    { minX: s0, maxX: s1, minZ: c1, maxZ: INNER },
  ];
  const patch = (r: Rect, kind: GroundPatch['kind']): GroundPatch => {
    const q = sideRect(r, sx);
    return { x: round((q.minX + q.maxX) / 2), z: round((q.minZ + q.maxZ) / 2), w: round(q.maxX - q.minX), d: round(q.maxZ - q.minZ), kind };
  };
  p.place({ boxes: [], ground: roads.map((r) => patch(r, 'road')) });
  for (const r of roads) p.reserve(sideRect(r, sx));

  const blocks: { r: Rect; front: Front }[] = [
    { r: { minX: a, maxX: s0, minZ: a, maxZ: c0 }, front: 'n' },
    { r: { minX: s1, maxX: INNER, minZ: a, maxZ: c0 }, front: 'w' },
    { r: { minX: a, maxX: s0, minZ: c1, maxZ: INNER }, front: 'e' },
    { r: { minX: s1, maxX: INNER, minZ: c1, maxZ: INNER }, front: 'w' },
  ];
  p.place({ boxes: [], ground: blocks.map(({ r }) => patch(r, 'sidewalk')) });

  // Buildings along the streets: deep blocks get a row on each street side, back to back.
  let enterableLeft = enterableHere;
  for (const { r: raw, front: rawFront } of blocks) {
    const r = sideRect(raw, sx);
    const front = sideFront(rawFront, sx);
    const inner: Rect = { minX: r.minX + SIDEWALK, maxX: r.maxX - SIDEWALK, minZ: r.minZ + SIDEWALK, maxZ: r.maxZ - SIDEWALK };
    const alongX = front === 'n' || front === 's';
    const depth = alongX ? inner.maxZ - inner.minZ : inner.maxX - inner.minX;
    if (depth < 5 || (alongX ? inner.maxX - inner.minX : inner.maxZ - inner.minZ) < 5) continue;
    const back: Front = front === 'n' ? 's' : front === 's' ? 'n' : front === 'e' ? 'w' : 'e';
    if (depth >= 2 * 6.8 + GAP) {
      const half = (depth - GAP) / 2;
      const frontRow: Rect = alongX
        ? (front === 'n' ? { ...inner, minZ: inner.maxZ - half } : { ...inner, maxZ: inner.minZ + half })
        : (front === 'e' ? { ...inner, minX: inner.maxX - half } : { ...inner, maxX: inner.minX + half });
      const backRow: Rect = alongX
        ? (front === 'n' ? { ...inner, maxZ: inner.minZ + half } : { ...inner, minZ: inner.maxZ - half })
        : (front === 'e' ? { ...inner, maxX: inner.minX + half } : { ...inner, minX: inner.maxX - half });
      if (fillRow(p, frontRow, front, enterableLeft ? { twoFloors } : null)) enterableLeft = false;
      fillRow(p, backRow, back, null);
    } else if (fillRow(p, inner, front, enterableLeft && depth >= 7 ? { twoFloors } : null)) {
      enterableLeft = false;
    }
  }

  // Lamps along the avenue and the cross street.
  for (let along = a + 4; along < INNER - 2; along += p.range(9, 12)) {
    for (const lamp of [propPiece('lamp', round(sx * (a + 0.6)), round(along), sx === 1 ? 3 : 1), propPiece('lamp', round(sx * along), round(c0 - 0.6), 2)]) {
      if (p.fits(lamp, { ignoreReserved: true, gap: 1 })) p.place(lamp);
    }
  }

  // Cover in the streets.
  const streetPieces = 9 + Math.floor(p.rand() * 6);
  for (let placed = 0, attempt = 0; attempt < 280 && placed < streetPieces; attempt++) {
    const k = p.rand();
    const x = k < 0.35 ? p.range(1.5, a - 0.8) : k < 0.7 ? p.range(a + 2, INNER - 2) : p.range(s0 + 0.8, s1 - 0.8);
    const z = k < 0.35 ? p.range(6, INNER - 4) : k < 0.7 ? p.range(c0 + 0.8, c1 - 0.8) : p.range(a + 2, INNER - 2);
    const cover = streetCover(p, sx * x, z);
    if (!p.fits(cover, { ignoreReserved: true })) continue;
    p.place(cover);
    placed++;
  }
  // Cones: decoration only.
  for (let i = 0; i < 5; i++) {
    const cone = propPiece('cone', round(sx * p.range(a + 2, INNER - 2)), round(p.range(c0 + 0.6, c1 - 0.6)), 0);
    if (p.fits({ boxes: [{ x: cone.props![0]!.x, z: cone.props![0]!.z, w: 0.6, d: 0.6, h: 0.8, y: 0, color: 0, surface: 'concrete' }] }, { ignoreReserved: true, gap: 0.8 })) p.place(cone);
  }
}

export function townLayout(seed: string, p: Placer): MapLayout {
  carveOutline(p, 'town');
  const avenue = round(p.range(7, 9));
  const a = avenue / 2;
  // The avenues: along the middle line (between the halves) and down the centre to both flags.
  p.placeAsIs({ boxes: [], ground: [
    { x: 0, z: 0, w: round(INNER * 2), d: avenue, kind: 'road' },
  ] });
  p.place({ boxes: [], ground: [{ x: 0, z: round((a + INNER) / 2), w: avenue, d: round(INNER - a), kind: 'road' }] });
  p.reserve({ minX: -a, maxX: a, minZ: 0, maxZ: INNER });
  p.reserve({ minX: 0, maxX: INNER, minZ: -a, maxZ: a });
  p.reserve({ minX: -INNER, maxX: 0, minZ: -a, maxZ: a });

  // One enterable building per half, on a random side.
  const east = p.chance(0.5);
  const twoFloors = p.chance(0.5);
  townSide(p, 1, a, east, twoFloors);
  townSide(p, -1, a, !east, twoFloors);
  return p.result(seed, 'town');
}
