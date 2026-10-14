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
    // Through Alice's eyes: her health, gun and items in place of Bob's own (no keys to press on them), and the radar.
    await alice.give('medkit');
    await expect(bob.page.locator('#watched-tag strong')).toHaveText(alice.name);
    await expect(bob.page.locator('#health')).toContainText('100');
    await expect(bob.page.locator('#ammo.watched')).toContainText('Rifle');
    await expect(bob.page.locator('#ammo.watched #ammo-value')).toHaveText('30');
    // She fires once: her rounds, as Bob sees them, follow.
    await alice.page.evaluate(() => (window as any).game.test.fire());
    await expect(bob.page.locator('#ammo.watched #ammo-value')).toHaveText('29');
    await expect(bob.page.locator('#ammo.watched')).toContainText('/ 90');
    // She reloads: Bob's panel says so, and the gun in his view plays the reload too.
    await alice.page.keyboard.press('KeyR');
    await expect(bob.page.locator('#ammo.watched')).toHaveClass(/reloading/);
    await expect.poll(() => bob.page.evaluate(() => (window as any).game.povWeapon.reloading)).toBe(true);
    await expect(bob.page.locator('#abilities .slot')).toHaveCount(3);
    await expect(bob.page.locator('#abilities .slot kbd')).toHaveCount(0);
    await expect(bob.page.locator('#abilities .slot').first()).toContainText('Medkit');
    await expect(bob.page.locator('#minimap canvas')).toBeVisible();
    // The radar is centred on Alice (at DUEL.a), not on Bob's own body.
    await expect.poll(() => bob.page.evaluate(() => {
      const v = (window as any).game.minimap.lastView;
      return v ? [Math.round(v.x), Math.round(v.z)] : null;
    })).toEqual([8, 0]);
    // Spectators can't be shot
    await expect.poll(() => alice.page.evaluate((id) => (window as any).game.remotes.get(id)?.hitboxes.length, bobId)).toBe(0);

    await bob.openPauseMenu();
    await bob.page.getByRole('button', { name: 'Back to the fight' }).click();
    await expect.poll(async () => (await bob.state()).alive).toBe(true);
    await waitForValue(`rooms/${code}/players/${bobId}`, (p) => !p?.spec && p?.alive === true);
    await bob.play();
    await expect(bob.page.locator('#spectate')).toHaveCount(0);
    await expect(bob.page.locator('#watched-tag')).toHaveCount(0);
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

  test('sounds: the watched player is heard first-person, from inside their head', async ({ duel }) => {
    const { alice, bob, aliceId } = await duel();
    await bob.openPauseMenu();
    await bob.page.getByRole('button', { name: 'Spectate' }).click();
    await expect.poll(async () => (await bob.state()).spectating).toBe(true);
    await bob.play();
    await expect(bob.page.locator('#spectate strong')).toHaveText(alice.name);
    // Her steps, shots and reloads play as Bob's own would (centred), not placed beside his head.
    await expect.poll(() => bob.page.evaluate((id) => (window as any).game.seenThrough(id), aliceId)).toBe(true);
    // Everyone else is heard from where her head is.
    const gap = await bob.page.evaluate((id) => {
      const g = (window as any).game;
      return g.remotes.get(id).eyePosition(g.camera.position.clone()).distanceTo(g.soundFrom);
    }, aliceId);
    expect(gap).toBeLessThan(0.3);
    expect(await alice.page.evaluate((id) => (window as any).game.seenThrough(id), aliceId)).toBe(false);
  });
});
