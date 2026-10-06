/**
 * The building blocks maps are dressed with: cover pieces, models, and structures you climb.
 * Every kit builds a Piece standing on y = 0 around a point; the placer lifts it onto the ground.
 *
 * Sizes follow the player (playerDims.ts): 0.7 m wide, 1.75 m tall, steps up 0.7 m, jumps about
 * 1.3 m. Low cover (~1.1 m) hides you crouching, mid cover (~1.8 m) standing, tall cover (2.4 m+)
 * breaks sightlines. Ramps rise at most 1 m per 2 m (26.6°), well under the 55° you can walk.
 */

import { PROPS, type PropId, type PropTag } from '../propManifest';
import type { BoxSurface } from '../textures';
import { q } from './dmath';
import type { Rng } from './rng';
import { turn } from './symmetry';
import type { MapBox, MapTheme, Piece, PropRot } from './types';

export type CoverClass = 'low' | 'mid' | 'tall';

/** A kit that builds cover at (x, z), turned to run along `axis` */
export type CoverKit = (k: KitContext, x: number, z: number, axis: 'x' | 'z') => Piece;

export interface KitContext {
  rng: Rng;
  theme: MapTheme;
  color(): number;
}

const RAMP_RUN = 2;
const RAIL = { h: 1, t: 0.12 };

const box = (x: number, z: number, w: number, h: number, d: number, y: number, color: number, surface: BoxSurface, extra: Partial<MapBox> = {}): MapBox => ({
  x: q(x), z: q(z), w: q(w), h: q(h), d: q(d), y: q(y), color, surface, ...extra,
});

/** A box that runs along `axis`: `long` along it, `thick` across. */
const along = (axis: 'x' | 'z', x: number, z: number, long: number, thick: number, h: number, y: number, color: number, surface: BoxSurface, extra: Partial<MapBox> = {}) =>
  axis === 'x' ? box(x, z, long, h, thick, y, color, surface, extra) : box(x, z, thick, h, long, y, color, surface, extra);

// ---------------------------------------------------------------- models

/** Size of a model after `rot` quarter turns. */
export function propSize(id: PropId, rot: PropRot, scale = 1): { w: number; d: number; h: number } {
  const p = PROPS[id];
  const odd = rot % 2 === 1;
  return { w: (odd ? p.d : p.w) * scale, d: (odd ? p.w : p.d) * scale, h: p.h * scale };
}

/** A model at (x, z) standing on `y`, turned `rot` quarter turns, with its collision boxes. */
export function propPiece(id: PropId, x: number, z: number, rot: PropRot, y = 0, scale = 1): Piece {
  const info = PROPS[id];
  const boxes: MapBox[] = info.colliders.map((c) => {
    const [dx, dz] = turn(c.dx * scale, c.dz * scale, rot);
    const odd = rot % 2 === 1;
    return {
      x: q(x + dx), z: q(z + dz),
      w: q((odd ? c.d : c.w) * scale), d: q((odd ? c.w : c.d) * scale), h: q(c.h * scale), y: q(y + c.y * scale),
      color: info.color, surface: 'concrete', visible: false, ...(c.blocks ? { blocks: c.blocks } : {}),
      ...(c.dx || c.dz ? { pivot: { x: q(x), z: q(z), rot, dx: c.dx * scale, dz: c.dz * scale, w: c.w * scale, d: c.d * scale } } : {}),
    } satisfies MapBox;
  });
  return { boxes, props: [{ id, x: q(x), z: q(z), y: q(y), rot, ...(scale !== 1 ? { scale } : {}) }] };
}

export const propsTagged = (tag: PropTag): PropId[] => (Object.keys(PROPS) as PropId[]).filter((id) => PROPS[id].tags.includes(tag));

/** A model kit: one of `ids`, turned to suit the axis */
export const model = (ids: readonly PropId[], scale: [number, number] = [1, 1]): CoverKit => (k, x, z, axis) => {
  const id = k.rng.pick(ids);
  const base = axis === 'x' ? 0 : 1;
  const rot = ((base + (k.rng.chance(0.5) ? 2 : 0)) % 4) as PropRot;
  return propPiece(id, x, z, rot, 0, scale[0] === scale[1] ? scale[0] : q(k.rng.range(scale[0], scale[1])));
};

