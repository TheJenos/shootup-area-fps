import { describe, expect, it } from 'vitest';
import { propPiece } from '../kits';
import { tPiece, tPoint, tVertex, type Symmetry } from '../symmetry';
import type { Piece } from '../types';

const SYMS: Symmetry[] = ['rotate', 'mirror'];

describe('symmetry', () => {
  it('maps a point back to itself after two copies', () => {
    for (const sym of SYMS) {
      const [x, z] = tPoint(sym, 3.25, 7.5);
      expect(tPoint(sym, x, z)).toEqual([3.25, 7.5]);
    }
  });

  it('copies a piece (models, off-centre boxes, ramps) back to itself after two copies', () => {
    const piece: Piece = {
      boxes: [
        ...propPiece('water-tower', 10, 20, 1).boxes,
        { x: 4, z: 6, w: 2, h: 1, d: 3, y: 0, color: 0, surface: 'concrete', ramp: 'x+' },
      ],
      props: propPiece('tank', 5, 9, 3).props!,
      patches: [{ x: 1, z: 2, w: 3, d: 4, kind: 'dirt', y: 0 }],
    };
    for (const sym of SYMS) expect(tPiece(sym, tPiece(sym, piece))).toEqual(piece);
  });

  it('turns a model rather than reflecting it, and keeps its collision on it', () => {
    const p = propPiece('tank', 10, 20, 0);
    const t = tPiece('rotate', p);
    expect(t.props![0]).toMatchObject({ x: -10, z: -20, rot: 2 });
    // Each box keeps its offset from the model, turned half way round.
    p.boxes.forEach((b, i) => {
      const c = t.boxes[i]!;
      expect(c.x + 10).toBeCloseTo(-(b.x - 10));
      expect(c.z + 20).toBeCloseTo(-(b.z - 20));
    });
  });

  it('pairs every ground vertex with its copy', () => {
    const n = 8;
    for (const sym of SYMS) {
      for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
        const t = tVertex(sym, n, ix, iz);
        const tx = t % (n + 1);
        const tz = Math.floor(t / (n + 1));
        expect(tVertex(sym, n, tx, tz)).toBe(iz * (n + 1) + ix);
      }
    }
  });
});
