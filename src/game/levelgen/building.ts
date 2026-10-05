/**
 * Enterable buildings, built from boxes so they collide, stop bullets and show in the preview:
 * walls with door and window openings, an optional second floor reached by a ramp stair, and a
 * roof nobody can get onto.
 *
 * Sizes follow the player (player.ts): 0.7 m wide, 1.75 m tall, steps up 0.7 m, jumps ~1.3 m.
 * Doors are ≥ 1.8 m wide and ≥ 2.3 m tall; windows have a 1 m sill and are 1 m tall, so you
 * shoot through them but can't climb through.
 */

import type { BoxSurface } from '../textures';
import { round } from './core';
import type { MapBox, Piece } from './types';

export type Side = 'n' | 's' | 'e' | 'w';

export interface Opening {
  side: Side;
  /** Centre of the opening along the side, from the side's middle */
  at: number;
  width: number;
  /** Bottom and top heights (absolute) */
  bottom: number;
  top: number;
}

export interface BuildingSpec {
  /** Centre and outer size */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Total wall height */
  wallH: number;
  /** Wall thickness */
  t?: number;
  wall: BoxSurface;
  wallColor: number;
  floor: BoxSurface;
  floorColor: number;
  roof: BoxSurface;
  roofColor: number;
  openings: Opening[];
  /** A second floor at this height, with a ramp stair along `stairs.side` */
  upper?: { y: number; stairs: Side; railColor: number };
  /** A catwalk (instead of a full floor) along one side, at this height */
  catwalk?: { y: number; side: Side; width: number; color: number };
  /** Leave a strip of the roof open so daylight gets in */
  skylight?: boolean;
}

export const DOOR = { width: 2, top: 2.4 };
export const WINDOW = { width: 1.2, bottom: 1, top: 2 };
const SLAB = 0.25;
/** A ramp stair climbs this much run per metre of rise (gentle enough to walk) */
const STAIR_RUN = 1.45;
const STAIR_WIDTH = 1.5;
const RAIL = { h: 1, t: 0.12 };

/** Length of a side's wall (n/s run the full width, e/w fit between them). */
const sideLength = (s: BuildingSpec, side: Side, t: number) => (side === 'n' || side === 's' ? s.w : s.d - 2 * t);

/** A wall along one side as solid spans plus the parts below and above each opening. */
function wall(s: BuildingSpec, side: Side, t: number): MapBox[] {
  const len = sideLength(s, side, t);
  const H = s.wallH;
  const openings = s.openings.filter((o) => o.side === side).sort((a, b) => a.at - b.at);
  const spans: [number, number, number, number][] = []; // along from, along to, y from, y to
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
    return {
      x: round(s.x + (ns ? mid : off)), z: round(s.z + (ns ? off : mid)),
      w: round(ns ? span : t), d: round(ns ? t : span), h: round(y1 - y0), y: round(y0),
      color: s.wallColor, surface: s.wall,
    };
  });
}

/** `outer` minus `hole` as up to four rectangles (min/max x and z). */
function subtract(
  outer: [number, number, number, number], hole: [number, number, number, number],
): [number, number, number, number][] {
  const [ox0, ox1, oz0, oz1] = outer;
  const [hx0, hx1, hz0, hz1] = [Math.max(ox0, hole[0]), Math.min(ox1, hole[1]), Math.max(oz0, hole[2]), Math.min(oz1, hole[3])];
  if (hx0 >= hx1 || hz0 >= hz1) return [outer];
  const out: [number, number, number, number][] = [];
  if (hz0 > oz0) out.push([ox0, ox1, oz0, hz0]);
  if (hz1 < oz1) out.push([ox0, ox1, hz1, oz1]);
  if (hx0 > ox0) out.push([ox0, hx0, hz0, hz1]);
  if (hx1 < ox1) out.push([hx1, ox1, hz0, hz1]);
  return out.filter(([a, b, c, d]) => b - a > 0.05 && d - c > 0.05);
}

const slab = (r: [number, number, number, number], y: number, h: number, color: number, surface: BoxSurface): MapBox => ({
  x: round((r[0] + r[1]) / 2), z: round((r[2] + r[3]) / 2), w: round(r[1] - r[0]), d: round(r[3] - r[2]),
  h, y: round(y), color, surface,
});