/** Merge pieces */
export function merge(...pieces: Piece[]): Piece {
  return {
    boxes: pieces.flatMap((p) => p.boxes),
    props: pieces.flatMap((p) => p.props ?? []),
    patches: pieces.flatMap((p) => p.patches ?? []),
  };
}

// ---------------------------------------------------------------- cover

export const crate: CoverKit = (k, x, z) => {
  const s = k.rng.range(1.2, 1.8);
  return { boxes: [box(x, z, s, Math.min(2.2, s * k.rng.range(1, 1.3)), s, 0, k.color(), 'crate')] };
};

/** A step crate, a tall crate and a small one on top: climbable mid cover */
export const crateStack: CoverKit = (k, x, z, axis) => {
  const c = k.color();
  const dir = k.rng.chance(0.5) ? 1 : -1;
  const ox = axis === 'x' ? dir * 2.05 : 0;
  const oz = axis === 'z' ? dir * 2.05 : 0;
  return {
    boxes: [
      box(x, z, 2, 2, 2, 0, c, 'crate'),
      box(x + ox, z + oz, 2, 1, 2, 0, c, 'crate'),
      box(x, z, 1.2, 1, 1.2, 2, k.color(), 'crate'),
    ],
  };
};

/** Concrete jersey barrier: hides you crouching, shoot over it standing */
export const lowWall: CoverKit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(2.4, 4), 0.7, k.rng.range(1.05, 1.2), 0, 0xb9b6ad, 'concrete')] });

/** A row of sandbags: crouch cover */
export const sandbags: CoverKit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(2.6, 3.6), 0.9, 1.1, 0, k.rng.pick([0xa89a72, 0x9c8e66, 0xb3a57c]), 'planks', { step: 'sand' })] });

export const wall: CoverKit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(4, 6.5), 0.8, k.rng.range(2, 2.7), 0, k.color(), k.theme.wallSurface)] });

export const corner: CoverKit = (k, x, z, axis) => {
  const c = k.color();
  const a = k.rng.range(3, 4.5);
  const s = k.rng.chance(0.5) ? 1 : -1;
  const other = axis === 'x' ? 'z' : 'x';
  const ox = axis === 'x' ? s * (a / 2 - 0.4) : -(a / 2 - 0.4);
  const oz = axis === 'x' ? a / 2 - 0.4 : s * (a / 2 - 0.4);
  return { boxes: [along(axis, x, z, a, 0.8, 2.3, 0, c, k.theme.wallSurface), along(other, x + ox, z + oz, a, 0.8, 2.3, 0, c, k.theme.wallSurface)] };
};

export const pillar: CoverKit = (k, x, z) => {
  const s = k.rng.range(2, 2.8);
  return { boxes: [box(x, z, s, k.rng.range(3.2, 4.6), s, 0, k.color(), k.theme.pillarSurface)] };
};

export const barrels: CoverKit = (k, x, z) => {
  const color = k.rng.pick([0x3f6fa8, 0xb5482f, 0x5c6b4a, 0xc9a23a]);
  const r = 0.66;
  const spots: [number, number][] = ([[0, 0], [r, 0], [0, r], [r, r]] as [number, number][]).slice(0, 2 + k.rng.int(0, 2));
  return {
    boxes: spots.map(([dx, dz]) => box(x + dx - r / 2, z + dz - r / 2, 0.62, 0.95, 0.62, 0, color, 'metal', { shape: 'cylinder', step: 'hard' })),
  };
};

export const pallets: CoverKit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, 1.4, 1.2, k.rng.pick([1.1, 1.3]), 0, k.rng.pick([0xa07a4f, 0x8a6a45]), 'crate')] });

/** ISO-ish 20 ft container */
export const CONTAINER = { len: 6, h: 2.6, w: 2.4 };
const CONTAINER_COLORS = [0xb5482f, 0x2f6fa8, 0x3f8a4a, 0xd08a2a, 0x7d8597, 0x8a3f5f];

/** Crate steps up onto a container's end, so its roof is a vantage point */
function crateSteps(axis: 'x' | 'z', end: number, cross: number, dir: 1 | -1, color: number): MapBox[] {
  const near = end + dir * 0.65;
  const far = end + dir * 1.95;
  return axis === 'x'
    ? [box(near, cross, 1.3, 1.8, 1.3, 0, color, 'crate'), box(far, cross, 1.3, 0.9, 1.3, 0, color, 'crate')]
    : [box(cross, near, 1.3, 1.8, 1.3, 0, color, 'crate'), box(cross, far, 1.3, 0.9, 1.3, 0, color, 'crate')];
}

