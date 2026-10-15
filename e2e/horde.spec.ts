import { db, dropPlaceholder, serverNow, waitForValue } from './support/db';
import { expect, rules, test } from './support/fixtures';
import type { Player } from './support/player';

/*
 * Horde: everyone together against waves of zombie bots, which the room owner's computer brings on away
 * from the survivors. Clearing a wave starts the next after a break; whoever went down during it is back.
 * Everyone down at once ends the round.
 */

type Players = Record<string, { name: string; team?: string; color?: string; npc?: boolean; alive: boolean; x: number; y: number; z: number }>;
const zombiesIn = (p: Players | null) => Object.entries(p ?? {}).filter(([, v]) => v.npc);

/** Skip the rest of the break before the current wave */
async function startWave(code: string): Promise<number> {
  const rec = await waitForValue(`rooms/${code}/game/horde`, (v) => !!v, 30_000);
  await db.patch(`rooms/${code}/game/horde`, { at: serverNow() });
  return rec.wave as number;
}

/** Stand next to a living zombie until `done` (they hunt whoever is closest) */
async function goToZombies(p: Player, code: string, done: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await done()) return;
    const players = await db.get<Players>(`rooms/${code}/players`);
    const z = zombiesIn(players).find(([, v]) => v.alive);
    if (z && (await p.state()).alive) await p.teleport(z[1].x + 1.2, z[1].y, z[1].z);
    await p.page.waitForTimeout(700);
  }
  throw new Error('Timed out waiting near the zombies');
}

test.describe('horde', () => {
  test('zombies come on for a wave; clearing it brings the next; everyone down ends the round', async ({ players, rooms }) => {
    test.setTimeout(150_000);
    const code = await rooms.seed(rules('hrd', { health: 25 }));
    const alice = await players.open('AliceHorde');
    await alice.gotoLobby();
    await alice.joinByCode(code);
    await db.patch(`lobby/${code}`, { hostId: await alice.id() });
    await dropPlaceholder(code);
    await alice.play();
    await alice.recordMessages();
    expect((await alice.state()).team).toBe('blue');

    expect(await startWave(code)).toBe(1);
    const first = await waitForValue<Players>(`rooms/${code}/players`, (p) => zombiesIn(p).length >= 2, 30_000);
    const [zid, zombie] = zombiesIn(first)[0]!;
    expect(zombie).toMatchObject({ team: 'red', color: '#7fd650', npc: true });
    // Not players: the lobby doesn't count them, the scoreboard doesn't list them.
    expect((await db.get<Record<string, string>>(`lobby/${code}/members`))?.[zid]).toBeUndefined();
    expect((await alice.hud()).scoreboard.some((r: { id: string }) => r.id === zid)).toBe(false);
    await expect(alice.page.locator('#scorebar-wrap.horde')).toContainText('Wave 1');

    // Down to the last one: kill one and the wave is cleared.
    await db.patch(`rooms/${code}/game/horde`, { left: 1 });
    const end = Date.now() + 40_000;
    while ((await db.get<number>(`rooms/${code}/game/horde/wave`)) === 1 && Date.now() < end) {
      const at = await alice.page.evaluate((id) => (window as any).game.test.remotePos(id) as [number, number, number] | null, zid);
      if (at) await alice.teleport(at[0] + 4, at[1], at[2]);
      await alice.shoot(zid, { part: 'head', shots: 2, timeout: 2_000 });
    }
    await waitForValue(`rooms/${code}/game/horde`, (h) => h?.wave === 2, 10_000);
    await expect.poll(() => alice.messages()).toContainEqual(expect.stringContaining('WAVE 1 CLEARED'));

    // Wave 2: Alice stands among them until they get her. With nobody left standing, the horde wins.
    await startWave(code);
    await goToZombies(alice, code, async () => !!(await db.get(`rooms/${code}/game/ended`)));
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e, 10_000);
    expect(ended).toMatchObject({ winner: 'red' });
    expect(await db.get(`rooms/${code}/game/hordeBest`)).toBe(2);
    await expect(alice.page.locator('#round-over')).toContainText('Overrun on wave 2');
  });

  test('whoever goes down sits the wave out, and is back once it is cleared', async ({ duel }) => {
    test.setTimeout(150_000);
    const { code, alice, bob } = await duel(rules('hrd'), { positions: false });
    await startWave(code);
    await waitForValue<Players>(`rooms/${code}/players`, (p) => zombiesIn(p).length >= 1, 30_000);
    // Bob walks into them; Alice stays put, so the wave goes on.
    await goToZombies(bob, code, async () => !(await bob.state()).alive);
    await expect.poll(async () => (await bob.hud()).death?.untilWave).toBe(true);
    await bob.page.waitForTimeout(2_000);
    expect((await bob.state()).alive).toBe(false);
    expect((await alice.state()).alive).toBe(true);

    // The wave cleared: Bob is back for the break.
    await db.patch(`rooms/${code}/game/horde`, { left: 0 });
    await waitForValue(`rooms/${code}/game/horde`, (h) => h?.wave === 2, 10_000);
    await expect.poll(async () => (await bob.state()).alive, { timeout: 10_000 }).toBe(true);
  });
});
