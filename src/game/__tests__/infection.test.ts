import { describe, expect, it } from 'vitest';
import {
  INFECT_DELAY, PICK_GRACE, SURVIVORS, ZOMBIES, alphaCount, deathInfects, infectAt, isAlpha, phaseOf, pickAlphas, refereeCall, timeUpWinner,
} from '../infection';
import { MAX_RECORD_HP, zombieHealth } from '../zombies';
import { baseRules, goalOf, normalizeRules, PRESETS } from '../rules';
import { teamInfo } from '../modes';
import type { InfRecord } from '../../types';

const T0 = 1_000_000;
const turned = infectAt(T0);
const rec = (ids: string[], t = turned): InfRecord => ({ alpha: Object.fromEntries(ids.map((id) => [id, true])), t });

describe('infection', () => {
  it('gives survivors a head start, then waits for someone to infect', () => {
    expect(phaseOf(undefined, T0, T0)).toBe('countdown');
    expect(phaseOf(undefined, T0, T0 + (INFECT_DELAY - 1) * 1000)).toBe('countdown');
    expect(phaseOf(undefined, T0, turned)).toBe('waiting');
    expect(phaseOf(rec(['a']), T0, turned)).toBe('live');
    // An empty pick (Firebase drops empty objects anyway) isn't an infection.
    expect(phaseOf({ alpha: {}, t: turned }, T0, turned)).toBe('waiting');
  });

  it('picks the first zombies once the head start is over, and only with someone to chase', () => {
    expect(refereeCall(undefined, T0, T0 + 1000, { survivors: 6, zombies: 0 })).toBeNull();
    expect(refereeCall(undefined, T0, turned, { survivors: 6, zombies: 0 })).toBe('pick');
    expect(refereeCall(undefined, T0, turned, { survivors: 1, zombies: 0 })).toBeNull();
  });

  it('picks again when the first zombies never turned', () => {
    const r = rec(['gone']);
    expect(refereeCall(r, T0, turned + 1000, { survivors: 4, zombies: 0 })).toBeNull();
    expect(refereeCall(r, T0, turned + PICK_GRACE * 1000, { survivors: 4, zombies: 0 })).toBe('pick');
  });

  it('ends the round when the last survivor falls', () => {
    const r = rec(['a']);
    expect(refereeCall(r, T0, turned + 5000, { survivors: 2, zombies: 3 })).toBeNull();
    expect(refereeCall(r, T0, turned + 5000, { survivors: 0, zombies: 5 })).toBe('zombies-win');
    // Everybody left: nobody wins by default.
    expect(refereeCall(r, T0, turned + 5000, { survivors: 0, zombies: 0 })).toBeNull();
  });

  it('gives the round to the survivors if anyone is standing at the buzzer', () => {
    expect(timeUpWinner({ survivors: 1, zombies: 7 })).toBe(SURVIVORS);
    expect(timeUpWinner({ survivors: 0, zombies: 7 })).toBe(ZOMBIES);
  });

  it('only infects the dead once the zombies are out', () => {
    expect(deathInfects(undefined, T0, T0 + 1000)).toBe(false);
    expect(deathInfects(rec(['a']), T0, turned + 1000)).toBe(true);
  });

  it('never turns everyone at the start', () => {
    expect(alphaCount(1, 8)).toBe(1);
    expect(alphaCount(3, 8)).toBe(3);
    expect(alphaCount(4, 3)).toBe(2);
    expect(alphaCount(1, 1)).toBe(0);
  });

  it('picks distinct players', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const picked = pickAlphas(ids, 3, rand);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    for (const id of picked) expect(ids).toContain(id);
    expect(pickAlphas(ids, 9)).toHaveLength(5);
    expect(isAlpha(rec(picked), picked[0]!)).toBe(true);
    expect(isAlpha(rec(picked), 'nobody')).toBe(false);
  });

  it('keeps zombie health within what a player record may hold', () => {
    expect(zombieHealth(100, false)).toBe(150);
    expect(zombieHealth(100, true)).toBe(200);
    expect(zombieHealth(200, true)).toBe(MAX_RECORD_HP);
    expect(zombieHealth(25, false)).toBeGreaterThan(25);
  });

  it('is a team mode with named sides, and its own rules', () => {
    expect(teamInfo('red', 'inf').name).toBe('Zombies');
    expect(teamInfo('blue', 'inf').name).toBe('Survivors');
    expect(teamInfo('red', 'tdm').name).toBe('Red');
    const r = baseRules('inf');
    expect(r.limit).toBe(1);
    expect(normalizeRules({ ...r, limit: 9 }).limit).toBe(4);
    // Gun Game is free-for-all only.
    expect(normalizeRules({ ...r, loadout: 'gungame' }).loadout).toBe('standard');
    expect(goalOf(r)).toMatch(/zombie/i);
    expect(PRESETS.filter((p) => p.rules.base === 'inf').length).toBeGreaterThanOrEqual(2);
  });
});
