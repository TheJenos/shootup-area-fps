import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

/** Settings → Video → Kill cam (the test players start with it off), from the pause menu, then back to playing. */
async function setKillcam(p: Player, on: boolean): Promise<void> {
  await p.openPauseMenu();
  await p.page.locator('#pause-overlay').getByRole('button', { name: 'Settings' }).click();
  await p.page.getByRole('tab', { name: 'Video' }).click();
  await p.page.getByRole('checkbox', { name: /Kill cam/ }).setChecked(on);
  await p.page.getByRole('button', { name: 'Done' }).click();
  await p.play();
}

/*
 * The kill cam: killed by someone, you watch the last few seconds through their eyes while you wait to
 * respawn. Space / a click / Skip ends it; a setting turns it off.
 */
test.describe('kill cam', () => {
  test('shows the last moments through the killer\'s eyes, and can be skipped', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 8 }));
    await setKillcam(bob, true);
    // A few seconds of play to record.
    await alice.page.waitForTimeout(2_000);
    await alice.kill(bob);
    await expect.poll(async () => (await bob.state()).killcam).toBe(true);
    const banner = bob.page.locator('#killcam');
    await expect(banner).toContainText('Kill cam');
    await expect(banner.locator('strong')).toHaveText(alice.name);
    await expect(bob.page.locator('#death-overlay')).toHaveCount(0);
    // Seen through Alice's eyes: the camera follows her recorded moves (the test teleported her into
    // place just before, so it ends up where she is now).
    const at = await alice.page.evaluate(() => (window as any).game.player.position.toArray());
    const fromAlice = async () => {
      const cam = await bob.page.evaluate(() => (window as any).game.camera.position.toArray());
      return Math.hypot(cam[0] - at[0], cam[2] - at[2]);
    };
    await expect.poll(fromAlice, { timeout: 6_000, intervals: [100] }).toBeLessThan(2);

    // Space skips it: back to the death screen, still waiting to respawn.
    await bob.page.keyboard.press('Space');
    await expect(banner).toHaveCount(0);
    await expect(bob.page.locator('#death-overlay')).toContainText('Respawning');
    expect((await bob.state()).killcam).toBe(false);
    await expect.poll(async () => (await bob.state()).alive, { timeout: 20_000 }).toBe(true);
  });

  test('plays to the end on its own, then respawns', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 1 }));
    await setKillcam(bob, true);
    await alice.page.waitForTimeout(2_000);
    await alice.kill(bob);
    await expect.poll(async () => (await bob.state()).killcam).toBe(true);
    // The 1 s respawn waits for it (about 4.5 s).
    await bob.page.waitForTimeout(1_500);
    expect((await bob.state()).alive).toBe(false);
    await expect.poll(async () => (await bob.state()).alive, { timeout: 20_000 }).toBe(true);
    expect((await bob.state()).killcam).toBe(false);
  });

  test('can be turned off in the settings', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 4 }));
    await setKillcam(bob, true);
    await setKillcam(bob, false);
    await alice.page.waitForTimeout(1_000);
    await alice.kill(bob);
    await expect(bob.page.locator('#death-overlay')).toContainText(alice.name);
    await bob.page.waitForTimeout(500);
    expect((await bob.state()).killcam).toBe(false);
    await expect(bob.page.locator('#killcam')).toHaveCount(0);
  });
});
