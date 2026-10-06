/**
 * Seeded map generator. Pure data (no Three.js), so the lobby can draw a preview
 * and every client builds exactly the same map from the room's seed.
 *
 * A seed picks a style (Industrial, Town, Outdoor) and a theme to go with it; the style's
 * generator in levelgen/ places pieces in one quarter and mirrors them into the other three, so
 * every spawn and both CTF bases see the same layout. Each map is checked (levelgen/check.ts):
 * if it fails, the seed is retried with a suffix, and as a last resort the original box arena
 * is used. Then terrain (levelgen/terrain.ts) raises rolling hills in the open ground between the
 * pieces. The `classic` seed is the original hand-made arena, on a smaller, flat map.
 */

import type { BoxSurface } from './textures';
import { ARENA_HALF, CLASSIC_FLAGS, CLASSIC_HALF, CLASSIC_SPAWNS, Placer, rngFor } from './levelgen/core';
import { checkLayout } from './levelgen/check';
import { addTerrain, type TerrainOptions } from './levelgen/terrain';
import { industrialLayout } from './levelgen/industrial';
import { outdoorLayout } from './levelgen/outdoor';
import { townLayout } from './levelgen/town';
import { arenaLayout } from './levelgen/pieces';
import type { MapBox, MapLayout, MapStyle, MapTheme } from './levelgen/types';

export type {
  BoxBlocks, GroundKind, GroundPatch, MapBox, MapLayout, MapProp, MapStyle, MapTheme, PropRot, StepSurface, Terrain,
} from './levelgen/types';
export { terrainHeight } from './levelgen/terrain';
export { ARENA_HALF };

/** Seed of the original hand-made map (also used for rooms made before seeds existed) */
export const CLASSIC_SEED = 'CLASSIC';
export const SEED_MAX_LENGTH = 16;

export const THEMES: MapTheme[] = [
  {
    name: 'Training Yard', surface: 'hard',
    floorTexture: 'tiles', wallSurface: 'concrete', pillarSurface: 'metal', sky: 0x9cc6ea, hemiSky: 0xe4f1ff, hemiGround: 0x5a4d3a, sun: 0xfff4e0,
    floor: '#5d6b58', floorLine: '#4d5a49', wall: 0x8a8f99,
    palette: [0x9a6b4f, 0xc28a4a, 0x6f7d8c, 0x4f7a6a, 0x4f6a7a, 0x7d8597],
  },
  {
    name: 'Dust Bowl', surface: 'sand',
    floorTexture: 'sand', wallSurface: 'brick', pillarSurface: 'concrete', sky: 0xe8cfa4, hemiSky: 0xfff0d6, hemiGround: 0x7a5a36, sun: 0xffe2b0,
    floor: '#b8955f', floorLine: '#a3824f', wall: 0xa88a64,
    palette: [0x8c5a3c, 0xc9a26b, 0x6e4f3a, 0xb0703f, 0x998066],
  },
  {
    name: 'Frostbite', surface: 'snow',
    floorTexture: 'snow', wallSurface: 'concrete', pillarSurface: 'metal', sky: 0xcfe6f5, hemiSky: 0xf2fbff, hemiGround: 0x6c7f91, sun: 0xeaf6ff,
    floor: '#d9e4ec', floorLine: '#c3d1dc', wall: 0x9fb3c4,
    palette: [0x5d7f9e, 0x86a7c2, 0x3e5a73, 0xb3c9d9, 0x6f8fa3],
  },
  {
    name: 'Dusk Yard', surface: 'hard',
    floorTexture: 'asphalt', wallSurface: 'brick', pillarSurface: 'metal', sky: 0x3d3b63, hemiSky: 0xffb38a, hemiGround: 0x2a2440, sun: 0xffa36b,
    floor: '#4a4560', floorLine: '#3d3852', wall: 0x5d5778,
    palette: [0x8a4f6b, 0xd07a52, 0x5a6b9a, 0x9c6b9e, 0x4f8a8a],
  },
  {
    name: 'Greenwood', surface: 'sand',
    floorTexture: 'grass', wallSurface: 'planks', pillarSurface: 'rock', sky: 0xa8d0ee, hemiSky: 0xeaf6ff, hemiGround: 0x4a5a32, sun: 0xfff1d0,
    floor: '#5f8a45', floorLine: '#4f7a3a', wall: 0x7a8a6a,
    palette: [0x8a6a45, 0x6f7d5a, 0xa58a5f, 0x5c6b4a, 0x7d6a55],
  },
  {
    name: 'Toxic Works', surface: 'hard',
    floorTexture: 'plate', wallSurface: 'metal', pillarSurface: 'concrete', sky: 0xa9c79b, hemiSky: 0xe6ffd6, hemiGround: 0x3b4a2e, sun: 0xf3ffd0,
    floor: '#4f5a46', floorLine: '#414b39', wall: 0x6b7563,
    palette: [0x8fbf3f, 0x5c6b4a, 0xc9c94a, 0x3f5f5a, 0x7a8a5a],
  },
];

const theme = (name: string) => THEMES.find((t) => t.name === name) as MapTheme;

/** Which themes each style is drawn in */
const STYLE_THEMES: Record<Exclude<MapStyle, 'arena'>, MapTheme[]> = {
  industrial: [theme('Toxic Works'), theme('Dusk Yard'), theme('Training Yard')],
  town: [theme('Training Yard'), theme('Dusk Yard'), theme('Dust Bowl'), theme('Frostbite')],
  outdoor: [theme('Greenwood'), theme('Frostbite'), theme('Dust Bowl')],
};

/** Styles a seed can roll */
const STYLES: Exclude<MapStyle, 'arena'>[] = ['industrial', 'town', 'outdoor'];