/** A container, sometimes with crate steps up one end */
export const container: CoverKit = (k, x, z, axis) => {
  const boxes = [along(axis, x, z, CONTAINER.len, CONTAINER.w, CONTAINER.h, 0, k.rng.pick(CONTAINER_COLORS), 'container', { step: 'hard' })];
  if (k.rng.chance(0.5)) {
    const dir = k.rng.chance(0.5) ? 1 : -1;
    boxes.push(...crateSteps(axis, (axis === 'x' ? x : z) + dir * CONTAINER.len / 2, axis === 'x' ? z : x, dir, k.color()));
  }
  return { boxes };
};

/** Two containers end to end with a third across their middle, steps up one end */
export const containerStack: CoverKit = (k, x, z, axis) => {
  const gap = 1.8;
  const off = (CONTAINER.len + gap) / 2;
  const at = (o: number, y: number) => along(axis, axis === 'x' ? x + o : x, axis === 'z' ? z + o : z, CONTAINER.len, CONTAINER.w, CONTAINER.h, y, k.rng.pick(CONTAINER_COLORS), 'container', { step: 'hard' });
  const dir = k.rng.chance(0.5) ? 1 : -1;
  return {
    boxes: [
      at(-off, 0), at(off, 0), at(0, CONTAINER.h),
      ...crateSteps(axis, (axis === 'x' ? x : z) + dir * (off + CONTAINER.len / 2), axis === 'x' ? z : x, dir, k.color()),
    ],
  };
};

// ---------------------------------------------------------------- structures

export interface PlatformSpec {
  /** Top height above the pad */
  h: number;
  w: number;
  d: number;
  /** Side the ramp comes up on */
  ramp: 'x+' | 'x-' | 'z+' | 'z-';
  /** Side with a solid parapet (cover facing the action) */
  parapet: 'x+' | 'x-' | 'z+' | 'z-';
  body: BoxSurface;
  bodyColor: number;
  top: BoxSurface;
  topColor: number;
  /** Stand on legs (walk underneath) instead of a solid block */
  legs?: boolean;
}

/** Ramp footprint for a platform side */
export function rampRect(s: PlatformSpec, x: number, z: number): { x: number; z: number; w: number; d: number } {
  const run = s.h * RAMP_RUN;
  const width = Math.min(2.6, (s.ramp[0] === 'x' ? s.d : s.w) - 0.6);
  switch (s.ramp) {
    case 'x+': return { x: x + s.w / 2 + run / 2, z, w: run, d: width };
    case 'x-': return { x: x - s.w / 2 - run / 2, z, w: run, d: width };
    case 'z+': return { x, z: z + s.d / 2 + run / 2, w: width, d: run };
    default: return { x, z: z - s.d / 2 - run / 2, w: width, d: run };
  }
}

/**
 * A platform you walk up to: a block (or a deck on legs), a ramp up one side, a solid parapet on
 * one side (crouch behind it) and railings on the rest.
 */
