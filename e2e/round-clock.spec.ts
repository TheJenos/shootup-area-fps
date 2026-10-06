import { expireClock, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('round clock and match summary', () => {
  test('the clock counts down and turns red near the end', async ({ duel }) => {
    const { code, alice } = await duel(rules('ffa', { minutes: 3 }));
    await expect(alice.page.locator('#scorebar .clock')).toHaveText(/^[23]:\d\d$/);
    await expireClock(code, 3, 25_000);
    await expect(alice.page.locator('#scorebar .clock')).toHaveText(/^0:[12]\d$/);
    await expect(alice.page.locator('#scorebar .clock')).toHaveClass(/urgent/);
  });

  test("time's up with nobody ahead: a draw", async ({ duel }) => {
    const { code, alice, bob } = await duel(rules('ffa', { minutes: 3 }));
    await expireClock(code, 3);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: 'draw', reason: 'time' });
    for (const p of [alice, bob]) {
      await expect(p.page.locator('#round-over')).toContainText("Time's up");
      await expect(p.page.locator('#round-over h2')).toHaveText("It's a draw!");
      await expect(p.page.locator('#round-over')).toHaveClass(/draw/);
    }
  });

  test("time's up: the most kills wins", async ({ duel }) => {
    const { code, alice, bob, aliceId } = await duel(rules('ffa', { minutes: 3 }));
    await alice.kill(bob);
    await expireClock(code, 3);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: aliceId, reason: 'time' });
    await expect(alice.page.locator('#round-over h2')).toHaveText('You win!');
    await expect(bob.page.locator('#round-over h2')).toHaveText(`${alice.name} wins!`);
  });

  test('holding Tab shows the match summary', async ({ duel }) => {
    const { code, alice, bob } = await duel(rules('ffa', { respawn: 1 }));
    await alice.kill(bob);
    await expect.poll(async () => (await alice.state()).kills).toBe(1);
    await alice.page.keyboard.down('Tab');
    const summary = alice.page.getByRole('dialog').filter({ has: alice.page.locator('#summary-title') });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(`Room ${code}`);
    await expect(summary).toContainText('2 players');
    for (const h of ['Player', 'K', 'D', 'K/D', 'Damage', 'Acc.', 'HS', 'Best streak', 'Ping']) {
      await expect(summary.locator('th', { hasText: new RegExp(`^${h.replace('.', '\\.')}$`) })).toHaveCount(1);
    }
    const me = summary.locator('tbody tr.me');
    await expect(me).toContainText(alice.name);
    await expect(summary.locator('tbody tr', { hasText: bob.name })).toBeVisible();
    await expect(summary.locator('section.mine')).toContainText('Headshots');
    await alice.page.keyboard.up('Tab');
    await expect(summary).toBeHidden();
  });

  test('team modes split the summary by team', async ({ duel }) => {
    const { alice } = await duel(rules('tdm'));
    await alice.page.keyboard.down('Tab');
    await expect(alice.page.locator('#match-summary tr.team-row.red')).toBeVisible();
    await expect(alice.page.locator('#match-summary tr.team-row.blue')).toBeVisible();
    await alice.page.keyboard.up('Tab');
  });
});
