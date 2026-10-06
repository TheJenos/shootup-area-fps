import { db, seedPickup, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

/** Put a pickup a step in front of the player, then step onto it */
async function walkOnto(p: Player, code: string, pickup: { type: string; uses?: number }): Promise<string> {
  const [x, , z] = (await p.state()).pos;
  await p.teleport(x, 0, z + 3);
  const id = await seedPickup(code, { ...pickup, x, z });
  await expect.poll(() => p.page.evaluate((id) => (window as any).game.pickups.typeOf(id), id)).toBe(pickup.type);
  await p.teleport(x, 0, z);
  return id;
}

test.describe('pickups', () => {
  test('abilities are picked up by walking over them', async ({ duel }) => {
    const { code, alice } = await duel();
    await alice.recordMessages();
    const id = await walkOnto(alice, code, { type: 'medkit' });
    await expect.poll(async () => (await alice.state()).slots[0]).toBe('medkit');
    await expect.poll(() => alice.messages()).toContain('Picked up Medkit');
    await waitForValue(`rooms/${code}/pickups/${id}`, (v) => v === null);
    await expect(alice.page.locator('#abilities .slot').first()).not.toHaveClass(/empty/);
  });

  test('with every slot full, abilities stay on the floor', async ({ duel }) => {
    const { code, alice } = await duel();
    await alice.recordMessages();
    for (const t of ['shield', 'speed', 'scan']) await alice.give(t);
    const id = await walkOnto(alice, code, { type: 'medkit' });
    await expect.poll(() => alice.messages()).toContain('Slots full — use an ability to make room');
    await alice.page.waitForTimeout(500);
    expect(await db.get(`rooms/${code}/pickups/${id}`)).toMatchObject({ type: 'medkit' });
  });

  test('ammo boxes: refused when full, restock when needed', async ({ duel }) => {
    // With ammo boxes off, the rifle never runs dry
    const { code, alice } = await duel(rules('ffa', { ammo: true }));
    await alice.recordMessages();
    const id = await walkOnto(alice, code, { type: 'ammo' });
    await expect.poll(() => alice.messages()).toContain('Ammo full');
    // Off the box, or it would refill us straight away
    await alice.teleport(8, 0, 6);

    // Use some of the reserve
    await alice.page.evaluate(async () => {
      const t = (window as any).game.test;
      for (let n = 0; n < 10;) {
        t.aimAtPoint(40, 1.5, 6);
        if (t.fire()) n++;
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    await alice.page.keyboard.press('KeyR');
    await expect.poll(async () => (await alice.state()).reserve).toBe(80);
    const box = await db.get(`rooms/${code}/pickups/${id}`);
    await alice.teleport(box.x, 0, box.z);
    await expect.poll(() => alice.messages()).toContain('Ammo restocked');
    await expect.poll(async () => (await alice.state()).reserve).toBeGreaterThan(80);
  });

  test('guns: E picks one up, Q switches, a different one swaps', async ({ duel }) => {
    const { code, alice } = await duel();
    await walkOnto(alice, code, { type: 'shotgun' });
    await expect(alice.page.locator('#gun-prompt')).toContainText('Pick up Shotgun');
    await alice.page.keyboard.press('KeyE');
    await expect.poll(async () => (await alice.state()).special).toBe('shotgun');
    await expect.poll(async () => (await alice.state()).gun).toBe('shotgun');
    await expect(alice.page.locator('#ammo .gun-slot')).toHaveCount(2);

    await alice.page.keyboard.press('KeyQ');
    await expect.poll(async () => (await alice.state()).gun).toBe('rifle');
    await alice.page.keyboard.press('KeyQ');
    await expect.poll(async () => (await alice.state()).gun).toBe('shotgun');

    // Swapping leaves the old gun on the floor
    await alice.teleport(8, 0, 6);
    await walkOnto(alice, code, { type: 'deagle' });
    await expect(alice.page.locator('#gun-prompt')).toContainText('Swap Shotgun for Deagle');
    await alice.page.keyboard.press('KeyE');
    await expect.poll(async () => (await alice.state()).special).toBe('deagle');
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.values(p).some((x: any) => x.type === 'shotgun'));
  });

  test('a picked-up gun is dropped when you die', async ({ duel }) => {
    // Loot only drops in modes with pickups
    const { code, alice, bob } = await duel(rules('ffa', { guns: true }));
    await walkOnto(bob, code, { type: 'sniper' });
    await bob.page.keyboard.press('KeyE');
    await expect.poll(async () => (await bob.state()).special).toBe('sniper');
    await bob.teleport(16, 0, 0, Math.PI / 2);
    await alice.waitForRemote(bob, [16, 0, 0]);
    await alice.kill(bob);
    await expect(bob.page.locator('#death-overlay')).toBeVisible();
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.values(p).some((x: any) => x.type === 'sniper' && x.uses > 0));
  });

  test('the leader keeps the map stocked, and someone takes over when they leave', async ({ duel }) => {
    test.slow();
    const { code, alice, bob } = await duel(rules('ffa', { guns: true, ammo: true, abilities: true }));
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.keys(p).length >= 3, 30_000);
    const leader = (await alice.state()).leader ? alice : bob;
    const other = leader === alice ? bob : alice;
    expect((await other.state()).leader).toBe(false);
    const types = Object.values((await db.get(`rooms/${code}/pickups`)) ?? {}).map((p: any) => p.type);
    expect(types.length).toBeGreaterThanOrEqual(3);

    await leader.leave();
    await db.del(`rooms/${code}/pickups`);
    await expect.poll(async () => (await other.state()).leader).toBe(true);
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.keys(p).length >= 1, 30_000);
  });
});
