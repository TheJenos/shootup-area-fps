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
  /**
   * The two halves are designed separately rather than one copied onto the other. Only Capture the
   * Flag needs the halves the same (each team attacks the other's base); every other mode plays on
   * an asymmetric map. Missing means symmetric.
   */
  asym?: boolean;
}

/** Whether a mode's maps are asymmetric (see MapSpec.asym) */
export const asymFor = (base: string): boolean => base !== 'ctf';

export const MAP_SIZES: readonly MapSize[] = ['s', 'm', 'l'];

export const SIZE_LABEL: Record<MapSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };

export const isMapSize = (v: unknown): v is MapSize => v === 's' || v === 'm' || v === 'l';

/** Everything the generator scales with the map size */
export interface SizeParams {
  /**
   * Maze cells across the map, and rows of cells in red's half (row 0, against the middle line, is
   * the middle plaza; the maze fills the rest). Twice as many columns as rows, so the map is square.
   */
  cols: number;
  rows: number;
  /** Cells on the main path, from the base to the middle plaza */
  pathCells: [number, number];
  /** More ways from the base to the middle, besides the main path (each its own way through the maze) */
  lanes: [number, number];
  /** Flank loops per half: reopened maze walls between far-apart parts of the path */
  loops: [number, number];
  /** Dead-end side pockets per half */
  pockets: [number, number];
  /** Open areas grown round the path, per half */
  blobs: [number, number];
  /** Radius of the clearing round each flag */
  baseR: number;
  spawnsPerTeam: number;
  /** Pickup spots per half */
  pickups: number;
  /** Gap between pieces of cover along the path (m) */
  coverGap: number;
  /** Longest straight run of the path (cells) */
  maxRun: number;
  /** Longest walk from flag to flag (s, at walking pace): a map you can't cross quickly is redrawn */
  crossTime: number;
}

export const SIZE_PARAMS: Record<MapSize, SizeParams> = {
  s: {
    cols: 12, rows: 6, pathCells: [9, 13], lanes: [1, 1], loops: [1, 2], pockets: [2, 3], blobs: [6, 8], baseR: 9,
    spawnsPerTeam: 6, pickups: 6, coverGap: 8, maxRun: 4, crossTime: 45,
  },
  m: {
    cols: 16, rows: 8, pathCells: [12, 18], lanes: [1, 2], loops: [2, 3], pockets: [2, 4], blobs: [9, 12], baseR: 10,
    spawnsPerTeam: 8, pickups: 7, coverGap: 9, maxRun: 4, crossTime: 58,
  },
  l: {
    cols: 18, rows: 9, pathCells: [15, 22], lanes: [2, 2], loops: [2, 4], pockets: [3, 5], blobs: [12, 15], baseR: 11,
    spawnsPerTeam: 10, pickups: 9, coverGap: 10, maxRun: 5, crossTime: 70,
  },
};

/** Cache and comparison key */
export const specKey = (s: MapSpec): string => `${s.gen}:${s.size}:${s.seed}${s.asym ? ':asym' : ''}`;
