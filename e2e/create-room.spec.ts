import { db, waitForValue } from './support/db';
import { expect, test, uniqueName } from './support/fixtures';

/** Every prebuilt mode, and what its room must store */
const PRESETS = [
  { name: 'Free-for-all', base: 'ffa', short: 'FFA', limit: 25 },
  { name: 'Team Deathmatch', base: 'tdm', short: 'TDM', limit: 50 },
  { name: 'Capture the Flag', base: 'ctf', short: 'CTF', limit: 3 },
  { name: 'Gun Game', base: 'ffa', short: 'GG', limit: 12, loadout: 'gungame' },
  { name: 'Sniper Only', base: 'ffa', short: 'SNP', limit: 20, loadout: 'sniper' },
  { name: 'Sniper TDM', base: 'tdm', short: 'SNT', limit: 40, loadout: 'sniper' },
  { name: 'Sniper Flags', base: 'ctf', short: 'SNF', limit: 3, loadout: 'sniper' },
  { name: 'Shotgun Brawl', base: 'ffa', short: 'SHG', limit: 25, loadout: 'shotgun', speed: 1.1 },
  { name: 'Hand Cannons', base: 'ffa', short: 'DGL', limit: 25, loadout: 'deagle' },
  { name: 'Headhunter', base: 'ffa', short: 'HS', limit: 15, headshotsOnly: true },
  { name: 'Hardcore TDM', base: 'tdm', short: 'HC', limit: 40, health: 50, abilities: false, respawn: 6 },
  { name: 'Tank CTF', base: 'ctf', short: 'TNK', limit: 3, health: 200, speed: 0.9 },
  { name: 'Moon Gravity', base: 'ffa', short: 'MOON', limit: 25, gravity: 0.35 },
  { name: 'Speed Rush', base: 'ffa', short: 'SPD', limit: 30, speed: 1.45, respawn: 1 },
];

test.describe('create room', () => {
  for (const preset of PRESETS) {
    test(`creates a ${preset.name} room`, async ({ players, rooms }) => {
      const p = await players.open(uniqueName('Maker'));
      await p.gotoLobby();
      const page = p.page;
      await page.getByRole('tab', { name: 'Create room' }).click();
      const chip = page.getByRole('radio', { name: new RegExp(`^${preset.short}\\s*${preset.name}$`) });
      await chip.click();
      await expect(chip).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('button.create-button')).toHaveText(`Create ${preset.name} room`);

      const roomName = uniqueName('Room ');
      const code = rooms.track(await p.createRoom({ seed: 'classic', roomName }));
      expect(code).toMatch(/^[A-Z0-9]{5}$/);

      const lobby = await db.get(`lobby/${code}`);
      const { name, ...expected } = preset;
      expect(lobby).toMatchObject({ name: roomName, mode: preset.base, seed: 'CLASSIC', host: p.name });
      expect(lobby.rules).toMatchObject({ name, ...expected });
      expect(Object.values(lobby.members)).toEqual([p.name]);
      const state = await p.state();
      expect(state.rules).toMatchObject({ name, base: preset.base });
      // The score bar shows the mode's badge and goal
      await expect(page.locator('#scorebar')).toContainText(preset.short);
      if (preset.loadout === 'gungame') await expect(page.locator('#scorebar')).toContainText('Level 1/12');
      else if (preset.base === 'ffa') await expect(page.locator('#scorebar')).toContainText(`First to ${preset.limit}`);
      if (preset.base !== 'ffa') expect(state.team).toMatch(/red|blue/);
      else expect(state.team).toBeNull();
      if (preset.health) await expect(page.locator('#health')).toContainText(String(preset.health));

      // The last player out closes the room
      await p.leave();
      await waitForValue(`lobby/${code}`, (v) => v === null);
      await waitForValue(`rooms/${code}`, (v) => v === null);
    });
  }

  test('map seed, the dice and "Surprise me"', async ({ players }) => {
    const p = await players.open('Seeder');
    await p.gotoLobby();
    const page = p.page;
    await page.getByRole('tab', { name: 'Create room' }).click();
    const seed = page.getByLabel('Map seed');
    const mapName = page.locator('.map-controls strong');

    await seed.fill('classic');
    await expect(seed).toHaveValue(/classic/i);
    const classicName = await mapName.innerText();

    await page.getByRole('button', { name: 'New random map' }).click();
    await expect(seed).not.toHaveValue(/classic/i);
    await expect(mapName).not.toHaveText(classicName);
    await expect(mapName).toContainText('·');

    // Same seed, same map
    const rolled = await seed.inputValue();
    const rolledName = await mapName.innerText();
    await seed.fill('');
    await expect(mapName).toHaveText('Surprise me');
    await seed.fill(rolled);
    await expect(mapName).toHaveText(rolledName);

    await expect(page.getByRole('img', { name: /Map preview/ })).toBeVisible();
  });

  test('map size is chosen with the seed and stored with the room', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Sizer'));
    await p.gotoLobby();
    await p.page.getByRole('tab', { name: 'Create room' }).click();
    const sizes = p.page.getByRole('radiogroup', { name: 'Map size' });
    // The classic arena has one size.
    await p.page.getByLabel('Map seed').fill('classic');
    await expect(sizes.getByRole('radio', { name: 'Large' })).toBeDisabled();
    // A generated map's name doesn't depend on its size.
    await p.page.getByLabel('Map seed').fill('E2ESIZE');
    const name = await p.page.locator('.map-controls strong').innerText();
    await sizes.getByRole('radio', { name: 'Small' }).click();
    await expect(sizes.getByRole('radio', { name: 'Small' })).toHaveAttribute('aria-checked', 'true');
    await expect(p.page.locator('.map-controls strong')).toHaveText(name);

    const code = rooms.track(await p.createRoom({ seed: 'E2ESIZE', size: 'Large' }));
    const state = await p.state();
    const lobby = await db.get(`lobby/${code}`);
    expect(lobby).toMatchObject({ seed: 'E2ESIZE', size: 'l', gen: state.mapGen });
    expect(await db.get(`rooms/${code}/game`)).toMatchObject({ seed: 'E2ESIZE', size: 'l', gen: state.mapGen });
    expect(state).toMatchObject({ mapSeed: 'E2ESIZE', mapSize: 'l' });
    // The first client to build the map records its fingerprint, and it's ours.
    await expect.poll(async () => (await db.get(`rooms/${code}/game`)).mapHash).toBe(state.mapHash);
  });

  test('a blank room name becomes "<name>\'s room", and a blank seed a random map', async ({ players, rooms }) => {
    const p = await players.open(uniqueName('Blank'));
    await p.gotoLobby();
    await p.page.getByRole('tab', { name: 'Create room' }).click();
    await expect(p.page.getByLabel('Room name')).toHaveAttribute('placeholder', `${p.name}'s room`);
    await p.page.getByLabel('Map seed').fill('');
    await p.page.locator('button.create-button').click();
    await p.waitJoined();
    const code = rooms.track(await p.roomCode());
    const lobby = await db.get(`lobby/${code}`);
    expect(lobby.name).toBe(`${p.name}'s room`);
    expect(lobby.seed).toMatch(/^[A-Z0-9]+$/);
    expect(lobby.seed).not.toBe('CLASSIC');
    expect((await p.state()).mapSeed).toBe(lobby.seed);
  });
});
