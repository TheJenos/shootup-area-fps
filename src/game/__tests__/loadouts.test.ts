import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOADOUTS, PRESETS, ROULETTE_GUNS, baseRules, goalOf, loadoutGuns, normalizeRules, rouletteGun, tweaks } from '../rules';
import { kitGunFor } from '../bot/gear';

describe('loadouts', () => {
  it('every loadout is one the database accepts', () => {
    const rules = readFileSync(new URL('../../../database.rules.json', import.meta.url), 'utf8');
    const check = rules.match(/"loadout":\s*{\s*".validate":\s*"([^"]+)"/)?.[1] ?? '';
    for (const l of LOADOUTS) expect(check, l.value).toContain(`'${l.value}'`);
  });

  it('two-gun loadouts and Roulette survive normalizing, with pickups switched off', () => {
    for (const loadout of ['sniper-deagle', 'rifle-shotgun', 'random'] as const) {
      const r = normalizeRules({ ...baseRules('tdm'), loadout, guns: true, ammo: true });
      expect(r.loadout).toBe(loadout);
      expect(r.guns).toBe(false);
      expect(r.ammo).toBe(false);
    }
    expect(normalizeRules({ ...baseRules('ffa'), loadout: 'bazooka' }).loadout).toBe('standard');
  });

  it('names the guns each loadout hands out, in slot order', () => {
    expect(loadoutGuns('standard')).toEqual([]);
    expect(loadoutGuns('sniper')).toEqual(['sniper']);
    expect(loadoutGuns('sniper-deagle')).toEqual(['sniper', 'deagle']);
    expect(loadoutGuns('random')).toEqual([]);
    for (const l of LOADOUTS) expect(l.guns.length).toBeLessThanOrEqual(2);
  });

  it('says what the loadout is in the mode description', () => {
    expect(tweaks({ ...baseRules('ffa'), loadout: 'rifle-shotgun' })).toContain('Rifle + Shotgun, endless ammo');
    expect(tweaks({ ...baseRules('inf'), loadout: 'sniper-deagle' })).toContain('Survivors: Sniper + Deagle, endless ammo');
    expect(tweaks({ ...baseRules('ffa'), loadout: 'random' })).toContain('A random gun each life, endless ammo');
    expect(tweaks({ ...baseRules('ffa'), loadout: 'deagle' })).toContain('Deagles only, endless ammo');
    expect(goalOf(PRESETS.find((p) => p.id === 'quickscope')!.rules)).toContain('Sniper + Deagle');
  });

  it('Roulette only spins real guns', () => {
    for (let i = 0; i < 50; i++) expect(ROULETTE_GUNS).toContain(rouletteGun());
  });
});

describe('bots with two guns', () => {
  it('hold whichever suits the distance', () => {
    expect(kitGunFor(['sniper', 'deagle'], 6, 'sniper')).toBe('deagle');
    expect(kitGunFor(['sniper', 'deagle'], 60, 'deagle')).toBe('sniper');
    expect(kitGunFor(['rifle', 'shotgun'], 5, 'rifle')).toBe('shotgun');
    expect(kitGunFor(['rifle', 'shotgun'], 20, 'shotgun')).toBe('rifle');
    expect(kitGunFor(['rifle', 'sniper'], 45, 'rifle')).toBe('sniper');
  });

  it('keep the gun in hand when nobody is known, or when both suit', () => {
    expect(kitGunFor(['sniper', 'deagle'], null, 'sniper')).toBe('sniper');
    expect(kitGunFor(['rifle', 'deagle'], 15, 'deagle')).toBe('deagle');
    expect(kitGunFor(['rifle', 'deagle'], 15, 'rifle')).toBe('rifle');
  });
});
