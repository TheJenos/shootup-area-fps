/**
 * Places pieces in red's half and their copies in blue's, keeping the rules every map follows:
 * inside the walls, a walkable gap between pieces, clear of the flags and spawns, out of the middle
 * strip of every lane (so there's always a way through), and only in the zones a piece belongs in.
 *
 * Two ways to stand on the terrain:
 * - ground: the piece sits on the lowest ground under it (sinking a little into a slope), for cover,
 *   rocks and the like. Only after the terrain is final.
 * - pad: a flat pad is cut and filled under it (terrain.ts addPad), for structures you walk on or
 *   into. Only before the terrain is final.
 */

import { groundRange } from './heightField';
import { distanceToRect, gapBetween, grow, q, rectOf, type Rect } from './dmath';
import type { Rng } from './rng';
import { tPiece, type Symmetry } from './symmetry';
import { ZONE, type Terrain, type ZoneId } from './terrain';
import type { Ground, GroundPatch, MapBox, MapProp, MapTheme, Piece } from './types';

/** Narrowest gap left between obstacles (players are 0.7 m wide) */
export const GAP = 1.6;
export const SPAWN_CLEARANCE = 2.5;
export const FLAG_CLEARANCE = 4;

export interface PlaceOptions {
  /** Zones the whole footprint must be in (default: anywhere) */
  zones?: readonly ZoneId[];
  /** Gap to other pieces (default GAP) */
  gap?: number;
  /** May stand in a lane's middle strip */
  core?: boolean;
  /** ground (default) or pad, see above */
  mode?: 'ground' | 'pad';
  /** ground: steepest ground allowed under it (highest minus lowest) */
  maxStep?: number;
  /** pad: deepest cut or fill */
  maxCut?: number;
  /** pad: height wanted, if the pins allow */
  padH?: number;
  /** Already symmetric (in the middle): placed once, no copy */
  self?: boolean;
  /** May come closer to the flags (base defences) */
  flagClear?: number;
}

/** Why placements were refused (for tuning) */
export const placeStats: Record<string, number> = {};
const no = (why: string): null => { if (placeStats.on) placeStats[why] = (placeStats[why] ?? 0) + 1; return null; };

/** Boxes that take up floor space for spacing purposes (not tree canopies, not things overhead) */
const footprint = (p: Piece) => p.boxes.filter((b) => b.blocks !== 'shots' && b.y < 1.5);

export class Placer {
  readonly boxes: MapBox[] = [];
  readonly props: MapProp[] = [];
  readonly patches: GroundPatch[] = [];
  readonly rects: Rect[] = [];
  /** Spawn points (red's), kept clear */
  spawns: [number, number][] = [];
  /** Points kept clear by a radius (flag spots...) */
  readonly keepClear: { x: number; z: number; r: number }[] = [];
  ground: Ground | null = null;

  constructor(
    readonly rng: Rng,
    readonly terrain: Terrain,
    readonly theme: MapTheme,
    readonly sym: Symmetry,
    readonly flags: [number, number][],
  ) {}

  get half(): number {
    return this.terrain.half;
  }

  color(): number {
    return this.rng.pick(this.theme.palette);
  }