export const STYLE_NAMES: Record<MapStyle, string> = {
  arena: 'Arena', town: 'Town', industrial: 'Industrial', outdoor: 'Outdoor',
};

/** Seeds are case-insensitive letters and digits, so they're easy to read out and type. */
export function normalizeSeed(seed: string): string {
  return seed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, SEED_MAX_LENGTH);
}

export function randomSeed(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** The first two numbers a seed rolls decide its style and theme (see mapName). */
function styleAndTheme(rand: () => number): { style: Exclude<MapStyle, 'arena'>; theme: MapTheme } {
  const style = STYLES[Math.floor(rand() * STYLES.length)] ?? 'industrial';
  const list = STYLE_THEMES[style];
  return { style, theme: list[Math.floor(rand() * list.length)] ?? (THEMES[0] as MapTheme) };
}

const GENERATORS: Record<Exclude<MapStyle, 'arena'>, (seed: string, p: Placer) => MapLayout> = {
  industrial: industrialLayout,
  town: townLayout,
  outdoor: outdoorLayout,
};

/** Retries with a suffixed seed before falling back to the plain arena */
const RETRIES = 4;

/** How hilly each style's open ground gets: big rolling hills outdoors, low mounds elsewhere */
const TERRAIN: Record<MapStyle, TerrainOptions> = {
  outdoor: { height: 3.6, scale: 26 },
  industrial: { height: 1.5, scale: 20 },
  town: { height: 1.2, scale: 18 },
  arena: { height: 1.6, scale: 22 },
};

function generate(seed: string): MapLayout {
  const layout = generateFlat(seed);
  addTerrain(layout, rngFor(`${seed}#terrain`), TERRAIN[layout.style]);
  return layout;
}

function generateFlat(seed: string): MapLayout {
  const { style, theme } = styleAndTheme(rngFor(seed));
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const rand = rngFor(attempt ? `${seed}#${attempt}` : seed);
    // Skip the two style / theme rolls so the first attempt matches mapName.
    rand();
    rand();
    const layout = GENERATORS[style](seed, new Placer(rand, theme));
    if (checkLayout(layout).ok) return layout;
  }
  const rand = rngFor(`${seed}#arena`);
  return arenaLayout(seed, new Placer(rand, theme));
}

/** Recently generated maps: the lobby, room list, HUD and game all ask for the same few seeds. */
const recent = new Map<string, MapLayout>();
const CACHE_SIZE = 6;

export function generateMap(rawSeed: string): MapLayout {
  const seed = normalizeSeed(rawSeed) || CLASSIC_SEED;
  if (seed === CLASSIC_SEED) return classicMap();
  let layout = recent.get(seed);
  if (layout) {
    recent.delete(seed);
  } else {
    layout = generate(seed);
  }
  recent.set(seed, layout);
  while (recent.size > CACHE_SIZE) recent.delete(recent.keys().next().value as string);
  return layout;
}

/** "Theme · Style" for a seed, without generating the map. */
export function mapName(rawSeed: string): string {
  const seed = normalizeSeed(rawSeed) || CLASSIC_SEED;
  if (seed === CLASSIC_SEED) return (THEMES[0] as MapTheme).name;
  const { style, theme: t } = styleAndTheme(rngFor(seed));
  return `${t.name} · ${STYLE_NAMES[style]}`;
}

/** The display name of a generated layout ("Theme · Style", or just the theme for the classic arena). */
export function layoutName(l: MapLayout): string {
  return l.seed === CLASSIC_SEED ? l.theme.name : `${l.theme.name} · ${STYLE_NAMES[l.style]}`;
}

/** The original hand-built arena. */
function classicMap(): MapLayout {
  const boxes: MapBox[] = [];
  const add = (x: number, z: number, w: number, h: number, d: number, color: number, surface: BoxSurface, y = 0) =>
    boxes.push({ x, z, w, h, d, y, color, surface });

  add(0, 0, 6, 1.2, 6, 0x7d8597, 'concrete');
  add(1.8, 1.8, 1.4, 1, 1.4, 0xc28a4a, 'crate', 1.2);
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    add(sx * 3.6, sz * 3.6, sx ? 1.2 : 2, 0.6, sz ? 1.2 : 2, 0x7d8597, 'concrete');
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(sx * 14, sz * 8, 8, 3, 1, 0x9a6b4f, 'brick');
      add(sx * 8, sz * 14, 1, 3, 8, 0x9a6b4f, 'brick');
      add(sx * 20, sz * 20, 2, 2, 2, 0xc28a4a, 'crate');
      add(sx * 22.2, sz * 20, 2, 1, 2, 0xc28a4a, 'crate');
      add(sx * 20, sz * 20, 1.2, 1, 1.2, 0xb5793d, 'crate', 2);
      add(sx * 30, sz * 30, 3, 4, 3, 0x6f7d8c, 'metal');
      add(sx * 6, sz * 22, 1.5, 1.5, 1.5, 0xc28a4a, 'crate');
      add(sx * 22, sz * 6, 1.5, 1.5, 1.5, 0xc28a4a, 'crate');
      add(sx * 32, sz * 14, 4, 2.2, 1, 0x4f7a6a, 'concrete');
      add(sx * 14, sz * 32, 1, 2.2, 4, 0x4f7a6a, 'concrete');
    }
    add(0, sx * 24, 12, 2, 1, 0x4f6a7a, 'concrete');
    add(sx * 24, 0, 1, 2, 12, 0x4f6a7a, 'concrete');
  }
  return {
    seed: CLASSIC_SEED, theme: THEMES[0] as MapTheme, style: 'arena', half: CLASSIC_HALF, flags: CLASSIC_FLAGS,
    boxes, props: [], ground: [], spawnPoints: CLASSIC_SPAWNS, doors: [],
  };
}
