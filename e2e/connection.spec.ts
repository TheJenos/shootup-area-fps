import { expect, rules, test } from './support/fixtures';

test.describe('connection problems', () => {
  test('losing the connection mid-match shows it, and recovers', async ({ duel }) => {
    const { alice } = await duel(rules('ffa'));
    await alice.context.setOffline(true);
    await expect(alice.page.locator('#offline-banner')).toContainText('Reconnecting…', { timeout: 60_000 });
    await expect(alice.page.locator('#killfeed')).toContainText('Connection lost');
    await alice.openPauseMenu();
    await expect(alice.page.locator('#pause-overlay .state')).toContainText('Connection lost');

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
