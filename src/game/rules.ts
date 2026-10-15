import { GUN_GAME_LADDER, MODES } from './modes';
import { GUNS } from './gunStats';
import type { GameMode, GunKind } from '../types';
import type { BotSkill } from './bot/brain';

/*
 * Game modes = a base type (FFA, TDM, CTF, S&D or Infection: teams, flags, how points are scored) plus a set of
 * rules on top. The prebuilt modes are just named rule sets, and players can make their own.
 * A room's rules are stored with it (lobby/{code}/rules), so everyone who joins plays the same.
 */

/** Two guns for everyone, both with endless ammo: the first in hand, the second a switch away */
export type Kit = 'sniper-deagle' | 'shotgun-deagle' | 'rifle-shotgun' | 'rifle-sniper' | 'rifle-deagle' | 'sniper-shotgun';

/**
 * What players hold: the normal rifle + pickups, one fixed gun for everyone, a two-gun kit, a random
 * gun each life (Roulette), or the Gun Game ladder
 */
export type Loadout = 'standard' | 'gungame' | 'random' | GunKind | Kit;

export interface ModeRules {
  base: GameMode;
  /** Shown in the lobby, the score bar and the menu */
  name: string;
  /** Badge text, up to 4 characters */
  short: string;
  loadout: Loadout;
  /** What spawns on the map. Guns and ammo boxes only matter with the standard loadout. */
  guns: boolean;
  abilities: boolean;
  ammo: boolean;
  /**
   * Kills (FFA: one player, TDM: a team), captures (CTF) or rounds (S&D) to win; Gun Game uses the ladder.
   * Infection: how many players turn into zombies at the start. Horde: how many waves to survive.
   */
  limit: number;
  /** Round length in minutes */
  minutes: number;
  /** Starting / maximum health */
  health: number;
  /** Only headshots hurt (grenades are left out of the pickups) */
  headshotsOnly: boolean;
  /** Seconds before respawning (S&D has no respawns: the dead wait for the next round) */
  respawn: number;
  /** Movement speed multiplier */
  speed: number;
  /** Gravity multiplier (lower = higher, floatier jumps) */
  gravity: number;
  /** How fast pickups come back (and, above 1, how many lie about): 1 is the usual */
  pickupRate: number;
  /** How hard guns kick when fired (0: none at all) */
  recoil: number;
  /** Heads this many times their size, hitboxes and all (big-head modes) */
  headSize: number;
  /** Bots fill the room up to this many players (0: no bots); the room owner plays them */
  bots: number;
  botSkill: BotSkill;
}

export const LIMITS = {
  limit: { ffa: [5, 60], tdm: [10, 150], ctf: [1, 10], snd: [2, 10], inf: [1, 4], hrd: [3, 30] } as Record<GameMode, [number, number]>,
  minutes: [3, 20],
  health: [25, 200],
  respawn: [1, 10],
  speed: [0.7, 1.5],
  gravity: [0.3, 1.5],
  pickupRate: [0.25, 3],
  recoil: [0, 2],
  headSize: [1, 3],
  bots: [0, 12],
} as const;

export const BOT_SKILL_OPTIONS: { value: BotSkill; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
  { value: 'expert', label: 'Expert' },
];

export interface LoadoutDef {
  value: Loadout;
  label: string;
  description: string;
  /** Where the editor lists it */
  group: 'Standard' | 'One gun' | 'Two guns' | 'Wild';
  /** The guns everyone holds, in slot order (none: they come from the map, the ladder or the roulette) */
  guns: GunKind[];
}

export const LOADOUTS: LoadoutDef[] = [
  { value: 'standard', label: 'Standard', group: 'Standard', guns: [], description: 'The rifle, plus whatever guns and ammo you find on the map' },
  { value: 'rifle', label: 'Rifles', group: 'One gun', guns: ['rifle'], description: 'Automatic, steady at any range' },
  { value: 'shotgun', label: 'Shotguns', group: 'One gun', guns: ['shotgun'], description: 'Close, loud and brutal' },
  { value: 'sniper', label: 'Snipers', group: 'One gun', guns: ['sniper'], description: 'One-shot headshots down the long lanes' },
  { value: 'deagle', label: 'Deagles', group: 'One gun', guns: ['deagle'], description: 'Two body shots or one to the head' },
  { value: 'sniper-deagle', label: 'Sniper + Deagle', group: 'Two guns', guns: ['sniper', 'deagle'], description: 'Scope the lanes; the pistol for anyone who gets close' },
  { value: 'rifle-sniper', label: 'Rifle + Sniper', group: 'Two guns', guns: ['rifle', 'sniper'], description: 'Spray the short corners, pick off the long ones' },
  { value: 'rifle-shotgun', label: 'Rifle + Shotgun', group: 'Two guns', guns: ['rifle', 'shotgun'], description: 'Run and gun, with a blast for every doorway' },
  { value: 'rifle-deagle', label: 'Rifle + Deagle', group: 'Two guns', guns: ['rifle', 'deagle'], description: 'The classic: a rifle and a sidearm' },
  { value: 'shotgun-deagle', label: 'Shotgun + Deagle', group: 'Two guns', guns: ['shotgun', 'deagle'], description: 'Up close, and slightly less close' },
  { value: 'sniper-shotgun', label: 'Sniper + Shotgun', group: 'Two guns', guns: ['sniper', 'shotgun'], description: 'Long shots, and a door-kicker for the rest' },
  { value: 'random', label: 'Roulette', group: 'Wild', guns: [], description: 'A random gun every life: make the most of it' },
  { value: 'gungame', label: 'Gun Game ladder', group: 'Wild', guns: [], description: 'Every kill hands you the next gun (free-for-all only)' },
];

