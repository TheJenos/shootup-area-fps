import { describe, expect, it } from 'vitest';
import { generateMap, GENERATOR_VERSION } from '../mapgen';
import {
  BOMB_TIME, FREEZE_TIME, JOIN_GRACE, ROUND_TIME, canJoin, SITE_RADIUS, attackersFor, bombHome, bombPlacement, bombSites, decide, newRound, phaseOf,
  pickCarrier, secondsLeft, sidesSwapped, siteAt, type Headcount,
} from '../snd';

const heads = (red: [number, number], blue: [number, number]): Headcount =>
  ({ red: { size: red[0], alive: red[1] }, blue: { size: blue[0], alive: blue[1] } });
const FULL = heads([3, 3], [3, 3]);
const T0 = 1_000_000;
const live = T0 + FREEZE_TIME * 1000 + 1;

describe('search & destroy', () => {
  it('swaps sides after limit - 1 rounds, then alternates in overtime', () => {
    const sides = Array.from({ length: 12 }, (_, n) => attackersFor(n, 5));
    expect(sides).toEqual(['red', 'red', 'red', 'red', 'blue', 'blue', 'blue', 'blue', 'red', 'blue', 'red', 'blue']);
    expect(sidesSwapped(4, 5)).toBe(true);
    expect(sidesSwapped(3, 5)).toBe(false);
    expect(sidesSwapped(0, 5)).toBe(false);
  });

  it('holds everyone during the freeze, then runs the attack clock', () => {
    const s = newRound(0, 5, T0, 'p1', { x: 0, y: 0, z: 0 });
    expect(s.atk).toBe('red');
    expect(phaseOf(s, T0)).toBe('freeze');
    expect(secondsLeft(s, T0)).toBe(FREEZE_TIME);
    expect(phaseOf(s, live)).toBe('live');
    expect(decide(s, T0, heads([3, 0], [3, 0]))).toBeNull();
  });

  it('lets late arrivals play early in a round, not later', () => {
    const s = newRound(0, 5, T0, 'p1', { x: 0, y: 0, z: 0 });
    expect(canJoin(s, T0)).toBe(true);
    expect(canJoin(s, s.at + (JOIN_GRACE - 1) * 1000)).toBe(true);
    expect(canJoin(s, s.at + (JOIN_GRACE + 1) * 1000)).toBe(false);
    expect(canJoin({ ...s, bomb: { x: 0, z: 0, site: 'a', plantedAt: s.at + 1000 } }, s.at + 2000)).toBe(false);
  });

  it('decides rounds by elimination, the clock and the fuse', () => {
    const s = newRound(0, 5, T0, 'p1', { x: 0, y: 0, z: 0 });
    expect(decide(s, live, FULL)).toBeNull();
    expect(decide(s, live, heads([3, 0], [3, 2]))).toEqual({ winner: 'blue', why: 'elim' });
    expect(decide(s, live, heads([3, 1], [3, 0]))).toEqual({ winner: 'red', why: 'elim' });
    expect(decide(s, s.at + ROUND_TIME * 1000, FULL)).toEqual({ winner: 'blue', why: 'time' });
    // A team nobody is on can't be wiped out.
    expect(decide(s, live, heads([2, 2], [0, 0]))).toBeNull();

    // Planted with ten seconds of attack time left.
    const at = s.at + (ROUND_TIME - 10) * 1000;
    const planted = { ...s, bomb: { x: 1, y: 0, z: 2, site: 'a' as const, plantedAt: at, planter: 'p1' } };
    expect(phaseOf(planted, at)).toBe('planted');
    expect(secondsLeft(planted, at)).toBe(BOMB_TIME);
    // Planted: the attack clock no longer matters, nor do the attackers being dead.
    expect(decide(planted, s.at + ROUND_TIME * 1000 + 5, heads([3, 0], [3, 1]))).toBeNull();
    expect(decide(planted, at + 1, heads([3, 1], [3, 0]))).toEqual({ winner: 'red', why: 'elim' });
    expect(decide(planted, at + BOMB_TIME * 1000, FULL)).toEqual({ winner: 'red', why: 'bomb' });
    expect(phaseOf({ ...planted, over: { winner: 'red', why: 'bomb', at: 0 } }, at)).toBe('over');
  });

  it('reads the bomb record', () => {
    expect(bombPlacement({ by: 'p1' })).toEqual({ at: 'carried', carrier: 'p1' });
    expect(bombPlacement({ x: 1, y: 2, z: 3 })).toEqual({ at: 'ground', x: 1, y: 2, z: 3 });
    expect(bombPlacement({ x: 1, z: 3, site: 'b', plantedAt: 5 })).toMatchObject({ at: 'planted', site: 'b', y: 0, planter: null });
    expect(bombPlacement({})).toBeNull();
  });

  it('hands the bomb to an attacker the same way every time, and rotates it', () => {
    expect(pickCarrier([], 0)).toBeNull();
    expect(pickCarrier(['c', 'a', 'b'], 0)).toBe(pickCarrier(['a', 'b', 'c'], 0));
    expect(new Set([0, 1, 2].map((n) => pickCarrier(['a', 'b', 'c'], n))).size).toBeGreaterThan(1);
  });

  it('puts two distinct, mirrored sites in the defenders\' half of generated maps', () => {
    for (const seed of ['alpha', 'harbor', 'dunes7', 'k2']) {
      for (const size of ['s', 'm', 'l'] as const) {
        const map = generateMap({ seed, size, gen: GENERATOR_VERSION });
        for (const team of ['red', 'blue'] as const) {
          const sites = bombSites(map, team);
          const side = team === 'red' ? 1 : -1;
          expect(sites.a.z * side).toBeGreaterThan(0);
          expect(sites.b.z * side).toBeGreaterThan(0);
          expect(Math.hypot(sites.a.x - sites.b.x, sites.a.z - sites.b.z)).toBeGreaterThan(SITE_RADIUS * 2);
          expect(siteAt(sites, sites.a)).toBe('a');
          expect(siteAt(sites, sites.b)).toBe('b');
          const home = bombHome(map, team);
          expect(home.z * side).toBeGreaterThan(0);
        }
      }
    }
  });
});
