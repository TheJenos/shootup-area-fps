/**
 * Biomes: what a lane graph is built out of. Each has its own terrain (deep canyons, rolling forest,
 * low town blocks), its own cover, structures and landmarks, and the themes it's drawn in.
 */

import type { PropId } from '../propManifest';
import type { BoxSurface, GroundKind } from '../textures';
import type { GraphOptions } from './graph';
import {
  barrels, container, containerStack, crate, crateStack, lowWall, model, pallets, pillar, sandbags, wall, corner,
  type CoverClass, type CoverKit, type LandmarkId,
} from './kits';
import type { TerrainOptions } from './terrain';

export type BiomeId = 'quarry' | 'oldtown' | 'highlands' | 'refinery';

export interface Cover {
  kit: CoverKit;
  cls: CoverClass;
  weight: number;
  /** Turned to run along the lane (containers) rather than across it (walls you hide behind) */
  along?: boolean;
}

export interface Biome {
  id: BiomeId;
  label: string;
  themes: readonly string[];
  /** First half of map names ("Red Cut · Quarry") */
  names: readonly string[];
  /** Mostly roofs and walls: more light from the sky */
  indoor: boolean;
  graph: GraphOptions;
  terrain: TerrainOptions;
  landmarks: readonly (readonly [LandmarkId, number])[];
  /** Cover in the lanes, the middle and at chokes */
  cover: readonly Cover[];
  /** Big things on the ridges and the rim (rocks, trees): pieces per 100 m² */
  ridge: readonly Cover[];
  ridgeDensity: number;
  /** Buildings and big models standing on the ridges, facing the lanes */
  ridgeModels: readonly PropId[];
  ridgeModelCount: [number, number];
  /** Enterable buildings with a walkable roof, per half */
  houses: [number, number];
  house: { wall: BoxSurface; roof: BoxSurface; floor: BoxSurface; wallH: number; colors: readonly number[] };
  /** Overlook platforms */
  overlook: { legs: boolean; body: BoxSurface; top: BoxSurface; bodyColor: number; topColor: number };
  /** Footbridges over chokes */
  bridge: { surface: BoxSurface; color: number; chance: number };
  /** Ground paint for lanes */
  path: GroundKind;
  /** Decoration along lane edges (lamps), if any */
  lamps?: PropId;
}

const c = (kit: CoverKit, cls: CoverClass, weight: number, along = false): Cover => ({ kit, cls, weight, along });

