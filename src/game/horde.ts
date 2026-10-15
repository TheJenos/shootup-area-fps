import { MAX_RECORD_HP } from './zombies';
import type { HordeRecord } from '../types';

/*
 * Horde: everyone together (the survivors) against waves of zombie bots, each wave bigger and tougher
 * than the last. A short break comes before each wave. Whoever dies sits out the rest of the wave and is
 * back for the break after it, healed and restocked like everyone else; if everyone is down at once,
 * the horde wins. Clearing the mode's last wave wins it for the survivors.
 *
 * The round's record (game/horde) holds the wave, when it starts and how many of its zombies are left
 * to kill. The room's owner runs it: its client plays the zombies (BotHost brings them on a few at a
 * time and counts each kill off), and it starts each wave once the last is cleared, or calls the round.
 */

/** Seconds before the first wave, and between waves */
export const FIRST_BREAK = 10;
export const BREAK = 12;
/** The most zombies on the map at once, whatever the wave: each is a body every client draws and animates */
export const MAX_ALIVE = 14;
/** The most zombies one wave can have */
const MAX_WAVE = 150;
/** Zombies come on this far (m) from every survivor, at least, and preferably no further than the second */
export const SPAWN_MIN = 20;
const SPAWN_NEAR = 45;

/** break: the pause before a wave; live: it's on; cleared: its last zombie is down (the next is a moment away) */
export type HordePhase = 'break' | 'live' | 'cleared';

export function phaseOf(rec: HordeRecord | undefined, now: number): HordePhase {
  if (!rec || now < rec.at) return 'break';
  return rec.left > 0 ? 'live' : 'cleared';
}

/** Zombies in wave `wave` (from 1) against `players` survivors: more each wave, and more for more players */
export function waveSize(wave: number, players: number): number {
  const base = 6 + 3 * (Math.max(1, wave) - 1);
  return Math.min(MAX_WAVE, Math.round(base * (1 + 0.4 * (Math.max(1, players) - 1))));
}

/** How many of a wave's zombies may be on the map at once */
export const maxAlive = (players: number): number => Math.min(MAX_ALIVE, 4 + 2 * Math.max(1, players));

/** Seconds between zombies coming on in wave `wave` (they come faster later) */
export const spawnInterval = (wave: number): number => Math.max(0.6, 2.4 - 0.15 * (Math.max(1, wave) - 1));

/** A zombie's full health in wave `wave`: tougher each wave, within what a player record may hold */
export const zombieHp = (wave: number): number => Math.min(MAX_RECORD_HP, 50 + 10 * (Math.max(1, wave) - 1));

/** Seconds between a Horde zombie's swipes (at normal bot skill: see CLAW_PACE): slower than Infection's */
export const CLAW_COOLDOWN = 0.9;

/** One zombie of wave `wave`: its health, how hard its claws hit, and whether it runs (walkers shamble) */
export interface HordeZombie {
  hp: number;
  claw: number;
  runner: boolean;
}

export function zombieFor(wave: number, rand: () => number = Math.random): HordeZombie {
  const w = Math.max(1, wave);
  return {
    hp: zombieHp(w),
    claw: Math.min(45, 18 + 3 * (w - 1)),
    // None in the first two waves; more each wave after, up to half.
    runner: rand() < Math.min(0.5, (w - 2) * 0.08),
  };
}

/** Wave `wave`, ready to be written: it starts after a break from `now` (server ms) */
export function newWave(wave: number, players: number, now: number): HordeRecord {
  return { wave, at: now + (wave <= 1 ? FIRST_BREAK : BREAK) * 1000, left: waveSize(wave, players) };
}

/** Who's on the survivors' side: how many are playing, and how many of them are standing */
export interface Survivors {
  size: number;
  alive: number;
}

/**
 * What the referee should do now: set up the first wave, start the next one (the last is cleared), call
 * the round won (that was the mode's last wave) or lost (everyone is down mid-wave), or nothing.
 */
export function refereeCall(rec: HordeRecord | undefined, now: number, survivors: Survivors, waves: number):
  'first' | 'next' | 'won' | 'overrun' | null {
  if (!rec) return survivors.size > 0 ? 'first' : null;
  const phase = phaseOf(rec, now);
  if (phase === 'cleared') return rec.wave >= waves ? 'won' : 'next';
  if (phase === 'live' && survivors.size > 0 && survivors.alive === 0) return 'overrun';
  return null;
}

export interface Spot {
  x: number;
  z: number;
}

/**
 * Where the next zombie comes on (an index into `spots`): at least SPAWN_MIN from every survivor, and
 * among those preferably the nearer ones (it should arrive soon), at random. With nowhere that far, the
 * spot furthest from them. -1 with no spots at all.
 */
export function pickSpawn(spots: readonly Spot[], survivors: readonly Spot[], rand: () => number = Math.random): number {
  if (!spots.length) return -1;
  const away = spots.map((s, i) => ({
    i, d: survivors.length ? Math.min(...survivors.map((p) => Math.hypot(p.x - s.x, p.z - s.z))) : Infinity,
  }));
  const clear = away.filter((a) => a.d >= SPAWN_MIN);
  if (!clear.length) return away.reduce((best, a) => (a.d > best.d ? a : best)).i;
  const near = clear.filter((a) => a.d <= SPAWN_NEAR);
  const pool = near.length ? near : clear;
  return pool[Math.floor(rand() * pool.length)]!.i;
}

/** Zombies' names in the kill feed: walkers one of these, runners "Runner" */
const WALKERS = ['Walker', 'Shambler', 'Rotter', 'Biter', 'Groaner', 'Lurker', 'Crawler', 'Stumbler'];
export const zombieName = (runner: boolean, rand: () => number = Math.random): string =>
  (runner ? 'Runner' : WALKERS[Math.floor(rand() * WALKERS.length)]!);
