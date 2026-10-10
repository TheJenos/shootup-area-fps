import { describe, expect, it } from 'vitest';
import { generateMap, toSpec } from '../index';
import { MAX_ENTRANCES, MIN_LOOPS } from '../routes';
import type { MapSize } from '../spec';

describe('map routes', () => {
  it.each(['s', 'm', 'l'] as MapSize[])('loop round each other, without guess spots (%s)', (size) => {
    for (const seed of ['LOOP1', 'LOOP2', 'LOOP3', 'LOOP4', 'LOOP5']) {
      const g = generateMap(toSpec(seed, size)).graph!;
      expect(g.loops).toBeGreaterThanOrEqual(MIN_LOOPS);
      expect(g.entrances).toBeLessThanOrEqual(MAX_ENTRANCES);
      // Small loops as well as the big ones: every map has a connector between lanes.
      expect(g.connectors.some((c) => c.points.some(([, z]) => Math.abs(z) > 1))).toBe(true);
    }
  });

  it('sometimes cross one route over another', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => `OVER${i}`);
    expect(seeds.some((seed) => generateMap(toSpec(seed, 'l')).graph!.overpasses > 0)).toBe(true);
  });
});