/** A building as a piece: walls, floor slabs, stair, railings, roof, and points outside each door. */
export function building(s: BuildingSpec): Piece {
  const t = s.t ?? 0.3;
  const boxes: MapBox[] = [];
  for (const side of ['n', 's', 'e', 'w'] as const) boxes.push(...wall(s, side, t));

  // Inside faces
  const ix0 = s.x - s.w / 2 + t;
  const ix1 = s.x + s.w / 2 - t;
  const iz0 = s.z - s.d / 2 + t;
  const iz1 = s.z + s.d / 2 - t;

  const level = s.upper ?? (s.catwalk ? { y: s.catwalk.y, stairs: s.catwalk.side, railColor: s.catwalk.color } : null);
  if (level) {
    // A ramp stair along one inside wall, rising toward the corner; the floor above has a hole over
    // the whole ramp (you'd hit your head otherwise), railed except where the ramp arrives.
    const rise = level.y;
    const run = round(rise * STAIR_RUN);
    const along = level.stairs === 'n' || level.stairs === 's' ? 'x' : 'z';
    const inner = level.stairs === 'n' ? iz1 - STAIR_WIDTH / 2 : level.stairs === 's' ? iz0 + STAIR_WIDTH / 2
      : level.stairs === 'e' ? ix1 - STAIR_WIDTH / 2 : ix0 + STAIR_WIDTH / 2;
    // The ramp's low end starts 1 m from one inside corner; its high end points at the other.
    const start = (along === 'x' ? ix0 : iz0) + 1;
    const mid = start + run / 2;
    const ramp: MapBox = along === 'x'
      ? { x: round(mid), z: round(inner), w: run, d: STAIR_WIDTH, h: round(rise), y: 0, color: level.railColor, surface: 'metal', ramp: 'x+' }
      : { x: round(inner), z: round(mid), w: STAIR_WIDTH, d: run, h: round(rise), y: 0, color: level.railColor, surface: 'metal', ramp: 'z+' };
    boxes.push(ramp);
    const hole: [number, number, number, number] = along === 'x'
      ? [start - 0.5, start + run, inner - STAIR_WIDTH / 2 - 0.4, inner + STAIR_WIDTH / 2 + 0.4]
      : [inner - STAIR_WIDTH / 2 - 0.4, inner + STAIR_WIDTH / 2 + 0.4, start - 0.5, start + run];

    if (s.catwalk) {
      // A walkway along the stair wall only, the length of the building after the stair.
      const wd = s.catwalk.width;
      const strip: [number, number, number, number] = along === 'x'
        ? [start + run, ix1, level.stairs === 'n' ? iz1 - wd : iz0, level.stairs === 'n' ? iz1 : iz0 + wd]
        : [level.stairs === 'e' ? ix1 - wd : ix0, level.stairs === 'e' ? ix1 : ix0 + wd, start + run, iz1];
      boxes.push(slab(strip, rise - SLAB, SLAB, s.catwalk.color, 'metal'));
      // Railing along the open edge of the walkway (you can shoot through it).
      const edge = along === 'x' ? (level.stairs === 'n' ? strip[2] : strip[3]) : (level.stairs === 'e' ? strip[0] : strip[1]);
      const len = along === 'x' ? strip[1] - strip[0] : strip[3] - strip[2];
      const c = along === 'x' ? (strip[0] + strip[1]) / 2 : (strip[2] + strip[3]) / 2;
      boxes.push(along === 'x'
        ? { x: round(c), z: round(edge), w: round(len), d: RAIL.t, h: RAIL.h, y: round(rise), color: s.catwalk.color, surface: 'metal', blocks: 'move' }
        : { x: round(edge), z: round(c), w: RAIL.t, d: round(len), h: RAIL.h, y: round(rise), color: s.catwalk.color, surface: 'metal', blocks: 'move' });
    } else {
      for (const r of subtract([ix0, ix1, iz0, iz1], hole)) boxes.push(slab(r, rise - SLAB, SLAB, s.floorColor, s.floor));
      // Rails round the hole on the floor above: the far long side and the low end (the wall is on the
      // other long side, and the high end is where you step off the ramp).
      const [hx0, hx1, hz0, hz1] = hole;
      if (along === 'x') {
        const farZ = level.stairs === 'n' ? hz0 : hz1;
        boxes.push({ x: round((hx0 + hx1) / 2), z: round(farZ), w: round(hx1 - hx0), d: RAIL.t, h: RAIL.h, y: round(rise), color: level.railColor, surface: 'metal', blocks: 'move' });
        boxes.push({ x: round(hx0), z: round((hz0 + hz1) / 2), w: RAIL.t, d: round(hz1 - hz0), h: RAIL.h, y: round(rise), color: level.railColor, surface: 'metal', blocks: 'move' });
      } else {
        const farX = level.stairs === 'e' ? hx0 : hx1;
        boxes.push({ x: round(farX), z: round((hz0 + hz1) / 2), w: RAIL.t, d: round(hz1 - hz0), h: RAIL.h, y: round(rise), color: level.railColor, surface: 'metal', blocks: 'move' });
        boxes.push({ x: round((hx0 + hx1) / 2), z: round(hz0), w: round(hx1 - hx0), d: RAIL.t, h: RAIL.h, y: round(rise), color: level.railColor, surface: 'metal', blocks: 'move' });
      }
    }
  }

  // Roof: over the walls, with an optional daylight strip down the middle of the long axis.
  const roof: [number, number, number, number] = [s.x - s.w / 2, s.x + s.w / 2, s.z - s.d / 2, s.z + s.d / 2];
  const pieces = s.skylight
    ? subtract(roof, s.w >= s.d ? [s.x - s.w / 2 + 2, s.x + s.w / 2 - 2, s.z - 1, s.z + 1] : [s.x - 1, s.x + 1, s.z - s.d / 2 + 2, s.z + s.d / 2 - 2])
    : [roof];
  for (const r of pieces) boxes.push(slab(r, s.wallH, 0.3, s.roofColor, s.roof));

  // Points 1.2 m outside each ground-floor door, which the map checker makes sure you can reach.
  const doors: [number, number][] = [];
  for (const o of s.openings) {
    if (o.bottom > 0.01 || o.top < 2) continue;
    const out = 1.2;
    if (o.side === 'n') doors.push([round(s.x + o.at), round(s.z + s.d / 2 + out)]);
    if (o.side === 's') doors.push([round(s.x + o.at), round(s.z - s.d / 2 - out)]);
    if (o.side === 'e') doors.push([round(s.x + s.w / 2 + out), round(s.z + o.at)]);
    if (o.side === 'w') doors.push([round(s.x - s.w / 2 - out), round(s.z + o.at)]);
  }
  return { boxes, doors };
}

