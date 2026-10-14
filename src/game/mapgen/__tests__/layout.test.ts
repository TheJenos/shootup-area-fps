import { describe, expect, it } from 'vitest';
import { GENERATOR_VERSION, generateMap, toSpec } from '../index';
import { generateWithReport } from '../generate';
import { TEAM_ACCENT } from '../edge';
import { TAG, insideOutline, tBlock } from '../layout';
import type { MapSize } from '../spec';
import type { Symmetry } from '../symmetry';

const SIZES: MapSize[] = ['s', 'm', 'l'];
const SEEDS = ['SHAPE1', 'SHAPE2', 'SHAPE3', 'SHAPE4', 'SHAPE5', 'SHAPE6'];

describe('map shapes', () => {
  it.each(SIZES)('are never the whole square, and differ from seed to seed (%s)', (size) => {
    const outlines = SEEDS.map((seed) => generateMap(toSpec(seed, size)).outline!);
    for (const o of outlines) {
      const share = o.inside.reduce((s, v) => s + v, 0) / (o.n * o.n);
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.7);
      // The ring round the grid is always outside, so buildings or cliffs stand all round.
      for (let i = 0; i < o.n; i++) {
        for (const c of [i, (o.n - 1) * o.n + i, i * o.n, i * o.n + o.n - 1]) expect(o.inside[c]).toBe(0);
      }
    }
    expect(new Set(outlines.map((o) => o.inside.join(''))).size).toBe(SEEDS.length);
  });

  it.each(SIZES)('keep flags, spawns, pickups and routes inside, and both halves the same (%s)', (size) => {
    for (const seed of SEEDS) {
      const m = generateMap(toSpec(seed, size));
      const o = m.outline!;
      const sym = m.layout!.symmetry as Symmetry;
      for (let k = 0; k < o.n; k++) for (let i = 0; i < o.n; i++) expect(o.inside[k * o.n + i]).toBe(o.inside[tBlock(sym, o.n, i, k)]);
      const inside = (x: number, z: number) => insideOutline(o, m.half, x, z);
      for (const [x, , z] of [m.flags.red, m.flags.blue]) expect(inside(x, z)).toBe(true);
      for (const s of m.spawns) expect(inside(s.x, s.z)).toBe(true);
      for (const p of m.pickupSpots) expect(inside(p.x, p.z)).toBe(true);
      for (const r of m.layout!.routes) for (const [x, z] of r.points) expect(inside(x, z)).toBe(true);
    }
  });

  it('grow open areas that never join two far-apart parts of the route', () => {
    for (const seed of SEEDS) {
      const { layout: l } = generateWithReport(toSpec(seed, 'l'));
      expect(l.blobs.length).toBeGreaterThan(0);
      const { n } = l.outline;
      // Red's half: open blocks that touch are at most a couple of steps apart along the route,
      // unless the maze joins them (corridor to corridor, through a passage or a loop).
      for (let k = n / 2 + 1; k < n - 1; k++) {
        for (let i = 1; i < n - 1; i++) {
          const a = k * n + i;
          if (l.tag[a] !== TAG.blob) continue;
          for (const b of [a + 1, a - 1, a + n, a - n]) {
            if (l.tag[b] === TAG.outside) continue;
            expect(Math.abs(l.step[a]! - l.step[b]!)).toBeLessThanOrEqual(2);
          }
        }
      }
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

  it('have team colors on each side', () => {
    for (const seed of SEEDS) {
      const m = generateMap(toSpec(seed, 'm'));
      const red = m.boxes.filter((b) => b.color === TEAM_ACCENT.red);
      const blue = m.boxes.filter((b) => b.color === TEAM_ACCENT.blue);
      expect(red.length).toBe(blue.length);
      expect(red.every((b) => b.z > 0) && blue.every((b) => b.z < 0)).toBe(true);
    }
  });

  it('fill the open areas with things', () => {
    for (const seed of SEEDS) {
      const { map: m, layout: l } = generateWithReport(toSpec(seed, 'm'));
      const inBlob = (x: number, z: number) => {
        const o = l.outline;
        const t = l.tag[Math.floor((z + o.half) / o.cell) * o.n + Math.floor((x + o.half) / o.cell)];
        return t === TAG.blob;
      };
      const placed = [...m.boxes.filter((b) => b.blocks !== 'shots'), ...m.props].filter((b) => inBlob(b.x, b.z));
      expect(placed.length).toBeGreaterThan(4);
    }
  });
});

describe('the wall round the map', () => {
  /** Outside blocks next to the play area (any of the 8 around) that no wall stands over: holes to see out of */
  const holes = (m: ReturnType<typeof generateMap>) => {
    const o = m.outline!;
    const { n, cell, half } = o;
    const walls = m.boxes.filter((b) => b.h >= 2 && b.visible !== false);
    const out: string[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      if (o.inside[k * n + i]) continue;
      let near = false;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const bi = i + a;
        const bk = k + b;
        if (bi >= 0 && bk >= 0 && bi < n && bk < n && o.inside[bk * n + bi]) near = true;
      }
      if (!near) continue;
      const x = -half + (i + 0.5) * cell;
      const z = -half + (k + 0.5) * cell;
      if (!walls.some((b) => Math.abs(b.x - x) < b.w / 2 && Math.abs(b.z - z) < b.d / 2)) out.push(`${x},${z}`);
    }
    return out;
  };

  it.each(SIZES)('stands all the way round, symmetric or not, the middle line included (%s)', (size) => {
    for (const seed of [...SEEDS, 'GC8B', 'GOG9', 'G16S6', 'GICA', 'GUK8', 'G10O7', 'GD']) {
      for (const asym of [false, true]) {
        expect(holes(generateMap(toSpec(seed, size, GENERATOR_VERSION, asym))), `${seed} ${size} ${asym ? 'asym' : 'sym'}`).toEqual([]);
      }
    }
  });
});