/** The guns a loadout puts in everyone's hands, in slot order (empty for Standard, Gun Game and Roulette) */
export const loadoutGuns = (loadout: Loadout): GunKind[] => LOADOUTS.find((l) => l.value === loadout)?.guns ?? [];

/** Roulette's wheel: every gun, one each life */
export const ROULETTE_GUNS: GunKind[] = ['rifle', 'shotgun', 'sniper', 'deagle'];
export const rouletteGun = (): GunKind => ROULETTE_GUNS[Math.floor(Math.random() * ROULETTE_GUNS.length)]!;

/** The plain base mode, as it plays by default. */
export function baseRules(base: GameMode): ModeRules {
  const def = MODES[base];
  return {
    base, name: def.name, short: def.short, loadout: 'standard', guns: true, abilities: true, ammo: true,
    limit: def.limit, minutes: def.timeLimit / 60, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1,
    pickupRate: 1, recoil: 1, headSize: 1, bots: 0, botSkill: 'normal',
  };
}

export interface Preset {
  id: string;
  description: string;
  rules: ModeRules;
}

const preset = (id: string, description: string, base: GameMode, rules: Partial<ModeRules> & Pick<ModeRules, 'name' | 'short'>): Preset =>
  ({ id, description, rules: normalizeRules({ ...baseRules(base), ...rules }) });

export const PRESETS: Preset[] = [
  { id: 'ffa', description: MODES.ffa.description, rules: baseRules('ffa') },
  { id: 'tdm', description: MODES.tdm.description, rules: baseRules('tdm') },
  { id: 'ctf', description: MODES.ctf.description, rules: baseRules('ctf') },
  { id: 'snd', description: MODES.snd.description, rules: baseRules('snd') },
  { id: 'inf', description: MODES.inf.description, rules: baseRules('inf') },
  { id: 'hrd', description: MODES.hrd.description, rules: baseRules('hrd') },
  preset('gungame', 'Every kill gives the next gun; finish the ladder to win', 'ffa', {
    name: 'Gun Game', short: 'GG', loadout: 'gungame', limit: GUN_GAME_LADDER.length, minutes: 10, guns: false, ammo: false, abilities: false,
  }),
  preset('sniper-ffa', 'Everyone gets a sniper, nothing else', 'ffa', { name: 'Sniper Only', short: 'SNP', loadout: 'sniper', limit: 20 }),
  preset('sniper-tdm', 'Red vs Blue, snipers only', 'tdm', { name: 'Sniper TDM', short: 'SNT', loadout: 'sniper', limit: 40 }),
  preset('sniper-ctf', 'Steal the flag with snipers covering the lanes', 'ctf', { name: 'Sniper Flags', short: 'SNF', loadout: 'sniper' }),
  preset('shotgun', 'Shotguns only, close and loud', 'ffa', { name: 'Shotgun Brawl', short: 'SHG', loadout: 'shotgun', speed: 1.1, limit: 25 }),
  preset('deagle', 'Deagles only: every shot counts', 'ffa', { name: 'Hand Cannons', short: 'DGL', loadout: 'deagle', limit: 25 }),
  preset('headshots', 'Only headshots do damage', 'ffa', { name: 'Headhunter', short: 'HS', headshotsOnly: true, limit: 15 }),
  preset('hardcore', 'Half health, no abilities, slower respawns', 'tdm', {
    name: 'Hardcore TDM', short: 'HC', health: 50, abilities: false, respawn: 6, limit: 40,
  }),
  preset('tanks', 'Double health, flags change hands slowly', 'ctf', { name: 'Tank CTF', short: 'TNK', health: 200, speed: 0.9 }),
  preset('sniper-snd', 'One life, one bolt: Search & Destroy with snipers', 'snd', { name: 'Sniper S&D', short: 'SSD', loadout: 'sniper' }),
  preset('moon', 'Low gravity: huge jumps, floaty fights', 'ffa', { name: 'Moon Gravity', short: 'MOON', gravity: 0.35, speed: 1.1 }),
  preset('speed', 'Fast feet, instant respawns', 'ffa', { name: 'Speed Rush', short: 'SPD', speed: 1.45, respawn: 1, limit: 30 }),
  preset('siege', 'Infection with shotguns: hold the line up close', 'inf', { name: 'Shotgun Siege', short: 'SIEG', loadout: 'shotgun', limit: 2, minutes: 6 }),
  preset('long-night', 'Thirty waves of the horde, if you last that long', 'hrd', { name: 'Long Night', short: 'NITE', limit: 30 }),
  preset('quickscope', 'Snipers, with a Deagle for anyone who gets close', 'ffa', { name: 'Quickscope', short: 'QS', loadout: 'sniper-deagle', limit: 25 }),
  preset('roulette', 'A random gun every life', 'ffa', { name: 'Roulette', short: 'RLT', loadout: 'random', limit: 25 }),
  preset('big-heads', 'Huge heads: every shot could be a headshot', 'ffa', { name: 'Big Heads', short: 'BIG', headSize: 2.5, limit: 30 }),
];

