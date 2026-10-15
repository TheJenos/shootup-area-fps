import type { InfRecord, Team } from '../types';

/*
 * Infection: everyone starts a round as a survivor. After a short head start a few of them turn (the
 * "alpha" zombies); from then on a survivor who dies, for any reason, comes back as a zombie. Zombies win
 * once nobody is left to infect; survivors win if anyone is still standing when the clock runs out.
 *
 * Teams carry it, as in every team mode: survivors are blue, zombies red (shown as Survivors and Zombies).
 * Who's a zombie is each player's own record, so a turn is just a team change by the player's client (or,
 * for a bot, its owner's). The round's record (game/inf) only holds who was picked to turn first. The room's
 * owner referees: it picks them once the head start is over, again if they all left, and calls the round
 * when the last survivor falls.
 */

export const SURVIVORS: Team = 'blue';
export const ZOMBIES: Team = 'red';

/** Seconds of head start before the first zombies turn */
export const INFECT_DELAY = 15;
/** First zombies who haven't turned this long after being picked (they left, or never got the word) are picked again (s) */
export const PICK_GRACE = 4;
/** The fewest players an infection can start with: one to turn, one to chase */
export const MIN_PLAYERS = 2;

/** countdown: the head start; waiting: it's over, but there's nobody to infect yet; live: zombies are out */
export type InfPhase = 'countdown' | 'waiting' | 'live';

/** When the first zombies turn in a round that started at `startedAt` (server ms) */
export const infectAt = (startedAt: number): number => startedAt + INFECT_DELAY * 1000;

export function phaseOf(rec: InfRecord | undefined, startedAt: number | undefined, now: number): InfPhase {
  if (rec?.alpha && Object.keys(rec.alpha).length) return 'live';
  if (startedAt !== undefined && now < infectAt(startedAt)) return 'countdown';
  return 'waiting';
}

/** Whether `id` is one of the round's first zombies (they're tougher, all round) */
export const isAlpha = (rec: InfRecord | undefined, id: string): boolean => !!rec?.alpha?.[id];

/** How many to turn first: the mode's setting, but never everyone (somebody has to be chased) */
export function alphaCount(setting: number, players: number): number {
  return Math.max(0, Math.min(Math.round(setting), players - 1));
}

/** `n` of `ids`, chosen at random */
export function pickAlphas(ids: readonly string[], n: number, rand: () => number = Math.random): string[] {
  const pool = [...ids];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(0, n));
}

/** Who's playing: survivors still standing (the dead ones are turning), and zombies, dead or alive */
export interface InfCount {
  survivors: number;
  zombies: number;
}

/**
 * What the referee should do now: pick the first zombies (the head start is over, or the ones picked left
 * before turning), end the round (no survivors left), or nothing.
 */
export function refereeCall(rec: InfRecord | undefined, startedAt: number | undefined, now: number, count: InfCount):
  'pick' | 'zombies-win' | null {
  const phase = phaseOf(rec, startedAt, now);
  if (phase === 'countdown') return null;
  if (phase === 'waiting') return count.survivors >= MIN_PLAYERS ? 'pick' : null;
  if (count.zombies === 0) {
    // Picked, but nobody has turned: give them a moment, then pick again.
    return now - rec!.t >= PICK_GRACE * 1000 && count.survivors >= MIN_PLAYERS ? 'pick' : null;
  }
  return count.survivors === 0 ? 'zombies-win' : null;
}

/** Who wins when the clock runs out: anyone still standing makes it the survivors' round */
export const timeUpWinner = (count: InfCount): Team => (count.survivors > 0 ? SURVIVORS : ZOMBIES);

/** A survivor who dies now comes back as a zombie (not during the head start) */
export const deathInfects = (rec: InfRecord | undefined, startedAt: number | undefined, now: number): boolean =>
  phaseOf(rec, startedAt, now) === 'live';
