import { rules, seedRoom, deleteRoom } from './support/db';
import { expect, test, uniqueName } from './support/fixtures';
import { GENERATOR_VERSION } from '../src/game/mapgen/index';

test.describe('lobby', () => {
  test('tabs switch between rooms, create and leaderboard', async ({ players }) => {
    const p = await players.open('Tabby');
    await p.gotoLobby();
    const page = p.page;
    await expect(page.getByRole('tab', { name: /Open rooms/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-rooms')).toBeVisible();

    await page.getByRole('tab', { name: 'Create room' }).click();
    await expect(page.locator('#panel-create')).toBeVisible();
    await expect(page.locator('#panel-rooms')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Leaderboard' }).click();
    await expect(page.locator('#panel-leaderboard')).toBeVisible();

    // ＋ Create room on the rooms tab jumps to the create tab
    await page.getByRole('tab', { name: /Open rooms/ }).click();
    await page.getByRole('button', { name: /Create room/ }).first().click();
    await expect(page.locator('#panel-create')).toBeVisible();
  });

  test('lists open rooms with their mode, map, code and players', async ({ players, rooms }) => {
    const host = uniqueName('Host');
    const name = uniqueName('Listed room ');
    const code = await rooms.seed(rules('tdm', { name: 'Team Deathmatch' }), { name, host });

    const p = await players.open('Lister');
    await p.gotoLobby();
    const row = p.page.locator('#room-list li', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator('.mode-badge')).toHaveClass(/tdm/);
    await expect(row.locator('.meta')).toContainText('Team Deathmatch');
    await expect(row.locator('.meta')).toContainText(code);
    await expect(row.locator('.meta')).toContainText('1 playing');

    // The list updates live when the room goes away
    await deleteRoom(code);
    await expect(row).toHaveCount(0);
  });

  test('lists a generated map with its size; rooms from another version can\'t be joined', async ({ players, rooms }) => {
    const sized = uniqueName('Sized room ');
    const newer = uniqueName('Future room ');
    await rooms.seed(rules('ffa'), { name: sized, seed: 'E2ELIST', size: 's', gen: GENERATOR_VERSION });
    await rooms.seed(rules('ffa'), { name: newer, seed: 'E2ELIST', size: 'm', gen: GENERATOR_VERSION + 1 });

    const p = await players.open('Versions');
    await p.gotoLobby();
    const sizedRow = p.page.locator('#room-list li', { hasText: sized });
    await expect(sizedRow.locator('.meta')).toContainText('(Small)');
    await expect(sizedRow.getByRole('button', { name: 'Join' })).toBeEnabled();
    const newerRow = p.page.locator('#room-list li', { hasText: newer });
    await expect(newerRow.locator('.meta')).toContainText('Newer version');
    await expect(newerRow.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  test('search filters by name, code, mode and host', async ({ players, rooms }) => {
    const tag = uniqueName('Zq');
    const host = uniqueName('Hst');
    const a = await rooms.seed(rules('ctf', { name: 'Capture the Flag' }), { name: `${tag} alpha`, host });
    const b = await rooms.seed(rules('ffa', { name: 'Free-for-all' }), { name: `${tag} beta` });

    const p = await players.open('Searcher');
    await p.gotoLobby();
    const page = p.page;
    const search = page.getByLabel('Search rooms');
    const list = page.locator('#room-list');

    await search.fill(tag);
    await expect(list.locator('li .name')).toHaveCount(2);
    await search.fill(`${tag} alpha`);
    await expect(list.locator('li .name')).toHaveCount(1);
    await search.fill(b);
    await expect(list).toContainText(`${tag} beta`);
    await expect(list).not.toContainText(`${tag} alpha`);
    await search.fill(host);
    await expect(list).toContainText(a);
    await search.fill('Capture the Flag');
    await expect(list).toContainText(`${tag} alpha`);
    await expect(list).not.toContainText(`${tag} beta`);
    await search.fill('nothing-matches-this-xyz');
    await expect(list).toContainText('No rooms match');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
  });

  test('joining by code, and a code that does not exist', async ({ players, rooms }) => {
    const code = await rooms.seed(rules('ffa'));
    const p = await players.open('Joiner');
    await p.gotoLobby();
    const page = p.page;

    await expect(page.locator('form.code-join').getByRole('button', { name: 'Join' })).toBeDisabled();
    await page.getByLabel('Room code').fill('nope!9');
    await expect(page.getByLabel('Room code')).toHaveValue('NOPE9');
    await page.locator('form.code-join').getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('#panel-rooms p.error')).toHaveText("Room NOPE9 doesn't exist.");

    await p.joinByCode(code);
    await expect(page.locator('#room-tag strong')).toHaveText(code);
    await expect(page).toHaveURL(new RegExp(`#${code}$`));
  });

  test('joining from the room list', async ({ players, rooms }) => {
    const name = uniqueName('Click me ');
    const code = await rooms.seed(rules('ffa'), { name });
    const p = await players.open('Clicker');
    await p.gotoLobby();
    await p.page.locator('#room-list li', { hasText: name }).getByRole('button', { name: 'Join' }).click();
    await p.waitJoined();
    expect(await p.roomCode()).toBe(code);
  });

  test('rooms with nobody in them are swept away', async ({ players }) => {
    const code = await seedRoom(rules('ffa'), { name: uniqueName('Empty ') });
    // No members at all: abandoned
    const { db } = await import('./support/db');
    await db.del(`lobby/${code}/members`);
    const p = await players.open('Sweeper');
    await p.gotoLobby();
    await expect.poll(() => db.get(`lobby/${code}`)).toBeNull();
    await deleteRoom(code);
  });
});
