import { describe, expect, it } from 'vitest';
import { CLASSIC_SEED, generateMap, isPlayableSpec, mapName, toSpec, GENERATOR_VERSION } from '../index';
import { generateWithReport } from '../generate';
import { mapHalf } from '../layout';
import { SIZE_PARAMS, type MapSize } from '../spec';
import { MAX_SLOPE } from '../ground';
import { tVertex, type Symmetry } from '../symmetry';
import { validateMap } from '../validate';

const SIZES: MapSize[] = ['s', 'm', 'l'];

describe('the classic arena', () => {
  it('never changes', () => {
    const m = generateMap(toSpec(CLASSIC_SEED));
    const sum = Math.round(m.boxes.reduce((s, b) => s + b.x * 3 + b.z * 7 + b.w + b.h + b.d + b.y, 0) * 10) / 10;
    expect(m.boxes.length).toBe(50);
    expect(sum).toBe(406.6);
    expect(m.flags).toEqual({ red: [0, 0, 32], blue: [0, 0, -32] });
    expect(m.half).toBe(40);
  });

  it('is the same whatever the size or version', () => {
    expect(generateMap(toSpec('classic', 'l', 1))).toBe(generateMap(toSpec('CLASSIC', 's')));
    expect(isPlayableSpec(toSpec('classic', 'm', 1))).toBe(true);
  });

  it('passes the map checks', () => {
    expect(validateMap(generateMap(toSpec(CLASSIC_SEED))).problems).toEqual([]);
  });
});

describe('generated maps', () => {
  it.each(SIZES)('are valid and the same every time (%s)', (size) => {
    for (const seed of ['UNIT01', 'UNIT02', 'UNIT03']) {
      const a = generateWithReport(toSpec(seed, size));
      expect(a.report.problems).toEqual([]);
      const b = generateWithReport(toSpec(seed, size));
      expect(b.map.hash).toBe(a.map.hash);
      expect(a.map.half).toBe(mapHalf(SIZE_PARAMS[size]));
    }
  });

  it('are named from the seed alone, the same at every size', () => {
    for (const seed of ['NAME01', 'NAME02']) {
      const name = mapName(seed);
      expect(name).toContain(' · ');
      for (const size of SIZES) expect(generateMap(toSpec(seed, size)).name).toBe(name);
    }
  });

  it('give each team its own spawns, in its own half', () => {
    const m = generateMap(toSpec('SPAWNS', 'm'));
    const red = m.spawns.filter((s) => s.team === 'red');
    const blue = m.spawns.filter((s) => s.team === 'blue');
    expect(red.length).toBe(SIZE_PARAMS.m.spawnsPerTeam);
    expect(blue.length).toBe(red.length);
    expect(red.every((s) => s.z > 0)).toBe(true);
    expect(blue.every((s) => s.z < 0)).toBe(true);
  });

  it('are refused by builds of another version', () => {
    expect(isPlayableSpec({ seed: 'ABC', size: 'm', gen: GENERATOR_VERSION + 1 })).toBe(false);
    expect(isPlayableSpec({ seed: 'ABC', size: 'm', gen: GENERATOR_VERSION })).toBe(true);
  });

  it('fail the checks when something blocks a spawn', () => {
    const m = generateMap(toSpec('BROKEN', 's'));
    const s = m.spawns[0]!;
    const broken = { ...m, boxes: [...m.boxes, { x: s.x, z: s.z, w: 3, h: 3, d: 3, y: s.y, color: 0, surface: 'concrete' as const }] };
    expect(validateMap(broken).ok).toBe(false);
  });
});

