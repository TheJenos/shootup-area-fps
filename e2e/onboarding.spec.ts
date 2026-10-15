import { expect, rules, test, uniqueName } from './support/fixtures';

test.describe('first visit', () => {
  test('asks for a name once, checks it, and keeps it', async ({ players }) => {
    const p = await players.open({ name: null });
    await p.gotoLobby();
    const page = p.page;
    await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
    const input = page.getByLabel('Your name');
    const cont = page.getByRole('button', { name: 'Continue' });

    await input.fill('A');
    await expect(cont).toBeDisabled();

    await input.fill('Bad<name>');
    await cont.click();
    await expect(page.locator('p.error')).toHaveText('Names are 2–16 characters: letters, numbers, spaces, - or _.');

    await input.fill('  Maverick   Jr ');
    await cont.click();
    await expect(page.locator('.lobby-profile')).toContainText('Playing as');
    await expect(page.locator('.lobby-profile strong')).toHaveText('Maverick Jr');
    expect(await page.evaluate(() => localStorage.getItem('fps-name'))).toBe('Maverick Jr');

    // A returning visit goes straight to the lobby
    await page.reload();
    await expect(page.getByRole('heading', { name: 'What should we call you?' })).toHaveCount(0);
    await expect(page.locator('.lobby-profile strong')).toHaveText('Maverick Jr');
  });

  test('names are capped at 16 characters', async ({ players }) => {
    const p = await players.open({ name: null });
    await p.gotoLobby();
    const input = p.page.getByLabel('Your name');
    await input.fill('ABCDEFGHIJKLMNOPQRSTUV');
    await expect(input).toHaveValue('ABCDEFGHIJKLMNOP');
  });

  test('the first match shows the controls for a few seconds, once', async ({ players, rooms }) => {
    // `hints: true` keeps the one-time tips, which the other tests silence.
    const p = await players.open({ name: uniqueName('Newbie'), hints: true });
    const code = await rooms.seed(rules('ffa'));
    await p.gotoLobby();
    await p.joinByCode(code);
    await p.play();
    const card = p.page.locator('#controls-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('move');
    await expect(card).toContainText('shoot');
    await expect(card).toBeHidden({ timeout: 15_000 });
    // Remembered: not again next time
    expect(JSON.parse(await p.page.evaluate(() => localStorage.getItem('fps-hints') ?? '[]'))).toContain('controls');
  });
});