export function platform(s: PlatformSpec, x: number, z: number): Piece {
  const boxes: MapBox[] = [];
  if (s.legs) {
    const deck = 0.3;
    boxes.push(box(x, z, s.w, deck, s.d, s.h - deck, s.topColor, s.top, { step: 'wood' }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      boxes.push(box(x + sx * (s.w / 2 - 0.3), z + sz * (s.d / 2 - 0.3), 0.4, s.h - deck, 0.4, 0, s.bodyColor, s.body));
    }
  } else {
    boxes.push(box(x, z, s.w, s.h - 0.2, s.d, 0, s.bodyColor, s.body));
    boxes.push(box(x, z, s.w, 0.2, s.d, s.h - 0.2, s.topColor, s.top));
  }
  const r = rampRect(s, x, z);
  const rampDir = (s.ramp === 'x+' ? 'x-' : s.ramp === 'x-' ? 'x+' : s.ramp === 'z+' ? 'z-' : 'z+') as MapBox['ramp'];
  boxes.push(box(r.x, r.z, r.w, s.h, r.d, 0, s.topColor, s.top, { ramp: rampDir }));
  // Edges: parapet on one side, railings on the others (not where the ramp arrives).
  for (const side of ['x+', 'x-', 'z+', 'z-'] as const) {
    const xs = side[0] === 'x';
    const sign = side[1] === '+' ? 1 : -1;
    const ex = xs ? x + sign * (s.w / 2 - 0.15) : x;
    const ez = xs ? z : z + sign * (s.d / 2 - 0.15);
    const long = xs ? s.d : s.w;
    if (side === s.parapet) {
      boxes.push(xs ? box(ex, ez, 0.3, 1.05, long, s.h, s.bodyColor, s.body) : box(ex, ez, long, 1.05, 0.3, s.h, s.bodyColor, s.body));
    } else if (side === s.ramp) {
      // Railing stubs either side of the ramp's top.
      const rw = xs ? r.d : r.w;
      const stub = (long - rw) / 2 - 0.1;
      if (stub > 0.3) {
        for (const o of [-1, 1]) {
          const c = o * (rw / 2 + 0.1 + stub / 2);
          boxes.push(xs
            ? box(ex, z + c, RAIL.t, RAIL.h, stub, s.h, s.topColor, 'metal', { blocks: 'move' })
            : box(x + c, ez, stub, RAIL.h, RAIL.t, s.h, s.topColor, 'metal', { blocks: 'move' }));
        }
      }
    } else {
      boxes.push(xs ? box(ex, ez, RAIL.t, RAIL.h, long, s.h, s.topColor, 'metal', { blocks: 'move' }) : box(ex, ez, long, RAIL.h, RAIL.t, s.h, s.topColor, 'metal', { blocks: 'move' }));
    }
  }
  return { boxes };
}

/**
 * A footbridge across a lane: a deck at `h` from (ax, az) to (bx, bz) (straight along x or z),
 * railings that stop movement but not bullets, and pillars at each end. Its ends land on ground
 * of about the same height (the ridges either side), so no ramps are needed.
 */
export function bridge(ax: number, az: number, bx: number, bz: number, h: number, width: number, color: number, surface: BoxSurface): Piece {
  const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
  const cx = (ax + bx) / 2;
  const cz = (az + bz) / 2;
  const l = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
  const deck = 0.3;
  const boxes: MapBox[] = [
    alongX ? box(cx, cz, l, deck, width, h - deck, color, surface, { step: 'hard' }) : box(cx, cz, width, deck, l, h - deck, color, surface, { step: 'hard' }),
  ];
  for (const o of [-1, 1]) {
    const off = o * (width / 2 - 0.06);
    boxes.push(alongX
      ? box(cx, cz + off, l, RAIL.h, RAIL.t, h, color, 'metal', { blocks: 'move' })
      : box(cx + off, cz, RAIL.t, RAIL.h, l, h, color, 'metal', { blocks: 'move' }));
  }
  return { boxes };
}

export type Side = 'n' | 's' | 'e' | 'w';

export interface Opening {
  side: Side;
  /** Centre of the opening along the side, from the side's middle */
  at: number;
  width: number;
  /** Bottom and top heights */
  bottom: number;
  top: number;
}

export interface BuildingSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  wallH: number;
  t?: number;
  wall: BoxSurface;
  wallColor: number;
  floor: BoxSurface;
  floorColor: number;
  roof: BoxSurface;
  roofColor: number;
  openings: Opening[];
  /** A ramp up the outside of one wall onto a walkable roof with a parapet */
  roofAccess?: Side;
}

export const DOOR = { width: 2, top: 2.4 };
export const WINDOW = { width: 1.2, bottom: 1, top: 2 };

const sideLength = (s: BuildingSpec, side: Side, t: number) => (side === 'n' || side === 's' ? s.w : s.d - 2 * t);

/** A wall along one side as solid spans plus the parts below and above each opening. */
function wallOf(s: BuildingSpec, side: Side, t: number): MapBox[] {
  const len = sideLength(s, side, t);
  const H = s.wallH;
  const openings = s.openings.filter((o) => o.side === side).sort((a, b) => a.at - b.at);
  const spans: [number, number, number, number][] = [];
  let cursor = -len / 2;
  for (const o of openings) {
    const a = o.at - o.width / 2;
    const b = o.at + o.width / 2;
    if (a > cursor + 0.01) spans.push([cursor, a, 0, H]);
    if (o.bottom > 0.01) spans.push([a, b, 0, o.bottom]);
    if (o.top < H - 0.01) spans.push([a, b, o.top, H]);
    cursor = b;
  }
  if (cursor < len / 2 - 0.01) spans.push([cursor, len / 2, 0, H]);
  const ns = side === 'n' || side === 's';
  const off = side === 'n' ? s.d / 2 - t / 2 : side === 's' ? -s.d / 2 + t / 2 : side === 'e' ? s.w / 2 - t / 2 : -s.w / 2 + t / 2;
  return spans.map(([a, b, y0, y1]) => {
    const mid = (a + b) / 2;
    const span = b - a;
    return box(s.x + (ns ? mid : off), s.z + (ns ? off : mid), ns ? span : t, y1 - y0, ns ? t : span, y0, s.wallColor, s.wall);
  });
}

