/**
 * The player's body, shared by the controller (player.ts) and the map generator's walk checks
 * (mapgen/navgrid.ts), so a map is only called walkable if the player can really walk it.
 * Pure numbers: no three.js, so the generator can run in a worker.
 */

/** Half the body's width (m) */
export const RADIUS = 0.35;
/** Standing height (m) */
export const HEIGHT = 1.75;
/** Eye height standing (m) */
export const EYE_HEIGHT = 1.6;
/** Highest ledge (or ramp side) you can walk straight onto without jumping */
export const STEP_UP = 0.7;
/** Steepest slope you can walk up (radians; ramps and terrain are well under this) */
export const MAX_SLOPE = (55 * Math.PI) / 180;
/** Anything starting this high above your feet is walked under */
export const HEADROOM = 1.9;
