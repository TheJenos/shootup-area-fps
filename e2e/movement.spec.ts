import { expect, rules, test, uniqueName } from './support/fixtures';
import type { Player } from './support/player';

/*
 * Frame rates are low on a software renderer and the game clamps each frame's time step, so game
 * time can run slower than the wall clock. These tests compare speeds and heights (which don't
 * depend on frame rate) rather than distances covered in a fixed time.
 */

/** Sample the player's state every frame for `ms` and keep the largest `pick` */
async function peak(p: Player, ms: number, pick: 'height' | 'speed'): Promise<number> {
  return p.page.evaluate(async ({ ms, pick }) => {
    const t = (window as any).game.test;
    const end = performance.now() + ms;
    let top = 0;
    while (performance.now() < end) {
      const s = t.state();
      top = Math.max(top, pick === 'height' ? s.pos[1] : s.speed);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return top;
  }, { ms, pick });
}

async function jumpApex(p: Player, ms = 4_000): Promise<number> {
  // A teleport leaves us airborne until the next physics step; jumping only works from the ground
  await expect.poll(async () => (await p.state()).onGround).toBe(true);
  const apex = peak(p, ms, 'height');
  // Hold jump until we're off the ground (a quick tap can fall between two slow frames), then let go
  // before landing so it doesn't jump again.
  await p.holdUntil(['Space'], (s) => s.pos[1] > 0.05, 5_000);
  return apex;
}

/** Top speed while holding `keys` */
async function topSpeed(p: Player, keys: string[] = ['KeyW']): Promise<number> {
  await p.teleport(0, 0, 18, 0);
  await p.page.waitForTimeout(300);
  for (const k of keys) await p.page.keyboard.down(k);
  // Long enough to reach full speed even when frames are slow
  const speed = await peak(p, 2_500, 'speed');
  for (const k of [...keys].reverse()) await p.page.keyboard.up(k);
  return speed;
}

async function soloIn(p: Player, code: string) {
  await p.gotoLobby();
  await p.joinByCode(code);
  await p.play();
}

test.describe('movement', () => {
  test('WASD moves the player, and the others see it', async ({ duel }) => {
    const { alice, bob, aliceId } = await duel();
    await alice.teleport(0, 0, 18, 0);
    await bob.waitForRemote(aliceId, [0, 0, 18]);
    const at = async () => (await alice.state()).pos;

    let pos = await at();
    const [x0, z0] = [pos[0], pos[2]];
    pos = (await alice.holdUntil(['KeyW'], (s) => s.pos[2] < z0 - 1)).pos;
    await alice.holdUntil(['KeyS'], (s) => s.pos[2] > pos[2] + 1);
    await alice.holdUntil(['KeyD'], (s) => s.pos[0] > x0 + 1);
    pos = await at();
    await alice.holdUntil(['KeyA'], (s) => s.pos[0] < pos[0] - 1);

    // Bob's copy of Alice follows her
    await bob.waitForRemote(aliceId, await at());
  });

  test('jump, crouch, sprint and slide', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Mover'));
    await soloIn(p, await rooms.seed(rules('ffa')));
    await p.teleport(0, 0, 18, 0);
    await p.page.waitForTimeout(300);

    expect(await jumpApex(p)).toBeGreaterThan(0.6);
    await expect.poll(async () => (await p.state()).onGround).toBe(true);

    await p.page.keyboard.down('ControlLeft');
    await expect.poll(async () => (await p.state()).stance).toBe('crouch');
    await p.page.keyboard.up('ControlLeft');
    await expect.poll(async () => (await p.state()).stance).toBe('stand');

    const walk = await topSpeed(p);
    const sprint = await topSpeed(p, ['ShiftLeft', 'KeyW']);
    expect(walk).toBeGreaterThan(2);
    expect(sprint).toBeGreaterThan(walk * 1.2);

    // Crouch while sprinting: a slide. It needs full sprint speed on the ground when crouch goes down,
    // so on a slow frame it can miss; give it a few goes.
    let slid = false;
    for (let attempt = 0; attempt < 4 && !slid; attempt++) {
      await p.teleport(0, 0, 18, 0);
      await p.page.waitForTimeout(400);
      await p.page.keyboard.down('ShiftLeft');
      await p.page.keyboard.down('KeyW');
      await expect.poll(async () => (await p.state()).speed).toBeGreaterThan(8.5);
      // The slide is short: watch every frame for it
      const stances = p.page.evaluate(async () => {
        const t = (window as any).game.test;
        const seen = new Set<string>();
        const end = performance.now() + 1_500;
        while (performance.now() < end) {
          seen.add(t.state().stance);
          await new Promise((r) => requestAnimationFrame(r));
        }
        return [...seen];
      });
      await p.page.keyboard.down('ControlLeft');
      slid = (await stances).includes('slide');
      for (const k of ['ControlLeft', 'KeyW', 'ShiftLeft']) await p.page.keyboard.up(k);
      await p.page.waitForTimeout(1_000); // slide cooldown
    }
    expect(slid).toBe(true);
  });

  test('gravity and speed rules change jumps and running', async ({ players, rooms }) => {
    const normal = await players.open(uniqueName('Earth'));
    const moon = await players.open(uniqueName('Moon'));
    await soloIn(normal, await rooms.seed(rules('ffa')));
    await soloIn(moon, await rooms.seed(rules('ffa', { gravity: 0.35, speed: 1.5 })));
    for (const p of [normal, moon]) {
      await p.teleport(0, 0, 18, 0);
      await p.page.waitForTimeout(300);
    }
    const low = await jumpApex(normal);
    const high = await jumpApex(moon, 8_000);
    expect(high).toBeGreaterThan(low * 1.8);

    const slow = await topSpeed(normal);
    const fast = await topSpeed(moon);
    expect(fast / slow).toBeGreaterThan(1.35);
  });
});
