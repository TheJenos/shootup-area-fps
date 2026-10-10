import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('free-for-all scoring', () => {
  test('taking and losing the lead', async ({ duel }) => {
    const { alice, bob } = await duel(rules('ffa', { respawn: 1 }));
    await alice.recordMessages();
    await bob.recordMessages();

    await alice.kill(bob);
    await expect.poll(() => alice.messages()).toContainEqual(expect.stringContaining('YOU TOOK THE LEAD'));
    await expect.poll(() => bob.messages()).toContainEqual(expect.stringContaining(`👑 ${alice.name} took the lead (1 kill)`));
    await expect(alice.page.locator('#scorebar .you')).toHaveClass(/leading/);

    // Bob pulls ahead with two kills
    for (let i = 0; i < 2; i++) {
      await expect.poll(async () => (await alice.state()).alive, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await bob.state()).alive, { timeout: 15_000 }).toBe(true);
      await alice.teleport(8, 0, 0, -Math.PI / 2);
      await bob.teleport(16, 0, 0, Math.PI / 2);
      await bob.waitForRemote(alice, [8, 0, 0]);
      await bob.kill(alice);
    }
    await expect.poll(() => alice.messages()).toContainEqual(expect.stringContaining(`LEAD LOST ${bob.name} took the lead · 2 kills`));
    await expect.poll(() => bob.messages()).toContainEqual(expect.stringContaining('YOU TOOK THE LEAD'));
  });

  test('reaching the kill limit ends the round, then the next one starts', async ({ duel }) => {
    test.slow();
    const { code, alice, bob, aliceId } = await duel(rules('ffa', { limit: 5, respawn: 1 }));
    await db.put(`rooms/${code}/players/${aliceId}/kills`, 4);
    await expect.poll(async () => (await alice.state()).kills).toBe(4);
    await expect(alice.page.locator('#scorebar .you')).toContainText('4');

    await alice.kill(bob);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: aliceId, name: alice.name, reason: 'score' });

    const over = alice.page.locator('#round-over');
    await expect(over).toContainText('Score limit reached');
    await expect(over.locator('h2')).toHaveText('You win!');
    await expect(over).toHaveClass(/won/);
    await expect(over.locator('ol.podium li').first()).toContainText(alice.name);
    await expect(over.locator('ol.podium li').first()).toContainText('5 K / 0 D');
    await expect(bob.page.locator('#round-over h2')).toHaveText(`${alice.name} wins!`);
    await expect(bob.page.locator('#round-over')).toHaveClass(/lost/);
    // Nobody can shoot between rounds
    expect(await alice.page.evaluate(() => (window as any).game.test.fire())).toBe(false);

    // Alice made the only kills, so she's MVP; then the next map loads
    await expect(alice.page.locator('#mvp')).toContainText(`${alice.name} (you)`, { timeout: 15_000 });
    await expect(bob.page.locator('#mvp h2')).toHaveText(alice.name);
    await alice.recordMessages();
    const next = await waitForValue(`rooms/${code}/game`, (g) => g?.round === 1, 40_000);
    expect(next.ended).toBeUndefined();
    expect(next.seed).toBe(ended.nextSeed);
    await expect.poll(async () => (await alice.state()).mapSeed).toBe(next.seed);
    await expect.poll(async () => (await alice.state()).kills).toBe(0);
    await expect.poll(() => alice.messages()).toContainEqual(expect.stringMatching(/^Round 2 · .* — fight!$/));
    await expect(alice.page.locator('#round-over')).toHaveCount(0);
    await waitForValue(`lobby/${code}/seed`, (s) => s === next.seed);
    // Everyone respawns at once on the new map, spread apart rather than on the same spot.
    const [a, b] = await Promise.all([alice.state(), bob.state()]);
    expect(Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2])).toBeGreaterThan(10);
  });
});
