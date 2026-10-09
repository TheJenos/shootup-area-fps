import { otherTeam } from './modes';
import type { MapData } from './mapgen';
import type { BombRecord, SiteId, SndRecord, Team } from '../types';

/*
 * Search & Destroy: a match is a series of short rounds with no respawns. One team attacks: one of
 * them starts with the bomb, and planting it at either of the defenders' two sites (and keeping it
 * there until it goes off) wins the round. The defenders win by defusing it, by running the clock
 * out before it's planted, or by taking out every attacker first. Teams swap sides at halftime.
 *
 * The round lives at game/snd and changes only through transactions, like the flags in CTF. The
 * leader (lowest player id) referees: it sets rounds up, decides them and starts the next.
 */

/** Seconds everyone is held at their spawn before a round */
export const FREEZE_TIME = 5;
/** Seconds the attackers have to plant */
export const ROUND_TIME = 100;
/** Seconds from planting until the bomb goes off */
export const BOMB_TIME = 40;
/** Seconds of holding the interact key to plant / to defuse */
export const PLANT_TIME = 3.5;
export const DEFUSE_TIME = 6;
/** Seconds between a round being decided and the next one starting */
export const ROUND_END_TIME = 5;
/** How close to a site's centre the bomb can be planted (m) */
export const SITE_RADIUS = 3.5;
/** How close an attacker has to walk to pick up a dropped bomb, and a defender to defuse (m) */
export const BOMB_PICKUP_RADIUS = 1.5;
export const DEFUSE_RADIUS = 2.2;
/** Everyone this close when it goes off dies (m); shown as a shock wave */
export const BOMB_BLAST_RADIUS = 14;
/** Players who join (or switch team) this long into the fight still play the round; later ones wait (s) */
export const JOIN_GRACE = 15;
/** Moving this far (m) from where a plant or defuse started stops it */
export const CHANNEL_SLIP = 0.6;

export interface Point {
  x: number;
  y: number;
  z: number;
}

export const SITE_IDS: SiteId[] = ['a', 'b'];

/**
 * Rounds per half: a match to `limit` lasts at most 2 × (limit − 1) + 1 rounds, so each side attacks
 * limit − 1 times before the swap. Past that (tied going into the last round) sides alternate.
 */
export const halfLength = (limit: number) => Math.max(1, limit - 1);

/** Who attacks in round `n` (from 0) of a match to `limit`. Red attacks first. */
export function attackersFor(n: number, limit: number): Team {
  const half = halfLength(limit);
  if (n < half) return 'red';
  if (n < half * 2) return 'blue';
  return (n - half * 2) % 2 === 0 ? 'red' : 'blue';
}

/** Round `n` is the first with sides swapped. */
export const sidesSwapped = (n: number, limit: number) => n > 0 && attackersFor(n, limit) !== attackersFor(n - 1, limit);

export type SndPhase = 'freeze' | 'live' | 'planted' | 'over';

export function phaseOf(s: SndRecord, now: number): SndPhase {
  if (s.over) return 'over';
  if (s.bomb.plantedAt !== undefined) return 'planted';
  return now < s.at ? 'freeze' : 'live';
}

/** Where the bomb is */
export type BombPlacement =
  | { at: 'carried'; carrier: string }
  | { at: 'planted'; site: SiteId; x: number; y: number; z: number; plantedAt: number; planter: string | null }
  | { at: 'ground'; x: number; y: number; z: number };

export function bombPlacement(b: BombRecord | undefined): BombPlacement | null {
  if (!b) return null;
  if (b.by) return { at: 'carried', carrier: b.by };
  if (typeof b.x !== 'number' || typeof b.z !== 'number') return null;
  const y = b.y ?? 0;
  if (b.site && typeof b.plantedAt === 'number') {
    return { at: 'planted', site: b.site, x: b.x, y, z: b.z, plantedAt: b.plantedAt, planter: b.planter ?? null };
  }
  return { at: 'ground', x: b.x, y, z: b.z };
}

/** Whether someone arriving now can still play this round (the freeze, or early in the fight before a plant) */
export function canJoin(s: SndRecord, now: number): boolean {
  const phase = phaseOf(s, now);
  return phase === 'freeze' || (phase === 'live' && now < s.at + JOIN_GRACE * 1000);
}

