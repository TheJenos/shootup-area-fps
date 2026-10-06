import { db, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

/** Abilities on (they're inventory items), nothing spawning on its own */
const withAbilities = (over = {}) => rules('ffa', { abilities: true, ...over });

/** Give `type` and press the slot key it landed in */
async function use(p: Player, type: string): Promise<void> {
  const slot = await p.give(type);
  expect(slot).toBeGreaterThanOrEqual(0);
  await expect(p.page.locator('#abilities .slot').nth(slot)).not.toHaveClass(/empty/);
  await p.page.keyboard.press(`Digit${slot + 1}`);
}

test.describe('abilities', () => {
  test('slots: an empty slot says so, a used ability cools down', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities());
    await alice.recordMessages();
    await alice.page.keyboard.press('Digit2');
    await expect.poll(() => alice.messages()).toContain('Empty slot — pick up an ability');

    // A medkit is refused at full health and kept
    await alice.give('medkit');
    await alice.page.keyboard.press('Digit1');
    await expect.poll(() => alice.messages()).toContain('Already at full health');
    expect((await alice.state()).slots[0]).toBe('medkit');

    // Hurt, it heals 50, then cools down
    await bob.shoot(alice, { part: 'head' });
    await expect.poll(async () => (await alice.state()).hp).toBe(50);
    await alice.page.keyboard.press('Digit1');
    await expect.poll(async () => (await alice.state()).hp).toBe(100);
    await expect(alice.page.locator('#abilities .slot').first()).toHaveClass(/cooling/);
    await alice.page.waitForTimeout(800);
    await alice.page.keyboard.press('Digit1');
    await expect.poll(() => alice.messages()).toContainEqual(expect.stringMatching(/^Medkit ready in [\d.]+ s$/));
  });

  test('the inventory lists abilities and drops them as pickups', async ({ duel }) => {
    const { code, alice } = await duel(withAbilities());
    await alice.give('shield');
    await alice.give('grenade');
    await alice.page.keyboard.press('KeyI');
    const inv = alice.page.getByRole('dialog', { name: 'Inventory' });
    await expect(inv).toBeVisible();
    await expect(inv).toContainText('Shield');
    await expect(inv).toContainText('Grenade');
    await inv.locator('.items .item', { hasText: 'Shield' }).getByRole('button', { name: 'Drop' }).click();
    await expect(inv).not.toContainText('Shield');
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.values(p).some((x: any) => x.type === 'shield'));
    await alice.page.keyboard.press('KeyI');
    await expect(inv).toBeHidden();
  });

  test('shield soaks up damage', async ({ duel }) => {
    const { code, alice, bob, aliceId } = await duel(withAbilities());
    await use(alice, 'shield');
    await waitForValue(`rooms/${code}/players/${aliceId}/shield`, (s) => s === true);
    await expect(alice.page.locator('#abilities .buff.shield')).toBeVisible();
    await bob.shoot(alice, { part: 'body' });
    await expect.poll(async () => (await alice.state()).shield).toBe(30);
    expect((await alice.state()).hp).toBe(100);
    // 30 left; a headshot (50) breaks it and does the rest
    await bob.shoot(alice, { part: 'head' });
    await expect.poll(async () => (await alice.state()).hp).toBe(80);
    await expect(alice.page.locator('#abilities .buff.shield')).toHaveCount(0);
  });

  test('speed boost and dash make you faster', async ({ duel }) => {
    const { alice } = await duel(withAbilities());
    await use(alice, 'speed');
    await expect(alice.page.locator('#abilities .buff.speed')).toBeVisible();
    await alice.teleport(0, 0, 18, 0);
    await alice.page.keyboard.down('KeyW');
    await expect.poll(async () => (await alice.state()).speed).toBeGreaterThan(7);
    await alice.page.keyboard.up('KeyW');

    await alice.teleport(0, 0, 18, 0);
    await alice.page.waitForTimeout(300);
    await use(alice, 'dash');
    await expect.poll(async () => (await alice.state()).speed, { intervals: [20] }).toBeGreaterThan(10);
  });

  test('cloak hides you until you shoot', async ({ duel }) => {
    const { code, alice, bob, aliceId } = await duel(withAbilities());
    await use(alice, 'cloak');
    await expect(alice.page.locator('#hud')).toHaveClass(/cloaked/);
    await waitForValue(`rooms/${code}/players/${aliceId}/cloak`, (c) => c === true);
    await expect.poll(() => bob.page.evaluate((id) => (window as any).game.remotes.get(id)?.cloaked, aliceId)).toBe(true);
    await alice.shoot(bob);
    await expect(alice.page.locator('#hud')).not.toHaveClass(/cloaked/);
    await waitForValue(`rooms/${code}/players/${aliceId}/cloak`, (c) => !c);
  });

  test('lifesteal heals you from the damage you deal', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities());
    await bob.shoot(alice, { part: 'head' });
    await expect.poll(async () => (await alice.state()).hp).toBe(50);
    await use(alice, 'lifesteal');
    await expect(alice.page.locator('#abilities .buff.lifesteal')).toBeVisible();
    await alice.shoot(bob, { part: 'head' });
    // 30% of 50
    await expect.poll(async () => (await alice.state()).hp).toBe(65);
  });

  test('scan pulse shows enemies through walls', async ({ duel }) => {
    const { alice, bobId } = await duel(withAbilities());
    await use(alice, 'scan');
    await expect(alice.page.locator('#abilities .buff.scan')).toBeVisible();
    await expect.poll(() => alice.page.evaluate((id) => (window as any).game.remotes.get(id)?.scanned, bobId)).toBeTruthy();
  });

  test('a grenade hurts enemies in the blast', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities({ health: 200 }));
    // Bob stands a few metres off; Alice lobs it at the floor by his feet
    await bob.teleport(12, 0, 0, Math.PI / 2);
    await alice.waitForRemote(bob, [12, 0, 0]);
    await alice.face(11, -6, 0);
    await use(alice, 'grenade');
    await expect.poll(async () => (await bob.state()).hp, { timeout: 10_000 }).toBeLessThan(200);
  });

  test('smoke, molotov and flashbang go off where they land', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities({ health: 200 }));
    await bob.teleport(12, 0, 0, Math.PI / 2);
    await alice.waitForRemote(bob, [12, 0, 0]);

    // Molotov: once it's burning, Bob walks into it and burns while he stands there
    await alice.face(11.5, -6, 0);
    await use(alice, 'molotov');
    const fireAt = () => bob.page.evaluate(() => {
      const f = [...(window as any).game.fires.fires.values()][0];
      return f ? (f.center.toArray() as [number, number, number]) : null;
    });
    await expect.poll(fireAt, { timeout: 10_000 }).not.toBeNull();
    const fire = (await fireAt())!;
    await bob.teleport(fire[0], fire[1], fire[2]);
    await expect.poll(async () => (await bob.state()).hp, { timeout: 10_000 }).toBeLessThan(200);
    // Fire burns in ticks of 8
    expect((200 - (await bob.state()).hp) % 8).toBe(0);
    await bob.teleport(12, 0, 0, Math.PI / 2);

    // Flashbang in front of Bob, who's looking at it
    await bob.page.evaluate(() => (window as any).game.test.aimAtPoint(8, 1.6, 0));
    await alice.face(10, -1, 0);
    await use(alice, 'flash');
    await expect.poll(async () => (await bob.hud()).flash?.strength ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

    await alice.face(11, -2, 0);
    await use(alice, 'smoke');
    await expect.poll(() => bob.page.evaluate(() => (window as any).game.smoke.smokes.size), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('carrying the flag, you cannot throw', async ({ duel }) => {
    const { alice } = await duel(rules('ctf', { abilities: true }), { positions: false });
    await alice.recordMessages();
    const team = (await alice.state()).team;
    await alice.teleport(0, 0, team === 'red' ? -32 : 32);
    await expect.poll(async () => (await alice.state()).carryingFlag).toBe(true);
    await use(alice, 'grenade');
    await expect.poll(() => alice.messages()).toContain("Hands full — you can't throw while carrying the flag");
  });

  test('abilities fall on the floor when you die', async ({ duel }) => {
    const { code, alice, bob } = await duel(withAbilities());
    await bob.give('turret');
    await alice.kill(bob);
    await waitForValue(`rooms/${code}/pickups`, (p) => !!p && Object.values(p).some((x: any) => x.type === 'turret'));
    expect(await db.get(`rooms/${code}/pickups`)).toBeTruthy();
  });
});