/** Length of the ramp up to a building's roof (it runs along one wall, which must be longer) */
export const roofRampRun = (wallH: number): number => (wallH + 0.3) * RAMP_RUN;

/** Footprint of a building's roof ramp (outside the walls) */
export function roofRampRect(s: BuildingSpec): { x: number; z: number; w: number; d: number; dir: NonNullable<MapBox['ramp']> } | null {
  if (!s.roofAccess) return null;
  const rise = s.wallH + 0.3;
  const run = rise * RAMP_RUN;
  const width = 1.8;
  // The ramp runs along the wall, starting near one corner and rising toward the other.
  switch (s.roofAccess) {
    case 'n': return { x: s.x - s.w / 2 + run / 2 + 0.2, z: s.z + s.d / 2 + width / 2, w: run, d: width, dir: 'x+' };
    case 's': return { x: s.x + s.w / 2 - run / 2 - 0.2, z: s.z - s.d / 2 - width / 2, w: run, d: width, dir: 'x-' };
    case 'e': return { x: s.x + s.w / 2 + width / 2, z: s.z + s.d / 2 - run / 2 - 0.2, w: width, d: run, dir: 'z-' };
    default: return { x: s.x - s.w / 2 - width / 2, z: s.z - s.d / 2 + run / 2 + 0.2, w: width, d: run, dir: 'z+' };
  }
}

/** A building: walls with doors and windows, a roof, and maybe a ramp up to a walkable roof. */
export function building(s: BuildingSpec): Piece {
  const t = s.t ?? 0.3;
  const boxes: MapBox[] = [];
  for (const side of ['n', 's', 'e', 'w'] as const) boxes.push(...wallOf(s, side, t));
  boxes.push(box(s.x, s.z, s.w, 0.3, s.d, s.wallH, s.roofColor, s.roof));
  const ramp = roofRampRect(s);
  if (ramp) {
    const top = s.wallH + 0.3;
    boxes.push(box(ramp.x, ramp.z, ramp.w, top, ramp.d, 0, s.roofColor, s.roof, { ramp: ramp.dir }));
    // Parapet round the roof, open where the ramp arrives.
    const high = ramp.dir === 'x+' ? [ramp.x + ramp.w / 2, ramp.z] : ramp.dir === 'x-' ? [ramp.x - ramp.w / 2, ramp.z]
      : ramp.dir === 'z+' ? [ramp.x, ramp.z + ramp.d / 2] : [ramp.x, ramp.z - ramp.d / 2];
    for (const side of ['n', 's', 'e', 'w'] as const) {
      const ns = side === 'n' || side === 's';
      const off = side === 'n' ? s.d / 2 - 0.15 : side === 's' ? -s.d / 2 + 0.15 : side === 'e' ? s.w / 2 - 0.15 : -s.w / 2 + 0.15;
      const len = ns ? s.w : s.d;
      if (side === s.roofAccess) {
        // Open along the last stretch of the ramp, where it's level with the roof.
        const gapAt = ns ? high[0]! - s.x : high[1]! - s.z;
        const up = ramp.dir[1] === '+' ? 1 : -1;
        const g0 = up > 0 ? gapAt - 2.6 : gapAt - 0.4;
        const g1 = up > 0 ? gapAt + 0.4 : gapAt + 2.6;
        const a0 = -len / 2;
        const a1 = g0;
        const b0 = g1;
        const b1 = len / 2;
        for (const [u, v] of [[a0, a1], [b0, b1]] as const) {
          if (v - u < 0.3) continue;
          const m = (u + v) / 2;
          boxes.push(ns ? box(s.x + m, s.z + off, v - u, 1, 0.3, top, s.wallColor, s.wall) : box(s.x + off, s.z + m, 0.3, 1, v - u, top, s.wallColor, s.wall));
        }
      } else {
        boxes.push(ns ? box(s.x, s.z + off, len, 1, 0.3, top, s.wallColor, s.wall) : box(s.x + off, s.z, 0.3, 1, len, top, s.wallColor, s.wall));
      }
    }
  }
  return { boxes };
}

