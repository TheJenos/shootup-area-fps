import * as THREE from 'three';
import type { GameMode, GunKind, Team } from '../types';

/**
 * Gun Game: everyone starts on the first gun and each kill moves them to the next; the first
 * through the whole ladder wins. No pickups, endless ammo.
 */
export const GUN_GAME_LADDER: GunKind[] = [
  'rifle', 'deagle', 'shotgun', 'sniper', 'rifle', 'shotgun', 'deagle', 'sniper', 'rifle', 'deagle', 'shotgun', 'sniper',
];

/** The gun for a player with `kills` kills (the last gun stays until the round ends). */
export const gunGameGun = (kills: number): GunKind =>
  GUN_GAME_LADDER[Math.min(Math.max(0, kills), GUN_GAME_LADDER.length - 1)] ?? 'rifle';

export interface ModeDef {
  name: string;
  short: string;
  description: string;
  teams: boolean;
  /** Kills (FFA: one player's, TDM: a team's) or flag captures (CTF) needed to win the round */
  limit: number;
  /** Round length in seconds; the best score when it runs out wins */
  timeLimit: number;
  /** Whether guns, abilities and ammo spawn on the map */
  pickups: boolean;
}

export const MODES: Record<GameMode, ModeDef> = {
  ffa: {
    name: 'Free-for-all', short: 'FFA', description: 'Everyone for themselves', teams: false, limit: 25, timeLimit: 8 * 60, pickups: true,
  },
  tdm: {
    name: 'Team Deathmatch', short: 'TDM', description: 'Red vs Blue, team kills count', teams: true, limit: 50, timeLimit: 10 * 60, pickups: true,
  },
  ctf: {
    name: 'Capture the Flag', short: 'CTF', description: 'Bring the enemy flag to yours', teams: true, limit: 3, timeLimit: 12 * 60, pickups: true,
  },
  gungame: {
    name: 'Gun Game', short: 'GG', description: 'Every kill gives the next gun; finish the ladder to win', teams: false,
    limit: GUN_GAME_LADDER.length, timeLimit: 10 * 60, pickups: false,
  },
};

export const GAME_MODES = Object.keys(MODES) as GameMode[];

export const isGameMode = (m: unknown): m is GameMode => typeof m === 'string' && m in MODES;

export const TEAMS: Team[] = ['red', 'blue'];

export const TEAM_INFO: Record<Team, { name: string; color: string }> = {
  red: { name: 'Red', color: '#ff4d4d' },
  blue: { name: 'Blue', color: '#3d8bff' },
};

export const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/** Seconds the winner screen stays up after a round ends */
export const RESULTS_TIME = 6;
/** Seconds of MVP replay after that, before the next map loads */
export const MVP_TIME = 10;
/** The round clock turns red for the last this-many seconds */
export const CLOCK_WARNING = 30;

/** Each team's half of the map: red owns +z, blue owns -z. */
const SIDE: Record<Team, number> = { red: 1, blue: -1 };

export const FLAG_BASES: Record<Team, THREE.Vector3> = {
  red: new THREE.Vector3(0, 0, 32 * SIDE.red),
  blue: new THREE.Vector3(0, 0, 32 * SIDE.blue),
};

/** Distance at which a player touches a flag */
export const FLAG_RADIUS = 1.5;
/** A dropped flag goes back to its base after this long */
export const FLAG_RETURN_TIME = 20;

/** Spawn points on the team's own half (points on the center line are left out). */
export function teamSpawns(points: THREE.Vector3[], team: Team): THREE.Vector3[] {
  return points.filter((p) => Math.sign(p.z) === SIDE[team]);
}
