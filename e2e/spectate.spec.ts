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

  test('when the player being watched is killed, the camera follows the killer', async ({ duel, players }) => {
    test.setTimeout(120_000);
    const { code, alice, bob, bobId } = await duel();
    // Someone else is playing too, so following the killer isn't just "the only one left".
    const dave = await players.open('DaveSpec');
    await dave.gotoLobby();
    await dave.joinByCode(code);
    await dave.play();
    const carol = await players.open('CarolSpec');
    await carol.gotoLobby();
    await carol.joinByCode(code);
    await carol.play();
    await carol.openPauseMenu();
    await carol.page.getByRole('button', { name: 'Spectate' }).click();
    await carol.play();
    // Click through to Bob.
    const watching = carol.page.locator('#spectate strong');
    await expect(watching).toHaveText(/./);
    await expect.poll(async () => {
      if ((await watching.textContent()) === bob.name) return true;
      await carol.page.evaluate(() => (window as any).game.test.nextSpectate());
      return false;
    }, { intervals: [300] }).toBe(true);

    await alice.kill(bob);
    await waitForValue(`rooms/${code}/players/${bobId}/alive`, (a) => a === false);
    await expect(watching).toHaveText(alice.name);
    // And stays there: no bouncing around while Bob waits to respawn.
    await carol.page.waitForTimeout(1_500);
    await expect(watching).toHaveText(alice.name);
  });
});
