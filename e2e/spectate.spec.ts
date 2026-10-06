import { waitForValue } from './support/db';
import { expect, test } from './support/fixtures';

test.describe('spectating', () => {
  test('spectate from the pause menu and come back', async ({ duel }) => {
    const { code, alice, bob, bobId } = await duel();
    await bob.openPauseMenu();
    await bob.page.getByRole('button', { name: 'Spectate' }).click();
    await expect.poll(async () => (await bob.state()).spectating).toBe(true);
    await waitForValue(`rooms/${code}/players/${bobId}/spec`, (v) => v === true);
    await expect(bob.page.locator('#pause-overlay .state')).toContainText('Spectating');
    await bob.play();
    await expect(bob.page.locator('#spectate')).toContainText('Spectating');
    await expect(bob.page.locator('#spectate strong')).toHaveText(alice.name);
    // Spectators have no health panel and can't be shot
    await expect(bob.page.locator('#health')).toHaveCount(0);
    await expect.poll(() => alice.page.evaluate((id) => (window as any).game.remotes.get(id)?.hitboxes.length, bobId)).toBe(0);

    await bob.openPauseMenu();
    await bob.page.getByRole('button', { name: 'Back to the fight' }).click();
    await expect.poll(async () => (await bob.state()).alive).toBe(true);
    await waitForValue(`rooms/${code}/players/${bobId}`, (p) => !p?.spec && p?.alive === true);
    await bob.play();
    await expect(bob.page.locator('#spectate')).toHaveCount(0);
    await expect(bob.page.locator('#health')).toContainText('100');
  });
});
