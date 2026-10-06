import { test as base, expect } from '@playwright/test';
import { deleteRoom, dropPlaceholder, rules, seedRoom, type RoomRules } from './db';
import { DUEL, Player, type PlayerOptions } from './player';

/*
 * Fixtures:
 *   players  opens players (each in their own browser context) and closes them after the test
 *   rooms    remembers room codes so their database records are deleted after the test
 *   duel     a ready match: a room with the given rules, Alice and Bob in it and playing, facing each
 *            other 8 m apart on the classic map
 */

interface Duel {
  code: string;
  alice: Player;
  bob: Player;
  aliceId: string;
  bobId: string;
}

export interface Fixtures {
  players: { open(opts: PlayerOptions | string): Promise<Player> };
  rooms: { track(code: string): string; seed(r: RoomRules, opts?: Parameters<typeof seedRoom>[1]): Promise<string> };
  duel(r?: RoomRules, opts?: { positions?: boolean }): Promise<Duel>;
}

/** Each test gets its own names, so parallel workers never mix up their rooms or leaderboard rows. */
let serial = 0;
export const uniqueName = (prefix: string) => `${prefix}${process.pid % 1000}${++serial}`.slice(0, 16);

export const test = base.extend<Fixtures>({
  players: async ({ browser }, use) => {
    const open: Player[] = [];
    await use({
      async open(opts) {
        const p = await Player.open(browser, typeof opts === 'string' ? { name: opts } : opts);
        open.push(p);
        return p;
      },
    });
    await Promise.all(open.map((p) => p.close()));
  },

  rooms: async ({}, use) => {
    const codes = new Set<string>();
    await use({
      track: (code) => (codes.add(code), code),
      seed: async (r, opts) => {
        const code = await seedRoom(r, opts);
        codes.add(code);
        return code;
      },
    });
    await Promise.all([...codes].map((c) => deleteRoom(c).catch(() => {})));
  },

  duel: async ({ players, rooms }, use) => {
    await use(async (r = rules('ffa'), { positions = true } = {}) => {
      const code = await rooms.seed(r);
      const alice = await players.open(uniqueName('Alice'));
      const bob = await players.open(uniqueName('Bob'));
      await alice.gotoLobby();
      await alice.joinByCode(code);
      await dropPlaceholder(code);
      await bob.gotoLobby();
      await bob.joinByCode(code);
      await Promise.all([alice.play(), bob.play()]);
      const [aliceId, bobId] = await Promise.all([alice.id(), bob.id()]);
      if (positions) {
        await alice.teleport(...DUEL.a, DUEL.aYaw);
        await bob.teleport(...DUEL.b, DUEL.bYaw);
      }
      await Promise.all([
        alice.waitForRemote(bobId, positions ? DUEL.b : undefined),
        bob.waitForRemote(aliceId, positions ? DUEL.a : undefined),
      ]);
      return { code, alice, bob, aliceId, bobId };
    });
  },
});

export { expect };
export { rules };