export const BIOMES: Record<BiomeId, Biome> = {
  quarry: {
    id: 'quarry',
    label: 'Quarry',
    themes: ['Dust Bowl', 'Dust Bowl', 'Training Yard'],
    names: ['Red Cut', 'Gravel Pit', 'Dry Wash', 'Ore Ridge', 'Slag Hollow', 'Copper Gulch', 'Deep Cut', 'Sandstone', 'Dust Devil'],
    indoor: false,
    graph: { plateau: [1.2, 1.8], mids: [['plaza', 2], ['hill', 2], ['sunken', 1]] },
    terrain: { ridge: [3.8, 4.8], rise: 7, noise: 0.35, rim: 5.5 },
    landmarks: [['derrick', 2], ['gantry', 1], ['ruin', 1]],
    cover: [
      c(crate, 'low', 2), c(crateStack, 'mid', 2), c(sandbags, 'low', 3), c(lowWall, 'low', 2),
      c(container, 'tall', 2, true), c(model(['rock-a', 'rock-c', 'rock-e']), 'mid', 3), c(model(['rock-tall-c', 'rock-tall-e']), 'tall', 1),
      c(containerStack, 'tall', 1, true),
    ],
    ridge: [c(model(['rock-b', 'rock-d', 'rock-f', 'rock-a']), 'mid', 4), c(model(['rock-tall-a', 'rock-tall-c']), 'tall', 1)],
    ridgeDensity: 0.4,
    ridgeModels: ['tank', 'water-tower'],
    ridgeModelCount: [0, 1],
    houses: [0, 1],
    house: { wall: 'concrete', roof: 'metal', floor: 'concrete', wallH: 3.2, colors: [0xa88a64, 0x998066, 0xb0703f] },
    overlook: { legs: false, body: 'rock', top: 'concrete', bodyColor: 0xb3aa9a, topColor: 0x9a9a92 },
    bridge: { surface: 'metal', color: 0x7d8597, chance: 0.7 },
    path: 'dirt',
  },
  oldtown: {
    id: 'oldtown',
    label: 'Old Town',
    themes: ['Training Yard', 'Dusk Yard', 'Frostbite', 'Dust Bowl'],
    names: ['Market Row', 'Bell Square', 'Old Quarter', 'Canal Street', 'Mill Lane', 'Chapel Hill', 'Union Yard', 'Lantern Way'],
    indoor: true,
    graph: { plateau: [0.8, 1.3], mids: [['plaza', 3], ['hill', 1]] },
    terrain: { ridge: [1.6, 2.4], rise: 5, noise: 0.2, rim: 3 },
    landmarks: [['tower', 2], ['fountain', 2]],
    cover: [
      c(model(['barrier']), 'low', 2), c(model(['dumpster']), 'mid', 2, true), c(model(['planter']), 'low', 2), c(lowWall, 'low', 2),
      c(crate, 'low', 1), c(wall, 'tall', 1), c(corner, 'tall', 1), c(pillar, 'tall', 1),
    ],
    ridge: [c(model(['tree-street']), 'mid', 1), c(model(['planter', 'dumpster']), 'low', 1)],
    ridgeDensity: 0.15,
    ridgeModels: ['shop-a', 'shop-b', 'shop-c', 'shop-d', 'shop-e', 'shop-f', 'shop-g', 'shop-h', 'house-a', 'house-b', 'house-c', 'house-d', 'house-e', 'house-f', 'house-h', 'house-k'],
    ridgeModelCount: [7, 12],
    houses: [1, 2],
    house: { wall: 'plaster', roof: 'concrete', floor: 'planks', wallH: 3.4, colors: [0xd8cdb8, 0xc9b79a, 0xb8c4c9, 0xd9b8a0, 0xa9b8a0] },
    overlook: { legs: false, body: 'brick', top: 'concrete', bodyColor: 0x9a6b4f, topColor: 0x8a8f99 },
    bridge: { surface: 'concrete', color: 0x8a8f99, chance: 0.6 },
    path: 'concrete',
    lamps: 'lamp',
  },
  highlands: {
    id: 'highlands',
    label: 'Highlands',
    themes: ['Greenwood', 'Greenwood', 'Frostbite'],
    names: ['Pine Ridge', 'Elk Hollow', 'Misty Fork', 'Bear Creek', 'Fern Gully', 'Stonewatch', 'Cold Spring', 'Owl Bluff'],
    indoor: false,
    graph: { plateau: [1.2, 2], mids: [['hill', 2], ['plaza', 1], ['sunken', 1]] },
    terrain: { ridge: [3.4, 4.6], rise: 9, noise: 0.45, rim: 5 },
    landmarks: [['lookout', 3], ['stones', 2]],
    cover: [
      c(model(['log']), 'mid', 2, true), c(model(['log-stack']), 'mid', 2), c(model(['stump']), 'low', 1), c(model(['rock-a', 'rock-c', 'rock-e']), 'mid', 3),
      c(model(['fence-wood']), 'low', 2), c(model(['tent']), 'tall', 1), c(model(['rock-tall-c', 'rock-tall-e']), 'tall', 2), c(model(['rock-b']), 'tall', 1),
    ],
    ridge: [
      c(model(['tree-oak', 'tree-default', 'tree-detailed', 'tree-fat', 'tree-tall'], [0.85, 1.2]), 'tall', 6),
      c(model(['tree-pine-tall-a', 'tree-pine-round-c', 'tree-cone'], [0.85, 1.2]), 'tall', 3),
      c(model(['rock-b', 'rock-d', 'rock-f']), 'mid', 2), c(model(['bush', 'bush-small']), 'low', 2),
    ],
    ridgeDensity: 0.9,
    ridgeModels: [],
    ridgeModelCount: [0, 0],
    houses: [1, 1],
    house: { wall: 'planks', roof: 'planks', floor: 'planks', wallH: 3.2, colors: [0x8a6a45, 0x7d6a55, 0xa07a4f] },
    overlook: { legs: true, body: 'planks', top: 'planks', bodyColor: 0x5c4a3a, topColor: 0x8a6a45 },
    bridge: { surface: 'planks', color: 0x8a6a45, chance: 0.5 },
    path: 'dirt',
  },
  refinery: {
    id: 'refinery',
    label: 'Refinery',
    themes: ['Toxic Works', 'Dusk Yard', 'Training Yard'],
    names: ['Pipeline', 'Cooling Works', 'Sulfur Yard', 'Valve Row', 'Tank Farm', 'Smelter', 'Flare Stack', 'Pump House'],
    indoor: true,
    graph: { plateau: [1, 1.6], mids: [['plaza', 3], ['hill', 1]] },
    terrain: { ridge: [2.2, 3.2], rise: 6, noise: 0.25, rim: 4 },
    landmarks: [['tanks', 2], ['gantry', 2]],
    cover: [
      c(barrels, 'low', 3), c(pallets, 'low', 2), c(lowWall, 'low', 2), c(crate, 'low', 1), c(crateStack, 'mid', 2),
      c(container, 'tall', 2, true), c(containerStack, 'tall', 1, true), c(model(['tank']), 'tall', 1),
    ],
    ridge: [c(model(['tank']), 'tall', 1), c(barrels, 'low', 1), c(container, 'tall', 1)],
    ridgeDensity: 0.25,
    ridgeModels: ['factory-a', 'factory-b', 'factory-c', 'factory-d', 'factory-e', 'factory-f', 'chimney-medium', 'tank-large', 'chimney', 'water-tower'],
    ridgeModelCount: [5, 9],
    houses: [1, 1],
    house: { wall: 'metal', roof: 'metal', floor: 'metal', wallH: 3.6, colors: [0x6b7563, 0x7d8597, 0x5c6b4a] },
    overlook: { legs: true, body: 'metal', top: 'metal', bodyColor: 0x6b7563, topColor: 0x7d8597 },
    bridge: { surface: 'metal', color: 0x7d8597, chance: 0.8 },
    path: 'concrete',
  },
};

/** How often each biome is rolled */
export const BIOME_WEIGHTS: readonly (readonly [BiomeId, number])[] = [['quarry', 1], ['oldtown', 1], ['highlands', 1], ['refinery', 1]];
