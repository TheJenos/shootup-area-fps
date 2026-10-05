import { ref, query, orderByChild, limitToLast, onValue, runTransaction, type DataSnapshot, type Unsubscribe } from 'firebase/database';
import { db } from './firebase';

/*
 * Two boards with the same shape: the global one at leaderboard/{profileId}, and one per Discord
 * server at guildboard/{guildId}/{profileId} (rounds played in an Activity in that server). Every finished round adds the player's own
 * kills, deaths and captures, and a win if their side won. Rank is by score:
 *
 *   score = kills × 10 + captures × 30 + wins × 50
 *
 * Like the rest of the game this is client-reported. The database rules cap what one round
 * can add and check that the score matches the formula, which keeps casual tampering out.
 */

export interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  captures: number;
  wins: number;
  rounds: number;
}

export interface RoundResult {
  kills: number;
  deaths: number;
  captures: number;
  won: boolean;
}

export const scoreOf = (e: Pick<LeaderboardEntry, 'kills' | 'captures' | 'wins'>): number =>
  e.kills * 10 + e.captures * 30 + e.wins * 50;

const PROFILE_KEY = 'fps-profile';

/**
 * This browser's leaderboard identity. Inside Discord it's tied to the Discord account instead
 * (see `discordProfileId`), so it follows the player between devices.
 */
export function browserProfileId(): string {
  try {
    let id = localStorage.getItem(PROFILE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
      id = `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      localStorage.setItem(PROFILE_KEY, id);
    }
    return id;
  } catch {
    // No storage: a fresh identity per visit (still counted, just not linked between visits).
    return `p_${Math.random().toString(36).slice(2, 14)}`;
  }
}

/** Which board: the global one, or one Discord server's */
export type BoardScope = { kind: 'global' } | { kind: 'guild'; guildId: string };

export const GLOBAL_BOARD: BoardScope = { kind: 'global' };

const boardPath = (scope: BoardScope) => (scope.kind === 'global' ? 'leaderboard' : `guildboard/${scope.guildId}`);

/** Discord ids are snowflakes; anything else never reaches the database. */
export const isGuildId = (id: unknown): id is string => typeof id === 'string' && /^[0-9]{5,25}$/.test(id);

export const discordProfileId = (userId: string): string => `d_${userId}`;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function entryOf(child: DataSnapshot): LeaderboardEntry {
  const v = (child.val() ?? {}) as Partial<LeaderboardEntry>;
  return {
    id: child.key ?? '',
    name: typeof v.name === 'string' && v.name ? v.name : 'Player',
    score: num(v.score),
    kills: num(v.kills),
    deaths: num(v.deaths),
    captures: num(v.captures),
    wins: num(v.wins),
    rounds: num(v.rounds),
  };
}

/** One player's own totals (null until they've finished a round). */
export function watchEntry(scope: BoardScope, profileId: string, callback: (entry: LeaderboardEntry | null) => void): Unsubscribe {
  return onValue(ref(db(), `${boardPath(scope)}/${profileId}`), (snap) => callback(snap.exists() ? entryOf(snap) : null), () => callback(null));
}

/** Live top `limit` players, best first. */
export function watchLeaderboard(
  scope: BoardScope,
  limit: number,
  callback: (entries: LeaderboardEntry[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const top = query(ref(db(), boardPath(scope)), orderByChild('score'), limitToLast(limit));
  return onValue(top, (snap) => {
    const entries: LeaderboardEntry[] = [];
    snap.forEach((child) => {
      entries.push(entryOf(child));
    });
    // limitToLast returns ascending; best first, ties to whoever got there in fewer rounds.
    entries.sort((a, b) => b.score - a.score || a.rounds - b.rounds || a.name.localeCompare(b.name));
    callback(entries);
  }, (err) => onError?.(err));
}

/** Add one finished round to our global totals, and to the Discord server's board when played in one. */
export async function recordRound(profileId: string, name: string, result: RoundResult, guildId?: string | null): Promise<void> {
  const boards: BoardScope[] = [GLOBAL_BOARD, ...(isGuildId(guildId) ? [{ kind: 'guild', guildId } as const] : [])];
  await Promise.all(boards.map((b) => addRound(b, profileId, name, result)));
}

async function addRound(scope: BoardScope, profileId: string, name: string, result: RoundResult): Promise<void> {
  await runTransaction(ref(db(), `${boardPath(scope)}/${profileId}`), (current: Partial<LeaderboardEntry> | null) => {
    const kills = num(current?.kills) + num(result.kills);
    const captures = num(current?.captures) + num(result.captures);
    const wins = num(current?.wins) + (result.won ? 1 : 0);
    return {
      name: name.slice(0, 16),
      kills,
      deaths: num(current?.deaths) + num(result.deaths),
      captures,
      wins,
      rounds: num(current?.rounds) + 1,
      score: scoreOf({ kills, captures, wins }),
    };
  });
}
