/**
 * Biomes: what a maze map is built out of. Each has its own ground (deep quarry hills, rolling
 * forest, flat town streets), the cover along its paths, what fills its open areas, the
 * centrepiece of its middle plaza, what walls it in, and the themes it's drawn in.
 */

import type { GroundKind } from '../textures';
import type { EdgeStyle } from './edge';
import type { GroundOptions } from './ground';
import {
  barrels, container, crate, crateStack, lowWall, model, pallets, pillar, sandbags, wall,
  type HutStyle, type Kit, type LandmarkId,
} from './objects';

export type BiomeId = 'quarry' | 'oldtown' | 'highlands' | 'refinery';

export interface Biome {
  id: BiomeId;
  label: string;
  themes: readonly string[];
  /** First half of map names ("Red Cut · Quarry") */
  names: readonly string[];
  /** Mostly roofs and walls: more light from the sky */
  indoor: boolean;
  ground: GroundOptions;
  /** Cover along the paths and round the plaza and the bases */
  cover: readonly (readonly [Kit, number])[];
  /** What fills the open areas, and how much: pieces per 100 m² */
  fill: readonly (readonly [Kit, number])[];
  density: number;
  /** Huts in the open areas, per half */
  huts: [number, number];
  hut: HutStyle;
  landmarks: readonly (readonly [LandmarkId, number])[];
  /** Ground paint for the paths */
  path: GroundKind;
  /** What stands round the map's shape */
  edge: EdgeStyle;
}

const ROCKS = model(['rock-a', 'rock-c', 'rock-e'], [0.7, 0.9], true);
const BIG_ROCKS = model(['rock-b', 'rock-d', 'rock-f'], [0.6, 0.8], true);
const TALL_ROCKS = model(['rock-tall-c', 'rock-tall-e'], [0.9, 1.1], true);
const TREES = model(['tree-oak', 'tree-default', 'tree-detailed', 'tree-fat', 'tree-tall'], [0.85, 1.2], true);
const PINES = model(['tree-pine-tall-a', 'tree-pine-round-c', 'tree-cone'], [0.85, 1.2], true);
const BUSHES = model(['bush', 'bush-small'], [0.9, 1.2], true);

export const BIOMES: Record<BiomeId, Biome> = {
  quarry: {
    id: 'quarry',
    label: 'Quarry',
    themes: ['Dust Bowl', 'Dust Bowl', 'Training Yard'],
    names: ['Red Cut', 'Gravel Pit', 'Dry Wash', 'Ore Ridge', 'Slag Hollow', 'Copper Gulch', 'Deep Cut', 'Sandstone', 'Dust Devil'],
    indoor: false,
    ground: { amp: 4, period: 30 },
    cover: [[crate, 2], [crateStack, 2], [sandbags, 3], [lowWall, 2], [ROCKS, 3], [TALL_ROCKS, 1]],
    fill: [[BIG_ROCKS, 3], [ROCKS, 3], [TALL_ROCKS, 2], [container, 2], [crateStack, 1], [model(['tank']), 1]],
    density: 1,
    huts: [0, 1],
    hut: { wall: 'concrete', roof: 'metal', colors: [0xa88a64, 0x998066, 0xb0703f], wallH: 3 },
    landmarks: [['stones', 2], ['ruin', 1], ['crates', 1]],
    path: 'dirt',
    edge: { kind: 'cliffs', surfaces: ['rock'], colors: [0xb3aa9a, 0xa39a88, 0x9c8f7a], height: [5, 10] },
  },
  oldtown: {
    id: 'oldtown',
    label: 'Old Town',
    themes: ['Training Yard', 'Dusk Yard', 'Frostbite', 'Dust Bowl'],
    names: ['Market Row', 'Bell Square', 'Old Quarter', 'Canal Street', 'Mill Lane', 'Chapel Hill', 'Union Yard', 'Lantern Way'],
    indoor: true,
    ground: { amp: 1.2, period: 40 },
    cover: [[model(['barrier']), 2], [model(['dumpster']), 2], [model(['planter']), 2], [lowWall, 2], [crate, 1], [wall, 1], [pillar, 1]],
    fill: [[model(['tree-street'], [0.9, 1.1], true), 4], [model(['planter']), 2], [model(['dumpster']), 1], [wall, 1], [pillar, 1], [crate, 1]],
    density: 0.8,
    huts: [1, 2],
    hut: { wall: 'plaster', roof: 'concrete', colors: [0xd8cdb8, 0xc9b79a, 0xb8c4c9, 0xd9b8a0, 0xa9b8a0], wallH: 3.2 },
    landmarks: [['tower', 2], ['fountain', 2]],
    path: 'concrete',
    edge: { kind: 'buildings', surfaces: ['plaster', 'plaster', 'brick'], colors: [0xd8cdb8, 0xc9b79a, 0xb8c4c9, 0xd9b8a0, 0xa9b8a0], height: [7, 14] },
  },
  highlands: {
    id: 'highlands',
    label: 'Highlands',
    themes: ['Greenwood', 'Greenwood', 'Frostbite'],
    names: ['Pine Ridge', 'Elk Hollow', 'Misty Fork', 'Bear Creek', 'Fern Gully', 'Stonewatch', 'Cold Spring', 'Owl Bluff'],
    indoor: false,
    ground: { amp: 5, period: 26 },
    cover: [[model(['log']), 2], [model(['log-stack']), 2], [model(['stump']), 1], [ROCKS, 3], [model(['fence-wood']), 2], [TALL_ROCKS, 2]],
    fill: [[TREES, 6], [PINES, 4], [BUSHES, 3], [ROCKS, 2], [model(['stump']), 1], [model(['log']), 1]],
    density: 2,
    huts: [0, 1],
    hut: { wall: 'planks', roof: 'planks', colors: [0x8a6a45, 0x7d6a55, 0xa07a4f], wallH: 3 },
    landmarks: [['stones', 3], ['ruin', 1]],
    path: 'dirt',
    edge: { kind: 'cliffs', surfaces: ['rock'], colors: [0x8d8a80, 0x7f7c72, 0x96907f], height: [5, 11] },
  },
  refinery: {
    id: 'refinery',
    label: 'Refinery',
    themes: ['Toxic Works', 'Dusk Yard', 'Training Yard'],
    names: ['Pipeline', 'Cooling Works', 'Sulfur Yard', 'Valve Row', 'Tank Farm', 'Smelter', 'Flare Stack', 'Pump House'],
    indoor: true,
    ground: { amp: 1.5, period: 36 },
    cover: [[barrels, 3], [pallets, 2], [lowWall, 2], [crate, 1], [crateStack, 2], [container, 1]],
    fill: [[container, 3], [model(['tank']), 2], [barrels, 2], [crateStack, 1], [pallets, 1], [pillar, 1]],
    density: 0.8,
    huts: [1, 1],
    hut: { wall: 'metal', roof: 'metal', colors: [0x6b7563, 0x7d8597, 0x5c6b4a], wallH: 3.4 },
    landmarks: [['tanks', 2], ['crates', 1]],
    path: 'concrete',
    edge: { kind: 'buildings', surfaces: ['metal', 'concrete'], colors: [0x6b7563, 0x7d8597, 0x8a8a86, 0x5c6b4a], height: [7, 15] },
  },
};

/** How often each biome is rolled */
export const BIOME_WEIGHTS: readonly (readonly [BiomeId, number])[] = [['quarry', 1], ['oldtown', 1], ['highlands', 1], ['refinery', 1]];
