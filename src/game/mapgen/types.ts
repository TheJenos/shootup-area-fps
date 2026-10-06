/**
 * Map data. Pure data (no three.js, no classes), so it can be built in a worker, posted to the
 * page, drawn as a lobby preview, and every client builds exactly the same map from the room's seed.
 */

import type { BoxSurface, FloorTexture, GroundKind } from '../textures';
import type { RampDir } from '../rampMath';
import type { MapSpec } from './spec';

export type { GroundKind };

/** What footsteps on a surface sound like (the sounds in audio.ts) */
export type StepSurface = 'hard' | 'sand' | 'snow' | 'wood';

/**
 * What a box stops: `all` players and bullets; `move` only players (railings you can shoot
 * through); `shots` only bullets and line of sight (tree canopies you walk under).
 */
export type BoxBlocks = 'all' | 'move' | 'shots';

export interface MapBox {
  x: number;
  z: number;
  /** Size along x / y / z */
  w: number;
  h: number;
  d: number;
  /** Height of the bottom face */
  y: number;
  color: number;
  /** Texture; picked from the piece type and theme, never from the seed's random numbers */
  surface: BoxSurface;
  /** A ramp instead of a box: the top slopes from its bottom up to `y + h` at this side */
  ramp?: RampDir;
  /** Drawn as an upright cylinder (barrels, tanks); collides as an eight-sided shape inside it */
  shape?: 'cylinder';
  /** Not drawn: collision and bullet proxy for a model (MapProp) that supplies the looks */
  visible?: false;
  blocks?: BoxBlocks;
  /** Footstep sound on top of it; otherwise derived from the surface */
  step?: StepSurface;
  /**
   * For a model's collision box: the model's position and turn, and the box's offset and size before
   * turning. Transformed copies turn models rather than reflect them, so the box is re-placed from these.
   */
  pivot?: { x: number; z: number; rot: PropRot; dx: number; dz: number; w: number; d: number };
}

/** Quarter turns, so transformed copies stay exact */
export type PropRot = 0 | 1 | 2 | 3;

/** A model from public/models/props.glb (see propManifest.ts). Visual only: its boxes give the collision. */
export interface MapProp {
  id: string;
  x: number;
  z: number;
  /** Height of its base */
  y: number;
  rot: PropRot;
  scale?: number;
}

/** A flat overlay on a flat pad (a yard, a plaza): drawn just above the ground under its centre. */
export interface GroundPatch {
  x: number;
  z: number;
  w: number;
  d: number;
  kind: GroundKind;
  /** Height of the pad it lies on */
  y: number;
}

export interface MapTheme {
  name: string;
  /** What footsteps on the floor sound like */
  surface: 'hard' | 'sand' | 'snow';
  floorTexture: FloorTexture;
  /** Textures for long walls and for pillars / towers */
  wallSurface: BoxSurface;
  pillarSurface: BoxSurface;
  sky: number;
  hemiSky: number;
  hemiGround: number;
  sun: number;
  floor: string;
  floorLine: string;
  wall: number;
  /** Colors for cover, picked per obstacle */
  palette: number[];
}

/** Ground paint: what each terrain vertex looks like */
export const PAINT = { floor: 0, path: 1, rough: 2, rock: 3 } as const;

/**
 * The ground: heights on a square grid of vertices over the whole map, row by row along z (row 0 at
 * z = -half), each row along x. Each cell is split into two triangles along the diagonal from
 * (x0, z0) to (x1, z1); see heightField.ts, which every user (drawing, physics, checks) goes through.
 * All heights are ≥ 0, and no slope is steeper than you can walk.
 */
export interface Ground {
  /** Cells per side (vertices per side is one more) */
  n: number;
  /** Cell size (m) */
  cell: number;
  half: number;
  /** (n + 1)² heights */
  heights: Float32Array | Float64Array;
  /** (n + 1)² PAINT values */
  paint: Uint8Array;
}

export type Team = 'red' | 'blue';

export interface Spawn {
  x: number;
  y: number;
  z: number;
  /** The team that spawns here in team modes; null = only in free-for-all */
  team: Team | null;
}

export type ZoneKind = 'base' | 'lane' | 'choke' | 'mid' | 'connector' | 'ridge' | 'edge';

export interface PickupSpot {
  x: number;
  y: number;
  z: number;
  tier: 'weapon' | 'ability' | 'any';
}

/**
 * The map's design: how the two bases connect. Kept with the map for the preview, a minimap and
 * debugging. Points are in red's half and the other team's copy (under the map's symmetry).
 */
export interface LaneGraph {
  /** rotate: (x, z) → (-x, -z), mirror: (x, z) → (x, -z) */
  symmetry: 'rotate' | 'mirror';
  lanes: { role: 'main' | 'flank'; width: number; points: [number, number][] }[];
  connectors: { width: number; points: [number, number][] }[];
  chokes: [number, number][];
  overlooks: [number, number][];
  mid: { kind: 'plaza' | 'hill' | 'sunken'; radius: number };
}

export interface MapData {
  spec: MapSpec;
  /** Fingerprint of the content: every client should get the same one for a spec */
  hash: number;
  name: string;
  /** The biome's name, or 'Classic' */
  biome: string;
  theme: MapTheme;
  /** More light from the sky for maps with a lot of roofs */
  indoor: boolean;
  half: number;
  /** null = flat floor at y = 0 */
  ground: Ground | null;
  boxes: MapBox[];
  props: MapProp[];
  patches: GroundPatch[];
  flags: { red: [number, number, number]; blue: [number, number, number] };
  spawns: Spawn[];
  pickupSpots: PickupSpot[];
  graph: LaneGraph | null;
  /** Highest ground along the map's edge: the perimeter walls stand this much taller */
  edge: { height: number };
  /** How the lanes are painted */
  path: GroundKind;
}

/** A group of things placed (and copied into the other half) together. */
export interface Piece {
  boxes: MapBox[];
  props?: MapProp[];
  patches?: GroundPatch[];
}
