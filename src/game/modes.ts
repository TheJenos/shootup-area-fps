import * as THREE from 'three';
import type { GameMode, GunKind, Team } from '../types';

/**
 * Gun Game ladder (a loadout, see rules.ts): everyone starts on the first gun and each kill moves
 * them to the next; the first through the whole ladder wins.
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
  /** Kills (FFA: one player's, TDM: a team's), flag captures (CTF) or rounds (S&D) needed to win the match */
  limit: number;
  /** Round length in seconds; the best score when it runs out wins */
  timeLimit: number;
  /** Whether guns, abilities and ammo spawn on the map */
  pickups: boolean;
  /** One line telling a new player what to do */
  goal: string;
}

/** The base types every mode (prebuilt or custom) is built on; see rules.ts for the rest. */
export const MODES: Record<GameMode, ModeDef> = {
  ffa: {
    name: 'Free-for-all', short: 'FFA', description: 'Everyone for themselves', teams: false, limit: 25, timeLimit: 8 * 60, pickups: true,
    goal: 'Every kill counts — first to 25 wins',
  },
  tdm: {
    name: 'Team Deathmatch', short: 'TDM', description: 'Red vs Blue, team kills count', teams: true, limit: 50, timeLimit: 10 * 60, pickups: true,
    goal: 'Kills score for your team — first team to 50 wins',
  },
  ctf: {
    name: 'Capture the Flag', short: 'CTF', description: 'Bring the enemy flag to yours', teams: true, limit: 3, timeLimit: 12 * 60, pickups: true,
    goal: 'Take the enemy flag to your base — first to 3 captures. Your own flag must be home to score.',
  },
  snd: {
    name: 'Search & Destroy', short: 'S&D', description: 'One life per round: plant the bomb or stop it', teams: true, limit: 5, timeLimit: 20 * 60, pickups: true,
    goal: 'Attackers plant the bomb at site A or B, defenders stop them. One life per round — first team to 5 rounds wins.',
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

/** Where each team's flag stands on the current map: moved in place by setFlagBases when a map loads. */
export const FLAG_BASES: Record<Team, THREE.Vector3> = {
  red: new THREE.Vector3(0, 0, 32 * SIDE.red),
  blue: new THREE.Vector3(0, 0, 32 * SIDE.blue),
};

/** Move the flag bases to a map's flag spots (see MapData.flags). */
export function setFlagBases(flags: { red: readonly [number, number, number]; blue: readonly [number, number, number] }): void {
  FLAG_BASES.red.set(...flags.red);
  FLAG_BASES.blue.set(...flags.blue);
}

/**
 * Carrying the enemy flag stows your guns and grenades: the flag itself is your only weapon,
 * swung at close range. Two body hits (or a hit to the head and one more) take someone down.
 */
export const MELEE_DAMAGE = 55;
export const MELEE_HEAD_DAMAGE = 80;
/** Reach of a swing from the eyes (m) */
export const MELEE_RANGE = 2.4;
/** Seconds between swings */
export const MELEE_COOLDOWN = 0.7;

/** The knife (V): always carried, a quick slash at arm's length. Damage per hit, head or body. */
export const KNIFE_DAMAGE = 50;
/** Reach of a slash from the eyes (m) */
export const KNIFE_RANGE = 2.2;
/** Seconds from one slash to the next */
export const KNIFE_COOLDOWN = 0.6;

/** Distance at which a player touches a flag */
export const FLAG_RADIUS = 1.5;
/** A dropped flag goes back to its base after this long */
export const FLAG_RETURN_TIME = 20;

/** A team's spawn points (the map marks whose each is; free-for-all ones are left out). */
export function teamSpawns(points: readonly { pos: THREE.Vector3; team: Team | null }[], team: Team): THREE.Vector3[] {
  return points.filter((p) => p.team === team).map((p) => p.pos);
}