/**
 * Doors and windows for a building: a door on each of two different sides (more on bigger ones),
 * and windows spread along every side, never too close to corners or each other.
 */
export function openingsFor(
  rand: () => number, w: number, d: number, t: number,
  o: { doors?: number; windowsPerSide?: [number, number]; doorWidth?: number; doorTop?: number; upperY?: number; windowRow?: { bottom: number; top: number } } = {},
): Opening[] {
  const sides: Side[] = ['n', 's', 'e', 'w'];
  const out: Opening[] = [];
  const doorCount = Math.max(2, o.doors ?? 2);
  // Pick door sides: always two different ones first.
  const order = [...sides].sort(() => rand() - 0.5);
  const doorSides = order.slice(0, Math.min(4, doorCount));
  const dw = o.doorWidth ?? DOOR.width;
  const dt = o.doorTop ?? DOOR.top;
  const len = (side: Side) => (side === 'n' || side === 's' ? w : d - 2 * t);
  for (const side of doorSides) {
    const room = len(side) / 2 - dw / 2 - t - 0.6;
    out.push({ side, at: round((rand() * 2 - 1) * Math.max(0, room) * 0.7), width: dw, bottom: 0, top: dt });
  }
  const [wMin, wMax] = o.windowsPerSide ?? [1, 2];
  const rows = [o.windowRow ?? WINDOW];
  if (o.upperY !== undefined) rows.push({ bottom: o.upperY + 1, top: o.upperY + 2 });
  for (const side of sides) {
    for (const row of rows) {
      const n = Math.floor(wMin + rand() * (wMax - wMin + 1));
      for (let i = 0; i < n; i++) {
        const room = len(side) / 2 - WINDOW.width / 2 - t - 0.5;
        if (room <= 0) continue;
        const at = round((rand() * 2 - 1) * room);
        const clash = out.some((e) => e.side === side && Math.abs(e.at - at) < (e.width + WINDOW.width) / 2 + 0.6 && e.bottom < row.top && e.top > row.bottom);
        if (!clash) out.push({ side, at, width: WINDOW.width, bottom: row.bottom, top: row.top });
      }
    }
  }
  return out;
}
