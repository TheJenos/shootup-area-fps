import { describe, expect, it } from 'vitest';
import { Rng } from '../rng';

/** The generator's RNG before the rework (levelgen/core.ts rngFor), kept here to pin the sequence. */
function legacy(seed: string): () => number {
  let a = 2166136261;
  for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Rng', () => {
  it('rolls the same numbers as the original generator', () => {
    for (const seed of ['CLASSIC', 'ABC123', 'ZZZZZZ', '']) {
      const a = new Rng(seed);
      const b = legacy(seed);
      for (let i = 0; i < 16; i++) expect(a.next()).toBe(b());
    }
  });

  it('pins the first numbers of a seed', () => {
    const r = new Rng('PINNED');
    expect([r.next(), r.next(), r.next()].map((v) => Math.round(v * 1e9))).toMatchSnapshot();
  });

  it('forks independent, repeatable streams', () => {
    const a = new Rng('S').fork('terrain');
    const b = new Rng('S').fork('terrain');
    const c = new Rng('S').fork('graph');
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });

  it('shuffles into a permutation, the same way every time', () => {
    const one = new Rng('shuffle').shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const two = new Rng('shuffle').shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(one).toEqual(two);
    expect([...one].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps ints, ranges and picks in bounds', () => {
    const r = new Rng('bounds');
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      const x = r.range(-2, 2);
      expect(x).toBeGreaterThanOrEqual(-2);
      expect(x).toBeLessThan(2);
      expect(['a', 'b']).toContain(r.pick(['a', 'b']));
    }
  });
});