/** Doors on two or three sides and windows along every side, never too close to each other. */
export function openingsFor(rng: Rng, w: number, d: number, t: number, o: { doors?: number; doorWidth?: number; windows?: [number, number]; avoid?: Side } = {}): Opening[] {
  const sides: Side[] = ['n', 's', 'e', 'w'];
  const out: Opening[] = [];
  const dw = o.doorWidth ?? DOOR.width;
  const len = (side: Side) => (side === 'n' || side === 's' ? w : d - 2 * t);
  const doorSides = rng.shuffle(sides.filter((s) => s !== o.avoid)).slice(0, Math.max(2, o.doors ?? 2));
  for (const side of doorSides) {
    const room = len(side) / 2 - dw / 2 - t - 0.6;
    out.push({ side, at: q((rng.next() * 2 - 1) * Math.max(0, room) * 0.6), width: dw, bottom: 0, top: DOOR.top });
  }
  const [wMin, wMax] = o.windows ?? [1, 2];
  for (const side of sides) {
    const n = rng.int(wMin, wMax);
    for (let i = 0; i < n; i++) {
      const room = len(side) / 2 - WINDOW.width / 2 - t - 0.5;
      if (room <= 0) continue;
      const at = q((rng.next() * 2 - 1) * room);
      const clash = out.some((e) => e.side === side && Math.abs(e.at - at) < (e.width + WINDOW.width) / 2 + 0.6);
      if (!clash) out.push({ side, at, width: WINDOW.width, bottom: WINDOW.bottom, top: WINDOW.top });
    }
  }
  return out;
}

/** Points 1.4 m outside each door, which must be reachable. */
export function doorsOf(s: BuildingSpec): [number, number][] {
  const out: [number, number][] = [];
  for (const o of s.openings) {
    if (o.bottom > 0.01) continue;
    const d = 1.4;
    if (o.side === 'n') out.push([q(s.x + o.at), q(s.z + s.d / 2 + d)]);
    if (o.side === 's') out.push([q(s.x + o.at), q(s.z - s.d / 2 - d)]);
    if (o.side === 'e') out.push([q(s.x + s.w / 2 + d), q(s.z + o.at)]);
    if (o.side === 'w') out.push([q(s.x - s.w / 2 - d), q(s.z + o.at)]);
  }
  return out;
}

// ---------------------------------------------------------------- landmarks (the middle)

export type LandmarkId = 'tower' | 'gantry' | 'tanks' | 'fountain' | 'lookout' | 'stones' | 'derrick' | 'ruin';

/**
 * The middle's centrepiece. Built symmetric under both symmetries (a half turn and a reflection
 * across the middle line), so it's placed once. `r` is the middle's radius.
 */
