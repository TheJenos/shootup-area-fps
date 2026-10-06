/**
 * Map layout data. Pure data (no Three.js), so the lobby can draw a preview and every
 * client builds exactly the same map from the room's seed.
 */

import type { BoxSurface, FloorTexture, GroundKind } from '../textures';
import type { RampDir } from '../ramps';

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
  /** A ramp instead of a box: the top slopes from the floor up to `h` at this side */
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
   * turning. Mirrored copies turn models rather than reflect them, so the box is re-placed from these
   * (a lopsided model's boxes would otherwise land on the wrong side of it).
   */
  pivot?: { x: number; z: number; rot: PropRot; dx: number; dz: number; w: number; d: number };
}

/** Quarter turns, so mirrored copies stay exact */
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

/** A flat overlay on the floor: streets, sidewalks, lawns, painted zones. */
export interface GroundPatch {
  x: number;
  z: number;
  w: number;
  d: number;
  kind: GroundKind;
}

export type MapStyle = 'arena' | 'town' | 'industrial' | 'outdoor';

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

export interface MapLayout {
  seed: string;
  theme: MapTheme;
  style: MapStyle;
  boxes: MapBox[];
  props: MapProp[];
  ground: GroundPatch[];
  /** [x, z] pairs */
  spawnPoints: [number, number][];
  /** Points just outside each building door, which must be reachable (checked by levelgen/check.ts) */
  doors: [number, number][];
}

/** A group of things placed (and mirrored) together. */
export interface Piece {
  boxes: MapBox[];
  props?: MapProp[];
  ground?: GroundPatch[];
  doors?: [number, number][];
}
