/*
 * The Realtime Database emulator's REST API, as an admin (rules don't apply). Tests use it to set rooms
 * up, to fast-forward round state (scores, clocks) and to check what the game wrote.
 */

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000';
const NS = 'demo-fps';

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://${HOST}/${path}.json?ns=${NS}`, {
    method,
    headers: { Authorization: 'Bearer owner' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export const db = {
  get: <T = any>(path: string) => request('GET', path) as Promise<T | null>,
  put: (path: string, value: unknown) => request('PUT', path, value),
  patch: (path: string, value: Record<string, unknown>) => request('PATCH', path, value),
  del: (path: string) => request('DELETE', path),
  /** A value with a fresh push-style key, as the game's push() makes */
  push: async (path: string, value: unknown) => ((await request('POST', path, value)) as { name: string }).name,
};

/** The server's clock, which the game's round timers run on. */
export const serverNow = () => Date.now();

export interface RoomRules {
  base: 'ffa' | 'tdm' | 'ctf' | 'snd';
  name: string;
  short: string;
  loadout: 'standard' | 'gungame' | 'rifle' | 'shotgun' | 'sniper' | 'deagle';
  guns: boolean;
  abilities: boolean;
  ammo: boolean;
  limit: number;
  minutes: number;
  health: number;
  headshotsOnly: boolean;
  respawn: number;
  speed: number;
  gravity: number;
  bots?: number;
  botSkill?: 'easy' | 'normal' | 'hard';
}

const BASE: Record<RoomRules['base'], RoomRules> = {
  ffa: { base: 'ffa', name: 'Free-for-all', short: 'FFA', loadout: 'standard', guns: true, abilities: true, ammo: true, limit: 25, minutes: 8, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1 },
  tdm: { base: 'tdm', name: 'Team Deathmatch', short: 'TDM', loadout: 'standard', guns: true, abilities: true, ammo: true, limit: 50, minutes: 10, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1 },
  ctf: { base: 'ctf', name: 'Capture the Flag', short: 'CTF', loadout: 'standard', guns: true, abilities: true, ammo: true, limit: 3, minutes: 12, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1 },
  snd: { base: 'snd', name: 'Search & Destroy', short: 'S&D', loadout: 'standard', guns: true, abilities: true, ammo: true, limit: 5, minutes: 20, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1 },
};

/**
 * Rules for a test room. Pickups are off unless asked for, so nothing random lands under a player's
 * feet and changes their health or guns mid-test.
 */
export function rules(base: RoomRules['base'], over: Partial<RoomRules> = {}): RoomRules {
  return { ...BASE[base], guns: false, abilities: false, ammo: false, ...over };
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A room placeholder member, so the lobby doesn't sweep the room away as abandoned before anyone joins */
export const PLACEHOLDER = 'E2EPLACEHOLDER';

export function randomCode(): string {
  let s = 'T';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/** A room as createRoom() makes it, written straight to the database. */
export async function seedRoom(
  r: RoomRules, opts: { name?: string; seed?: string; host?: string; size?: 's' | 'm' | 'l'; gen?: number } = {},
): Promise<string> {
  const code = randomCode();
  // The classic arena by default: flat, and the same on every generator version.
  const map = { seed: opts.seed ?? 'CLASSIC', ...(opts.size ? { size: opts.size } : {}), ...(opts.gen ? { gen: opts.gen } : {}) };
  const now = serverNow();
  await db.put(`lobby/${code}`, {
    name: opts.name ?? `E2E ${code}`,
    mode: r.base,
    rules: r,
    ...map,
    host: opts.host ?? 'E2E',
    createdAt: now,
    members: { [PLACEHOLDER]: opts.host ?? 'E2E' },
  });
  await db.put(`rooms/${code}/game`, { round: 0, ...map, startedAt: now });
  return code;
}

export async function deleteRoom(code: string): Promise<void> {
  await Promise.all([db.del(`lobby/${code}`), db.del(`rooms/${code}`)]);
}

export const dropPlaceholder = (code: string) => db.del(`lobby/${code}/members/${PLACEHOLDER}`);

/** Put a pickup on the map, as the leader's spawner would. Returns its id. */
export const seedPickup = (code: string, p: { type: string; x: number; z: number; uses?: number }) =>
  db.push(`rooms/${code}/pickups`, p);

/** Move the round clock so it runs out in `inMs`. */
export async function expireClock(code: string, minutes: number, inMs = 1_000): Promise<void> {
  await db.put(`rooms/${code}/game/startedAt`, serverNow() - minutes * 60_000 + inMs);
}

/** Poll the database until `check` passes on the value at `path`. */
export async function waitForValue<T = any>(path: string, check: (v: T | null) => boolean, timeout = 15_000): Promise<T | null> {
  const end = Date.now() + timeout;
  let last: T | null = null;
  while (Date.now() < end) {
    last = await db.get<T>(path);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting on ${path}; last value: ${JSON.stringify(last)}`);
}