export function landmark(id: LandmarkId, k: KitContext, r: number): Piece {
  const c = k.color();
  switch (id) {
    case 'tower': {
      // A clock tower: a tall block with a low wall round its foot, cover on each side.
      const s = 3.6;
      const boxes = [box(0, 0, s, 9, s, 0, c, k.theme.pillarSurface), box(0, 0, s + 0.6, 0.6, s + 0.6, 9, 0x6f6a66, 'concrete')];
      for (const [x, z, w, d] of [[s / 2 + 2.2, 0, 0.7, 2.6], [-(s / 2 + 2.2), 0, 0.7, 2.6], [0, s / 2 + 2.2, 2.6, 0.7], [0, -(s / 2 + 2.2), 2.6, 0.7]] as const) {
        boxes.push(box(x, z, w, 1.1, d, 0, 0xb9b6ad, 'concrete'));
      }
      return { boxes };
    }
    case 'fountain': {
      const boxes = [
        box(0, 0, 6, 0.8, 6, 0, 0xb9b6ad, 'concrete', { shape: 'cylinder' }),
        box(0, 0, 1.6, 2.6, 1.6, 0, 0x9aa3ad, 'concrete', { shape: 'cylinder' }),
        box(0, 0, 3, 0.4, 3, 2.6, 0x9aa3ad, 'concrete', { shape: 'cylinder' }),
      ];
      return { boxes, patches: [{ x: 0, z: 0, w: 2 * r, d: 2 * r, kind: 'sidewalk', y: 0 }] };
    }
    case 'gantry': {
      // An elevated walkway across the middle (along x), ramps up at both ends.
      const y = 2.8;
      const run = y * RAMP_RUN;
      const half = Math.max(2, Math.min(6, r - run - 0.5));
      const color = 0x7d8597;
      const boxes: MapBox[] = [
        box(0, 0, half * 2, 0.25, 2.4, y - 0.25, color, 'metal', { step: 'hard' }),
        box(half + run / 2, 0, run, y, 2.4, 0, color, 'metal', { ramp: 'x-', step: 'hard' }),
        box(-half - run / 2, 0, run, y, 2.4, 0, color, 'metal', { ramp: 'x+', step: 'hard' }),
      ];
      for (const sz of [1, -1]) boxes.push(box(0, sz * 1.14, half * 2, 1, 0.12, y, color, 'metal', { blocks: 'move' }));
      for (const sx of [1, -1]) for (const sz of [1, -1]) boxes.push(box(sx * (half - 1), sz * 0.95, 0.4, y - 0.25, 0.4, 0, color, 'metal'));
      return { boxes, patches: [{ x: 0, z: 0, w: q(half * 2 + run * 2 + 2), d: 5, kind: 'hazard', y: 0 }] };
    }
    case 'tanks': {
      const a = 3.4;
      const color = k.rng.pick([0xc9c9c0, 0x8fbf3f, 0xb9b6ad]);
      const boxes: MapBox[] = [];
      for (const sx of [1, -1]) for (const sz of [1, -1]) boxes.push(box(sx * a, sz * a, 3.6, 5.2, 3.6, 0, color, 'metal', { shape: 'cylinder' }));
      boxes.push(box(0, 0, 2.4, 1.1, 2.4, 0, 0x7d8597, 'metal'));
      return { boxes, patches: [{ x: 0, z: 0, w: 2 * r, d: 2 * r, kind: 'concrete', y: 0 }] };
    }
    case 'lookout': {
      // A fire lookout: a deck on legs with ramps up both ends.
      const h = 3.4;
      const w = 4.4;
      const boxes: MapBox[] = [box(0, 0, w, 0.3, w, h - 0.3, 0x8a6a45, 'planks', { step: 'wood' })];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxes.push(box(sx * (w / 2 - 0.3), sz * (w / 2 - 0.3), 0.4, h - 0.3, 0.4, 0, 0x5c4a3a, 'planks'));
      const run = h * RAMP_RUN;
      boxes.push(box(w / 2 + run / 2, 0, run, h, 1.8, 0, 0x8a6a45, 'planks', { ramp: 'x-', step: 'wood' }));
      boxes.push(box(-w / 2 - run / 2, 0, run, h, 1.8, 0, 0x8a6a45, 'planks', { ramp: 'x+', step: 'wood' }));
      // Waist-high planking along the z sides, railings by the ramps.
      for (const sz of [1, -1]) boxes.push(box(0, sz * (w / 2 - 0.1), w, 1.05, 0.2, h, 0x8a6a45, 'planks'));
      return { boxes };
    }
    case 'stones': {
      // Standing stones in a ring, low rocks between.
      const boxes: MapBox[] = [];
      const props = [];
      for (const [x, z] of [[4.5, 0], [-4.5, 0], [0, 4.5], [0, -4.5]] as const) {
        const p = propPiece('rock-tall-c', x, z, 0);
        boxes.push(...p.boxes);
        props.push(...p.props!);
      }
      return { boxes, props };
    }
    case 'derrick': {
      const p = propPiece('water-tower', 0, 0, 0);
      return { ...p, patches: [{ x: 0, z: 0, w: 2 * r, d: 2 * r, kind: 'dirt', y: 0 }] };
    }
    case 'ruin': {
      // Four broken wall corners round an open middle.
      const boxes: MapBox[] = [];
      const a = 3.6;
      for (const sx of [1, -1]) for (const sz of [1, -1]) {
        boxes.push(box(sx * a, sz * (a + 1.1), 2.8, 2.4, 0.8, 0, c, k.theme.wallSurface));
        boxes.push(box(sx * (a + 1.1), sz * a, 0.8, 2.4, 2.8, 0, c, k.theme.wallSurface));
      }
      return { boxes };
    }
  }
}
