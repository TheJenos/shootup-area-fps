/**
 * Shared generator pieces: the seeded RNG, the spawns and flag spots, and the Placer, which keeps
 * every piece clear of the walls, spawns, flags and everything else, and mirrors it into the other
 * team's half (z → -z), so both teams and both CTF bases see the same layout while the two sides
 * of each half (east and west) are different.
 */

import { mirrorRampDir } from '../ramps';
import type { GroundPatch, MapBox, MapLayout, MapProp, MapStyle, MapTheme, Piece, PropRot } from './types';

export const ARENA_HALF = 40;

/** Same spawns on every map; the generator keeps them clear. */
export const SPAWN_POINTS: [number, number][] = [];
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) SPAWN_POINTS.push([sx * 35, sz * 35], [sx * 17, sz * 26], [sx * 26, sz * 17]);
  SPAWN_POINTS.push([0, sx * 34], [sx * 34, 0]);
}

/** Matches FLAG_BASES in modes.ts */
export const FLAG_SPOTS: [number, number][] = [[0, 32], [0, -32]];

/** Narrowest gap left between obstacles (players are 0.7 m wide) */
export const GAP = 1.6;
export const SPAWN_CLEARANCE = 2.5;
export const FLAG_CLEARANCE = 4;
/** Inner face of the outer walls */
export const INNER = ARENA_HALF - 0.5;

/** Deterministic PRNG (mulberry32) seeded from an FNV-1a hash of the seed text. */
export function rngFor(seed: string): () => number {
  let a = 2166136261;
  for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

export const rectOf = (boxes: readonly MapBox[]): Rect => ({
  minX: Math.min(...boxes.map((b) => b.x - b.w / 2)),
  maxX: Math.max(...boxes.map((b) => b.x + b.w / 2)),
  minZ: Math.min(...boxes.map((b) => b.z - b.d / 2)),
  maxZ: Math.max(...boxes.map((b) => b.z + b.d / 2)),
});

/** Gap between two rectangles: they're apart if either axis has room. */
export const gapBetween = (a: Rect, b: Rect) =>
  Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minZ - b.maxZ, b.minZ - a.maxZ);

export const distanceToRect = (r: Rect, x: number, z: number) =>
  Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

export const round = (n: number) => Math.round(n * 100) / 100;

/** Boxes that take up floor space for spacing purposes (not tree canopies). */
const footprint = (p: Piece) => p.boxes.filter((b) => b.blocks !== 'shots');

/** Prop rotation after mirroring x (sx = -1) and/or z (sz = -1). */
/** Rotate an offset by quarter turns (same as a model's rotation.y). */
export function turn(dx: number, dz: number, rot: PropRot): [number, number] {
  switch (rot) {
    case 1: return [dz, -dx];
    case 2: return [-dx, -dz];
    case 3: return [-dz, dx];
    default: return [dx, dz];
  }
}

/** A model's collision box in a mirrored copy: turned with the model (which is turned, not reflected). */
function mirrorPivotBox(b: MapBox, sx: number, sz: number): MapBox {
  const p = b.pivot!;
  const x = round(p.x * sx);
  const z = round(p.z * sz);
  const rot = mirrorRot(p.rot, sx, sz);
  const [dx, dz] = turn(p.dx, p.dz, rot);
  const odd = rot % 2 === 1;
  return { ...b, x: round(x + dx), z: round(z + dz), w: round(odd ? p.d : p.w), d: round(odd ? p.w : p.d), pivot: { ...p, x, z, rot } };
}

const mirrorRot = (rot: PropRot, sx: number, sz: number): PropRot => {
  let r: number = rot;
  if (sx < 0) r = (4 - r) % 4;
  if (sz < 0) r = (6 - r) % 4;
  return r as PropRot;
};

/** A piece and its mirror image in the other team's half (one copy if it sits across the middle). */
export function mirrored(piece: Piece): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const sx of [1]) {
    for (const sz of [1, -1]) {
      const boxes = piece.boxes.map((b) => (b.pivot ? mirrorPivotBox(b, sx, sz) : {
        ...b, x: round(b.x * sx), z: round(b.z * sz), ...(b.ramp ? { ramp: mirrorRampDir(b.ramp, sx, sz) } : {}),
      }));
      const props = piece.props?.map((p) => ({ ...p, x: round(p.x * sx), z: round(p.z * sz), rot: mirrorRot(p.rot, sx, sz) }));
      const ground = piece.ground?.map((g) => ({ ...g, x: round(g.x * sx), z: round(g.z * sz) }));
      const doors = piece.doors?.map(([x, z]) => [round(x * sx), round(z * sz)] as [number, number]);
      // A copy that lands exactly on another (a piece on an axis) is skipped.
      const at = (list: { x: number; z: number }[] | undefined) => (list ?? []).map((b) => [b.x, b.z]);
      const key = JSON.stringify([at(boxes).sort(), at(props).sort(), at(ground).sort(), (doors ?? []).slice().sort()]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ boxes, props, ground, doors });
    }
  }
  return out;
}

