import { CHEST_Y, HEAD_Y, aimAngles, wrapAngle } from './hitscan';
import type { BotNav, Waypoint } from './nav';
import type { GameMode, GunKind, Stance } from '../../types';
import type { Team } from '../mapgen/types';

/*
 * What a bot knows, as a fixed-length vector of numbers: the same in the training simulator and in
 * a real game, so a policy trained on one plays the other. Everything is relative to the bot (its
 * position and the way it faces), and it only knows where enemies are if it can see them (or saw
 * them a moment ago, or they shot it): no wallhacks.
 *
 * Bump OBS_VERSION whenever the layout changes: a policy trained on another layout is refused.
 */

export const OBS_VERSION = 1;

const GUN_ORDER: GunKind[] = ['rifle', 'shotgun', 'sniper', 'deagle'];
const PROBES = 8;
const ENEMIES = 3;
const PER_ENEMY = 10;
/** Enemies are remembered this long after last being seen (s) */
export const MEMORY_TIME = 4;
/** Getting shot is remembered this long (s) */
const HURT_TIME = 2;
/** Probes look this far for walls (m) */
const PROBE_RANGE = 20;
/** Eyes, standing */
const EYE = 1.6;

export const OBS_SIZE = 14 + PROBES + 8 + ENEMIES * PER_ENEMY + 4 + 8 + 3;

/** Where each part starts (for scripted bots and tests). Each enemy: seen, right, forward, up, distance, yaw error, pitch error, hp, carrying, age. */
export const OBS_LAYOUT = {
  self: 0,
  probes: 14,
  attack: 14 + PROBES,
  defend: 14 + PROBES + 4,
  enemies: 14 + PROBES + 8,
  perEnemy: PER_ENEMY,
  ally: 14 + PROBES + 8 + ENEMIES * PER_ENEMY,
  mode: 14 + PROBES + 8 + ENEMIES * PER_ENEMY + 4,
  hurt: 14 + PROBES + 8 + ENEMIES * PER_ENEMY + 12,
} as const;

export interface SelfView {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  stance: Stance;
  hp: number;
  maxHp: number;
  team: Team | null;
  gun: GunKind;
  ammo: number;
  mag: number;
  reloading: boolean;
  /** Carrying the enemy flag */
  carrying: boolean;
}

export interface BodyView {
  id: string;
  x: number; y: number; z: number;
  stance: Stance;
  alive: boolean;
  hp: number;
  maxHp: number;
  team: Team | null;
  /** Carrying a flag */
  carrying: boolean;
  /** A person, not a bot (the objective layer plans around where people go, it can't send them anywhere) */
  human?: boolean;
}

export type FlagState =
  | { at: 'base' }
  | { at: 'ground'; x: number; y: number; z: number }
  | { at: 'carried'; carrier: string };

export interface CtfView {
  /** Our base (where we score) and theirs (where their flag stands) */
  ownBase: { x: number; y: number; z: number };
  enemyBase: { x: number; y: number; z: number };
  own: FlagState;
  enemy: FlagState;
}

/** What the world can tell a bot */
export interface Senses {
  nav: BotNav;
  /** Whether a ray from a to b gets through */
  sees(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** Distance to the nearest wall from (x, y, z) along (dx, dz), up to `max` */
  probe(x: number, y: number, z: number, dx: number, dz: number, max: number): number;
  /** Middle of the map (where fights happen when there's nothing else to go for) */
  center: { x: number; y: number; z: number };
}

/** What a bot remembers between decisions */
export class BotMemory {
  /**
   * What it knows about each enemy: where, as of when (`t`), and when it last saw them with its own
   * eyes (`seenAt`; teammates' callouts and gunfire it heard leave that out).
   */
  readonly seen = new Map<string, { x: number; y: number; z: number; stance: Stance; t: number; seenAt?: number }>();

  /** Learn where an enemy is without seeing them (a callout, a gunshot): only if it's newer than what we know. */
  learn(id: string, x: number, y: number, z: number, stance: Stance, t: number): void {
    const m = this.seen.get(id);
    if (m && m.t >= t) return;
    this.seen.set(id, { x, y, z, stance, t, ...(m?.seenAt !== undefined ? { seenAt: m.seenAt } : {}) });
  }
  hurtAt = -Infinity;
  hurtFrom: { x: number; z: number } | null = null;

  /** Something hit us from `from` (the shooter's position) */
  /** Who shot us last (to shoot back at), if we know */
  hurtBy: string | null = null;

  /** Something hit us from `from` (the shooter's position) */
  hurt(now: number, from: { x: number; z: number } | null, by: string | null = null): void {
    this.hurtAt = now;
    this.hurtFrom = from;
    this.hurtBy = by;
  }

