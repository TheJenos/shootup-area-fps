import { dropPlaceholder } from './support/db';
import { expect, rules, test, uniqueName } from './support/fixtures';
import type { Player } from './support/player';

/**
 * Open an invite link in a browser that has loaded the game once already: these tests race the invite's
 * two-second countdown, and a cold first load (a fresh dev server, several browsers starting at once) can
 * take longer than that. (A different query string, so the link is a real page load, not a hash change.)
 */
async function openWarm(p: Player, path: string): Promise<void> {
  await p.page.goto('/?warm');
  await expect(p.page.locator('#lobby')).toBeVisible();
  await p.page.goto(path);
}

test.describe('invite links', () => {
  test('#CODE joins automatically after a short countdown', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const p = await players.open('Invited');
    await p.page.goto(`/#${code}`);
    await expect(p.page.locator('.invite-card')).toContainText(`Joining room ${code}`);
    await p.waitJoined();
    expect(await p.roomCode()).toBe(code);
  });

  test('?room=CODE works too, and "Join now" skips the wait', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const p = await players.open('Eager');
    await openWarm(p, `/?room=${code.toLowerCase()}`);
    await p.page.getByRole('button', { name: 'Join now' }).click();
    await p.waitJoined();
    expect(await p.roomCode()).toBe(code);
  });

  test('"Stay in the lobby" cancels it', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const p = await players.open('Stayer');
    await openWarm(p, `/#${code}`);
    await p.page.getByRole('button', { name: 'Stay in the lobby' }).click();
    await p.page.waitForTimeout(3_000);
    await expect(p.page.locator('#lobby')).toBeVisible();
    await expect(p.page.locator('.invite-card')).toHaveCount(0);
  });

  test('a new player picks a name first, then goes in', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const p = await players.open({ name: null });
    await p.page.goto(`/#${code}`);
    await expect(p.page.locator('form.name-setup')).toContainText(`You've been invited to room ${code}`);
    await p.page.getByLabel('Your name').fill(uniqueName('Newbie'));
    await p.page.getByRole('button', { name: 'Continue' }).click();
    await p.waitJoined();
  });

  test('a closed room says so and clears the link', async ({ players }) => {
    const p = await players.open('Late');
    await p.page.goto('/#ZZZZZ');
    await expect(p.page.locator('.warning')).toContainText('That room has closed', { timeout: 10_000 });
    await expect(p.page.locator('p.error')).toContainText("Room ZZZZZ doesn't exist.");
    expect(new URL(p.page.url()).hash).toBe('');
  });

  test('the pause menu copies a working invite link', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const host = await players.open(uniqueName('Host'));
    await host.gotoLobby();
    await host.joinByCode(code);
    await dropPlaceholder(code);
    await host.page.locator('#pause-overlay').getByRole('button', { name: 'Copy invite link' }).click();
    await expect(host.page.locator('#pause-overlay').getByRole('button', { name: 'Copied!' })).toBeVisible();
    const link = await host.page.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(`${new URL(host.page.url()).origin}/?room=${code}`);

    // The waiting banner has the same button
    await host.play();
    await host.page.locator('#waiting-banner').getByRole('button', { name: 'Copy invite' }).click();

    const guest = await players.open(uniqueName('Guest'));
    await guest.page.goto(link);
    await guest.waitJoined();
    expect(await guest.roomCode()).toBe(code);
  });
});
