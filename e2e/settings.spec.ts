import { expect, rules, test, uniqueName } from './support/fixtures';
import type { Player } from './support/player';
import { rangeIn, setRange } from './support/ui';

const saved = (p: Player) => p.page.evaluate(() => JSON.parse(localStorage.getItem('fps-settings') || '{}'));

async function openFromLobby(p: Player) {
  await p.gotoLobby();
  await p.page.getByRole('button', { name: 'Mouse and key settings' }).click();
  const dialog = p.page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('settings', () => {
  test('opens from the lobby and closes with Done, Esc or a click outside', async ({ players }) => {
    const p = await players.open('Settler');
    let dialog = await openFromLobby(p);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    await p.page.getByRole('button', { name: 'Mouse and key settings' }).click();
    await p.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await p.page.getByRole('button', { name: 'Mouse and key settings' }).click();
    await p.page.locator('#settings').click({ position: { x: 3, y: 3 } });
    await expect(dialog).toBeHidden();
  });

  test('controls: sensitivity, invert, toggle aim', async ({ players }) => {
    const p = await players.open('Mouser');
    const dialog = await openFromLobby(p);
    await expect(dialog.getByRole('tab', { name: 'Controls' })).toHaveAttribute('aria-selected', 'true');
    await dialog.locator('label.setting', { hasText: /^Sensitivity/ }).locator('input[type=number]').fill('2.5');
    await setRange(rangeIn(dialog, 'Aim sensitivity'), 0.5);
    await dialog.getByLabel('Invert vertical look').check();
    await dialog.getByLabel(/Toggle aim/).check();
    await expect(dialog.locator('label.setting', { hasText: 'Aim sensitivity' })).toContainText('0.50×');
    expect(await saved(p)).toMatchObject({ sensitivity: 2.5, aimSensitivity: 0.5, invertY: true, aimToggle: true });

    // Kept across reloads
    await p.page.reload();
    await p.page.getByRole('button', { name: 'Mouse and key settings' }).click();
    await expect(dialog.getByLabel('Invert vertical look')).toBeChecked();
  });

  test('video: field of view, quality, FPS counter and crosshair', async ({ players, rooms }) => {
    const p = await players.open('Viewer');
    const dialog = await openFromLobby(p);
    await dialog.getByRole('tab', { name: 'Video' }).click();
    await setRange(rangeIn(dialog, 'Field of view'), 90);
    await expect(dialog.locator('label.setting', { hasText: 'Field of view' })).toContainText('90°');
    await dialog.getByRole('radio', { name: 'Medium' }).click();
    await expect(dialog.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByLabel('Show FPS counter').check();
    const swatch = dialog.getByRole('radiogroup', { name: 'Crosshair colour' }).getByRole('radio').nth(2);
    const colour = (await swatch.getAttribute('aria-label'))!;
    await swatch.click();
    await setRange(rangeIn(dialog, 'Size'), 1.5);
    expect(await saved(p)).toMatchObject({ fov: 90, quality: 'medium', showFps: true, crosshairColor: colour, crosshairSize: 1.5 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    // ...and they show in the game
    rooms.track(await p.createRoom({ seed: 'classic' }));
    await expect(p.page.locator('#fps')).toContainText('FPS');
    const crosshair = p.page.locator('#hud #crosshair');
    await expect(crosshair).toHaveAttribute('style', new RegExp(`--ch: ${colour}`));
    await expect(crosshair).toHaveAttribute('style', /--ch-size: 1.5/);
    expect(await p.page.evaluate(() => (window as any).game.camera.fov)).toBeGreaterThan(80);
    await p.leave();
  });

  test('audio and accessibility', async ({ players }) => {
    const p = await players.open('Listener');
    const dialog = await openFromLobby(p);
    await dialog.getByRole('tab', { name: 'Audio' }).click();
    await setRange(rangeIn(dialog, 'Sound effects'), 0.4);
    await setRange(rangeIn(dialog, 'Music'), 0.2);
    await expect(dialog.locator('label.setting', { hasText: 'Sound effects' })).toContainText('40%');
    await dialog.getByLabel('Screen shake when hit').check();

    await dialog.getByRole('tab', { name: 'Accessibility' }).click();
    // Reduce motion on: the page gets the class, and screen shake goes off with it
    await dialog.getByRole('radio', { name: 'On' }).click();
    await expect(p.page.locator('html')).toHaveClass(/reduce-motion/);
    await dialog.getByRole('radio', { name: 'Off' }).click();
    await expect(p.page.locator('html')).not.toHaveClass(/reduce-motion/);
    await setRange(rangeIn(dialog, 'HUD size'), 1.25);
    await expect(dialog.locator('label.setting', { hasText: 'HUD size' })).toContainText('125%');
    expect(await saved(p)).toMatchObject({ sfxVolume: 0.4, musicVolume: 0.2, screenShake: false, reduceMotion: 'full', hudScale: 1.25 });

    await dialog.getByRole('button', { name: 'Show the one-time tips again' }).click();
    await expect(dialog.getByRole('button', { name: 'Tips will show again' })).toBeVisible();
    expect(await p.page.evaluate(() => localStorage.getItem('fps-hints'))).toBe('[]');
  });

  test('reset to defaults asks first', async ({ players }) => {
    const p = await players.open('Resetter');
    const dialog = await openFromLobby(p);
    await dialog.getByLabel('Invert vertical look').check();
    await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(dialog).toContainText('Reset every setting?');
    await dialog.getByRole('button', { name: 'Keep' }).click();
    await expect(dialog.getByLabel('Invert vertical look')).toBeChecked();
    await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(dialog.getByLabel('Invert vertical look')).not.toBeChecked();
    expect(await saved(p)).toMatchObject({ invertY: false, sensitivity: 1, fullscreen: true });
  });

  test('rebinding a key: listening, Esc cancels, swaps clashes, and works in game', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Binder'));
    const dialog = await openFromLobby(p);
    const row = (label: string) => dialog.locator('.binding', { hasText: label }).getByRole('button');

    await row('Move forward').click();
    await expect(row('Move forward')).toHaveText('Press a key…');
    await p.page.keyboard.press('Escape');
    await expect(row('Move forward')).toHaveText('W');
    await expect(dialog).toBeVisible();

    await row('Move forward').click();
    await p.page.keyboard.press('KeyT');
    await expect(row('Move forward')).toHaveText('T');
    expect((await saved(p)).bindings.forward).toBe('KeyT');

    // Taking a key that's in use swaps the two
    await row('Reload').click();
    await p.page.keyboard.press('KeyQ');
    await expect(row('Reload')).toHaveText('Q');
    await expect(row('Switch gun')).toHaveText('R');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // In the game, T walks forward and W does nothing
    const code = await rooms.seed(rules('ffa'));
    await p.joinByCode(code);
    await p.play();
    await p.teleport(0, 0, 10, 0);
    await p.hold('KeyW', 800);
    const pos = (await p.state()).pos;
    expect(Math.hypot(pos[0], pos[2] - 10)).toBeLessThan(0.3);
    await p.holdUntil(['KeyT'], (s) => s.pos[2] < 9);
  });

  test('opens from the pause menu in a match', async ({ players, rooms }) => {
    const p = await players.open('Pauser');
    const code = await rooms.seed(rules('ffa'));
    await p.gotoLobby();
    await p.joinByCode(code);
    // Headless, the game starts paused (no pointer lock until a click)
    await expect(p.page.locator('#pause-overlay')).toBeVisible();
    await p.page.locator('#pause-overlay').getByRole('button', { name: 'Settings' }).click();
    await expect(p.page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await p.page.getByRole('button', { name: 'Done' }).click();
    await expect(p.page.locator('#pause-overlay')).toBeVisible();
  });
});
