/**
 * Sightlines: what can see what, from head height (the bots' senses use it).
 *
 * A ray is blocked by the ground or by anything solid standing on it (boxes that stop bullets,
 * starting near the ground; things overhead such as bridges and tree canopies are treated as
 * see-through, which errs on the side of reporting a sightline).
 */

import { groundHeight } from './heightField';
import { dist } from './dmath';
import type { Ground, MapBox } from './types';

export const EYE = 1.55;
const STEP = 0.7;

export class Occlusion {
  readonly n: number;
  readonly half: number;
  /** Top of the ground or the highest solid thing standing on each 1 m cell */
  readonly top: Float32Array;

  constructor(readonly ground: Ground | null, half: number, boxes: readonly MapBox[]) {
    this.half = half;
    const n = Math.round(half * 2);
    this.n = n;
    this.top = new Float32Array(n * n);
    // The ground: the highest corner of each cell (errs toward blocking, by a few centimetres).
    if (ground && ground.n === n && ground.cell === 1) {
      const side = n + 1;
      const h = ground.heights;
      for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const v = k * side + i;
        this.top[k * n + i] = Math.max(h[v]!, h[v + 1]!, h[v + side]!, h[v + side + 1]!);
      }
    } else if (ground) {
      for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) this.top[k * n + i] = groundHeight(ground, i + 0.5 - half, k + 0.5 - half);
    }
    this.add(boxes);
  }

  add(boxes: readonly MapBox[]): void {
    const { n, half } = this;
    for (const b of boxes) {
      if (b.blocks === 'move') continue;
      const under = groundHeight(this.ground, b.x, b.z);
      if (b.y > under + 1.2) continue;
      const top = b.ramp ? b.y + b.h / 2 : b.y + b.h;
      const i0 = Math.max(0, Math.floor(b.x - b.w / 2 + half));
      const i1 = Math.min(n - 1, Math.floor(b.x + b.w / 2 + half));
      const k0 = Math.max(0, Math.floor(b.z - b.d / 2 + half));
      const k1 = Math.min(n - 1, Math.floor(b.z + b.d / 2 + half));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const c = k * n + i;
        if (top > this.top[c]!) this.top[c] = top;
      }
    }
  }

  /** Whether a ray from a to b (absolute heights) gets through (the first and last metre don't count) */
  visible(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const l = dist(ax, az, bx, bz);
    if (l < 2) return true;
    const { n, half, top } = this;
    const steps = Math.floor(l / STEP);
    const dx = (bx - ax) / l;
    const dz = (bz - az) / l;
    const dy = (by - ay) / l;
    for (let s = 2; s < steps - 1; s++) {
      const t = s * STEP;
      const i = Math.floor(ax + dx * t + half);
      const k = Math.floor(az + dz * t + half);
      if (i >= 0 && k >= 0 && i < n && k < n && ay + dy * t <= top[k * n + i]!) return false;
    }
    return true;
  }

  /** Eye-to-eye sight between two standing spots */
  sees(ax: number, az: number, bx: number, bz: number): boolean {
    return this.visible(ax, groundHeight(this.ground, ax, az) + EYE, az, bx, groundHeight(this.ground, bx, bz) + EYE, bz);
  }

  /** Whether a spot is inside something (not somewhere to stand) */
  blocked(x: number, z: number): boolean {
    const i = Math.floor(x + this.half);
    const k = Math.floor(z + this.half);
    if (i < 0 || k < 0 || i >= this.n || k >= this.n) return true;
    return this.top[k * this.n + i]! > groundHeight(this.ground, x, z) + 0.5;
  }
}
