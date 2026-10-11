import { expect, rules, test, uniqueName } from './support/fixtures';
import type { Player } from './support/player';

async function joinOnTouch(p: Player, code: string) {
  await p.gotoLobby();
  await p.joinByCode(code);
}

test.describe('touch screens', () => {
  test('the controls guide shows once, then "Tap to play" starts the game', async ({ players, rooms }) => {
    const p = await players.open({ name: uniqueName('Thumbs'), touch: true });
    const code = await rooms.seed(rules('ffa'));
    await joinOnTouch(p, code);
    const page = p.page;
    const intro = page.getByRole('dialog', { name: 'How to play on a touch screen' });
    await expect(intro).toBeVisible();
    await intro.getByRole('button', { name: 'Got it' }).click();
    await expect(intro).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('fps-touch-intro'))).toBe('1');

    await expect(page.locator('#pause-overlay')).toContainText('Left thumb moves');
    await page.getByRole('button', { name: 'Tap to play' }).click();
    await expect(page.locator('#pause-overlay')).toBeHidden();
    await expect(page.locator('#touch-controls')).toBeVisible();
    expect((await p.state()).locked).toBe(true);

    // Menu goes back to the pause screen, where "Controls guide" reopens the intro
    await page.getByRole('button', { name: 'Menu' }).dispatchEvent('pointerdown');
    await expect(page.locator('#pause-overlay')).toBeVisible();
    await page.getByRole('button', { name: 'Controls guide' }).click();
    await expect(intro).toBeVisible();
  });

  test('stick, jump, fire, reload, scoreboard and inventory buttons', async ({ players, rooms }) => {
    const p = await players.open({ name: uniqueName('Tapper'), touch: true });
    await p.page.addInitScript(() => localStorage.setItem('fps-touch-intro', '1'));
    const code = await rooms.seed(rules('ffa'));
    await joinOnTouch(p, code);
    const page = p.page;
    await page.getByRole('button', { name: 'Tap to play' }).click();
    await p.teleport(0, 0, 18, 0);
    await page.waitForTimeout(300);

    // Push the stick forward
    const zone = (await page.locator('.stick-zone').boundingBox())!;
    const [sx, sy] = [zone.x + zone.width / 2, zone.y + zone.height / 2];
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx, sy - 40, { steps: 4 });
    await page.waitForTimeout(700);
    await page.mouse.up();
    expect((await p.state()).pos[2]).toBeLessThan(17.5);

    // Jump
    const jump = page.getByRole('button', { name: 'Jump' });
    await jump.dispatchEvent('pointerdown');
    await expect.poll(async () => (await p.state()).pos[1], { intervals: [30] }).toBeGreaterThan(0.2);
    await jump.dispatchEvent('pointerup');

    // Fire spends a round, Reload refills it
    const fire = page.getByRole('button', { name: 'Fire' });
    await fire.dispatchEvent('pointerdown', { pointerId: 7 });
    await expect.poll(async () => (await p.state()).ammo).toBeLessThan(30);
    await fire.dispatchEvent('pointerup', { pointerId: 7 });
    await page.getByRole('button', { name: 'Reload' }).dispatchEvent('pointerdown');
    await expect.poll(async () => (await p.state()).ammo, { timeout: 10_000 }).toBe(30);

    // Scoreboard toggles; inventory opens with a Close button
    await page.getByRole('button', { name: 'Scoreboard' }).dispatchEvent('pointerdown');
    await expect(page.locator('#match-summary')).toBeVisible();
    await page.locator('#match-summary').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#match-summary')).toBeHidden();
    await page.getByRole('button', { name: 'Inventory' }).dispatchEvent('pointerdown');
    await expect(page.locator('#inventory')).toBeVisible();
    await page.locator('#inventory').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#inventory')).toBeHidden();
  });

  test('a thumb on the stick when you die does not keep you walking after the respawn', async ({ players, rooms }) => {
    test.slow();
    const p = await players.open({ name: uniqueName('Walker'), touch: true });
    await p.page.addInitScript(() => localStorage.setItem('fps-touch-intro', '1'));
    const code = await rooms.seed(rules('ffa', { respawn: 1 }));
    await joinOnTouch(p, code);
    await p.page.getByRole('button', { name: 'Tap to play' }).click();
    const bob = await players.open(uniqueName('Bob'));
    await bob.gotoLobby();
    await bob.joinByCode(code);
    await bob.play();
    await p.teleport(0, 0, 18, 0);

    // A slow walk forward, thumb kept on the stick
    const zone = (await p.page.locator('.stick-zone').boundingBox())!;
    const [sx, sy] = [zone.x + zone.width / 2, zone.y + zone.height / 2];
    await p.page.mouse.move(sx, sy);
    await p.page.mouse.down();
    await p.page.mouse.move(sx, sy - 14, { steps: 3 });
    await expect.poll(async () => (await p.state()).speed, { timeout: 5_000 }).toBeGreaterThan(0.3);

    // Bob catches up and takes them out: the on-screen controls go away with the thumb still down
    const [x, y, z] = (await p.state()).pos;
    await bob.teleport(x + 3, y, z - 1);
    await bob.waitForRemote(p);
    await bob.kill(p);
    await expect.poll(async () => (await p.state()).alive, { timeout: 15_000 }).toBe(true);

    // Back in the game, standing still: the stick was let go of for them when the controls went
    await p.page.waitForTimeout(1_500);
    expect((await p.state()).speed).toBeLessThan(0.1);
    await p.page.mouse.up();
  });

  test('portrait asks to rotate the device', async ({ players, rooms }) => {
    const p = await players.open({ name: uniqueName('Portrait'), touch: true, viewport: { width: 390, height: 780 } });
    await p.page.addInitScript(() => localStorage.setItem('fps-touch-intro', '1'));
    await joinOnTouch(p, await rooms.seed(rules('ffa')));
    await expect(p.page.locator('#rotate-hint')).toBeVisible();
    await expect(p.page.locator('#rotate-hint')).toContainText('Rotate your device');
    await p.page.setViewportSize({ width: 780, height: 390 });
    await expect(p.page.locator('#rotate-hint')).toBeHidden();
  });
});
