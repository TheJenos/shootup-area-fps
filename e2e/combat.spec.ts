import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('combat', () => {
  test('a kill is confirmed on the crosshair with the name', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 2 }));
    // The marker and the name only stay up for a moment: keep every one as it comes.
    await alice.page.evaluate(() => {
      const w = window as any;
      w.__kills = [];
      let last: unknown = null;
      w.game.hud.subscribe(() => {
        const s = w.game.hud.get();
        if (s.killConfirm && s.killConfirm !== last) w.__kills.push({ name: s.killConfirm.name, kill: s.hitmarker.kill });
        last = s.killConfirm;
      });
    });
    await alice.kill(bob);
    await expect.poll(() => alice.page.evaluate(() => (window as any).__kills)).toContainEqual({ name: bob.name, kill: true });
  });

  test('just respawned, you cannot be hurt for a moment, until you shoot', async ({ duel }) => {
    const { code, alice, bob, aliceId, bobId } = await duel(rules('ffa', { respawn: 1 }));
    await alice.kill(bob);
    // Back, and protected: everyone can see it on the record (the shimmer).
    await waitForValue(`rooms/${code}/players/${bobId}/inv`, (v) => v === true, 15_000);
    await expect.poll(async () => (await bob.state()).alive, { timeout: 30_000 }).toBe(true);
    // A shot inside the window does nothing. (The window is short; on a slow run it may already have
    // closed by the time the shot lands, so only hold it to that when it provably hadn't.)
    await bob.teleport(16, 0, 0, Math.PI / 2);
    await alice.teleport(8, 0, 0, -Math.PI / 2);
    await alice.waitForRemote(bob, [16, 0, 0]);
    const stillProtected = (await db.get(`rooms/${code}/players/${bobId}/inv`)) === true;
    await alice.shoot(bob, { part: 'body', shots: 1, timeout: 500 });
    if (stillProtected) expect((await bob.state()).hp).toBe(100);
    // It wears off by itself, and then shots land again.
    await waitForValue(`rooms/${code}/players/${bobId}/inv`, (v) => v === null, 5_000);
    await alice.shoot(bob, { part: 'body', shots: 1 });
    await expect.poll(async () => (await bob.state()).hp).toBeLessThan(100);
    // ...and firing ends it at once.
    await bob.kill(alice);
    await expect.poll(async () => (await alice.state()).alive, { timeout: 30_000 }).toBe(true);
    await bob.waitForRemote(alice);
    await alice.shoot(bob, { part: 'body', shots: 1, timeout: 1_000 });
    await expect.poll(() => db.get(`rooms/${code}/players/${aliceId}/inv`)).toBeNull();
  });

  test('the radar is drawn in the corner, unless switched off', async ({ duel }) => {
    const { alice } = await duel();
    await expect(alice.page.locator('#minimap canvas')).toBeVisible();
    await alice.openPauseMenu();
    await alice.page.getByRole('button', { name: 'Settings' }).click();
    await alice.page.getByRole('tab', { name: 'Video' }).click();
    await alice.page.getByLabel(/Radar/).uncheck();
    await expect(alice.page.locator('#minimap')).toHaveCount(0);
  });

  test('a body shot takes rifle damage off the victim, everywhere', async ({ duel }) => {
    const { code, alice, bob, bobId } = await duel();
    await expect(bob.page.locator('#health')).toContainText('100');

    expect(await alice.shoot(bob, { part: 'body' })).toBe(1);

    await expect.poll(async () => (await bob.state()).hp).toBe(80);
    await expect(bob.page.locator('#health')).toContainText('80');
    await waitForValue(`rooms/${code}/players/${bobId}/hp`, (hp) => hp === 80);
    // The shooter sees a hit marker
    await expect(alice.page.locator('#hitmarker')).toHaveClass(/show/);
  });

  test('a headshot does head damage and shows the headshot marker', async ({ duel }) => {
    const { alice, bob } = await duel();
    await alice.shoot(bob, { part: 'head' });
    await expect.poll(async () => (await bob.state()).hp).toBe(50);
    await expect(alice.page.locator('#hitmarker')).toHaveClass(/head/);
  });

  test('a kill: death screen, kill feed, scores, respawn and kill-heal', async ({ duel }) => {
    const { code, alice, bob, aliceId, bobId } = await duel(rules('ffa', { respawn: 2 }));
    // Hurt Alice first, so the kill-heal shows.
    await bob.shoot(alice, { part: 'body', shots: 2 });
    await expect.poll(async () => (await alice.state()).hp).toBe(60);

    await alice.kill(bob);

    await expect(bob.page.locator('#death-overlay')).toContainText('You were eliminated');
    await expect(bob.page.locator('#death-overlay')).toContainText(alice.name);
    await expect(alice.page.locator('#killfeed')).toContainText(bob.name);
    await expect(bob.page.locator('#killfeed')).toContainText(alice.name);
    await waitForValue(`rooms/${code}/players/${aliceId}/kills`, (k) => k === 1);
    await waitForValue(`rooms/${code}/players/${bobId}/deaths`, (d) => d === 1);
    await expect.poll(async () => (await alice.state()).kills).toBe(1);
    // +50% of full health back for the kill
    await expect.poll(async () => (await alice.state()).hp).toBe(100);

    // Respawns after the room's respawn time with full health
    await expect(bob.page.locator('#death-overlay')).toBeHidden({ timeout: 15_000 });
    const after = await bob.state();
    expect(after.alive).toBe(true);
    expect(after.hp).toBe(100);
    expect(after.deaths).toBe(1);
    await waitForValue(`rooms/${code}/players/${bobId}/alive`, (a) => a === true);
  });

  test('kill-heal is half of full health (25 in a 50 HP mode)', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { health: 50 }));
    await bob.shoot(alice, { part: 'body', shots: 2 });
    await expect.poll(async () => (await alice.state()).hp).toBe(10);
    await alice.kill(bob);
    await expect.poll(async () => (await alice.state()).hp).toBe(35);
  });

  test('reloading and the ammo readout', async ({ duel }) => {
    const { alice } = await duel();
    const page = alice.page;
    await expect(page.locator('#ammo-value')).toHaveText('30');
    // Empty most of the magazine at a wall
    await page.evaluate(async () => {
      const t = (window as any).game.test;
      let n = 0;
      while (n < 26) {
        t.aimAtPoint(40, 1.5, 0);
        if (t.fire()) n++;
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await expect(page.locator('#ammo-value')).toHaveText('4');
    await expect(page.locator('#reload-hint')).toContainText(/LOW AMMO|R TO RELOAD/);
    await page.keyboard.press('KeyR');
    await expect(page.locator('#reload-hint')).toContainText('RELOADING');
    await expect(page.locator('#ammo-value')).toHaveText('30', { timeout: 10_000 });
  });

  test('allies in team modes cannot hurt each other', async ({ duel }) => {
    const { code, alice, bob, bobId } = await duel(rules('tdm'));
    // Put Bob on Alice's team
    const aliceTeam = (await alice.state()).team;
    if ((await bob.state()).team !== aliceTeam) {
      await bob.openPauseMenu();
      await bob.page.getByRole('button', { name: /Switch to/ }).click();
      await expect.poll(async () => (await bob.state()).team).toBe(aliceTeam);
      await bob.play();
    }
    await waitForValue(`rooms/${code}/players/${bobId}/team`, (t) => t === aliceTeam);
    await alice.teleport(8, 0, 0, -Math.PI / 2);
    await bob.teleport(16, 0, 0, Math.PI / 2);
    await alice.waitForRemote(bobId);
    // Bullets pass through teammates: no hitbox to aim at is fine too, so fire at where Bob stands.
    await alice.page.evaluate(async () => {
      const t = (window as any).game.test;
      for (let n = 0; n < 3;) {
        t.aimAtPoint(16, 1.2, 0);
        if (t.fire()) n++;
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await bob.page.waitForTimeout(1_000);
    expect((await bob.state()).hp).toBe(100);
    expect(await db.get(`rooms/${code}/players/${bobId}/hp`)).toBe(100);
  });
});
