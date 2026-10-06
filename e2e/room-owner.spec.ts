import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';

test.describe('room owner', () => {
  test('the owner ends the round early with another mode and map', async ({ duel }) => {
    const { code, alice, bob, aliceId, bobId } = await duel(rules('ffa'));
    // A seeded room has no creator: the member with the lowest id takes it.
    const hostId = await waitForValue(`lobby/${code}/hostId`, (id) => id === aliceId || id === bobId);
    const [owner, other] = hostId === aliceId ? [alice, bob] : [bob, alice];

    // Only the owner gets the button; everyone sees who it is.
    await other.openPauseMenu();
    await expect(other.page.locator('#pause-overlay .owner')).toContainText(owner.name);
    await expect(other.page.getByRole('button', { name: 'Change match' })).toHaveCount(0);

    await owner.openPauseMenu();
    await expect(owner.page.locator('#pause-overlay .owner')).toContainText('You own this room');
    await owner.page.getByRole('button', { name: 'Change match' }).click();
    const setup = owner.page.locator('#match-setup');
    await setup.getByRole('radio', { name: /Team Deathmatch/ }).click();
    await setup.getByLabel('Map seed').fill('OWNERTEST');
    await setup.getByRole('button', { name: 'End round & restart' }).click();
    await expect(setup).toBeHidden();

    const game = await waitForValue(`rooms/${code}/game`, (g) => g?.round === 1);
    expect(game).toMatchObject({ seed: 'OWNERTEST', rules: { base: 'tdm' } });
    expect(game.ended).toBeUndefined();
    expect(await db.get(`lobby/${code}`)).toMatchObject({ mode: 'tdm', seed: 'OWNERTEST', rules: { base: 'tdm' } });

    // Both switch to the new rules and end up on opposite teams, on the new map.
    for (const p of [alice, bob]) {
      await expect.poll(async () => (await p.state()).rules.base).toBe('tdm');
      await expect.poll(async () => (await p.state()).mapSeed).toBe('OWNERTEST');
    }
    await expect.poll(async () => (await alice.state()).team).not.toBeNull();
    const [a, b] = await Promise.all([alice.state(), bob.state()]);
    expect(a.team).not.toBe(b.team);
  });

  test('ownership passes on when the owner leaves', async ({ duel }) => {
    const { code, alice, bob, aliceId, bobId } = await duel(rules('ffa'));
    const hostId = await waitForValue(`lobby/${code}/hostId`, (id) => id === aliceId || id === bobId);
    const [owner, [heir, heirId]] = hostId === aliceId ? [alice, [bob, bobId] as const] : [bob, [alice, aliceId] as const];
    await owner.leave();
    await waitForValue(`lobby/${code}/hostId`, (id) => id === heirId);
    await heir.openPauseMenu();
    await expect(heir.page.getByRole('button', { name: 'Change match' })).toBeVisible();
  });
});