/** Rooms made before custom modes stored these names as their mode. */
const LEGACY: Record<string, string> = { sniper: 'sniper-ffa', snipertdm: 'sniper-tdm', gungame: 'gungame' };

// Function declarations (not consts): the presets above are built with these when the module loads.
export function isBaseMode(m: unknown): m is GameMode {
  return m === 'ffa' || m === 'tdm' || m === 'ctf' || m === 'snd' || m === 'inf' || m === 'hrd';
}

function clamp(v: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * Make any rules object safe to play: fill gaps from the base mode, clamp numbers, and settle
 * combinations that don't make sense (fixed guns mean no gun pickups or ammo; Gun Game is FFA).
 */
export function normalizeRules(raw: unknown, fallbackMode: unknown = 'ffa'): ModeRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ModeRules>;
  const base: GameMode = isBaseMode(r.base) ? r.base : isBaseMode(fallbackMode) ? fallbackMode : 'ffa';
  const d = baseRules(base);
  const loadout: Loadout = LOADOUTS.some((l) => l.value === r.loadout) ? (r.loadout as Loadout) : 'standard';
  const gunGame = loadout === 'gungame' && base === 'ffa';
  const effectiveLoadout: Loadout = loadout === 'gungame' && !gunGame ? 'standard' : loadout;
  const standard = effectiveLoadout === 'standard';
  const text = (v: unknown, max: number, fallback: string) =>
    (typeof v === 'string' && v.trim() ? v.trim().slice(0, max).trim() : fallback);
  return {
    base,
    name: text(r.name, 24, d.name),
    short: text(r.short, 4, d.short).toUpperCase(),
    loadout: effectiveLoadout,
    guns: standard && r.guns !== false,
    abilities: r.abilities !== false,
    ammo: standard && r.ammo !== false,
    limit: gunGame ? GUN_GAME_LADDER.length : Math.round(clamp(r.limit, LIMITS.limit[base], d.limit)),
    minutes: Math.round(clamp(r.minutes, LIMITS.minutes, d.minutes)),
    health: Math.round(clamp(r.health, LIMITS.health, 100) / 25) * 25,
    headshotsOnly: r.headshotsOnly === true,
    respawn: Math.round(clamp(r.respawn, LIMITS.respawn, 3)),
    speed: Math.round(clamp(r.speed, LIMITS.speed, 1) * 20) / 20,
    gravity: Math.round(clamp(r.gravity, LIMITS.gravity, 1) * 20) / 20,
    pickupRate: Math.round(clamp(r.pickupRate, LIMITS.pickupRate, 1) * 4) / 4,
    recoil: Math.round(clamp(r.recoil, LIMITS.recoil, 1) * 4) / 4,
    headSize: Math.round(clamp(r.headSize, LIMITS.headSize, 1) * 4) / 4,
    bots: Math.round(clamp(r.bots, LIMITS.bots, 0)),
    botSkill: BOT_SKILL_OPTIONS.some((o) => o.value === r.botSkill) ? r.botSkill! : 'normal',
  };
}

