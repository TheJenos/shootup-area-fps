import { db } from './support/db';
import { expect, test, uniqueName } from './support/fixtures';
import type { Player } from './support/player';
import { rangeIn, setRange } from './support/ui';

const customModes = (p: Player) => p.page.evaluate(() => JSON.parse(localStorage.getItem('fps-custom-modes') || '[]'));

async function openCreate(p: Player) {
  await p.gotoLobby();
  await p.page.getByRole('tab', { name: 'Create room' }).click();
}

test.describe('custom modes', () => {
  test('the editor: base, name, badge, loadout, rules and a live description', async ({ players }) => {
    const p = await players.open('Editor');
    await openCreate(p);
    const page = p.page;
    await page.getByRole('button', { name: '＋ New mode' }).click();
    const editor = page.getByRole('dialog', { name: 'Custom mode' });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Mode name')).toHaveValue('Custom mode');

    // Base: switching resets the score limit to that base's
    await editor.getByRole('radio', { name: 'Team Deathmatch' }).click();
    await expect(editor.getByRole('radio', { name: 'Team Deathmatch' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.locator('label.setting', { hasText: 'Team kills to win' })).toContainText('50');
    await expect(editor.locator('.mode-preview')).toContainText('first team to 50 wins');
    // Gun Game is only offered for free-for-all
    await expect(editor.locator('select option', { hasText: 'Gun Game' })).toHaveCount(0);
    await editor.getByRole('radio', { name: 'Free-for-all' }).click();
    await expect(editor.locator('select option', { hasText: 'Gun Game' })).toHaveCount(1);

    await editor.getByLabel('Mode name').fill('Pistol Party');
    await editor.getByLabel('Badge (up to 4 letters)').fill('pp');
    await expect(editor.getByLabel('Badge (up to 4 letters)')).toHaveValue('PP');

    // One gun for everyone turns gun and ammo pickups off
    await editor.locator('label.setting', { hasText: 'Loadout' }).locator('select').selectOption('deagle');
    await expect(editor.getByLabel('Gun pickups')).toBeDisabled();
    await expect(editor.getByLabel('Ammo boxes')).toBeDisabled();
    await expect(editor).toContainText('ammo is endless');

    await editor.getByLabel('Headshots only (body hits do nothing)').check();
    await setRange(rangeIn(editor, 'Kills to win'), 10);
    await setRange(rangeIn(editor, 'Time limit'), 5);
    await setRange(rangeIn(editor, 'Respawn'), 1);
    await setRange(rangeIn(editor, 'Health'), 150);
    await setRange(rangeIn(editor, 'Speed'), 1.2);
    await setRange(rangeIn(editor, 'Gravity'), 0.5);
    await expect(editor.locator('label.setting', { hasText: 'Health' })).toContainText('150 HP');
    await expect(editor.locator('label.setting', { hasText: 'Speed' })).toContainText('120%');
    await expect(editor.locator('label.setting', { hasText: 'Gravity' })).toContainText('50%');
    await expect(editor.locator('.mode-preview')).toContainText('PP');
    await expect(editor.locator('.mode-preview')).toContainText('first to 10 wins');

    // Sliders can't go past the limits
    await setRange(rangeIn(editor, 'Kills to win'), 999);
    await expect(editor.locator('label.setting', { hasText: 'Kills to win' })).toContainText('60');
  });

  test('Cancel, Esc and clicking outside close the editor without changes', async ({ players }) => {
    const p = await players.open('Closer');
    await openCreate(p);
    const page = p.page;
    const editor = page.locator('#mode-editor');
    const open = () => page.getByRole('button', { name: '＋ New mode' }).click();

    await open();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
    await open();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await open();
    await editor.click({ position: { x: 5, y: 5 } });
    await expect(editor).toHaveCount(0);
    expect(await customModes(p)).toEqual([]);
    await expect(page.locator('.mode-detail strong')).toHaveText('Free-for-all');
  });

  test('"Use once" plays it without saving it', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Once'));
    await openCreate(p);
    const page = p.page;
    await page.getByRole('button', { name: '＋ New mode' }).click();
    await page.getByLabel('Mode name').fill('One Off');
    await setRange(rangeIn(page.locator('#mode-editor'), 'Health'), 75);
    await page.getByRole('button', { name: 'Use once' }).click();
    await expect(page.locator('.mode-detail strong')).toHaveText('One Off');
    await expect(page.locator('.mode-detail small')).toContainText('custom (not saved)');
    expect(await customModes(p)).toEqual([]);
    await expect(page.locator('button.create-button')).toHaveText('Create One Off room');

    const code = rooms.track(await p.createRoom({ seed: 'classic' }));
    const lobby = await db.get(`lobby/${code}`);
    expect(lobby.rules).toMatchObject({ name: 'One Off', health: 75, base: 'ffa' });
    await expect(page.locator('#health')).toContainText('75');
  });

  test('"Save & use" keeps it; edit replaces it, delete removes it', async ({ players }) => {
    const p = await players.open('Saver');
    await openCreate(p);
    const page = p.page;

    // Customizing a preset starts from it
    await page.getByRole('radio', { name: /Moon Gravity/ }).click();
    await page.getByRole('button', { name: 'Customize' }).click();
    await expect(page.getByLabel('Mode name')).toHaveValue('Moon Gravity (custom)');
    await page.getByLabel('Mode name').fill('Low Grav');
    await page.getByRole('button', { name: 'Save & use' }).click();

    const chip = page.getByRole('radiogroup', { name: 'Your modes' }).getByRole('radio', { name: /Low Grav/ });
    await expect(chip).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.mode-detail small')).toContainText('your mode');
    let saved = await customModes(p);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Low Grav', gravity: 0.35 });

    // Still there after a reload
    await page.reload();
    await page.getByRole('tab', { name: 'Create room' }).click();
    await page.getByRole('radiogroup', { name: 'Your modes' }).getByRole('radio', { name: /Low Grav/ }).click();

    // Editing with the same name replaces it
    await page.getByRole('button', { name: 'Edit' }).click();
    await setRange(rangeIn(page.locator('#mode-editor'), 'Gravity'), 0.6);
    await page.getByRole('button', { name: 'Save & use' }).click();
    saved = await customModes(p);
    expect(saved).toHaveLength(1);
    expect(saved[0].gravity).toBe(0.6);

    await page.getByRole('button', { name: 'Delete Low Grav' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Your modes' }).getByRole('radio')).toHaveCount(0);
    await expect(page.locator('.mode-detail strong')).toHaveText('Free-for-all');
    expect(await customModes(p)).toEqual([]);
  });

  test('keeps at most 12 modes, newest first', async ({ players }) => {
    const p = await players.open('Hoarder');
    await openCreate(p);
    const page = p.page;
    for (let i = 1; i <= 13; i++) {
      await page.getByRole('button', { name: '＋ New mode' }).click();
      await page.getByLabel('Mode name').fill(`Mode ${i}`);
      await page.getByRole('button', { name: 'Save & use' }).click();
    }
    const saved = await customModes(p);
    expect(saved).toHaveLength(12);
    expect(saved[0].name).toBe('Mode 13');
    expect(saved.map((m: { name: string }) => m.name)).not.toContain('Mode 1');
    await expect(page.getByRole('radiogroup', { name: 'Your modes' }).getByRole('radio')).toHaveCount(12);
  });
});
