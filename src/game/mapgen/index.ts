/**
 * Seeded map generator. Pure data (no three.js), so it runs in a worker, the lobby can draw a
 * preview, and every client builds exactly the same map from the room's map spec (seed, size and
 * generator version).
 *
 * A map starts as a maze: a winding path is cut through it from each base to the middle, widened
 * into corridors with open areas grown round it, and the open spaces are filled with the biome's
 * things; everything else is walled in by buildings or cliffs. See generate.ts for the pipeline.
 * The CLASSIC seed is the original hand-made arena.
 */

import { CLASSIC_SEED, classicMap } from './classic';
import { generate, metaFor } from './generate';
import { mapHash } from './hash';
import { asymFor, isMapSize, specKey, type MapSpec } from './spec';
import type { MapData } from './types';

export type {
  BoxBlocks, Ground, GroundKind, GroundPatch, MapBox, MapData, MapProp, MapTheme, MazeLayout, PickupSpot, PropRot, Spawn, StepSurface,
} from './types';
export { PAINT } from './types';
export { groundHeight, groundGradient, groundRange, rapierHeights } from './heightField';
export { MAP_SIZES, SIZE_LABEL, asymFor, isMapSize, specKey, type MapSize, type MapSpec } from './spec';
export { THEMES } from './themes';
export { insideOutline, outsideRects, type Outline } from './layout';
export { CLASSIC_SEED };

/**
 * Bump whenever any seed's map changes: rooms remember the version they were made with, and
 * clients on another version can't join them (they'd be playing on different maps).
 */
export const GENERATOR_VERSION = 5;
export const SEED_MAX_LENGTH = 16;

/** Seeds are case-insensitive letters and digits, so they're easy to read out and type. */
export function normalizeSeed(seed: string): string {
  return seed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, SEED_MAX_LENGTH);
}

export function randomSeed(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]; // det-ok: picks a seed, not a map
  return s;
}

/** A clean spec: normalized seed, a valid size, the version, asymmetric or not (CLASSIC ignores all but the seed). */
export function toSpec(seed: string, size?: unknown, gen?: unknown, asym?: unknown): MapSpec {
  const s = normalizeSeed(seed) || CLASSIC_SEED;
  return {
    seed: s, size: isMapSize(size) ? size : 'm', gen: typeof gen === 'number' && gen >= 1 ? Math.floor(gen) : GENERATOR_VERSION,
    ...(asym === true && s !== CLASSIC_SEED ? { asym: true } : {}),
  };
}

export const isClassic = (spec: MapSpec): boolean => spec.seed === CLASSIC_SEED;

/** `spec` as a room playing `base` has it: asymmetric unless it's Capture the Flag (see MapSpec.asym). */
export function specForMode(spec: MapSpec, base: string): MapSpec {
  const { asym: _old, ...rest } = spec;
  return isClassic(spec) || !asymFor(base) ? rest : { ...rest, asym: true };
}

/** Whether this build can make the map (the classic one always; others only on the same version). */
export const isPlayableSpec = (spec: MapSpec): boolean => isClassic(spec) || spec.gen === GENERATOR_VERSION;

/** Two specs that make the same map */
export const sameMap = (a: MapSpec, b: MapSpec): boolean =>
  isClassic(a) ? isClassic(b) : !isClassic(b) && specKey(a) === specKey(b);

/** Recently generated maps: the lobby, room list, HUD and game ask for the same few. */
const recent = new Map<string, MapData>();
const CACHE_SIZE = 6;

let classic: MapData | null = null;

/** Build (or fetch from the cache) the map for a spec. Synchronous: see client.ts for the worker. */
export function generateMap(spec: MapSpec): MapData {
  if (isClassic(spec)) {
    if (!classic) {
      const body = classicMap();
      classic = { ...body, hash: mapHash(body) };
    }
    return classic;
  }
  const key = specKey(spec);
  let map = recent.get(key);
  if (map) recent.delete(key);
  else map = generate(spec);
  remember(key, map);
  return map;
}

/** Put a map built elsewhere (the worker) in the cache. */
export function remember(key: string, map: MapData): void {
  recent.set(key, map);
  while (recent.size > CACHE_SIZE) recent.delete(recent.keys().next().value as string);
}

export const cachedMap = (spec: MapSpec): MapData | null => (isClassic(spec) ? generateMap(spec) : recent.get(specKey(spec)) ?? null);

/** "Red Cut · Quarry" for a seed, without generating the map (the same for every size). */
export function mapName(seed: string): string {
  const s = normalizeSeed(seed) || CLASSIC_SEED;
  if (s === CLASSIC_SEED) return classicMap().name;
  return metaFor(s).name;
}