  /** Enemies seen at the last look (within `window` seconds of `now`) */
  inView(now: number, window = 0.25): string[] {
    const out: string[] = [];
    for (const [id, m] of this.seen) if (m.seenAt !== undefined && now - m.seenAt <= window) out.push(id);
    return out;
  }

  reset(): void {
    this.seen.clear();
    this.hurtAt = -Infinity;
    this.hurtFrom = null;
    this.hurtBy = null;
  }
}

export interface ObsInput {
  self: SelfView;
  others: readonly BodyView[];
  mode: GameMode;
  ctf: CtfView | null;
  /** Seconds, any clock that only goes forward */
  now: number;
  memory: BotMemory;
  senses: Senses;
  /** Filled in: walking distance to the attack objective (Infinity if there's no path) */
  info?: { attackDist: number };
  /**
   * The objective layer's goal (objective.ts). With one, the first nav slot is the way to it and the second
   * the nearest enemy, in every mode; without, the slots follow the mode (the flags in CTF).
   */
  goal?: { x: number; y: number; z: number } | null;
  /** The mode the policy is told it's playing (with a goal, CTF is shown as TDM: only the fighting is its job) */
  asMode?: GameMode;
}

/** Enemies (not teammates, not ourselves) */
const isEnemy = (self: SelfView, b: BodyView) => !self.team || b.team !== self.team;

/** Fill `out` with the observation (raw: the policy normalises it). Also updates the memory. */
export function observe(input: ObsInput, out: Float32Array = new Float32Array(OBS_SIZE)): Float32Array {
  const { self, others, ctf, now, memory, senses, info, goal } = input;
  const mode = input.asMode ?? input.mode;
  if (info) info.attackDist = Infinity;
  out.fill(0);
  let o = 0;
  const sin = Math.sin(self.yaw);
  const cos = Math.cos(self.yaw);
  /** World offset → (right, forward) in the bot's frame */
  const local = (dx: number, dz: number): [number, number] => [cos * dx - sin * dz, -sin * dx - cos * dz];
  const eyeY = self.y + (self.stance === 'stand' ? EYE : HEAD_Y[self.stance]);

  // ---- self (14)
  const [vr, vf] = local(self.vx, self.vz);
  out[o++] = self.hp / self.maxHp;
  out[o++] = vr / 10;
  out[o++] = vf / 10;
  out[o++] = self.vy / 10;
  out[o++] = self.onGround ? 1 : 0;
  out[o++] = self.stance === 'crouch' ? 1 : 0;
  out[o++] = self.stance === 'slide' ? 1 : 0;
  out[o++] = self.pitch / 1.5;
  out[o++] = self.mag > 0 ? self.ammo / self.mag : 0;
  out[o++] = self.reloading ? 1 : 0;
  for (const g of GUN_ORDER) out[o++] = self.gun === g ? 1 : 0;

  // ---- walls around (8), starting straight ahead, clockwise
  for (let p = 0; p < PROBES; p++) {
    const a = self.yaw - (p / PROBES) * Math.PI * 2;
    out[o++] = senses.probe(self.x, self.y + 0.9, self.z, -Math.sin(a), -Math.cos(a), PROBE_RANGE) / PROBE_RANGE;
  }

  // ---- see who's where (and remember)
  const visible: { b: BodyView; d: number; seen: boolean; age: number; x: number; y: number; z: number; stance: Stance }[] = [];
  for (const b of others) {
    if (!b.alive) {
      memory.seen.delete(b.id);
      continue;
    }
    if (!isEnemy(self, b)) continue;
    const sees = senses.sees(self.x, eyeY, self.z, b.x, b.y + CHEST_Y[b.stance], b.z)
      || senses.sees(self.x, eyeY, self.z, b.x, b.y + HEAD_Y[b.stance], b.z);
    if (sees) memory.seen.set(b.id, { x: b.x, y: b.y, z: b.z, stance: b.stance, t: now, seenAt: now });
    const m = memory.seen.get(b.id);
    if (!sees && (!m || now - m.t > MEMORY_TIME)) continue;
    const at = sees ? b : m!;
    visible.push({ b, d: Math.hypot(at.x - self.x, at.z - self.z), seen: sees, age: sees ? 0 : now - m!.t, x: at.x, y: at.y, z: at.z, stance: at.stance });
  }
  // Seen ones first, then the nearest.
  visible.sort((a, b) => Number(b.seen) - Number(a.seen) || a.d - b.d);

  // ---- nav (8): where to go to attack, and to defend
  const nav = (target: { x: number; y: number; z: number } | null, straight = false, attack = false) => {
    if (!target) { o += 4; return; }
    let w: Waypoint | null = straight ? null : senses.nav.waypoint(self.x, self.y, self.z, target.x, target.y, target.z);
    const pathed = !!w;
    if (attack && info && w) info.attackDist = w.dist;
    w ??= { x: target.x, y: target.y, z: target.z, dist: Math.hypot(target.x - self.x, target.z - self.z) };
    const [r, f] = local(w.x - self.x, w.z - self.z);
    const l = Math.hypot(r, f) || 1;
    out[o++] = r / l;
    out[o++] = f / l;
    out[o++] = Math.min(1, w.dist / 60);
    out[o++] = pathed ? 1 : 0.5;
  };
  const posOf = (id: string) => others.find((b) => b.id === id) ?? null;
  if (goal) {
    nav(goal, false, true);
    const nearest = visible[0];
    if (nearest) nav(nearest, true);
    else o += 4;
  } else if (ctf) {
    const flagSpot = (f: FlagState, base: { x: number; y: number; z: number }) =>
      f.at === 'base' ? base : f.at === 'ground' ? f : null;
    // Attack: bring their flag home if we have it; escort a teammate who has it; otherwise go get it.
    const enemyFlag = flagSpot(ctf.enemy, ctf.enemyBase);
    nav(self.carrying || ctf.enemy.at === 'carried' ? ctf.ownBase : enemyFlag, false, true);
    // Defend: our flag where it lies, or chase whoever has it (in a straight line: they're moving).
    if (ctf.own.at === 'carried') nav(posOf(ctf.own.carrier), true);
    else nav(flagSpot(ctf.own, ctf.ownBase));
  } else {
    nav(senses.center, false, true);
    const nearest = visible[0];
    if (nearest) nav(nearest, true);
    else o += 4;
  }

  // ---- enemies (3 × 10)
  for (let e = 0; e < ENEMIES; e++) {
    const v = visible[e];
    if (!v) { o += PER_ENEMY; continue; }
    const [r, f] = local(v.x - self.x, v.z - self.z);
    const [yaw, pitch] = aimAngles(self.x, eyeY, self.z, v.x, v.y + CHEST_Y[v.stance], v.z);
    out[o++] = v.seen ? 1 : 0;
    out[o++] = r / 30;
    out[o++] = f / 30;
    out[o++] = (v.y - self.y) / 10;
    out[o++] = Math.min(1, v.d / 60);
    out[o++] = wrapAngle(yaw - self.yaw) / Math.PI;
    out[o++] = (pitch - self.pitch) / (Math.PI / 2);
    out[o++] = v.seen ? v.b.hp / v.b.maxHp : 0;
    out[o++] = v.b.carrying ? 1 : 0;
    out[o++] = v.age / MEMORY_TIME;
  }

  // ---- nearest teammate (4)
  let ally: BodyView | null = null;
  let allyD = Infinity;
  if (self.team) {
    for (const b of others) {
      if (!b.alive || b.team !== self.team) continue;
      const d = Math.hypot(b.x - self.x, b.z - self.z);
      if (d < allyD) { allyD = d; ally = b; }
    }
  }
  if (ally) {
    const [r, f] = local(ally.x - self.x, ally.z - self.z);
    out[o++] = r / 30;
    out[o++] = f / 30;
    out[o++] = Math.min(1, allyD / 60);
    out[o++] = 1;
  } else {
    o += 4;
  }

  // ---- mode (8)
  out[o++] = mode === 'ffa' ? 1 : 0;
  out[o++] = mode === 'tdm' ? 1 : 0;
  out[o++] = mode === 'ctf' ? 1 : 0;
  out[o++] = self.carrying ? 1 : 0;
  // With a goal the flags are the objective layer's business, not the policy's.
  const flags = goal ? null : ctf;
  out[o++] = flags?.own.at === 'base' ? 1 : 0;
  out[o++] = flags?.own.at === 'carried' ? 1 : 0;
  out[o++] = flags?.enemy.at === 'base' ? 1 : 0;
  out[o++] = flags?.enemy.at === 'carried' && !self.carrying ? 1 : 0;

  // ---- getting shot (3)
  const hurtAge = now - memory.hurtAt;
  if (hurtAge < HURT_TIME) {
    out[o++] = 1 - hurtAge / HURT_TIME;
    if (memory.hurtFrom) {
      const [r, f] = local(memory.hurtFrom.x - self.x, memory.hurtFrom.z - self.z);
      const l = Math.hypot(r, f) || 1;
      out[o++] = r / l;
      out[o++] = f / l;
    } else {
      o += 2;
    }
  } else {
    o += 3;
  }

  if (o !== OBS_SIZE) throw new Error(`Observation is ${o} long, expected ${OBS_SIZE}`);
  return out;
}
