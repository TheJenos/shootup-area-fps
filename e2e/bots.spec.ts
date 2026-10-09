import { db, dropPlaceholder, waitForValue, type RoomRules } from './support/db';
import { expect, rules, test } from './support/fixtures';
import { setRange } from './support/ui';
import type { Player } from './support/player';

/*
 * Bots: the room owner keeps a list of them (each at its own level), adds, changes and removes them
 * mid-game from the pause menu, and plays them on their own computer. They show up as ordinary players
 * with their level in their name ("Kai [Hard]"), everyone can see and shoot them, and they stay until the
 * owner takes them out. When the owner leaves, whoever owns the room next brings the same bots back.
 */

type Players = Record<string, { name: string; bot?: boolean; team?: string; alive: boolean; kills: number; deaths: number }>;
type Slot = { base: string; skill: string; team?: string };
const botsIn = (players: Players | null) => Object.entries(players ?? {}).filter(([id]) => id.startsWith('b_'));
const botNames = (players: Players | null) => botsIn(players).map(([, b]) => b.name).sort();

/** A seeded room with these bots on its list, and Alice in it, owning it and playing */
async function ownedRoom(
  open: (name: string) => Promise<Player>, seed: (r: RoomRules) => Promise<string>,
  r: RoomRules, bots: Record<string, Slot> = {}, name = 'AliceBots',
) {
  const code = await seed(r);
  let at = 1;
  for (const [id, b] of Object.entries(bots)) await db.put(`lobby/${code}/bots/${id}`, { ...b, at: at++ });
  const alice = await open(name);
  await alice.gotoLobby();
  await alice.joinByCode(code);
  // Alice owns the room, as its creator would: a seeded room has no owner yet.
  await db.patch(`lobby/${code}`, { hostId: await alice.id() });
  await dropPlaceholder(code);
  await alice.play();
  return { code, alice };
}

