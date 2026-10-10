import { describe, expect, it } from 'vitest';
import { generateMap, toSpec } from '../index';
import { TEAM_ACCENT, insideOutline, insideShare, type Outline } from '../outline';
import { SIZE_PARAMS, type MapSize } from '../spec';

const SIZES: MapSize[] = ['s', 'm', 'l'];
const SEEDS = ['SHAPE1', 'SHAPE2', 'SHAPE3', 'SHAPE4', 'SHAPE5', 'SHAPE6'];

/** Outside blocks the grid's edge can't reach: solid blocks in the middle of the map */
function enclosed(o: Outline): number {
  const { n, inside } = o;
  const seen = new Uint8Array(n * n);
  const queue = [0];
  seen[0] = 1;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    const i = c % n;
    const k = (c - i) / n;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + a;
      const nk = k + b;
      if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
      const d = nk * n + ni;
      if (seen[d] || inside[d]) continue;
      seen[d] = 1;
      queue.push(d);
    }
  }
  let count = 0;
  for (let c = 0; c < n * n; c++) if (!inside[c] && !seen[c]) count++;
  return count;
}

describe('map shapes', () => {
  it.each(SIZES)('are never the whole square, and differ from seed to seed (%s)', (size) => {
    const outlines = SEEDS.map((seed) => generateMap(toSpec(seed, size)).outline!);
    for (const o of outlines) {
      const share = insideShare(o, SIZE_PARAMS[size].half);
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.86);
      // The ring round the grid is always outside, so buildings or cliffs stand all round.
      for (let i = 0; i < o.n; i++) {
        for (const c of [i, (o.n - 1) * o.n + i, i * o.n, i * o.n + o.n - 1]) expect(o.inside[c]).toBe(0);
      }
    }
    expect(new Set(outlines.map((o) => o.inside.join(''))).size).toBe(SEEDS.length);
  });

  it.each(SIZES)('keep flags, spawns, pickups and lanes inside, and both halves the same (%s)', (size) => {
    for (const seed of SEEDS) {
      const m = generateMap(toSpec(seed, size));
      const o = m.outline!;
      const sym = m.graph!.symmetry;
      for (let k = 0; k < o.n; k++) {
        for (let i = 0; i < o.n; i++) {
          const t = sym === 'rotate' ? (o.n - 1 - k) * o.n + (o.n - 1 - i) : (o.n - 1 - k) * o.n + i;
          expect(o.inside[k * o.n + i]).toBe(o.inside[t]);
        }
      }
      const inside = (x: number, z: number) => insideOutline(o, m.half, x, z);
      for (const [x, , z] of [m.flags.red, m.flags.blue]) expect(inside(x, z)).toBe(true);
      for (const s of m.spawns) expect(inside(s.x, s.z)).toBe(true);
      for (const p of m.pickupSpots) expect(inside(p.x, p.z)).toBe(true);
      for (const l of m.graph!.lanes) for (const [x, z] of l.points) expect(inside(x, z)).toBe(true);
    }
  });

  it('are walled in by buildings or cliffs, not a thin wall', () => {
    for (const seed of SEEDS) {
      const m = generateMap(toSpec(seed, 'm'));
      const out = m.boxes.filter((b) => !insideOutline(m.outline, m.half, b.x, b.z));
      expect(out.length).toBeGreaterThan(20);
      expect(out.some((b) => b.surface === 'perimeter')).toBe(false);
    }
  });

  it('have a different skyline landmark behind each half, and team colors on each side', () => {
    for (const seed of SEEDS) {
      const m = generateMap(toSpec(seed, 'm'));
      const tall = m.boxes.filter((b) => b.y + b.h > m.edge.height + 22 && !insideOutline(m.outline, m.half, b.x, b.z));
      expect(tall.some((b) => b.z > 0)).toBe(true);
      expect(tall.some((b) => b.z < 0)).toBe(true);
      const red = m.boxes.filter((b) => b.color === TEAM_ACCENT.red);
      const blue = m.boxes.filter((b) => b.color === TEAM_ACCENT.blue);
      expect(red.length).toBe(blue.length);
      expect(red.every((b) => b.z > 0) && blue.every((b) => b.z < 0)).toBe(true);
    }
  });

  it('sometimes leave a solid block in the middle of the map', () => {
    const seeds = Array.from({ length: 24 }, (_, i) => `ISLE${i}`);
    const withBlock = seeds.filter((seed) => enclosed(generateMap(toSpec(seed, 'l')).outline!) > 0).length;
    expect(withBlock).toBeGreaterThan(0);
  });
});
