import { GUN_GAME_LADDER, MODES } from './modes';
import { GUNS } from './guns';
import type { GameMode, GunKind } from '../types';

/*
 * Game modes = a base type (FFA, TDM or CTF: teams, flags, how points are scored) plus a set of
 * rules on top. The prebuilt modes are just named rule sets, and players can make their own.
 * A room's rules are stored with it (lobby/{code}/rules), so everyone who joins plays the same.
 */

/** What players hold: the normal rifle + pickups, one fixed gun for everyone, or the Gun Game ladder */
export type Loadout = 'standard' | 'gungame' | GunKind;

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
  /** Kills (FFA: one player, TDM: a team) or captures (CTF) to win; Gun Game uses the ladder */
  limit: number;
  /** Round length in minutes */
  minutes: number;
  /** Starting / maximum health */
  health: number;
  /** Only headshots hurt (grenades are left out of the pickups) */
  headshotsOnly: boolean;
  /** Seconds before respawning */
  respawn: number;
  /** Movement speed multiplier */
  speed: number;
  /** Gravity multiplier (lower = higher, floatier jumps) */
  gravity: number;
}

export const LIMITS = {
  limit: { ffa: [5, 60], tdm: [10, 150], ctf: [1, 10] } as Record<GameMode, [number, number]>,
  minutes: [3, 20],
  health: [25, 200],
  respawn: [1, 10],
  speed: [0.7, 1.5],
  gravity: [0.3, 1.5],
} as const;

export const LOADOUTS: { value: Loadout; label: string }[] = [
  { value: 'standard', label: 'Standard (rifle + pickups)' },
  { value: 'rifle', label: 'Rifles only' },
  { value: 'shotgun', label: 'Shotguns only' },
  { value: 'sniper', label: 'Snipers only' },
  { value: 'deagle', label: 'Deagles only' },
  { value: 'gungame', label: 'Gun Game ladder (FFA)' },
];

/** The plain base mode, as it plays by default. */
export function baseRules(base: GameMode): ModeRules {
  const def = MODES[base];
  return {
    base, name: def.name, short: def.short, loadout: 'standard', guns: true, abilities: true, ammo: true,
    limit: def.limit, minutes: def.timeLimit / 60, health: 100, headshotsOnly: false, respawn: 3, speed: 1, gravity: 1,
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
  preset('moon', 'Low gravity: huge jumps, floaty fights', 'ffa', { name: 'Moon Gravity', short: 'MOON', gravity: 0.35, speed: 1.1 }),
  preset('speed', 'Fast feet, instant respawns', 'ffa', { name: 'Speed Rush', short: 'SPD', speed: 1.45, respawn: 1, limit: 30 }),
];

/** Rooms made before custom modes stored these names as their mode. */
const LEGACY: Record<string, string> = { sniper: 'sniper-ffa', snipertdm: 'sniper-tdm', gungame: 'gungame' };

// Function declarations (not consts): the presets above are built with these when the module loads.
export function isBaseMode(m: unknown): m is GameMode {
  return m === 'ffa' || m === 'tdm' || m === 'ctf';
}

function clamp(v: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * Make any rules object safe to play: fill gaps from the base mode, clamp numbers, and settle
 * combinations that don't make sense (one fixed gun means no gun pickups or ammo; Gun Game is FFA).
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
        : `Take the enemy flag to your base — first to ${r.limit} capture${r.limit === 1 ? '' : 's'}. Your own flag must be home to score.`;
  const extras = tweaks(r);
  return extras.length ? `${win}. ${extras.join(' · ')}` : win;
}

/** The differences from the plain base mode, as short phrases ("Snipers only", "50 HP", …). */
export function tweaks(r: ModeRules): string[] {
  const out: string[] = [];
  if (r.loadout !== 'standard' && r.loadout !== 'gungame') out.push(`${GUNS[r.loadout].name}s only, endless ammo`);
  if (r.loadout === 'standard' && !r.guns) out.push('No gun pickups');
  if (r.loadout === 'standard' && !r.ammo) out.push('No ammo boxes');
  if (!r.abilities && r.loadout !== 'gungame') out.push('No abilities');
  if (r.headshotsOnly) out.push('Headshots only');
  if (r.health !== 100) out.push(`${r.health} HP`);
  if (r.speed !== 1) out.push(`${Math.round(r.speed * 100)}% speed`);
  if (r.gravity !== 1) out.push(r.gravity < 1 ? `Low gravity (${Math.round(r.gravity * 100)}%)` : `Heavy gravity (${Math.round(r.gravity * 100)}%)`);
  if (r.respawn !== 3) out.push(`${r.respawn}s respawn`);
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
