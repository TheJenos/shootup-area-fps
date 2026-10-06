import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('team deathmatch', () => {
  test('players are split into teams, and kills score for the team', async ({ duel }) => {
    const { code, alice, bob, aliceId, bobId } = await duel(rules('tdm', { respawn: 1 }));
    const [a, b] = [(await alice.state()).team, (await bob.state()).team];
    expect(a).toMatch(/red|blue/);
    expect(b).toBe(a === 'red' ? 'blue' : 'red');
    expect(await db.get(`rooms/${code}/players/${aliceId}/team`)).toBe(a);
    expect(await db.get(`rooms/${code}/players/${bobId}/team`)).toBe(b);
    await expect(alice.page.locator(`#scorebar .team.${a}`)).toHaveClass(/mine/);

    await alice.kill(bob);
    await waitForValue(`rooms/${code}/game/score/${a}`, (s) => s === 1);
    await expect(alice.page.locator(`#scorebar .team.${a}`)).toContainText('1');
    await expect(bob.page.locator(`#scorebar .team.${a}`)).toContainText('1');
  });

  test('switching teams from the pause menu', async ({ duel }) => {
    const { code, bob, bobId } = await duel(rules('tdm'));
    const before = (await bob.state()).team!;
    const other = before === 'red' ? 'blue' : 'red';
    await bob.openPauseMenu();
    await expect(bob.page.locator('#pause-overlay')).toContainText(`You're on ${before === 'red' ? 'Red' : 'Blue'}`);
    await bob.page.getByRole('button', { name: `Switch to ${other === 'red' ? 'Red' : 'Blue'}` }).click();
    await expect.poll(async () => (await bob.state()).team).toBe(other);
    await waitForValue(`rooms/${code}/players/${bobId}/team`, (t) => t === other);
  });

  test('the kill that reaches the limit wins it for the team', async ({ duel }) => {
    const { code, alice, bob } = await duel(rules('tdm', { limit: 10 }));
    const team = (await alice.state()).team!;
    const teamName = team === 'red' ? 'Red' : 'Blue';
    await db.put(`rooms/${code}/game/score/${team}`, 9);
    await expect(alice.page.locator(`#scorebar .team.${team}`)).toContainText('9');
    await alice.kill(bob);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: team, reason: 'score' });
    await expect(alice.page.locator('#round-over h2')).toHaveText(`${teamName} team wins!`);
    await expect(alice.page.locator('#round-over')).toHaveClass(/won/);
    await expect(bob.page.locator('#round-over')).toHaveClass(/lost/);
  });
});
