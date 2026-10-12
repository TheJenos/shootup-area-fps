import { describe, expect, it } from 'vitest';
import { carveMaze, distances, exits, joined } from '../maze';
import { KIND, longestRun, planRoute } from '../route';
import { Rng } from '../rng';
import { SIZE_PARAMS, type MapSize } from '../spec';

const SIZES: MapSize[] = ['s', 'm', 'l'];

describe('the maze', () => {
  it('is a perfect maze: every cell reachable, one way between any two', () => {
    for (const seed of ['MAZE1', 'MAZE2', 'MAZE3']) {
      const m = carveMaze(new Rng(seed), 12, 6);
      let passages = 0;
      for (let c = 0; c < m.w * m.h; c++) passages += exits(m, c).length;
      // Every passage counted from both ends; a spanning tree has cells - 1 of them.
      expect(passages / 2).toBe(m.w * m.h - 1);
      expect([...distances(m, 0)].every((d) => d >= 0)).toBe(true);
    }
  });

  it('is the same for the same seed', () => {
    expect(carveMaze(new Rng('SAME'), 10, 5).open).toEqual(carveMaze(new Rng('SAME'), 10, 5).open);
  });
});

describe('the route', () => {
  it.each(SIZES)('winds from the base to the middle within the size, with loops and pockets (%s)', (size) => {
    const P = SIZE_PARAMS[size];
    for (const seed of ['ROUTE1', 'ROUTE2', 'ROUTE3', 'ROUTE4']) {
      for (const sym of ['rotate', 'mirror'] as const) {
        const r = planRoute(new Rng(seed), sym, P)!;
        expect(r).not.toBeNull();
        const { main } = r;
        expect(main.length).toBeGreaterThanOrEqual(P.pathCells[0]);
        expect(main.length).toBeLessThanOrEqual(P.pathCells[1]);
        expect(longestRun(main)).toBeLessThanOrEqual(P.maxRun);
        // Base in the back rows, crossing in row 1, stepping down into the band.
        expect(Math.floor(main[0]! / P.cols)).toBeGreaterThanOrEqual(P.rows - 2);
        const cross = main[main.length - 1]!;
        expect(Math.floor(cross / P.cols)).toBe(1);
        expect(r.kind[cross - P.cols]).toBe(KIND.band);
        expect(joined(r.maze, cross, cross - P.cols)).toBe(true);
        for (let i = 1; i < main.length; i++) expect(joined(r.maze, main[i - 1]!, main[i]!)).toBe(true);
        expect(r.loops.length).toBeGreaterThanOrEqual(1);
        // Every used cell is on the route.
        for (let c = 0; c < r.kind.length; c++) if (r.kind[c] !== KIND.none) expect(r.label[c]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
