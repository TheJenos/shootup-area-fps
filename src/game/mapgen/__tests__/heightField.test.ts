import { describe, expect, it } from 'vitest';
import { groundGradient, groundHeight, groundRange, rapierHeights } from '../heightField';
import type { Ground } from '../types';

/** A 4 × 4-cell ground with a bump */
function sample(): Ground {
  const n = 4;
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) heights[iz * (n + 1) + ix] = (ix * 7 + iz * 3) % 5 * 0.25;
  return { n, cell: 1, half: 2, heights, paint: new Uint8Array(heights.length) };
}

describe('heightField', () => {
  it('passes through every vertex', () => {
    const g = sample();
    for (let iz = 0; iz <= g.n; iz++) for (let ix = 0; ix <= g.n; ix++) {
      expect(groundHeight(g, -g.half + ix, -g.half + iz)).toBeCloseTo(g.heights[iz * (g.n + 1) + ix]!);
    }
  });

  it('is flat at 0 without a ground', () => {
    expect(groundHeight(null, 3, 4)).toBe(0);
    expect(groundGradient(null, 3, 4)).toEqual([0, 0]);
  });

  it('has the gradient of the triangle under the point', () => {
    const g = sample();
    const e = 1e-4;
    for (const [x, z] of [[-1.7, -1.8], [-1.2, -1.1], [0.3, 0.6], [1.6, 0.2]] as const) {
      const [gx, gz] = groundGradient(g, x, z);
      expect(gx).toBeCloseTo((groundHeight(g, x + e, z) - groundHeight(g, x - e, z)) / (2 * e), 3);
      expect(gz).toBeCloseTo((groundHeight(g, x, z + e) - groundHeight(g, x, z - e)) / (2 * e), 3);
    }
  });

  it('finds the lowest and highest ground under a rectangle', () => {
    const g = sample();
    const r = groundRange(g, -2, 2, -2, 2);
    expect(r.lo).toBe(Math.min(...g.heights));
    expect(r.hi).toBe(Math.max(...g.heights));
  });

  it("lays the heights out as Rapier's column-major matrix (rows along z)", () => {
    const g = sample();
    const out = rapierHeights(g);
    const side = g.n + 1;
    expect(out[2 * side + 1]).toBe(g.heights[1 * side + 2]);
  });
});
