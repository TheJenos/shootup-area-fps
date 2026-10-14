import { GUNS } from '../gunStats';
import { wrapAngle } from './hitscan';
import type { BotNav } from './nav';

/*
 * What holds a bot to a player's limits, in one place for the live game (botHost.ts) and the
 * training simulator (sim/arena.ts): what it can see, how well it reads an enemy's health, its
 * recoil and ammo, and the ledges it can jump. Trained under the same rules it plays by, a policy
 * never meets a sense or a rule it didn't learn with.
 */

/** How wide a bot sees (radians, all of it): about a player's view; Expert a bit more (it's meant to be sharp) */
export const BOT_FOV = (120 * Math.PI) / 180;
export const EXPERT_FOV = (160 * Math.PI) / 180;
/** Anyone this close is noticed whichever way the bot faces (heard, bumped into) (m) */
export const FEEL_RANGE = 3;
/** A cloaked enemy is only seen this close (m) */
export const CLOAK_SEEN_RANGE = 6;
/** Spare rifle rounds, as a player starts with (Infinity in modes that hand everyone one gun) */
export const RIFLE_RESERVE = GUNS.rifle.reserve;
/** Ledges up to this high are on a bot's paths (m): under a jump's ~1.3 m apex, with room to clear it */
export const JUMP_UP = 1.1;
/** How long jump is held at a ledge (s) */
export const JUMP_HOLD = 0.25;

/** Whether (bx, bz) is in front of someone at (x, z) facing `yaw` within `fov`, or close enough to be felt */
export function inFieldOfView(x: number, z: number, yaw: number, bx: number, bz: number, fov: number): boolean {
  const dx = bx - x;
  const dz = bz - z;
  if (Math.hypot(dx, dz) < FEEL_RANGE) return true;
  // Forward is -z at yaw 0, so the bearing to them is atan2(-dx, -dz).
  return Math.abs(wrapAngle(Math.atan2(-dx, -dz) - yaw)) <= fov / 2;
}

/** An enemy's health as a name tag's bar reads it: in quarters (rounded up), not the exact number */
export const roughHp = (hp: number, maxHp: number): number => (Math.ceil((hp / maxHp) * 4) / 4) * maxHp;

/** A shot's kick, less with the sights up (0..1), as the player's */
export const adsRecoil = (recoil: number, ads: number): number => recoil * (1 - 0.45 * ads);

/**
 * Its way to `goal` goes up a ledge just ahead (only a jump gets up it), and it's heading that way:
 * time to jump. "Heading that way" is where it's moving, or, once it has walked into the ledge and
 * stopped, where it's facing (a bot pinned against the ledge has no speed left to tell by).
 * Needs the nav's jumps allowed (BotNav.allowJumps(JUMP_UP)).
 */
export function ledgeAhead(
  nav: BotNav, p: { x: number; y: number; z: number }, v: { x: number; z: number }, onGround: boolean,
  goal: { x: number; y: number; z: number } | null, yaw: number,
): boolean {
  if (!goal || !onGround) return false;
  const w = nav.waypoint(p.x, p.y, p.z, goal.x, goal.y, goal.z);
  if (!w?.jump) return false;
  const dx = w.x - p.x;
  const dz = w.z - p.z;
  const d = Math.hypot(dx, dz) || 1;
  const speed = Math.hypot(v.x, v.z);
  // Moving: along its velocity. Stalled: along its facing (forward is -z at yaw 0).
  const [hx, hz] = speed > 1 ? [v.x / speed, v.z / speed] : [-Math.sin(yaw), -Math.cos(yaw)];
  return (hx * dx + hz * dz) / d > 0.5;
}
