/**
 * What a room's map is: a seed, a size and the generator version that turns them into a map.
 * Only this is synced between clients; each builds the map itself.
 */

export type MapSize = 's' | 'm' | 'l';

export interface MapSpec {
  seed: string;
  size: MapSize;
  /** Generator version (GENERATOR_VERSION); the classic map ignores it, and the size */
  gen: number;
}

export const MAP_SIZES: readonly MapSize[] = ['s', 'm', 'l'];

export const SIZE_LABEL: Record<MapSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };

export const isMapSize = (v: unknown): v is MapSize => v === 's' || v === 'm' || v === 'l';

/** Everything the generator scales with the map size */
export interface SizeParams {
  /** Half the map's width */
  half: number;
  /** Distance of each flag from the middle line */
  baseZ: number;
  /** Radius of the flat plateau around each flag */
  baseR: number;
  /** Chance of three lanes rather than two */
  threeLanes: number;
  laneWidth: { main: number; flank: number };
  chokeWidth: number;
  /** Connectors between neighbouring lanes, per half */
  connectors: [number, number];
  spawnsPerTeam: number;
  /** Longest clear line of sight along a lane (m) */
  laneSight: { main: number; flank: number };
  /** Longest gap between pieces of cover along a lane (m) */
  coverGap: number;
}

export const SIZE_PARAMS: Record<MapSize, SizeParams> = {
  s: {
    half: 40, baseZ: 29, baseR: 9, threeLanes: 0.35, laneWidth: { main: 8, flank: 6 }, chokeWidth: 4.5,
    connectors: [1, 1], spawnsPerTeam: 6, laneSight: { main: 42, flank: 32 }, coverGap: 8,
  },
  m: {
    half: 54, baseZ: 40, baseR: 10, threeLanes: 0.7, laneWidth: { main: 10, flank: 7 }, chokeWidth: 5,
    connectors: [1, 2], spawnsPerTeam: 8, laneSight: { main: 54, flank: 40 }, coverGap: 9,
  },
  l: {
    half: 70, baseZ: 53, baseR: 11, threeLanes: 1, laneWidth: { main: 11, flank: 8 }, chokeWidth: 5.5,
    connectors: [2, 2], spawnsPerTeam: 10, laneSight: { main: 64, flank: 46 }, coverGap: 10,
  },
};

/** Cache and comparison key */
export const specKey = (s: MapSpec): string => `${s.gen}:${s.size}:${s.seed}`;
