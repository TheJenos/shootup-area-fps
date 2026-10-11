import { db, dropPlaceholder, waitForValue } from './support/db';
import { expect, rules, test, uniqueName } from './support/fixtures';

test.describe('joining and leaving', () => {
  test('alone in a room: waiting banner, paused, presence in the database', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Solo'));
    const code = await rooms.seed(rules('ffa'));
    await p.gotoLobby();
    await p.joinByCode(code);
    await dropPlaceholder(code);
    const page = p.page;

    await expect(page.locator('#pause-overlay')).toBeVisible();
    await expect(page.locator('#pause-overlay .state')).toHaveText("You're alive — the match is still running");
    await expect(page.locator('#pause-overlay .map')).toContainText('1 player in the match');
    const id = await p.id();
    const me = await db.get(`rooms/${code}/players/${id}`);
    expect(me).toMatchObject({ name: p.name, alive: true, hp: 100 });
    expect(await db.get(`lobby/${code}/members`)).toEqual({ [id]: p.name });

    // Resume (the click that starts the game where pointer lock works)
    await p.play();
    await expect(page.locator('#pause-overlay')).toBeHidden();
    await expect(page.locator('#announce')).toContainText('Free-for-all');
    await expect(page.locator('#waiting-banner')).toContainText(`Waiting for players — share room ${code}`);
  });

  test('two players see each other join and leave', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const alice = await players.open(uniqueName('Alice'));
    const bob = await players.open(uniqueName('Bob'));
    await alice.gotoLobby();
    await alice.joinByCode(code);
    await dropPlaceholder(code);
    await alice.play();
    // Feed lines only stay up a few seconds: keep them as they come
    await alice.recordMessages();
    await bob.gotoLobby();
    await bob.joinByCode(code);
    const [aliceId, bobId] = [await alice.id(), await bob.id()];
    await expect.poll(() => alice.messages()).toContain(`${bob.name} joined`);
    await expect(alice.page.locator('#waiting-banner')).toHaveCount(0);
    const members = await db.get(`lobby/${code}/members`);
    expect(members).toEqual({ [aliceId]: alice.name, [bobId]: bob.name });

    await alice.openPauseMenu();
    await expect(alice.page.locator('#pause-overlay .map')).toContainText('2 players in the match');

    // Bob leaves through the menu: Alice is told, his records go, the room stays
    await bob.leave();
    await expect.poll(() => alice.messages()).toContain(`${bob.name} left`);
    await waitForValue(`rooms/${code}/players/${bobId}`, (v) => v === null);
    await waitForValue(`lobby/${code}/members`, (m) => !!m && !m[bobId] && !!m[aliceId]);
    await expect(alice.page.locator('#pause-overlay .map')).toContainText('1 player in the match');

    // Bob is back in the lobby and can see the room
    await expect(bob.page.locator('#room-list')).toContainText(code);

    // The last one out closes the room
    await alice.leave();
    await waitForValue(`lobby/${code}`, (v) => v === null);
    await waitForValue(`rooms/${code}`, (v) => v === null);
  });

  test('closing the tab removes the player (onDisconnect)', async ({ duel }) => {
    const { code, alice, bob, bobId } = await duel();
    await alice.recordMessages();
    await bob.close();
    await waitForValue(`rooms/${code}/players/${bobId}`, (v) => v === null, 30_000);
    await expect.poll(() => alice.messages()).toContain(`${bob.name} left`);
  });

  test('a room left empty by a closed tab is swept away by the next look at the lobby', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Closer'));
    const code = await rooms.seed(rules('ffa'));
    await p.gotoLobby();
    await p.joinByCode(code);
    await dropPlaceholder(code);
    const id = await p.id();
    await p.close();
    // The server drops the player; the room itself stays until someone lists the lobby (no client
    // decides on its own that it was the last one there: see RoomConnection.join).
    await waitForValue(`lobby/${code}/members/${id}`, (v) => v === null, 30_000);
    const viewer = await players.open(uniqueName('Viewer'));
    await viewer.gotoLobby();
    await waitForValue(`lobby/${code}`, (v) => v === null, 30_000);
    await waitForValue(`rooms/${code}`, (v) => v === null, 30_000);
  });

  test('someone joining as the "last" player closes their tab keeps the room', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const alice = await players.open(uniqueName('Alice'));
    await alice.gotoLobby();
    await alice.joinByCode(code);
    await dropPlaceholder(code);
    // Alice has been alone long enough for any "I'm the last one here" bookkeeping to settle.
    await alice.page.waitForTimeout(1_500);
    const bob = await players.open(uniqueName('Bob'));
    await bob.gotoLobby();
    await bob.joinByCode(code);
    const bobId = await bob.id();
    // Alice's tab closes before she has necessarily seen Bob arrive.
    await alice.close();
    await bob.page.waitForTimeout(3_000);
    expect(await db.get(`lobby/${code}/members/${bobId}`)).toBe(bob.name);
    expect(await db.get(`rooms/${code}/players/${bobId}`)).toMatchObject({ name: bob.name });
    await expect(bob.page.locator('#game-screen')).toBeVisible();
  });

  test('a refreshed tab comes back as the same player, score and all', async ({ duel }) => {
    test.slow();
    const { code, alice, bob, aliceId, bobId } = await duel(rules('ffa', { respawn: 1 }));
    await alice.kill(bob);
    await expect.poll(async () => (await alice.state()).kills).toBe(1);
    const team = (await alice.state()).team;

    await alice.page.reload();
    await alice.waitJoined();
    // Same id, same score; Bob is still there for her.
    expect(await alice.id()).toBe(aliceId);
    await expect.poll(async () => (await alice.state()).kills).toBe(1);
    expect((await alice.state()).team).toBe(team);
    await alice.waitForRemote(bobId);
    // The room has one record for her, with the score in it.
    const players = await db.get<Record<string, { kills: number }>>(`rooms/${code}/players`);
    expect(Object.keys(players ?? {}).filter((id) => id !== bobId)).toEqual([aliceId]);
    await expect.poll(async () => (await db.get<{ kills: number }>(`rooms/${code}/players/${aliceId}`))?.kills).toBe(1);
    // Leaving through the menu is final: the next visit to a room starts fresh.
    await alice.leave();
    expect(await alice.page.evaluate(() => sessionStorage.getItem('fps-session'))).toBeNull();
  });

  test('"Still connecting" offers a way back when the room never answers', async ({ players, rooms }) => {
    test.slow();
    const p = await players.open('Waiter');
    const code = await rooms.seed(rules('ffa'));
    // Hold back the 3D models, so joining hangs on loading
    await p.page.route('**/models/**', () => {});
    await p.gotoLobby();
    await p.page.getByLabel('Room code').fill(code);
    await p.page.locator('form.code-join').getByRole('button', { name: 'Join' }).click();
    await expect(p.page.locator('#connecting-overlay')).toContainText('Connecting…');
    await expect(p.page.locator('#connecting-overlay')).toContainText('Still connecting…', { timeout: 20_000 });
    await p.page.getByRole('button', { name: 'Back to lobby' }).click();
    await expect(p.page.locator('#lobby')).toBeVisible();
  });
});
