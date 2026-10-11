import { db, dropPlaceholder, serverNow, waitForValue } from './support/db';
import { expect, rules, test, uniqueName, type Fixtures } from './support/fixtures';
import type { Player } from './support/player';

const BASE = { red: [0, 0, 32], blue: [0, 0, -32] } as const;
type Team = 'red' | 'blue';
const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/** A CTF duel with each player's team and the enemy flag's database path */
async function ctf(duel: Fixtures['duel'], limit = 3) {
  const d = await duel(rules('ctf', { limit, respawn: 1 }), { positions: false });
  const aTeam = (await d.alice.state()).team as Team;
  return { ...d, aTeam, bTeam: other(aTeam), flagPath: `rooms/${d.code}/game/flags/${other(aTeam)}` };
}

/** Walk onto the enemy base, which takes their flag */
async function grab(p: Player, team: Team) {
  const [x, y, z] = BASE[other(team)];
  await p.teleport(x, y, z);
  await expect.poll(async () => (await p.state()).carryingFlag).toBe(true);
}

test.describe('capture the flag', () => {
  test('taking the enemy flag: melee mode, everyone is told', async ({ duel }) => {
    const { alice, bob, aliceId, aTeam, flagPath } = await ctf(duel);
    await bob.recordMessages();
    await grab(alice, aTeam);
    await waitForValue(flagPath, (f) => f?.by === aliceId);
    await expect(alice.page.locator('#ammo')).toHaveClass(/melee/);
    await expect(alice.page.locator('#ammo')).toContainText('MELEE');
    await expect.poll(() => bob.messages()).toContainEqual(expect.stringContaining(`${alice.name} took the`));
    // The remote carrier shows it
    await expect.poll(() => bob.page.evaluate((id) => (window as any).game.remotes.get(id)?.carryingFlag, aliceId)).toBe(true);
  });

  test('E puts the flag down; the other team returns it by touching it', async ({ duel }) => {
    const { alice, bob, aTeam, flagPath } = await ctf(duel);
    await grab(alice, aTeam);
    await alice.page.keyboard.press('KeyE');
    await expect.poll(async () => (await alice.state()).carryingFlag).toBe(false);
    const dropped = await waitForValue(flagPath, (f) => typeof f?.x === 'number');
    // Standing on it doesn't pick it straight back up
    await alice.page.waitForTimeout(1_000);
    expect((await alice.state()).carryingFlag).toBe(false);

    // Its own team touches it: back to base
    await alice.teleport(10, 0, 0);
    await bob.teleport(dropped.x, 0, dropped.z);
    await waitForValue(flagPath, (f) => f === null);
  });

  test('dying drops the flag where the carrier fell', async ({ duel }) => {
    const { alice, bob, aTeam, flagPath } = await ctf(duel);
    await grab(alice, aTeam);
    const [x, , z] = (await alice.state()).pos;
    await bob.teleport(x + 4, 0, z);
    await bob.waitForRemote(alice, [x, 0, z]);
    await bob.kill(alice);
    const f = await waitForValue(flagPath, (f) => typeof f?.x === 'number');
    expect(Math.hypot(f.x - x, f.z - z)).toBeLessThan(2);
  });

  test('a dropped flag goes home by itself after 20 seconds', async ({ duel }) => {
    test.slow();
    const { alice, aTeam, flagPath } = await ctf(duel);
    await grab(alice, aTeam);
    await alice.page.keyboard.press('KeyE');
    await waitForValue(flagPath, (f) => typeof f?.x === 'number');
    await alice.teleport(10, 0, 0);
    await waitForValue(flagPath, (f) => f === null, 40_000);
  });

  test('objective markers point at the enemy flag, and at ours once it is taken', async ({ duel }) => {
    const { alice, bob, aTeam } = await ctf(duel);
    const markers = (p: Player) => p.page.locator('#objective-markers .objective');
    // Everyone is pointed at the enemy flag; nobody at their own while it's home.
    await expect(markers(alice)).toHaveCount(1);
    await expect(markers(alice)).toContainText('Enemy flag');
    await grab(alice, aTeam);
    // Alice holds it: nothing to point at for her. Bob is sent after his flag (and still shown Alice's).
    await expect(markers(alice)).toHaveCount(0);
    await expect(markers(bob).filter({ hasText: 'Our flag — stop them' })).toHaveCount(1);
    await expect(markers(bob)).toHaveCount(2);
  });

  test('a dropped flag is timed from the drop, even by a referee who arrived after it', async ({ duel }) => {
    const { alice, aTeam, flagPath } = await ctf(duel);
    await grab(alice, aTeam);
    await alice.page.keyboard.press('KeyE');
    const dropped = await waitForValue(flagPath, (f) => typeof f?.x === 'number');
    // The record carries the drop time (the server's clock), which is what every referee counts from.
    expect(typeof dropped.at).toBe('number');
    expect(Math.abs(dropped.at - serverNow())).toBeLessThan(10_000);
  });

  test('a referee who arrives mid-countdown sends the flag home on time', async ({ players, rooms }) => {
    test.slow();
    // A flag that has lain on the ground for 15 of its 20 s when Carol, alone and so the referee, joins.
    const code = await rooms.seed(rules('ctf'));
    const enemy: Team = 'blue';
    await db.put(`rooms/${code}/game/flags/${enemy}`, { x: 6, y: 0, z: 6, at: serverNow() - 15_000 });
    const carol = await players.open(uniqueName('Carol'));
    await carol.gotoLobby();
    await carol.joinByCode(code);
    await dropPlaceholder(code);
    const joinedAt = Date.now();
    await carol.play();
    // Her clock shows the time left, not a fresh 20 s...
    await expect.poll(async () => (await carol.hud()).flags?.[enemy]?.state).toBe('dropped');
    expect((await carol.hud()).flags[enemy].returnIn).toBeLessThanOrEqual(7);
    // ...and she returns it when it runs out, not 20 s after she first saw it (plus her 3 s referee grace).
    await waitForValue(`rooms/${code}/game/flags/${enemy}`, (f) => f === null, 20_000);
    expect(Date.now() - joinedAt).toBeLessThan(16_000);
  });

  test('no capture while your own flag is away', async ({ duel }) => {
    const { code, alice, bob, aTeam, bTeam } = await ctf(duel);
    await alice.recordMessages();
    await grab(bob, bTeam); // Bob holds Alice's flag
    await grab(alice, aTeam);
    const [x, y, z] = BASE[aTeam];
    await alice.teleport(x, y, z);
    await expect.poll(() => alice.messages()).toContain('Your flag must be at your base to score');
    expect(await db.get(`rooms/${code}/game/score/${aTeam}`)).toBeNull();
  });

  test('bringing the flag home scores, and the last capture wins', async ({ duel }) => {
    const { code, alice, bob, aTeam } = await ctf(duel, 1);
    await grab(alice, aTeam);
    const [x, y, z] = BASE[aTeam];
    await alice.teleport(x, y, z);
    await waitForValue(`rooms/${code}/game/score/${aTeam}`, (s) => s === 1);
    const ended = await waitForValue(`rooms/${code}/game/ended`, (e) => !!e);
    expect(ended).toMatchObject({ winner: aTeam, reason: 'score' });
    const name = aTeam === 'red' ? 'Red' : 'Blue';
    await expect(alice.page.locator('#round-over h2')).toHaveText(`${name} team wins!`);
    await expect(bob.page.locator('#round-over h2')).toHaveText(`${name} team wins!`);
    await expect(alice.page.locator('#round-over .podium li').first()).toContainText('1 cap');
  });

  test('a flag carrier swings the flag as a club', async ({ duel }) => {
    const { alice, bob, aTeam, bobId } = await ctf(duel);
    await grab(alice, aTeam);
    const [x, , z] = (await alice.state()).pos;
    await bob.teleport(x + 1.5, 0, z);
    await alice.waitForRemote(bobId, [x + 1.5, 0, z]);
    await expect.poll(async () => {
      await alice.shoot(bobId, { part: 'body' });
      return (await bob.state()).hp;
    }, { timeout: 10_000 }).toBeLessThan(100);
    expect([45, 20, 0]).toContain((await bob.state()).hp);
  });
});
