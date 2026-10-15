import { db, dropPlaceholder, expireClock, serverNow, waitForValue } from './support/db';
import { expect, rules, test, type Fixtures } from './support/fixtures';
import type { Player } from './support/player';

/*
 * Infection: everyone starts a survivor; after a head start one of them turns. Zombies have only claws
 * (one swipe takes a survivor down) and whoever they kill comes back as one of them. The zombies win when
 * nobody's left to infect, the survivors if anyone is still standing when the clock runs out.
 */

/** Most of the 15 s head start, skipped: the round's clock is moved back so the outbreak comes in a second */
const skipHeadStart = (code: string) => db.put(`rooms/${code}/game/startedAt`, serverNow() - 14_000);

/** An infection duel once the outbreak has come: who turned, who's left */
async function outbreak(duel: Fixtures['duel'], over: Parameters<typeof rules>[1] = {}) {
  const d = await duel(rules('inf', over));
  await skipHeadStart(d.code);
  const inf = await waitForValue(`rooms/${d.code}/game/inf`, (v) => !!v?.alpha, 20_000);
  const zombieId = Object.keys(inf!.alpha)[0]!;
  const alphaIsAlice = zombieId === d.aliceId;
  const [zombie, survivor] = alphaIsAlice ? [d.alice, d.bob] : [d.bob, d.alice];
  const survivorId = alphaIsAlice ? d.bobId : d.aliceId;
  await expect.poll(async () => (await zombie.state()).team).toBe('red');
  return { ...d, zombie, survivor, zombieId, survivorId };
}

/** Step up next to `target` and swipe once the claws are ready */
async function swipe(zombie: Player, target: Player, targetId: string): Promise<void> {
  const [x, y, z] = (await target.state()).pos;
  const [zx] = (await zombie.state()).pos;
  const side = zx > x ? 1 : -1;
  await zombie.teleport(x + side * 1.4, y, z, side > 0 ? Math.PI / 2 : -Math.PI / 2);
  // (The camera follows on the next frame.)
  await zombie.page.waitForTimeout(200);
  await zombie.page.evaluate((id) => (window as any).game.test.aimAt(id), targetId);
  await expect.poll(() => zombie.page.evaluate(() => (window as any).game.test.fire())).toBe(true);
}

test.describe('infection', () => {
  test('after the head start one turns; a swipe of the claws infects the last survivor and the zombies win', async ({ duel }) => {
    const { code, zombie, survivor, zombieId, survivorId } = await outbreak(duel);
    // The first zombie: tougher, claws in hand, in the zombies' colour; everyone sees the sides.
    const z = await zombie.state();
    expect(z.claws).toBe(true);
    expect(z.maxHp).toBe(200);
    await waitForValue(`rooms/${code}/players/${zombieId}`, (p) => p?.team === 'red' && p?.color === '#7fd650');
    expect((await survivor.state()).claws).toBe(false);
    await expect(survivor.page.locator('#scorebar-wrap.inf')).toContainText('Zombies');
    await expect(zombie.page.locator('#ammo.claws')).toBeVisible();

    await swipe(zombie, survivor, survivorId);
    await expect.poll(async () => (await survivor.state()).alive).toBe(false);
    // (Read from the HUD's state: on screen the kill cam or, a moment later, the round's results cover it.)
    await expect.poll(async () => (await survivor.hud()).death?.infected).toBe(true);
    await expect(zombie.page.locator('#killfeed')).toContainText('🧟');

    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e, 15_000);
    expect(ended).toMatchObject({ winner: 'red', reason: 'score' });
    await expect(survivor.page.locator('#round-over')).toContainText('Everyone was infected');
  });

  test('a survivor still standing when the clock runs out wins it for the survivors', async ({ duel }) => {
    const { code, survivor } = await outbreak(duel, { minutes: 3 });
    await expireClock(code, 3, 1_000);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e, 15_000);
    expect(ended).toMatchObject({ winner: 'blue', reason: 'time' });
    await expect(survivor.page.locator('#round-over')).toContainText('The survivors held out');
  });

  test('zombie bots hunt the survivor bots down', async ({ players, rooms }) => {
    test.setTimeout(150_000);
    const code = await rooms.seed(rules('inf', { minutes: 10 }));
    const slots = { a: 'Kai', b: 'Mo', c: 'Ren' };
    let at = 1;
    for (const [id, base] of Object.entries(slots)) await db.put(`lobby/${code}/bots/${id}`, { base, skill: 'easy', at: at++ });
    const alice = await players.open('AliceInf');
    await alice.gotoLobby();
    await alice.joinByCode(code);
    await db.patch(`lobby/${code}`, { hostId: await alice.id() });
    await dropPlaceholder(code);
    await alice.play();
    // Alice only watches (her computer plays the bots): the bots infect each other.
    await alice.page.evaluate(() => (window as any).game.startSpectating());
    const bots = (p: Record<string, { team?: string }> | null) => Object.entries(p ?? {}).filter(([id]) => id.startsWith('b_'));
    await waitForValue(`rooms/${code}/players`, (p) => bots(p).length === 3, 30_000);

    await skipHeadStart(code);
    await waitForValue(`rooms/${code}/game/inf`, (v) => !!v?.alpha, 20_000);
    // The first zombie catches at least one of the others.
    await waitForValue(`rooms/${code}/players`, (p) => bots(p).filter(([, b]) => b.team === 'red').length >= 2, 90_000);
  });
});
