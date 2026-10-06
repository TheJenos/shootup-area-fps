import { db } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('mode rules', () => {
  test('headshots only: body shots do nothing, a headshot hurts', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { name: 'Headhunter', short: 'HS', headshotsOnly: true }));
    await alice.shoot(bob, { part: 'body', shots: 3 });
    await bob.page.waitForTimeout(800);
    expect((await bob.state()).hp).toBe(100);
    await alice.shoot(bob, { part: 'head' });
    await expect.poll(async () => (await bob.state()).hp).toBe(50);
  });

  for (const gun of ['sniper', 'shotgun', 'deagle'] as const) {
    test(`${gun}s only: everyone holds a ${gun} with endless ammo`, async ({ duel }) => {
      const { alice, code } = await duel(rules('ffa', { loadout: gun, guns: true, ammo: true, abilities: false }));
      const s = await alice.state();
      expect(s.gun).toBe(gun);
      // Normalized rules: no gun or ammo pickups with a fixed gun
      expect(s.rules).toMatchObject({ loadout: gun, guns: false, ammo: false });
      await expect(alice.page.locator('#ammo')).toContainText('∞');
      // Q has nothing to switch to
      await alice.page.keyboard.press('KeyQ');
      await alice.page.waitForTimeout(300);
      expect((await alice.state()).gun).toBe(gun);
      // The leader's spawner leaves guns and ammo boxes out
      await alice.page.waitForTimeout(3_000);
      const pickups = Object.values((await db.get(`rooms/${code}/pickups`)) ?? {}) as { type: string }[];
      expect(pickups.filter((p) => ['shotgun', 'sniper', 'deagle', 'ammo'].includes(p.type))).toEqual([]);
    });
  }

  test('one-shot sniper body damage', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { loadout: 'sniper' }));
    // Hip-fire sniper spread is wide: keep shooting until one lands
    await expect.poll(async () => {
      await alice.shoot(bob, { part: 'body' });
      return (await bob.state()).hp;
    }, { timeout: 30_000, intervals: [1_500] }).toBeLessThanOrEqual(25);
  });

  test('gun game: each kill moves you up the ladder', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { name: 'Gun Game', short: 'GG', loadout: 'gungame', limit: 12, respawn: 1 }));
    expect((await alice.state()).gun).toBe('rifle');
    await expect(alice.page.locator('#scorebar')).toContainText('Level 1/12');

    await alice.kill(bob);
    await expect.poll(async () => (await alice.state()).gun).toBe('deagle');
    await expect(alice.page.locator('#toasts, .sr-only').first()).toBeAttached();
    await expect.poll(async () => (await alice.hud()).toast?.text ?? '').toContain('Level 2: Deagle');
    await expect(alice.page.locator('#scorebar')).toContainText('Level 2/12');
  });

  test('gun game: the last kill on the ladder wins', async ({ duel }) => {
    const { code, alice, bob, aliceId } = await duel(rules('ffa', { name: 'Gun Game', short: 'GG', loadout: 'gungame', limit: 12, respawn: 1 }));
    // Fast-forward Alice to the last gun
    await db.put(`rooms/${code}/players/${aliceId}/kills`, 11);
    await expect.poll(async () => (await alice.state()).kills).toBe(11);
    await expect.poll(async () => (await alice.state()).gun).toBe('sniper');
    await expect.poll(async () => {
      if ((await bob.state()).alive) await alice.shoot(bob, { part: 'head' });
      return (await db.get(`rooms/${code}/game/ended/winner`));
    }, { timeout: 45_000, intervals: [1_500] }).toBe(aliceId);
    await expect(alice.page.locator('#round-over')).toContainText('You win!');
  });

  test('health rule: 200 HP to start, and the bar scales', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ctf', { name: 'Tank CTF', short: 'TNK', health: 200 }), { positions: false });
    expect((await alice.state()).hp).toBe(200);
    await expect(alice.page.locator('#health')).toContainText('200');
    await expect(alice.page.locator('#health-bar')).toHaveAttribute('style', /width: 100%/);
    expect((await bob.state()).hp).toBe(200);
  });

  test('respawn rule: back after the set time', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 6 }));
    await alice.kill(bob);
    await expect(bob.page.locator('#death-overlay')).toContainText(/Respawning in [56]/);
    const died = Date.now();
    // Six seconds of game time; slow frames stretch that on the wall clock
    await expect.poll(async () => (await bob.state()).alive, { timeout: 60_000 }).toBe(true);
    expect(Date.now() - died).toBeGreaterThan(4_000);
  });
});
