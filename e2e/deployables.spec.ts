import { waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

const withAbilities = (over = {}) => rules('ffa', { abilities: true, ...over });

async function use(p: Player, type: string): Promise<void> {
  const slot = await p.give(type);
  await p.page.keyboard.press(`Digit${slot + 1}`);
}

const count = (p: Player, field: 'walls' | 'turrets' | 'mines') =>
  p.page.evaluate((f) => {
    const g = (window as any).game;
    return f === 'walls' ? g.walls.list().length : f === 'turrets' ? g.turrets.list().length : g.mines.mines.size;
  }, field);

test.describe('deployables', () => {
  test('a barrier stops bullets until it breaks', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities());
    await alice.recordMessages();
    await bob.recordMessages();
    // Bob puts a barrier between them
    await use(bob, 'wall');
    await expect.poll(() => count(alice, 'walls')).toBe(1);

    // Shots hit the barrier, not Bob
    await alice.shoot(bob, { shots: 5 });
    await bob.page.waitForTimeout(500);
    expect((await bob.state()).hp).toBe(100);

    // 300 HP at 20 a hit
    await expect.poll(async () => {
      await alice.shoot(bob, { shots: 3 });
      return count(alice, 'walls');
    }, { timeout: 30_000 }).toBe(0);
    await expect.poll(() => alice.messages()).toContain('Barrier destroyed');
    await expect.poll(() => bob.messages()).toContain('Your barrier was destroyed');
    await expect.poll(() => count(bob, 'walls')).toBe(0);

    await alice.shoot(bob);
    await expect.poll(async () => (await bob.state()).hp).toBeLessThan(100);
  });

  test('a barrier goes away after 20 seconds', async ({ duel }) => {
    test.slow();
    const { alice, bob } = await duel(withAbilities());
    await use(bob, 'wall');
    await expect.poll(() => count(alice, 'walls')).toBe(1);
    await expect.poll(() => count(alice, 'walls'), { timeout: 35_000 }).toBe(0);
  });

  test('a turret shoots enemies in range and can be destroyed', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities({ health: 200 }));
    await alice.recordMessages();
    await bob.recordMessages();
    await use(alice, 'turret');
    await expect.poll(() => count(bob, 'turrets')).toBe(1);
    // It fires at Bob: 8 a shot
    await expect.poll(async () => (await bob.state()).hp, { timeout: 15_000 }).toBeLessThan(200);
    expect((200 - (await bob.state()).hp) % 8).toBe(0);

    const [x, y, z] = await bob.page.evaluate(() => (window as any).game.turrets.list()[0].group.position.toArray());
    await expect.poll(async () => {
      await bob.page.evaluate(async ([x, y, z]) => {
        const t = (window as any).game.test;
        for (let n = 0; n < 4;) {
          t.aimAtPoint(x, y + 0.7, z);
          if (t.fire()) n++;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }, [x, y, z]);
      return count(bob, 'turrets');
    }, { timeout: 30_000 }).toBe(0);
    await expect.poll(() => bob.messages()).toContain('Turret destroyed');
    await expect.poll(() => alice.messages()).toContain('Your turret was destroyed');
  });

  test('a mine arms, then blows up under an enemy', async ({ duel }) => {
    const { alice, bob } = await duel(withAbilities());
    await alice.teleport(0, 0, 18, 0);
    await use(alice, 'mine');
    await alice.teleport(4, 0, 18, 0);
    await alice.page.waitForTimeout(2_000); // arming
    await bob.teleport(0, 0, 18);
    await expect(bob.page.locator('#death-overlay')).toContainText(alice.name, { timeout: 15_000 });
    await expect.poll(async () => (await bob.hud()).death?.weapon ?? null).toBe('mine');
  });

  test("a player's turret goes when they leave", async ({ duel }) => {
    const { code, alice, bob, aliceId } = await duel(withAbilities({ health: 200 }));
    await use(alice, 'turret');
    await expect.poll(() => count(bob, 'turrets')).toBe(1);
    await alice.leave();
    await waitForValue(`rooms/${code}/players/${aliceId}`, (v) => v === null);
    await expect.poll(() => count(bob, 'turrets')).toBe(0);
  });
});
