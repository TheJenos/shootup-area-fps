import * as THREE from 'three';
import type { GameMode, Team } from '../types';

export interface ModeDef {
  name: string;
  short: string;
  description: string;
  teams: boolean;
  /** Kills (FFA: one player's, TDM: a team's) or flag captures (CTF) needed to win the round */
  limit: number;
}

export const MODES: Record<GameMode, ModeDef> = {
  ffa: { name: 'Free-for-all', short: 'FFA', description: 'Everyone for themselves', teams: false, limit: 25 },
  tdm: { name: 'Team Deathmatch', short: 'TDM', description: 'Red vs Blue, team kills count', teams: true, limit: 50 },
  ctf: { name: 'Capture the Flag', short: 'CTF', description: "Bring the enemy flag to yours", teams: true, limit: 3 },
};

export const GAME_MODES = Object.keys(MODES) as GameMode[];

export const isGameMode = (m: unknown): m is GameMode => typeof m === 'string' && m in MODES;

export const TEAMS: Team[] = ['red', 'blue'];

export const TEAM_INFO: Record<Team, { name: string; color: string }> = {
  red: { name: 'Red', color: '#ff4d4d' },
  blue: { name: 'Blue', color: '#3d8bff' },
};

export const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/** Seconds the "round over" screen stays up before the next round starts */
export const INTERMISSION = 8;

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
