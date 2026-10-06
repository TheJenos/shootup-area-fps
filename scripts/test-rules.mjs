/*
 * Checks database.rules.json against the Realtime Database emulator: loads the rules into a
 * namespace of its own, then makes writes the game makes (which must be allowed) and writes a
 * cheater would try (which must be refused). Run inside the emulator:
 *
 *   npm run test:rules
 *
 * No dependencies: it talks to the emulator's REST API.
 */

import { readFile } from 'node:fs/promises';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000';
const NS = 'rules-test';
const base = `http://${HOST}`;

const rules = await readFile(new URL('../database.rules.json', import.meta.url), 'utf8');
JSON.parse(rules); // fail early on broken JSON

async function admin(method, path, body) {
  const res = await fetch(`${base}/${path}?ns=${NS}`, {
    method,
    headers: { Authorization: 'Bearer owner' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
}

/** An unauthenticated client write, like the game's. True if the rules allowed it. */
async function write(path, value) {
  const res = await fetch(`${base}/${path}.json?ns=${NS}`, { method: 'PUT', body: JSON.stringify(value) });
  return res.ok;
}

await admin('PUT', '.settings/rules.json', rules);
await admin('DELETE', '.json');

const entry = (over = {}) => {
  const e = { name: 'Tester', kills: 5, deaths: 2, captures: 1, wins: 1, rounds: 1, ...over };
  return { ...e, score: over.score ?? e.kills * 10 + e.captures * 30 + e.wins * 50 };
};

/** [description, path, value, should it be allowed?] run in order (later ones build on earlier ones) */
const cases = [
  ['global: first round', 'leaderboard/d_player0001', entry(), true],
  ['global: next round', 'leaderboard/d_player0001', entry({ kills: 9, deaths: 4, wins: 2, rounds: 2 }), true],
  ['global: score not matching the formula', 'leaderboard/d_player0001', entry({ kills: 10, deaths: 4, wins: 2, rounds: 3, score: 9999 }), false],
  ['global: more than 100 kills in a round', 'leaderboard/d_player0001', entry({ kills: 200, deaths: 4, wins: 2, rounds: 3 }), false],
  ['global: two rounds at once', 'leaderboard/d_player0001', entry({ kills: 10, deaths: 4, wins: 2, rounds: 4 }), false],
  ['global: kills going down', 'leaderboard/d_player0001', entry({ kills: 1, deaths: 4, wins: 2, rounds: 3 }), false],
  ['global: bad profile id', 'leaderboard/hacker', entry(), false],
  ['global: unknown field', 'leaderboard/p_browser001', { ...entry(), admin: true }, false],
  ['server: first round', 'guildboard/123456789012345678/d_player0001', entry(), true],
  ['server: bad server id', 'guildboard/not-a-server/d_player0001', entry(), false],
  ['server: score not matching the formula', 'guildboard/123456789012345678/d_player0002', entry({ score: 5000 }), false],
  ['lobby: room with a map spec', 'lobby/ROOM1', { name: 'Room', createdAt: 1, seed: 'ABC123', size: 'l', gen: 2, host: 'Tester' }, true],
  ['lobby: unknown map size', 'lobby/ROOM1/size', 'xl', false],
  ['lobby: generator version not a number', 'lobby/ROOM1/gen', '2', false],
  ['lobby: seed too long', 'lobby/ROOM1/seed', 'ABCDEFGHIJKLMNOPQ', false],
  ['game: round on a map', 'rooms/ROOM1/game', { round: 0, seed: 'ABC123', size: 'm', gen: 2, mapHash: 123456 }, true],
  ['game: unknown map size', 'rooms/ROOM1/game/size', 'huge', false],
  ['game: map fingerprint not a number', 'rooms/ROOM1/game/mapHash', 'abc', false],
  ['unknown top-level path', 'admin/flag', true, false],
];

let failed = 0;
for (const [name, path, value, allowed] of cases) {
  const ok = (await write(path, value)) === allowed;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name} (${allowed ? 'allowed' : 'refused'} expected)`);
}

await admin('DELETE', '.json');
if (failed) {
  console.error(`\n${failed} of ${cases.length} rule checks failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} rule checks passed`);