describe('ground', () => {
  it('keeps every slope walkable, every height above 0, and both halves the same', () => {
    for (const [seed, size] of [['TERR01', 's'], ['TERR02', 'm'], ['TERR03', 'l']] as const) {
      const m = generateMap(toSpec(seed, size));
      const g = m.ground!;
      const side = g.n + 1;
      for (let iz = 0; iz <= g.n; iz++) {
        for (let ix = 0; ix <= g.n; ix++) {
          const h = g.heights[iz * side + ix]!;
          expect(h).toBeGreaterThanOrEqual(0);
          if (ix < g.n) expect(Math.abs(g.heights[iz * side + ix + 1]! - h)).toBeLessThanOrEqual(MAX_SLOPE + 0.011);
          if (iz < g.n) expect(Math.abs(g.heights[(iz + 1) * side + ix]! - h)).toBeLessThanOrEqual(MAX_SLOPE + 0.011);
          expect(g.heights[tVertex(m.layout!.symmetry as Symmetry, g.n, ix, iz)]).toBe(h);
        }
      }
    }
  });
});

describe('asymmetric maps (every mode but Capture the Flag)', () => {
  const SEEDS = ['ASYM01', 'ASYM02', 'ASYM03', 'ASYM04'];

  it('pass every check, the same for every client, with halves that differ', () => {
    for (const size of ['s', 'm', 'l'] as const) {
      for (const seed of SEEDS) {
        const spec = toSpec(seed, size, GENERATOR_VERSION, true);
        const a = generateWithReport(spec);
        expect(a.report.problems, `${seed} ${size}`).toEqual([]);
        expect(generateWithReport(spec).map.hash).toBe(a.map.hash);
        const m = a.map;
        expect(m.layout!.symmetry).toBe('none');
        expect(m.spawns.filter((s) => s.team === 'red').length).toBe(m.spawns.filter((s) => s.team === 'blue').length);
        // Blue's half isn't red's turned round: the outline differs somewhere.
        const o = m.outline!;
        let differs = false;
        for (let k = 0; k < o.n && !differs; k++) for (let i = 0; i < o.n; i++) {
          if (o.inside[k * o.n + i] !== o.inside[(o.n - 1 - k) * o.n + (o.n - 1 - i)]) { differs = true; break; }
        }
        expect(differs, `${seed} ${size}`).toBe(true);
      }
    }
  });

  it('leave the symmetric map of a seed as it was, and name both the same', () => {
    const sym = generateMap(toSpec('ASYM01', 'm'));
    const asym = generateMap(toSpec('ASYM01', 'm', GENERATOR_VERSION, true));
    expect(sym.layout!.symmetry).not.toBe('none');
    expect(asym.hash).not.toBe(sym.hash);
    expect(asym.name).toBe(sym.name);
  });
});

describe('more than one way to the middle', () => {
  it.each(['s', 'm', 'l'] as const)('every map has a lane besides the main path, apart from it, into the middle at its own column (%s)', (size) => {
    for (const seed of ['LANE01', 'LANE02', 'LANE03', 'LANE04', 'LANE05', 'LANE06']) {
      for (const asym of [false, true]) {
        const g = generateWithReport(toSpec(seed, size, GENERATOR_VERSION, asym));
        const r = g.layout.route;
        expect(g.report.problems, `${seed} ${size}`).toEqual([]);
        expect(r.lanes.length, `${seed} ${size}`).toBeGreaterThanOrEqual(1);
        const main = new Set(r.main);
        const cols = new Set([r.main[r.main.length - 1]! % r.cols]);
        for (const lane of r.lanes) {
          // Its own way: not a cell of the main path or of another lane
          for (const c of lane) expect(main.has(c), `${seed} ${size}`).toBe(false);
          for (const c of lane) main.add(c);
          // Into the middle (row 1, over the band) at a column of its own
          const end = lane[lane.length - 1]!;
          expect(Math.floor(end / r.cols)).toBe(1);
          const col = end % r.cols;
          expect(cols.has(col)).toBe(false);
          cols.add(col);
          expect(col).toBeGreaterThanOrEqual(r.band[0]);
          expect(col).toBeLessThanOrEqual(r.band[1]);
        }
      }
    }
  });
});