  /** Every vertex under `r` is in one of `zones` */
  inZones(r: Rect, zones: readonly ZoneId[]): boolean {
    const t = this.terrain;
    const { i0, i1, k0, k1 } = t.cells(r);
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) if (!zones.includes(t.zone[k * t.side + i]! as ZoneId)) return false;
    }
    return true;
  }

  /** Whether `r` touches a lane's middle strip */
  inCore(r: Rect): boolean {
    const t = this.terrain;
    const { i0, i1, k0, k1 } = t.cells(grow(r, -0.2));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (t.core[k * t.side + i]) return true;
    return false;
  }

  /** Where `piece` would go, and how high, or null if it doesn't fit. */
  check(piece: Piece, o: PlaceOptions = {}): { dy: number; rect: Rect | null } | null {
    const solid = footprint(piece);
    const all = solid.length ? solid : piece.boxes;
    const H = this.half;
    let rect: Rect | null = null;
    if (all.length) {
      rect = rectOf(all);
      const r = rect;
      if (r.minX < -H + 1.2 || r.maxX > H - 1.2 || r.minZ < -H + 1.2 || r.maxZ > H - 1.2) return no('bounds');
      if (!o.self && r.minZ < 1) return no('middle');
      if (solid.length) {
        const gap = o.gap ?? GAP;
        for (const p of this.rects) if (gapBetween(p, r) < gap) return no('gap');
        const clear = o.flagClear ?? FLAG_CLEARANCE;
        for (const [x, z] of this.flags) if (distanceToRect(r, x, z) < clear) return no('flag');
        for (const k of this.keepClear) if (distanceToRect(r, k.x, k.z) < k.r) return no('keep');
        for (const [x, z] of this.spawns) {
          if (distanceToRect(r, x, z) < SPAWN_CLEARANCE) return no('spawn');
          const [tx, tz] = this.sym === 'rotate' ? [-x, -z] : [x, -z];
          if (distanceToRect(r, tx, tz) < SPAWN_CLEARANCE) return no('spawn');
        }
        if (!o.core && this.inCore(r)) return no('core');
      }
      if (o.zones && !this.inZones(r, o.zones)) return no('zone');
    }
    if (o.mode === 'pad') {
      if (!rect) return null;
      const h = this.terrain.padHeight(rect, o.maxCut ?? 1.2, o.padH);
      return h === null ? no('pad') : { dy: h, rect };
    }
    const g = this.ground;
    if (!g) throw new Error('ground placement before the terrain is final');
    if (rect) {
      const a = groundRange(g, rect.minX, rect.maxX, rect.minZ, rect.maxZ);
      if (a.hi - a.lo > (o.maxStep ?? 0.45)) return no('step');
      return { dy: a.lo, rect };
    }
    const p = piece.props?.[0];
    if (!p) return { dy: 0, rect: null };
    const a = groundRange(g, p.x - 0.4, p.x + 0.4, p.z - 0.4, p.z + 0.4);
    return { dy: a.lo, rect: null };
  }

  /** Place `piece` (and its copy) if it fits. */
  place(piece: Piece, o: PlaceOptions = {}): boolean {
    const at = this.check(piece, o);
    if (!at) return false;
    this.commit(piece, at.dy, at.rect, o);
    return true;
  }

  /**
   * Place without checking (the caller has, for structures made of several parts). `rect` is the
   * floor space it takes (null: none), `dy` how far to lift it, or the pad height in pad mode.
   */
  commit(piece: Piece, dy: number, rect: Rect | null, o: PlaceOptions = {}): void {
    if (o.mode === 'pad' && rect) this.terrain.addPad(rect, dy);
    const lifted = lift(piece, dy);
    const copies = o.self ? [lifted] : [lifted, tPiece(this.sym, lifted)];
    if (rect && footprint(piece).length) {
      this.rects.push(rect);
      if (!o.self) this.rects.push(this.terrain.tRect(rect));
    }
    for (const c of copies) {
      this.boxes.push(...c.boxes);
      if (c.props) this.props.push(...c.props);
      if (c.patches) this.patches.push(...c.patches);
    }
  }

  /** Keep a rectangle (and its copy) clear without putting anything there (a doorway, a stair foot). */
  reserve(r: Rect): void {
    this.rects.push(r, this.terrain.tRect(r));
  }
}

/** Raise a piece built at y = 0 by dy. */
export function lift(piece: Piece, dy: number): Piece {
  if (!dy) return piece;
  return {
    boxes: piece.boxes.map((b) => ({ ...b, y: q(b.y + dy) })),
    ...(piece.props ? { props: piece.props.map((p) => ({ ...p, y: q(p.y + dy) })) } : {}),
    ...(piece.patches ? { patches: piece.patches.map((g) => ({ ...g, y: q(g.y + dy) })) } : {}),
  };
}

/** All zones you walk in (not ridges or the rim) */
export const WALK_ZONES: readonly ZoneId[] = [ZONE.base, ZONE.lane, ZONE.choke, ZONE.mid, ZONE.connector, ZONE.overlook, ZONE.shoulder];
