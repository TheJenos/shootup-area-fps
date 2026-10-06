import { describe, expect, it } from 'vitest';
import { CLASSIC_SEED, generateMap, isPlayableSpec, mapName, toSpec, GENERATOR_VERSION } from '../index';
import { generateWithReport, metaFor } from '../generate';
import { buildGraph } from '../graph';
import { Rng } from '../rng';
import { SIZE_PARAMS, type MapSize } from '../spec';
import { MAX_SLOPE, Terrain } from '../terrain';
import { tVertex } from '../symmetry';
import { validateMap } from '../validate';
import { BIOMES } from '../biomes';

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
      expect(a.map.half).toBe(SIZE_PARAMS[size].half);
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

describe('terrain', () => {
  it('keeps every slope walkable, every height above 0, and both halves the same', () => {
    for (const [seed, size] of [['TERR01', 's'], ['TERR02', 'm'], ['TERR03', 'l']] as const) {
      const meta = metaFor(seed);
      let graph = null;
      for (let i = 0; i < 10 && !graph; i++) graph = buildGraph(new Rng(seed).fork(`g${i}`), i % 2 ? 'mirror' : 'rotate', SIZE_PARAMS[size], meta.biome.graph);
      expect(graph).not.toBeNull();
      const t = new Terrain(graph!, new Rng(seed), BIOMES[meta.biome.id].terrain);
      const { n, side, heights } = t;
      for (let iz = 0; iz <= n; iz++) {
        for (let ix = 0; ix <= n; ix++) {
          const h = heights[iz * side + ix]!;
          expect(h).toBeGreaterThanOrEqual(0);
          if (ix < n) expect(Math.abs(heights[iz * side + ix + 1]! - h)).toBeLessThanOrEqual(MAX_SLOPE + 0.011);
          if (iz < n) expect(Math.abs(heights[(iz + 1) * side + ix]! - h)).toBeLessThanOrEqual(MAX_SLOPE + 0.011);
          expect(heights[tVertex(graph!.sym, n, ix, iz)]).toBe(h);
        }
      }
      // The pinned heights (plateaus, lane floors) are kept, bar a few where two lanes' floors meet
      // (near the bases) and disagree by more than the slope allows: the slope limit wins there.
      let kept = 0;
      let pinned = 0;
      for (let v = 0; v < t.pin.length; v++) {
        const p = t.pin[v]!;
        if (Number.isNaN(p)) continue;
        pinned++;
        if (Math.abs(heights[v]! - p) < 0.02) kept++;
      }
      expect(kept / pinned).toBeGreaterThan(0.95);
    }
  });
});