export interface FitOptions {
  /** Keep SPAWN_CLEARANCE from every spawn (default true) */
  clearSpawns?: boolean;
  /** May go in reserved zones (street furniture on streets) */
  ignoreReserved?: boolean;
  /** Spacing from other pieces, default GAP */
  gap?: number;
}

/** Places pieces with the spacing rules and mirroring, and collects the layout. */
export class Placer {
  readonly boxes: MapBox[] = [];
  readonly props: MapProp[] = [];
  readonly ground: GroundPatch[] = [];
  readonly doors: [number, number][] = [];
  /** Spawn points for this map: the standard ones, moved inward where the outline covers them */
  spawns: [number, number][] = SPAWN_POINTS.map(([x, z]) => [x, z]);
  private readonly placed: Rect[] = [];
  private readonly reserved: Rect[] = [];

  constructor(readonly rand: () => number, readonly theme: MapTheme) {}

  range(min: number, max: number): number {
    return min + this.rand() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)] as T;
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }

  color(): number {
    return this.pick(this.theme.palette);
  }

  /** Would every mirrored copy of `piece` keep clear of the walls, spawns, flags and what's placed? */
  fits(piece: Piece, o: FitOptions = {}): boolean {
    const solid = footprint(piece);
    if (!solid.length) return true;
    const gap = o.gap ?? GAP;
    for (const copy of mirrored({ boxes: solid })) {
      const r = rectOf(copy.boxes);
      if (r.minX < -INNER + GAP || r.maxX > INNER - GAP || r.minZ < -INNER + GAP || r.maxZ > INNER - GAP) return false;
      if (this.placed.some((p) => gapBetween(p, r) < gap)) return false;
      if (!o.ignoreReserved && this.reserved.some((p) => gapBetween(p, r) < 0)) return false;
      if (o.clearSpawns !== false && this.spawns.some(([x, z]) => distanceToRect(r, x, z) < SPAWN_CLEARANCE)) return false;
      if (FLAG_SPOTS.some(([x, z]) => distanceToRect(r, x, z) < FLAG_CLEARANCE)) return false;
    }
    return true;
  }

  /** Place a piece and its mirror images. */
  place(piece: Piece): void {
    for (const copy of mirrored(piece)) this.placeAsIs(copy);
  }

  /** For pieces that are already symmetric (centerpieces). */
  placeAsIs(piece: Piece): void {
    const solid = footprint(piece);
    if (solid.length) this.placed.push(rectOf(solid));
    this.boxes.push(...piece.boxes);
    if (piece.props) this.props.push(...piece.props);
    if (piece.ground) this.ground.push(...piece.ground);
    if (piece.doors) this.doors.push(...piece.doors);
  }

  /** Keep big structures out of a zone (and its mirror images): streets, lanes. */
  reserve(r: Rect): void {
    for (const copy of mirrored({ boxes: [{ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, w: r.maxX - r.minX, d: r.maxZ - r.minZ, h: 0, y: 0, color: 0, surface: 'concrete' }] })) {
      this.reserved.push(rectOf(copy.boxes));
    }
  }

  /** What's been placed so far (rectangles, mirrored copies included). */
  get placedRects(): readonly Rect[] {
    return this.placed;
  }

  /**
   * Move any spawn that's within `clear` of `blockers` toward the middle of the map until it's free,
   * keeping spawns `apart` from each other. Spawns stay mirrored between the halves.
   */
  moveSpawns(blockers: readonly Rect[], clear = 3.5, apart = 6): void {
    const free = (x: number, z: number, others: [number, number][]) =>
      blockers.every((r) => distanceToRect(r, x, z) >= clear) && others.every(([ox, oz]) => Math.hypot(ox - x, oz - z) >= apart);
    const north: [number, number][] = [];
    for (const [x, z] of this.spawns) {
      if (z < 0) continue;
      let at: [number, number] = [x, z];
      if (!free(x, z, north)) {
        // Walk toward a point in the middle of our half, then try sideways steps.
        const tx = 0;
        const tz = z > 0 ? 18 : 0;
        for (let t = 0.05; t <= 1; t += 0.05) {
          const cx = round(x + (tx - x) * t);
          const cz = round(z + (tz - z) * t);
          if (free(cx, cz, north)) { at = [cx, cz]; break; }
        }
      }
      north.push(at);
    }
    this.spawns = north.flatMap(([x, z]) => (z === 0 ? [[x, z]] : [[x, z], [x, round(-z)]]) as [number, number][]);
  }

  result(seed: string, style: MapStyle): MapLayout {
    return {
      seed, theme: this.theme, style,
      boxes: this.boxes, props: this.props, ground: this.ground,
      spawnPoints: this.spawns, doors: this.doors,
    };
  }
}