/** The pause menu's Bots panel (owner only) */
async function openBots(p: Player) {
  await p.openPauseMenu();
  await p.page.getByRole('button', { name: 'Bots', exact: true }).click();
  const panel = p.page.locator('#bots-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Shoot at a bot until it dies: bots wander (behind cover, too), so step up close before each shot. */
async function killBot(player: Player, code: string, id: string): Promise<void> {
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    const bot = await db.get<{ x: number; y: number; z: number; deaths: number }>(`rooms/${code}/players/${id}`);
    if (bot && bot.deaths > 0) return;
    const at = await player.page.evaluate((bid) => (window as any).game.test.remotePos(bid) as [number, number, number] | null, id);
    if (at) await player.teleport(at[0] + 2.5, at[1], at[2]);
    await player.shoot(id, { part: 'body', shots: 3, timeout: 2_000 });
  }
  throw new Error(`${player.name} couldn't kill ${id}`);
}

test.describe('bots', () => {
  test('the owner adds bots mid-game at different levels, changes and removes them; they stay when people join', async ({ players, rooms }) => {
    test.setTimeout(150_000);
    const { code, alice } = await ownedRoom((n) => players.open(n), (r) => rooms.seed(r), rules('tdm', { limit: 150 }));
    expect(botsIn(await db.get<Players>(`rooms/${code}/players`))).toHaveLength(0);

    // Two bots: an Easy one on Blue, and an Expert one on whichever side needs it.
    const panel = await openBots(alice);
    await expect(panel.getByText(/No bots in this room/)).toBeVisible();
    await panel.getByLabel('New bot level').selectOption('easy');
    await panel.getByLabel('New bot team').selectOption('blue');
    await panel.getByRole('button', { name: 'Add bot' }).click();
    await expect(panel.locator('.bots-list li')).toHaveCount(1);
    await panel.getByLabel('New bot level').selectOption('expert');
    await panel.getByLabel('New bot team').selectOption('');
    await panel.getByRole('button', { name: 'Add bot' }).click();
    await expect(panel.locator('.bots-list li')).toHaveCount(2);
    await expect(panel.locator('h3 .count')).toHaveText('2 / 12');

    // They join straight away, as players, with their level in their name.
    const two = await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 2, 30_000);
    const easy = botsIn(two).find(([, b]) => / \[Easy\]$/.test(b.name));
    const expert = botsIn(two).find(([, b]) => / \[Expert\]$/.test(b.name));
    expect(easy, botNames(two).join(', ')).toBeTruthy();
    expect(expert, botNames(two).join(', ')).toBeTruthy();
    expect(easy![1].bot).toBe(true);
    expect(easy![1].team).toBe('blue');
    await expect.poll(() => db.get(`lobby/${code}/members/${easy![0]}`)).toBe(easy![1].name);
    await expect(panel.locator('.bots-list li').filter({ hasText: '[Easy]' })).toContainText(/\d+ – \d+/);

    // Easy becomes Hard: the same bot, renamed.
    const base = easy![1].name.replace(/ \[Easy\]$/, '');
    await panel.getByLabel(`${base}'s level`).selectOption('hard');
    await expect.poll(async () => (await db.get<{ name: string }>(`rooms/${code}/players/${easy![0]}`))?.name).toBe(`${base} [Hard]`);
    await expect.poll(() => db.get(`lobby/${code}/members/${easy![0]}`)).toBe(`${base} [Hard]`);

    // The Expert one goes.
    const expertBase = expert![1].name.replace(/ \[Expert\]$/, '');
    await panel.getByRole('button', { name: `Remove ${expertBase}` }).click();
    await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 1, 20_000);
    await expect.poll(() => db.get(`lobby/${code}/members/${expert![0]}`)).toBeNull();
    await expect(panel.locator('.bots-list li')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Back' }).click();
    await expect(panel).toBeHidden();

    // Someone joins: the bot stays.
    const bob = await players.open('BobBots');
    await bob.gotoLobby();
    await bob.joinByCode(code);
    await bob.play();
    await expect.poll(async () => (await bob.page.evaluate(() => (window as any).game.test.remoteIds())).filter((id: string) => id.startsWith('b_')).length).toBe(1);
    await bob.page.waitForTimeout(2_000);
    expect(botNames(await db.get<Players>(`rooms/${code}/players`))).toEqual([`${base} [Hard]`]);
    // Only the owner gets the Bots button.
    await bob.openPauseMenu();
    await expect(bob.page.getByRole('button', { name: 'Bots', exact: true })).toHaveCount(0);
  });

  test('bots can be shot, and the next owner brings them back when the owner leaves', async ({ players, rooms }) => {
    test.setTimeout(150_000);
    const { code, alice } = await ownedRoom((n) => players.open(n), (r) => rooms.seed(r), rules('tdm', { limit: 150 }), {
      s_one: { base: 'Kai', skill: 'normal' },
      s_two: { base: 'Ava', skill: 'hard' },
    });
    const full = await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 2, 45_000);
    expect(botNames(full)).toEqual(['Ava [Hard]', 'Kai [Normal]']);

    // Shooting an enemy bot kills it: the owner's client applies the damage and reports the death.
    // (Bots on patrol never stand still long enough to "settle": just wait for it to be drawn.)
    const aliceTeam = full![await alice.id()]!.team;
    const enemy = botsIn(full).find(([, b]) => b.team !== aliceTeam);
    expect(enemy, 'a bot on the other team').toBeTruthy();
    const [botId] = enemy!;
    await expect.poll(() => alice.page.evaluate((id) => (window as any).game.test.remoteIds().includes(id), botId)).toBe(true);
    await killBot(alice, code, botId);
    await expect.poll(async () => (await alice.state()).kills).toBeGreaterThan(0);

    // Bob joins, then Alice leaves: her bots go with her, and Bob (the new owner) brings the same ones back.
    const bob = await players.open('BobBots2');
    await bob.gotoLobby();
    await bob.joinByCode(code);
    await bob.play();
    const old = botsIn(await db.get<Players>(`rooms/${code}/players`)).map(([id]) => id);
    await alice.leave();
    const after = await waitForValue<Players>(`rooms/${code}/players`, (p) => {
      const ids = botsIn(p).map(([id]) => id);
      return ids.length === 2 && ids.every((id) => !old.includes(id));
    }, 45_000);
    expect(botNames(after)).toEqual(['Ava [Hard]', 'Kai [Normal]']);
  });

  test('a new room can start with bots', async ({ players, rooms }) => {
    test.setTimeout(120_000);
    const p = await players.open('Creator');
    await p.gotoLobby();
    await p.page.getByRole('tab', { name: 'Create room' }).click();
    await p.page.getByRole('radio', { name: /Team Deathmatch/ }).first().click();
    await setRange(p.page.getByLabel('Start with bots'), 3);
    await p.page.getByLabel('Bot skill').selectOption('expert');
    const code = rooms.track(await p.createRoom());
    const list = (await db.get<Record<string, Slot>>(`lobby/${code}/bots`)) ?? {};
    expect(Object.values(list).map((b) => b.skill)).toEqual(['expert', 'expert', 'expert']);
    await p.play();
    const three = await waitForValue<Players>(`rooms/${code}/players`, (q) => botsIn(q).length === 3, 45_000);
    expect(botNames(three).every((n) => / \[Expert\]$/.test(n))).toBe(true);
  });

  test('pick up guns and abilities, and use them', async ({ players, rooms }) => {
    test.setTimeout(180_000);
    // Pickups on: Alice (the only person, so the leader) keeps the map stocked; three bots go shopping.
    const { code } = await ownedRoom((n) => players.open(n), (r) => rooms.seed(r), rules('ffa', { limit: 60, guns: true, abilities: true, ammo: true }), {
      s_a: { base: 'Kai', skill: 'hard' }, s_b: { base: 'Ava', skill: 'hard' }, s_c: { base: 'Rex', skill: 'hard' },
    }, 'AliceShop');
    await waitForValue<Players>(`rooms/${code}/players`, (p) => botsIn(p).length === 3, 45_000);
    // Any bot seen with a picked-up gun, a throw, a shield or a cloak will do.
    type Gear = { gun?: string; th?: number; shield?: boolean; cloak?: boolean };
    const geared = (p: Players | null) => botsIn(p).some(([, b]) => {
      const g = b as unknown as Gear;
      return (g.gun && g.gun !== 'rifle') || (g.th ?? 0) > 0 || g.shield || g.cloak;
    });
    const seen = await waitForValue<Players>(`rooms/${code}/players`, geared, 150_000);
    expect(geared(seen)).toBe(true);
  });

  test('a room without bots gets none', async ({ duel }) => {
    const { code } = await duel(rules('ffa'));
    await new Promise((r) => setTimeout(r, 2_500));
    expect(botsIn(await db.get<Players>(`rooms/${code}/players`))).toHaveLength(0);
  });
});
