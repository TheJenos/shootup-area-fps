import { db, serverNow, waitForValue } from './support/db';
import { expect, rules, test, type Fixtures } from './support/fixtures';
import type { Player } from './support/player';

type Team = 'red' | 'blue';
const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/** An S&D duel, once the first round's freeze is over: who attacks, who defends, and where the round lives */
async function snd(duel: Fixtures['duel'], limit = 3) {
  const d = await duel(rules('snd', { limit }), { positions: false });
  const path = `rooms/${d.code}/game/snd`;
  const round = await waitForValue(path, (s) => !!s && serverNow() >= s.at, 20_000);
  const atk = round.atk as Team;
  // Both in this round (a slow load can land after the freeze; the join grace still lets them play).
  for (const p of [d.alice, d.bob]) await expect.poll(async () => (await p.state()).alive).toBe(true);
  const aliceAttacks = (await d.alice.state()).team === atk;
  const [attacker, defender] = aliceAttacks ? [d.alice, d.bob] : [d.bob, d.alice];
  return { ...d, path, atk, def: other(atk), attacker, defender };
}

/** Make sure `attacker` has the bomb: it's handed to an attacker, or (if none was known yet) lies at their spawn to pick up */
async function takeBomb(attacker: Player, path: string) {
  await expect.poll(async () => {
    if ((await attacker.state()).carryingBomb) return true;
    const bomb = await db.get<any>(`${path}/bomb`);
    if (bomb && !bomb.by && typeof bomb.x === 'number') await attacker.teleport(bomb.x, bomb.y ?? 0, bomb.z);
    return false;
  }, { timeout: 20_000 }).toBe(true);
}

test.describe('search & destroy', () => {
  test('the attacker plants the bomb on a site and the defender defuses it', async ({ duel }) => {
    const { code, path, def, attacker, defender } = await snd(duel);
    await defender.recordMessages();
    await takeBomb(attacker, path);
    const sites = (await attacker.state()).sites!;
    await attacker.teleport(sites.a.x, sites.a.y, sites.a.z);
    await attacker.holdUntil(['KeyE'], (s) => s.game.snd?.bomb.plantedAt !== undefined, 30_000);
    const bomb = await waitForValue(`${path}/bomb`, (b) => b?.site === 'a' && typeof b.plantedAt === 'number');
    await expect.poll(() => defender.messages()).toContainEqual(expect.stringContaining('BOMB PLANTED'));

    await defender.teleport(bomb.x, bomb.y ?? 0, bomb.z + 1);
    await defender.holdUntil(['KeyE'], (s) => !!s.game.snd?.over, 30_000);
    const over = await waitForValue(`${path}/over`, (o) => !!o);
    expect(over).toMatchObject({ winner: def, why: 'defuse' });
    expect(await db.get(`rooms/${code}/game/score/${def}`)).toBe(1);
  });

  test('no plant away from a site', async ({ duel }) => {
    const { path, attacker } = await snd(duel);
    await takeBomb(attacker, path);
    await attacker.hold('KeyE', 5_000);
    expect((await db.get<any>(`${path}/bomb`))?.plantedAt).toBeUndefined();
  });

  test('the dead sit the round out; wiping out the other side wins rounds, sides swap, and the match ends', async ({ duel }) => {
    test.slow();
    const { code, path, atk, attacker, defender } = await snd(duel, 2);

    // Round 1: the attacker takes the defender out.
    const [x, y, z] = (await defender.state()).pos;
    await attacker.teleport(x + 4, y, z);
    await attacker.waitForRemote(defender, [x, y, z]);
    await attacker.kill(defender);
    expect(await waitForValue(`${path}/over`, (o) => !!o)).toMatchObject({ winner: atk, why: 'elim' });
    // No respawn timer: still down until the next round.
    await defender.page.waitForTimeout(2_000);
    expect((await defender.state()).alive).toBe(false);
    expect((await defender.hud()).death?.respawnIn).toBe(-1);

    // Round 2: everyone's back, and the teams have swapped sides (a match to 2 has one-round halves).
    const second = await waitForValue(path, (s) => s?.n === 1 && serverNow() >= s.at, 20_000);
    expect(second.atk).toBe(other(atk));
    await expect.poll(async () => (await defender.state()).alive).toBe(true);
    const [x2, y2, z2] = (await defender.state()).pos;
    await attacker.teleport(x2 + 4, y2, z2);
    await attacker.waitForRemote(defender, [x2, y2, z2]);
    await attacker.kill(defender);

    // Two rounds to the same team: that's the match.
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: atk, reason: 'score' });
    const name = atk === 'red' ? 'Red' : 'Blue';
    await expect(attacker.page.locator('#round-over h2')).toHaveText(`${name} team wins!`);
  });

  test('a bomb left ticking goes off, wins the round and takes those near it along', async ({ duel }) => {
    test.slow();
    const { path, atk, attacker, defender } = await snd(duel);
    await takeBomb(attacker, path);
    const sites = (await attacker.state()).sites!;
    await attacker.teleport(sites.b.x, sites.b.y, sites.b.z);
    await attacker.holdUntil(['KeyE'], (s) => s.game.snd?.bomb.plantedAt !== undefined, 30_000);
    // The defender stands close by without defusing.
    await defender.teleport(sites.b.x + 5, sites.b.y, sites.b.z);
    const over = await waitForValue(`${path}/over`, (o) => !!o, 60_000);
    expect(over).toMatchObject({ winner: atk, why: 'bomb' });
    await expect.poll(async () => (await defender.state()).alive).toBe(false);
  });
});
