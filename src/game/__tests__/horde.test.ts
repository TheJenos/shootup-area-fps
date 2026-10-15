import { describe, expect, it } from 'vitest';
import {
  BREAK, FIRST_BREAK, MAX_ALIVE, SPAWN_MIN, maxAlive, newWave, phaseOf, pickSpawn, refereeCall, spawnInterval, waveSize, zombieFor, zombieHp, zombieName,
} from '../horde';
import { MAX_RECORD_HP } from '../zombies';
import { baseRules, goalOf, normalizeRules, PRESETS } from '../rules';
import { MODES, teamInfo } from '../modes';
import { anchorFor, pickPrey, ANCHOR_SLACK } from '../bot/zombie';

const T0 = 1_000_000;

describe('horde', () => {
  it('breaks before each wave, then fights it until its last zombie is down', () => {
    const w = newWave(1, 2, T0);
    expect(w).toMatchObject({ wave: 1, at: T0 + FIRST_BREAK * 1000 });
    expect(newWave(4, 2, T0).at).toBe(T0 + BREAK * 1000);
    expect(phaseOf(undefined, T0)).toBe('break');
    expect(phaseOf(w, T0)).toBe('break');
    expect(phaseOf(w, w.at)).toBe('live');
    expect(phaseOf({ ...w, left: 0 }, w.at + 1)).toBe('cleared');
  });

  it('grows each wave, and with the number of survivors, within limits', () => {
    expect(waveSize(1, 1)).toBe(6);
    expect(waveSize(2, 1)).toBeGreaterThan(waveSize(1, 1));
    expect(waveSize(5, 4)).toBeGreaterThan(waveSize(5, 1));
    expect(waveSize(200, 16)).toBeLessThanOrEqual(150);
    expect(maxAlive(1)).toBeLessThan(maxAlive(3));
    expect(maxAlive(16)).toBe(MAX_ALIVE);
    expect(spawnInterval(1)).toBeGreaterThan(spawnInterval(10));
    expect(spawnInterval(100)).toBeGreaterThanOrEqual(0.6);
  });

  it('makes zombies tougher each wave, never past what a player record may hold', () => {
    expect(zombieHp(2)).toBeGreaterThan(zombieHp(1));
    expect(zombieHp(100)).toBe(MAX_RECORD_HP);
    const early = Array.from({ length: 50 }, () => zombieFor(1));
    expect(early.every((z) => !z.runner)).toBe(true);
    let n = 0;
    const rand = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
    const late = Array.from({ length: 200 }, () => zombieFor(10, rand));
    expect(late.some((z) => z.runner)).toBe(true);
    expect(late.some((z) => !z.runner)).toBe(true);
    expect(zombieFor(1).claw).toBeLessThan(zombieFor(10).claw);
    expect(zombieFor(100).claw).toBeLessThanOrEqual(50);
    expect(zombieName(true)).toBe('Runner');
    expect(zombieName(false).length).toBeLessThanOrEqual(16);
  });

  it('sets the first wave up, moves on once one is cleared, and calls the round', () => {
    const live = { wave: 3, at: T0, left: 4 };
    expect(refereeCall(undefined, T0, { size: 2, alive: 2 }, 10)).toBe('first');
    expect(refereeCall(undefined, T0, { size: 0, alive: 0 }, 10)).toBeNull();
    expect(refereeCall(live, T0 + 1, { size: 2, alive: 1 }, 10)).toBeNull();
    expect(refereeCall({ ...live, left: 0 }, T0 + 1, { size: 2, alive: 1 }, 10)).toBe('next');
    expect(refereeCall({ ...live, wave: 10, left: 0 }, T0 + 1, { size: 2, alive: 1 }, 10)).toBe('won');
    expect(refereeCall(live, T0 + 1, { size: 2, alive: 0 }, 10)).toBe('overrun');
    // Everybody down in a break isn't possible (the break brings them back), and nobody playing isn't a loss.
    expect(refereeCall({ ...live, at: T0 + 5000 }, T0, { size: 2, alive: 0 }, 10)).toBeNull();
    expect(refereeCall(live, T0 + 1, { size: 0, alive: 0 }, 10)).toBeNull();
  });

  it('brings zombies on well away from every survivor, preferring the nearer of those spots', () => {
    const spots = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }, { x: 90, z: 0 }];
    const survivors = [{ x: 0, z: 0 }];
    for (let k = 0; k < 20; k++) expect(pickSpawn(spots, survivors)).toBe(2);
    // Nowhere far enough: the furthest.
    expect(pickSpawn([{ x: 1, z: 0 }, { x: 5, z: 0 }], survivors)).toBe(1);
    expect(pickSpawn([], survivors)).toBe(-1);
    expect(SPAWN_MIN).toBeGreaterThan(10);
  });

  it('is a team mode of its own, with waves to win as its limit', () => {
    const r = baseRules('hrd');
    expect(r.limit).toBe(10);
    expect(normalizeRules({ ...r, limit: 99 }).limit).toBe(30);
    expect(normalizeRules({ ...r, limit: 1 }).limit).toBe(3);
    expect(MODES.hrd.teams && !MODES.hrd.chooseTeams).toBe(true);
    expect(teamInfo('red', 'hrd').name).toBe('Zombies');
    expect(goalOf(r)).toMatch(/wave/i);
    expect(PRESETS.some((p) => p.id === 'hrd')).toBe(true);
  });
});

describe('zombie bots', () => {
  it('stick with their prey unless someone else is clearly nearer', () => {
    const self = { x: 0, y: 0, z: 0 };
    const a = { id: 'a', x: 10, y: 0, z: 0 };
    const b = { id: 'b', x: 9, y: 0, z: 0 };
    expect(pickPrey(self, [a, b], null)?.id).toBe('b');
    expect(pickPrey(self, [a, b], 'a')?.id).toBe('a');
    expect(pickPrey(self, [a, { ...b, x: 5 }], 'a')?.id).toBe('b');
    expect(pickPrey(self, [], 'a')).toBeNull();
  });

  it('share one route per survivor until they have really moved', () => {
    const anchors = new Map();
    const first = anchorFor(anchors, { id: 'a', x: 0, y: 0, z: 0 });
    expect(anchorFor(anchors, { id: 'a', x: ANCHOR_SLACK - 0.5, y: 0, z: 0 })).toBe(first);
    const moved = anchorFor(anchors, { id: 'a', x: ANCHOR_SLACK + 0.5, y: 0, z: 0 });
    expect(moved).not.toBe(first);
    expect(moved.x).toBe(ANCHOR_SLACK + 0.5);
  });
});
