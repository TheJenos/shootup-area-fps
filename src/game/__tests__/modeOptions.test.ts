import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRESETS, baseRules, normalizeRules, sameMode, tweaks } from '../rules';
import { hitPlayer } from '../bot/hitscan';

describe('custom mode options: pickup spawn rate, recoil, head size', () => {
  it('default to the usual game, and are kept to their ranges in quarter steps', () => {
    expect(baseRules('ffa')).toMatchObject({ pickupRate: 1, recoil: 1, headSize: 1 });
    expect(normalizeRules({ ...baseRules('ffa'), pickupRate: 9, recoil: -1, headSize: 0.4 })).toMatchObject({ pickupRate: 3, recoil: 0, headSize: 1 });
    expect(normalizeRules({ ...baseRules('ffa'), pickupRate: 1.6, recoil: 0.3, headSize: 2.1 })).toMatchObject({ pickupRate: 1.5, recoil: 0.25, headSize: 2 });
    // A room or saved mode from before these existed plays as it always did.
    const old: Record<string, unknown> = { ...baseRules('tdm') };
    delete old.pickupRate;
    delete old.recoil;
    delete old.headSize;
    expect(sameMode(normalizeRules(old), baseRules('tdm'))).toBe(true);
  });

  it('say what they change in the mode description', () => {
    expect(tweaks({ ...baseRules('ffa'), headSize: 2.5 })).toContain('Big heads (250%)');
    expect(tweaks({ ...baseRules('ffa'), recoil: 0 })).toContain('No recoil');
    expect(tweaks({ ...baseRules('ffa'), recoil: 1.5 })).toContain('150% recoil');
    expect(tweaks({ ...baseRules('ffa'), pickupRate: 2 })).toContain('2× pickup spawns');
    // No pickups at all: their rate says nothing.
    expect(tweaks({ ...baseRules('ffa'), pickupRate: 2, guns: false, ammo: false, abilities: false })).not.toContain('2× pickup spawns');
    expect(PRESETS.find((p) => p.id === 'big-heads')?.rules.headSize).toBe(2.5);
  });

  it('are ones the database accepts, within the same ranges', () => {
    const rules = readFileSync(new URL('../../../database.rules.json', import.meta.url), 'utf8');
    expect(rules).toContain('"pickupRate": {\n            ".validate": "newData.isNumber() && newData.val() >= 0.25 && newData.val() <= 3"');
    expect(rules).toContain('"recoil": {\n            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 2"');
    expect(rules).toContain('"headSize": {\n            ".validate": "newData.isNumber() && newData.val() >= 1 && newData.val() <= 3"');
  });
});

describe('bot bullets and big heads', () => {
  const target = { id: 'p', x: 0, y: 0, z: -10, stance: 'stand' as const };
  // Level with the forehead's top edge, a little above where a normal head ends (centre 1.62, r 0.17).
  const ray = { ox: 0, oy: 1.85, oz: 0, dx: 0, dy: 0, dz: -1 };

  it('miss over a normal head, and find a big one', () => {
    expect(hitPlayer(ray, target, 50)).toBeNull();
    expect(hitPlayer(ray, target, 50, 2)).toMatchObject({ head: true });
  });

  it('still hit the body below a big head', () => {
    const chest = { ...ray, oy: 1.1 };
    expect(hitPlayer(chest, target, 50, 2.5)).toMatchObject({ head: false });
  });
});