/** Seconds left on the clock that matters now: until the fight starts, the attackers' time, or the fuse. */
export function secondsLeft(s: SndRecord, now: number): number {
  const phase = phaseOf(s, now);
  const end = phase === 'freeze' ? s.at
    : phase === 'planted' ? (s.bomb.plantedAt ?? now) + BOMB_TIME * 1000
      : phase === 'live' ? s.at + ROUND_TIME * 1000
        : now;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** Who's on each team and how many of them are alive */
export type Headcount = Record<Team, { size: number; alive: number }>;

/**
 * Whether the round is decided now, and how: the fuse ran out (attackers), the clock ran out before a
 * plant (defenders), or one side is all dead. A team with nobody in it can't be wiped out.
 */
export function decide(s: SndRecord, now: number, heads: Headcount): { winner: Team; why: 'elim' | 'bomb' | 'time' } | null {
  const phase = phaseOf(s, now);
  if (phase === 'over' || phase === 'freeze') return null;
  const atk = s.atk;
  const def = otherTeam(atk);
  if (phase === 'planted') {
    if (now >= (s.bomb.plantedAt ?? now) + BOMB_TIME * 1000) return { winner: atk, why: 'bomb' };
    // Planted: the attackers are no longer needed, the defenders still have to defuse it.
    if (heads[def].size > 0 && heads[def].alive === 0) return { winner: atk, why: 'elim' };
    return null;
  }
  if (heads[atk].size > 0 && heads[atk].alive === 0) return { winner: def, why: 'elim' };
  if (heads[def].size > 0 && heads[def].alive === 0) return { winner: atk, why: 'elim' };
  if (now >= s.at + ROUND_TIME * 1000) return { winner: def, why: 'time' };
  return null;
}

const flat = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The defenders' two bomb sites on a map. A stands where their flag would (a flat, open pad every map
 * has); B is the pickup spot in their half furthest from it, at about the same height, so the two
 * sites pull the defence apart. Maps are symmetric, so both teams defend the same layout.
 */
export function bombSites(map: Pick<MapData, 'flags' | 'pickupSpots' | 'spawns' | 'half'>, defenders: Team): Record<SiteId, Point> {
  const [fx, fy, fz] = map.flags[defenders];
  const a = { x: fx, y: fy, z: fz };
  const side = defenders === 'red' ? 1 : -1;
  const inHalf = (p: Point) => p.z * side > map.half * 0.25;
  const level = (p: Point) => Math.abs(p.y - fy) < 2.5;
  const candidates: Point[] = map.pickupSpots.filter((p) => inHalf(p) && level(p));
  // Classic-style maps without spots: their spawns will do.
  if (!candidates.length) candidates.push(...map.spawns.filter((sp) => sp.team === defenders));
  let b: Point | null = null;
  let best = -1;
  for (const c of candidates) {
    const d = flat(c, a);
    // Ties (mirrored spots) go to the one with the smaller x, so every client picks the same.
    if (d > best + 1e-6 || (Math.abs(d - best) <= 1e-6 && b && c.x < b.x)) {
      best = d;
      b = c;
    }
  }
  if (!b || best < 8) b = { x: fx === 0 ? map.half * 0.5 : -fx, y: fy, z: fz * 0.7 };
  return { a, b: { x: b.x, y: b.y, z: b.z } };
}

/** Where the bomb waits when no attacker is around to carry it: their spawn nearest the middle of the others. */
export function bombHome(map: Pick<MapData, 'spawns' | 'flags'>, attackers: Team): Point {
  const own = map.spawns.filter((sp) => sp.team === attackers);
  if (!own.length) {
    const [x, y, z] = map.flags[attackers];
    return { x, y, z };
  }
  const cx = own.reduce((s, p) => s + p.x, 0) / own.length;
  const cz = own.reduce((s, p) => s + p.z, 0) / own.length;
  const home = own.reduce((best, p) => (Math.hypot(p.x - cx, p.z - cz) < Math.hypot(best.x - cx, best.z - cz) ? p : best));
  return { x: home.x, y: home.y, z: home.z };
}

/** The site whose plant zone `p` stands in, if any */
export function siteAt(sites: Record<SiteId, Point>, p: Point): SiteId | null {
  for (const id of SITE_IDS) {
    const s = sites[id];
    if (flat(s, p) <= SITE_RADIUS && Math.abs(s.y - p.y) < 2) return id;
  }
  return null;
}

export const SITE_NAME: Record<SiteId, string> = { a: 'A', b: 'B' };

/** A fresh round `n`: the bomb goes to `carrier` (or waits at the attackers' spawn). */
export function newRound(n: number, limit: number, now: number, carrier: string | null, home: Point): SndRecord {
  const atk = attackersFor(n, limit);
  const bomb: BombRecord = carrier ? { by: carrier } : { x: home.x, y: home.y, z: home.z };
  return { n, atk, at: now + FREEZE_TIME * 1000, bomb };
}

/** Pick the bomb carrier from the attackers, the same way on every try of the transaction. */
export function pickCarrier(attackers: readonly string[], n: number): string | null {
  if (!attackers.length) return null;
  const sorted = [...attackers].sort();
  return sorted[(n * 7 + 3) % sorted.length] ?? null;
}
