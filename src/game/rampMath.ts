/** Ramp maths without three.js, shared by the map generator (which runs in a worker) and ramps.ts. */

/** Which way a ramp rises: its high end is on the + or - side of that axis. */
export type RampDir = 'x+' | 'x-' | 'z+' | 'z-';

/** Mirror a ramp direction across an axis (sx / sz are 1 or -1). */
export function mirrorRampDir(dir: RampDir, sx: number, sz: number): RampDir {
  const axis = dir[0] as 'x' | 'z';
  const sign = dir[1] as '+' | '-';
  const flip = axis === 'x' ? sx < 0 : sz < 0;
  return `${axis}${flip ? (sign === '+' ? '-' : '+') : sign}` as RampDir;
}

/** Height of a ramp's surface at (x, z), clamped to its footprint (x0..x1, z0..z1, rising y0 → y1). */
export function rampHeightAt(dir: RampDir, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, x: number, z: number): number {
  const along = dir[0] === 'x' ? (x - x0) / (x1 - x0) : (z - z0) / (z1 - z0);
  const t = Math.min(1, Math.max(0, dir[1] === '+' ? along : 1 - along));
  return y0 + (y1 - y0) * t;
}
