import { waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

/** Aim at `id` and press V once the knife is ready (the game clock can run slower than ours in a test browser). */
async function slash(p: Player, id: string): Promise<void> {
  await expect.poll(() => p.page.evaluate(() => (window as any).game.weapon.knifeReady)).toBe(true);
  await p.page.evaluate((target) => (window as any).game.test.aimAt(target), id);
  await p.page.keyboard.press('KeyV');
}

/*
 * The knife: V slashes at whoever's within arm's reach, 50 damage a hit (head or body), so two hits
 * kill from full health. Out of reach it cuts air.
 */
test.describe('knife', () => {
  test('V slashes for 50 a hit; two hits kill, with the knife in the kill feed', async ({ duel }) => {
    const { code, alice, bob, bobId } = await duel(rules('ffa', { respawn: 3 }));
    // Out of reach (8 m): nothing.
    await slash(alice, bobId);
    await expect.poll(() => alice.page.evaluate(() => (window as any).game.weapon.knifeReady)).toBe(true);
    expect((await bob.state()).hp).toBe(100);

    // Step up to Bob (1.5 m) and slash.
    await alice.teleport(14.5, 0, 0, -Math.PI / 2);
    // (The camera follows on the next frame.)
    await alice.page.waitForTimeout(200);
    await slash(alice, bobId);
    await expect.poll(async () => (await bob.state()).hp).toBe(50);
    await waitForValue(`rooms/${code}/players/${bobId}/hp`, (hp) => hp === 50);
    await expect(alice.page.locator('#hitmarker')).toHaveClass(/show/);

    // Again, once the slash has recovered: dead.
    await slash(alice, bobId);
    await expect.poll(async () => (await bob.state()).alive).toBe(false);
    await expect(bob.page.locator('#death-overlay')).toContainText(alice.name);
    await expect(bob.page.locator('#death-overlay .weapon')).toHaveText('🔪');
    await expect(alice.page.locator('#killfeed')).toContainText('🔪');
    await expect.poll(async () => (await alice.state()).kills).toBe(1);
  });

  test('a slash drops the gun for a moment: no shooting mid-slash', async ({ duel }) => {
    const { alice } = await duel();
    const ammo = await alice.page.evaluate(() => (window as any).game.weapon.ammo);
    await alice.page.keyboard.press('KeyV');
    const fired = await alice.page.evaluate(() => (window as any).game.weapon.tryFire());
    expect(fired).toBe(false);
    expect(await alice.page.evaluate(() => (window as any).game.weapon.ammo)).toBe(ammo);
    // Back to the gun shortly after.
    await expect.poll(() => alice.page.evaluate(() => (window as any).game.weapon.knifing)).toBe(false);
  });
});
