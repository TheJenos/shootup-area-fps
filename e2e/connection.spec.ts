import { db, dropPlaceholder, waitForValue } from './support/db';
import { expect, rules, test, uniqueName } from './support/fixtures';

type Players = Record<string, { name: string; bot?: boolean; kills?: number }>;
const botsIn = (players: Players | null) => Object.entries(players ?? {}).filter(([id]) => id.startsWith('b_'));

test.describe('connection problems', () => {
  test("the owner's bots come back whole after a reconnect", async ({ players, rooms }) => {
    test.setTimeout(150_000);
    const code = await rooms.seed(rules('tdm'));
    await db.put(`lobby/${code}/bots`, { s_one: { base: 'Kai', skill: 'easy', at: 1 }, s_two: { base: 'Ava', skill: 'easy', at: 2 } });
    const alice = await players.open(uniqueName('Owner'));
    await alice.gotoLobby();
    await alice.joinByCode(code);
    await db.patch(`lobby/${code}`, { hostId: await alice.id() });
    await dropPlaceholder(code);
    await alice.play();
    const before = await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 2, 45_000);
    const ids = botsIn(before).map(([id]) => id).sort();

    // The connection drops: the server removes the bots' records along with the owner's.
    await alice.context.setOffline(true);
    await expect(alice.page.locator('#offline-banner')).toContainText('Reconnecting…', { timeout: 60_000 });
    await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 0, 60_000);

    // Back online: the same bots are written back in full (name, kills and all), not patched together
    // from the next partial update, which would leave records with no name and kills nobody can credit.
    await alice.context.setOffline(false);
    await expect(alice.page.locator('#offline-banner')).toHaveCount(0, { timeout: 60_000 });
    const after = await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 2, 30_000);
    expect(botsIn(after).map(([id]) => id).sort()).toEqual(ids);
    for (const [id, bot] of botsIn(after)) {
      expect(bot.name, id).toBe(before![id]!.name);
      expect(bot.bot, id).toBe(true);
      expect(typeof bot.kills, id).toBe('number');
      await expect.poll(() => db.get(`lobby/${code}/members/${id}`)).toBe(bot.name);
    }
  });

  test('losing the connection mid-match shows it, and recovers', async ({ duel }) => {
    const { alice } = await duel(rules('ffa'));
    await alice.context.setOffline(true);
    await expect(alice.page.locator('#offline-banner')).toContainText('Reconnecting…', { timeout: 60_000 });
    await expect(alice.page.locator('#killfeed')).toContainText('Connection lost');
    await alice.openPauseMenu();
    await expect(alice.page.locator('#pause-overlay .state')).toContainText('Connection lost');
    // Dragging on, the banner offers the lobby.
    await expect(alice.page.locator('#offline-banner')).toContainText('Still reconnecting…', { timeout: 30_000 });
    await expect(alice.page.locator('#offline-banner').getByRole('button', { name: 'Back to lobby' })).toBeVisible();

    await alice.context.setOffline(false);
    await expect(alice.page.locator('#offline-banner')).toHaveCount(0, { timeout: 60_000 });
    await expect(alice.page.locator('#killfeed')).toContainText('Back online');
  });

  test('the room list says when the server cannot be reached', async ({ players }) => {
    test.slow();
    const p = await players.open('Offline');
    // Nothing gets through to the database
    await p.context.route(/127\.0\.0\.1:9000|localhost:9000/, (route) => route.abort());
    await p.context.routeWebSocket(/:9000/, () => {});
    await p.gotoLobby();
    await expect(p.page.locator('#room-list')).toContainText("Couldn't reach the server", { timeout: 20_000 });
    await expect(p.page.locator('#room-list').getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
