import { describe, expect, it } from 'vitest';
import { NavGrid } from '../../mapgen/navgrid';
import type { MapBox } from '../../mapgen/types';
import { BotNav } from '../nav';

/** A flat 20 m square, with whatever boxes stand on it */
const navOn = (boxes: Partial<MapBox>[]) =>
  new BotNav(new NavGrid(null, 10, boxes.map((b) => ({ y: 0, color: 0, surface: 'crate', ...b }) as MapBox)));

/** A crate 1 m tall and 4 m across, east of the middle: too tall to step onto, low enough to jump */
const CRATE = { x: 5, z: 0, w: 4, d: 4, h: 1 };

describe('bot paths', () => {
  it('only step up, unless jumping is allowed: then a ledge is on the way, with a jump flagged at it', () => {
    const nav = navOn([CRATE]);
    // On top of the crate, from the ground just beside it
    const onTop = () => nav.waypoint(2, 0, 0.1, 5, 1, 0.1);
    const before = onTop();
    // Without jumps the crate's top can't be reached: the way leads to a stand-in on the ground.
    expect(before!.y).toBeLessThan(0.5);

    nav.allowJumps(1.1);
    const after = onTop();
    // Straight up onto it: the waypoint is on the top, the jump flagged right ahead, the cost counted.
    expect(after!.y).toBeCloseTo(1);
    expect(after!.jump).toBe(true);
    expect(after!.dist).toBeLessThan(10);
  });

  it('never jumps diagonally, nor up anything taller than allowed', () => {
    const nav = navOn([{ ...CRATE, h: 1.6 }]);
    nav.allowJumps(1.1);
    const w = nav.waypoint(1.5, 0, 0, 5, 1.6, 0);
    expect(w === null || w.y < 0.5).toBe(true);
  });

  it('goes round a barrier standing in the way, and back through once it has gone', () => {
    const nav = navOn([]);
    const straight = nav.waypoint(-6, 0, 0, 6, 0, 0)!.dist;
    // A wall 6 m wide across the line between them
    const wall = { min: { x: -0.2, y: 0, z: -3 }, max: { x: 0.2, y: 2.2, z: 3 } };
    nav.setBlocks('w1', [wall]);
    const around = nav.waypoint(-6, 0, 0, 6, 0, 0)!.dist;
    expect(around).toBeGreaterThan(straight + 1);
    nav.setBlocks('', []);
    expect(nav.waypoint(-6, 0, 0, 6, 0, 0)!.dist).toBeCloseTo(straight);
  });

  it('never walks across a corner it would catch on: the walk point is a clear straight walk away', () => {
    // An L-shaped way round a wall: from the south-west, round the wall's east end, to the north.
    const nav = navOn([{ x: -2, z: 0, w: 8, d: 1, h: 3 }]);
    const from = { x: -4, z: 2 };
    const w = nav.waypoint(from.x, 0, from.z, -4, 0, -3)!;
    expect(w).not.toBeNull();
    // Every point on the straight line to where it walks keeps a body's width off the wall (x -6..2, z -0.5..0.5).
    for (let f = 0; f <= 1; f += 0.02) {
      const x = from.x + (w.walkX - from.x) * f;
      const z = from.z + (w.walkZ - from.z) * f;
      const dx = Math.max(Math.abs(x - -2) - 4, 0);
      const dz = Math.max(Math.abs(z) - 0.5, 0);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(0.3);
    }
  });

  it('finds its way from right against a wall edge (closer than the grid keeps), and while hopping there', () => {
    // The same wall; the bot pressed against its east end, on the south side, heading north round it.
    const nav = navOn([{ x: -2, z: 0, w: 8, d: 1, h: 3 }]);
    for (const y of [0, 1.1]) {
      const w = nav.waypoint(1.8, y, 0.8, 1.8, 0, -3);
      expect(w).not.toBeNull();
      // Away from the wall's face first (south or east), not straight north into it.
      expect(w!.walkZ > 0.8 || w!.walkX > 1.8).toBe(true);
      expect(w!.dist).toBeLessThan(10);
    }
  });
});