/** The rules of a room record: its stored rules, or (older rooms) the preset its mode name stood for. */
export function rulesOfRoom(rules: unknown, mode: unknown): ModeRules {
  if (rules && typeof rules === 'object') return normalizeRules(rules, mode);
  const legacy = typeof mode === 'string' ? PRESETS.find((p) => p.id === LEGACY[mode]) : undefined;
  if (legacy) return legacy.rules;
  return baseRules(isBaseMode(mode) ? mode : 'ffa');
}

/** One sentence telling a new player what to do. */
export function goalOf(r: ModeRules): string {
  const win = r.loadout === 'gungame'
    ? `Every kill hands you the next gun — clear all ${r.limit} to win`
    : r.base === 'ffa' ? `Every kill counts — first to ${r.limit} wins`
      : r.base === 'tdm' ? `Kills score for your team — first team to ${r.limit} wins`
        : r.base === 'ctf' ? `Take the enemy flag to your base — first to ${r.limit} capture${r.limit === 1 ? '' : 's'}. Your own flag must be home to score.`
          : r.base === 'inf' ? `Survive until the clock runs out — anyone who dies turns. ${r.limit} zombie${r.limit === 1 ? '' : 's'} at the start, and they win once everyone has turned`
            : r.base === 'hrd' ? `Hold out together against waves of zombies, each bigger than the last. The fallen are back after each wave — survive ${r.limit} to win`
            : `Attackers plant the bomb at site A or B, defenders stop them. One life per round — first team to ${r.limit} rounds wins`;
  const extras = tweaks(r);
  return extras.length ? `${win}. ${extras.join(' · ')}` : win;
}

/** The differences from the plain base mode, as short phrases ("Snipers only", "50 HP", …). */
export function tweaks(r: ModeRules): string[] {
  const out: string[] = [];
  const survivors = r.base === 'inf' || r.base === 'hrd' ? 'Survivors: ' : '';
  const guns = loadoutGuns(r.loadout);
  if (guns.length === 1) out.push(`${survivors}${GUNS[guns[0]!].name}s only, endless ammo`);
  else if (guns.length > 1) out.push(`${survivors}${guns.map((g) => GUNS[g].name).join(' + ')}, endless ammo`);
  else if (r.loadout === 'random') out.push(`${survivors}A random gun each life, endless ammo`);
  if (r.loadout === 'standard' && !r.guns) out.push('No gun pickups');
  if (r.loadout === 'standard' && !r.ammo) out.push('No ammo boxes');
  if (!r.abilities && r.loadout !== 'gungame') out.push('No abilities');
  if (r.headshotsOnly) out.push('Headshots only');
  if (r.health !== 100) out.push(`${r.health} HP`);
  if (r.speed !== 1) out.push(`${Math.round(r.speed * 100)}% speed`);
  if (r.gravity !== 1) out.push(r.gravity < 1 ? `Low gravity (${Math.round(r.gravity * 100)}%)` : `Heavy gravity (${Math.round(r.gravity * 100)}%)`);
  if (r.headSize !== 1) out.push(`Big heads (${Math.round(r.headSize * 100)}%)`);
  if (r.recoil !== 1) out.push(r.recoil === 0 ? 'No recoil' : `${Math.round(r.recoil * 100)}% recoil`);
  if (r.pickupRate !== 1 && (r.abilities || r.guns || r.ammo)) out.push(`${r.pickupRate}× pickup spawns`);
  if (r.respawn !== 3 && r.base !== 'snd' && r.base !== 'hrd') out.push(`${r.respawn}s respawn`);
  return out;
}

// ---------------------------------------------------------------- the player's own modes

const STORAGE_KEY = 'fps-custom-modes';
const MAX_SAVED = 12;

export function loadCustomModes(): ModeRules[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    return Array.isArray(raw) ? raw.slice(0, MAX_SAVED).map((r) => normalizeRules(r)) : [];
  } catch {
    return [];
  }
}

/** Save (or replace, matched by name) one of the player's modes; returns the new list. */
export function saveCustomMode(rules: ModeRules): ModeRules[] {
  const list = [rules, ...loadCustomModes().filter((m) => m.name !== rules.name)].slice(0, MAX_SAVED);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
  return list;
}

export function deleteCustomMode(name: string): ModeRules[] {
  const list = loadCustomModes().filter((m) => m.name !== name);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
  return list;
}

export const sameRules = (a: ModeRules, b: ModeRules) => JSON.stringify(a) === JSON.stringify(b);

/** The same mode, whatever the bot settings (those are the room's, not the mode's) */
export const sameMode = (a: ModeRules, b: ModeRules) =>
  sameRules({ ...a, bots: 0, botSkill: 'normal' }, { ...b, bots: 0, botSkill: 'normal' });
