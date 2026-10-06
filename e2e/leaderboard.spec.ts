import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('leaderboard', () => {
  // Reads the shared global board, and seeds rows into it
  test.describe.configure({ mode: 'serial' });

  test('a finished round lands on the leaderboard', async ({ duel }) => {
    const { code, alice, bob } = await duel(rules('ffa', { limit: 5, respawn: 1 }));
    const [aliceProfile, bobProfile] = await Promise.all(
      [alice, bob].map((p) => p.page.evaluate(() => localStorage.getItem('fps-profile'))),
    );
    expect(aliceProfile).toMatch(/^p_/);
    const aliceId = await alice.id();
    await db.put(`rooms/${code}/players/${aliceId}/kills`, 4);
    await expect.poll(async () => (await alice.state()).kills).toBe(4);
    await alice.kill(bob);
    await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);

    const row = await waitForValue(`leaderboard/${aliceProfile}`, (r) => !!r);
    expect(row).toMatchObject({ name: alice.name, kills: 5, deaths: 0, wins: 1, rounds: 1, captures: 0, score: 100 });
    const loser = await waitForValue(`leaderboard/${bobProfile}`, (r) => !!r);
    expect(loser).toMatchObject({ name: bob.name, kills: 0, deaths: 1, wins: 0, score: 0 });

    // Shown on the lobby's Leaderboard tab, marked as us
    await alice.leave();
    await alice.page.getByRole('tab', { name: 'Leaderboard' }).click();
    const board = alice.page.locator('#panel-leaderboard');
    await expect(board.locator('h2')).toHaveText('Top 20 players');
    const mine = board.locator('tr.me');
    await expect(mine).toContainText(`${alice.name} (you)`);
    await expect(mine).toContainText('100');
    await expect(mine).toContainText('1'); // wins

    await Promise.all([db.del(`leaderboard/${aliceProfile}`), db.del(`leaderboard/${bobProfile}`)]);
  });

  test('medals for the top three, and your own row when outside the top 20', async ({ players }) => {
    const seeded = Array.from({ length: 21 }, (_, i) => `p_e2etop${String(i).padStart(4, '0')}`);
    const me = 'p_e2eme000000';
    try {
      await Promise.all(seeded.map((id, i) => db.put(`leaderboard/${id}`, {
        name: `Top ${i}`, kills: 100000 - i, deaths: 1, captures: 0, wins: 0, rounds: 1, score: (100000 - i) * 10,
      })));
      await db.put(`leaderboard/${me}`, { name: 'Me Myself', kills: 1, deaths: 1, captures: 0, wins: 0, rounds: 1, score: 10 });

      const p = await players.open('Me Myself');
      await p.context.addInitScript((id) => localStorage.setItem('fps-profile', id), me);
      await p.gotoLobby();
      await p.page.getByRole('tab', { name: 'Leaderboard' }).click();
      const board = p.page.locator('#panel-leaderboard');
      await expect(board.locator('tbody tr')).toHaveCount(20);
      await expect(board.locator('tbody tr').nth(0)).toContainText('🥇');
      await expect(board.locator('tbody tr').nth(0)).toContainText('Top 0');
      await expect(board.locator('tbody tr').nth(1)).toContainText('🥈');
      await expect(board.locator('tbody tr').nth(2)).toContainText('🥉');
      const outside = board.locator('tfoot tr.me');
      await expect(outside).toContainText('Me Myself (you)');
      await expect(outside.locator('.rank')).toHaveText('–');
    } finally {
      await Promise.all([...seeded, me].map((id) => db.del(`leaderboard/${id}`)));
    }
  });
});
