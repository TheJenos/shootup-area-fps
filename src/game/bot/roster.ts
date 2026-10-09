import { SKILLS, type BotSkill } from './brain';
import type { Team } from '../mapgen/types';

/*
 * A room's bots: the list the owner keeps (lobby/{code}/bots), one entry per bot with its level and,
 * in team modes, optionally its team. Whoever owns the room plays exactly these; they stay until the
 * owner removes them, however many people join.
 */

export interface BotSlot {
  /** Its name without the level, e.g. "Kai" */
  base: string;
  skill: BotSkill;
  /** Team modes: which side it plays on (missing or null: whichever is smaller when it joins) */
  team?: Team | null;
  /** When it was added (orders the list) */
  at: number;
}

export type BotRoster = Record<string, BotSlot>;

/** Most bots a room can have */
export const MAX_BOTS = 12;

export const BOT_NAMES = [
  'Ava', 'Kai', 'Nova', 'Rex', 'Zed', 'Ivy', 'Juno', 'Max', 'Oz', 'Pia', 'Taz', 'Vex', 'Wren', 'Yui', 'Bo', 'Cy',
  'Ash', 'Dex', 'Echo', 'Fox', 'Gil', 'Hex', 'Jet', 'Lux', 'Mars', 'Nyx', 'Odin', 'Quin', 'Rook', 'Sly',
];

/** The name players see: "Kai [Hard]" (always within the 16-character name limit) */
export const botName = (slot: Pick<BotSlot, 'base' | 'skill'>): string => `${slot.base} [${SKILLS[slot.skill].label}]`;

/** A name nobody in `taken` (bases or full names) is using yet */
export function pickBase(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.replace(/ \[.*\]$/, '')));
  const free = BOT_NAMES.filter((n) => !used.has(n));
  const list = free.length ? free : BOT_NAMES;
  return list[Math.floor(rand() * list.length)]!;
}

/** Slot id (also its key under lobby/{code}/bots) */
export const newSlotId = (rand: () => number = Math.random): string => `s_${Math.floor(rand() * 36 ** 8).toString(36).padStart(8, '0')}`;

/** `count` bots at `skill`, for a new room's list */
export function startingRoster(count: number, skill: BotSkill, now: number, rand: () => number = Math.random): BotRoster {
  const roster: BotRoster = {};
  const names: string[] = [];
  for (let i = 0; i < Math.min(count, MAX_BOTS); i++) {
    const base = pickBase(names, rand);
    names.push(base);
    roster[newSlotId(rand)] = { base, skill, at: now + i };
  }
  return roster;
}

/** The list in the order bots were added */
export const rosterEntries = (roster: BotRoster): [string, BotSlot][] => Object.entries(roster).sort((a, b) => a[1].at - b[1].at);
