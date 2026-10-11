import type { PlayerStats, Team } from '../types';

/*
 * What a refreshed tab needs to pick up where it left off: the same player id (so the room sees
 * the same person come back, not a newcomer), the team, and the round's score so far. Kept in
 * sessionStorage, which is this tab's alone and dies with it; cleared on leaving through the menu.
 * Like everything else in the game it's self-reported.
 */

const KEY = 'fps-session';

export interface SessionRecord {
  roomCode: string;
  playerId: string;
  team: Team | null;
  /** The round the score below belongs to (a refresh into a later round starts from zero) */
  round: number;
  kills: number;
  deaths: number;
  stats: PlayerStats;
}

function read(): SessionRecord | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SessionRecord>;
    if (typeof s.roomCode !== 'string' || typeof s.playerId !== 'string') return null;
    return s as SessionRecord;
  } catch {
    return null;
  }
}

/** The session left in this tab for `roomCode`, if any */
export function resumeSession(roomCode: string): SessionRecord | null {
  const s = read();
  return s && s.roomCode === roomCode ? s : null;
}

/** The player id to come back to `roomCode` with: the one this tab already used there, else `fresh` */
export function sessionPlayerId(roomCode: string, fresh: () => string): string {
  return resumeSession(roomCode)?.playerId ?? fresh();
}

export function rememberSession(s: SessionRecord): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // No storage: a refresh starts over, as it used to.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
