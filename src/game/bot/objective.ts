import { OBS_LAYOUT } from './observe';
import { MAX_TURN, type BotAction } from './policy';
import type { BodyView, CtfView } from './observe';
import type { GameMode } from '../../types';
import type { Team } from '../mapgen/types';

/*
 * The scripted half of a bot: where it should be going. The trained policy fights; this decides the
 * objective (CTF roles: carry the flag home, return ours, chase their carrier, escort ours, attack or
 * hold the base; elsewhere: patrol toward where enemies are likely to be) and, while the bot knows of no
 * enemy at all, walks it there along the map's paths. Once an enemy is seen, remembered or shooting at
 * it, the policy takes over, except in CTF: there the flags come first, so a bot keeps heading for its
 * objective and shoots on the way (see shouldPush), and only stops to fight someone right on top of it.
 */

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** A bot's patrol target (FFA / TDM), kept between decisions */
export interface Patrol {
  target: Point | null;
  until: number;
  /** CTF attackers: when this one started waiting at the rally point, and whether it has pushed on */
  rallySince: number | null;
  rallied: boolean;
  /** CTF attackers: since when it's been clearing the guards off their flag before grabbing it */
  clearingSince: number | null;
}

export const newPatrol = (): Patrol => ({ target: null, until: 0, rallySince: null, rallied: false, clearingSince: null });

/** Give up on a patrol point after this long (s), or once this close (m) */
const PATROL_TIME = 25;
const PATROL_REACHED = 4;
/** Go to a fight this close (m, scaled by aggression) */
const HELP_RANGE = 30;
/** Below this share of health (scaled by aggression), fall back to the team */
const RETREAT_HP = 0.35;
/** CTF: attackers gather this far along the way to the enemy base, wait up to this long for a second (s) */
const RALLY_SHARE = 0.4;
const RALLY_WAIT = 4;
const RALLY_BUDDY = 12;
/** CTF defenders hold a spot this far in front of their flag, toward the middle (m) */
const DEFEND_OFFSET = 6;
/** CTF defenders go for enemies this close to their flag (m) */
const GUARD_RANGE = 18;
/**
 * CTF attackers: an enemy known within GUARDED of their flag is guarding it. Grabbing it under their nose
 * gets the carrier killed on the spot, so from within CLEAR_FROM the attacker holds this far short of it
 * (STAGE) and fights until nobody's left there, or CLEAR_WAIT has passed (m, s).
 */
const GUARDED = 12;
const CLEAR_FROM = 25;
const STAGE = 10;
const CLEAR_WAIT = 8;

export interface GoalInput {
  self: { id: string; team: Team | null; x: number; y: number; z: number; carrying: boolean };
  /** Everyone else in play (alive or not) */
  others: readonly BodyView[];
  mode: GameMode;
  ctf: CtfView | null;
  /** Places worth patrolling: spawns and pickup spots, with whose half they're in */
  patrolPoints: readonly (Point & { team: Team | null })[];
  patrol: Patrol;
  now: number;
  rand?: () => number;
  /** Share of health left (0..1) */
  hp?: number;
  /** Enemies this bot knows about (seen, called out or heard), where they were */
  known?: readonly Point[];
  /** 0.6 (cautious) .. 1.4 (reckless) */
  aggression?: number;
}

const flat = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

/** Moving targets (carriers) are followed on a coarse grid: each new spot costs a path search over the map. */
const FOLLOW_GRID = 3;
const follow = (p: Point): Point => ({ x: Math.round(p.x / FOLLOW_GRID) * FOLLOW_GRID, y: p.y, z: Math.round(p.z / FOLLOW_GRID) * FOLLOW_GRID });

/** Whether `self` is among the `n` living teammates (itself included) nearest to `target` */
function amongNearest(self: GoalInput['self'], mates: readonly BodyView[], target: Point, n: number): boolean {
  const mine = flat(self, target);
  let closer = 0;
  for (const m of mates) if (m.alive && flat(m, target) < mine) closer++;
  return closer < n;
}

/** Hurt badly: back to the nearest living teammate (not if one is right here already). */
function retreat(input: GoalInput, mates: readonly BodyView[]): Point | null {
  const aggression = input.aggression ?? 1;
  if ((input.hp ?? 1) >= RETREAT_HP * (2 - aggression) || input.self.carrying) return null;
  const mate = mates.filter((m) => m.alive).sort((a, b) => flat(a, input.self) - flat(b, input.self))[0];
  return mate && flat(mate, input.self) > 5 ? follow(mate) : null;
}

/** An enemy we know of close enough to go and fight (where a teammate called them out, or we heard them). */
function fight(input: GoalInput, range: number): Point | null {
  const near = (input.known ?? []).filter((k) => flat(k, input.self) < range * (input.aggression ?? 1));
  return near.sort((a, b) => flat(a, input.self) - flat(b, input.self))[0] ?? null;
}

/** CTF defender: an enemy we know of closing in on our flag (the nearest to it). */
function intruder(input: GoalInput, flag: Point): Point | null {
  const near = (input.known ?? []).filter((k) => flat(k, flag) < GUARD_RANGE);
  return near.sort((a, b) => flat(a, flag) - flat(b, flag))[0] ?? null;
}

/** Where this bot should be heading right now. */
export function goalFor(input: GoalInput): Point {
  const { self, others, mode, ctf } = input;
  const mates = self.team ? others.filter((o) => o.team === self.team) : [];
  if (mode === 'ctf' && ctf && self.team) return ctfGoal(input, mates, others, ctf);
  if (mates.length) {
    const back = retreat(input, mates);
    if (back) return back;
  }
  const target = fight(input, HELP_RANGE);
  if (target) return follow(target);
  return patrolGoal(input, mates);
}

/**
 * CTF: the flags, not kills. Every bot has a job with a flag in it (carry, return, chase the thief,
 * escort, guard, attack); fights are what happens on the way. Nobody wanders off to a fight away from
 * its job or falls back to heal: an attacker low on health still goes for the flag.
 */
function ctfGoal(input: GoalInput, mates: readonly BodyView[], everyone: readonly BodyView[], ctf: CtfView): Point {
  const { self, patrol, now } = input;
  // Carrying their flag: home (and wait there for ours if it's away).
  if (self.carrying) return ctf.ownBase;
  // Our flag lying somewhere: the nearest of us goes to send it home.
  if (ctf.own.at === 'ground' && amongNearest(self, mates, ctf.own, 1)) return ctf.own;
  // Someone has our flag: the two nearest chase them.
  if (ctf.own.at === 'carried') {
    const carrier = everyone.find((o) => o.id === (ctf.own as { carrier: string }).carrier);
    if (carrier && amongNearest(self, mates, carrier, 2)) return follow(carrier);
  }
  // A teammate has theirs: walk them home.
  if (ctf.enemy.at === 'carried') {
    const carrier = mates.find((o) => o.id === (ctf.enemy as { carrier: string }).carrier);
    if (carrier) return follow(carrier);
  }
  // One in three holds a spot in front of our flag, covering the way in; it goes for anyone closing in on the flag.
  const defenders = Math.floor((mates.filter((m) => m.alive).length + 1) / 3);
  if (defenders > 0 && amongNearest(self, mates, ctf.ownBase, defenders)) {
    const close = intruder(input, ctf.ownBase);
    if (close) return follow(close);
    const toMiddle = Math.hypot(ctf.ownBase.x, ctf.ownBase.z) || 1;
    return { x: ctf.ownBase.x * (1 - DEFEND_OFFSET / toMiddle), y: ctf.ownBase.y, z: ctf.ownBase.z * (1 - DEFEND_OFFSET / toMiddle) };
  }
  // Everyone else attacks: straight for their flag.
  const flag = ctf.enemy.at === 'ground' ? ctf.enemy : ctf.enemyBase;
  // Their flag lying loose: a race, no waiting for company.
  if (ctf.enemy.at === 'ground') return flag;
  // Close to it with someone guarding it: take them out first, then grab it.
  const clear = clearFirst(input, ctf);
  if (clear) return clear;
  // Attackers go in pairs: gather at a rally point, push once a second one arrives (or after a short wait).
  if (flat(self, ctf.ownBase) < 10) {
    patrol.rallied = false;
    patrol.rallySince = null;
  }
  if (!patrol.rallied && mates.some((m) => m.alive)) {
    const rally = {
      x: ctf.ownBase.x + (ctf.enemyBase.x - ctf.ownBase.x) * RALLY_SHARE, y: ctf.ownBase.y,
      z: ctf.ownBase.z + (ctf.enemyBase.z - ctf.ownBase.z) * RALLY_SHARE,
    };
    if (flat(self, rally) > 6) return rally;
    patrol.rallySince ??= now;
    const buddy = mates.some((m) => m.alive && flat(m, self) < RALLY_BUDDY && flat(m, ctf.ownBase) > 10);
    if (!buddy && now - patrol.rallySince < RALLY_WAIT / (input.aggression ?? 1)) return rally;
    patrol.rallied = true;
  }
  return flag;
}

/**
 * A CTF attacker near their flag while someone's guarding it: hold a spot short of the flag (fight from
 * there) until the guards are gone or it's waited long enough. Null: go for the flag.
 */
function clearFirst(input: GoalInput, ctf: CtfView): Point | null {
  const { self, patrol, now } = input;
  const base = ctf.enemyBase;
  const toFlag = flat(self, base);
  const guarded = (input.known ?? []).some((k) => flat(k, base) < GUARDED);
  if (!guarded || toFlag > CLEAR_FROM) {
    if (toFlag > CLEAR_FROM) patrol.clearingSince = null;
    return null;
  }
  patrol.clearingSince ??= now;
  if (now - patrol.clearingSince > CLEAR_WAIT / (input.aggression ?? 1)) return null;
  // Where we are if already that close, else STAGE short of it on our side.
  if (toFlag <= STAGE) return { x: self.x, y: self.y, z: self.z };
  const k = STAGE / toFlag;
  return { x: base.x + (self.x - base.x) * k, y: base.y, z: base.z + (self.z - base.z) * k };
}

/**
 * FFA / TDM: walk between likely meeting places, toward the enemy's side in team modes, keeping near
 * the rest of the team there (a few candidates, the one closest to the team wins).
 */
function patrolGoal({ self, patrolPoints, patrol, now, rand = Math.random }: GoalInput, mates: readonly BodyView[]): Point {
  const reached = patrol.target && flat(self, patrol.target) < PATROL_REACHED;
  if (!patrol.target || reached || now > patrol.until) {
    // Team modes: the enemy's half and the middle; FFA: anywhere but right here.
    const options = patrolPoints.filter((p) => (self.team ? p.team !== self.team : true) && flat(self, p) > 15);
    const list = options.length ? options : patrolPoints;
    const alive = mates.filter((m) => m.alive);
    let pick = list[Math.floor(rand() * list.length)];
    if (alive.length && list.length > 1) {
      const cx = alive.reduce((s, m) => s + m.x, 0) / alive.length;
      const cz = alive.reduce((s, m) => s + m.z, 0) / alive.length;
      const draws = Array.from({ length: 3 }, () => list[Math.floor(rand() * list.length)]!);
      pick = draws.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0];
    }
    patrol.target = pick ? { x: pick.x, y: pick.y, z: pick.z } : { x: 0, y: 0, z: 0 };
    patrol.until = now + PATROL_TIME;
  }
  return patrol.target!;
}

// ---------------------------------------------------------------- travelling

const E = OBS_LAYOUT.enemies;

/** Whether the bot knows of an enemy (sees one, remembers one, or was just shot): the policy's turn. */
export function enemyKnown(obs: Float32Array): boolean {
  return obs[E]! > 0.5 || obs[E + 4]! > 0 || obs[OBS_LAYOUT.hurt]! > 0;
}

/** Carrying the enemy flag (guns stowed) */
const carrying = (obs: Float32Array) => obs[OBS_LAYOUT.mode + 3]! > 0.5;

/**
 * Whether the objective layer drives this decision: nobody to fight, or carrying the flag (a carrier's
 * only weapon is the flag itself, so it runs for home and swings at whoever gets in its way).
 */
export function shouldTravel(obs: Float32Array): boolean {
  return carrying(obs) || !enemyKnown(obs);
}

/** CTF: run and gun until this close to the goal; only an enemy this close stops the bot to fight (m) */
const PUSH_GOAL = 3;
const PUSH_ENEMY = 5;

/**
 * CTF: the objective comes first. Anywhere short of the goal, the bot keeps moving along the route
 * while the policy aims and shoots; it only stands and fights someone right on top of it (or once it's
 * there: a defender at its spot). Left to the policy, bots stop to trade shots and never score.
 */
export function shouldPush(obs: Float32Array): boolean {
  // (No enemy in the list, e.g. only just shot from somewhere unseen: nobody close.)
  const nearest = obs[E + 4]! || 1;
  return obs[OBS_LAYOUT.attack + 2]! > PUSH_GOAL / 60 && nearest > PUSH_ENEMY / 60;
}

/** Pushing, sprint unless someone in view is closer than this (m): then walk, for a steadier aim */
const PUSH_WALK = 20;

/** The policy's aim and trigger, the route's feet: sprinting, unless someone in view is close enough to shoot it out with. */
export function pushAction(fight: BotAction, obs: Float32Array): BotAction {
  const walk = travelAction(obs);
  const close = obs[E]! > 0.5 && obs[E + 4]! < PUSH_WALK / 60;
  return { ...fight, move: walk.move, sprint: walk.sprint && !close, jump: walk.jump, crouch: false };
}

/** The 8-way move closest to a direction (right, forward) in the bot's frame */
function moveToward(right: number, forward: number): number {
  if (Math.hypot(right, forward) < 1e-3) return 0;
  const i = Math.round(Math.atan2(right, forward) / (Math.PI / 4));
  return (((i % 8) + 8) % 8) + 1;
}

/**
 * Walk to the goal along the path (the observation's goal waypoint): face where the path goes, sprint
 * when it's straight ahead, hop when a wall is right in front. Only fires (swings) as a flag carrier.
 */
export function travelAction(obs: Float32Array): BotAction {
  const nav = OBS_LAYOUT.attack;
  const right = obs[nav]!;
  const forward = obs[nav + 1]!;
  const dist = obs[nav + 2]!;
  // At the goal (holding a base, waiting at home): stand still and look about.
  if (dist < 0.02 || Math.hypot(right, forward) < 0.1) {
    return { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0.15, aimPitch: -obs[OBS_LAYOUT.self + 7]! * 0.5 };
  }
  const angle = Math.atan2(right, forward);
  // A carrier clubs anyone right in front of it (the flag reaches 2.4 m; distances are in sixtieths).
  const swing = carrying(obs) && obs[E]! > 0.5 && obs[E + 4]! < 2.4 / 60 && Math.abs(obs[E + 5]! * Math.PI) < 0.5;
  return {
    move: moveToward(right, forward),
    sprint: Math.abs(angle) < 0.5,
    jump: obs[OBS_LAYOUT.probes]! < 0.04,
    crouch: false,
    fire: swing,
    // Turning right is a negative yaw change.
    aimYaw: Math.max(-1, Math.min(1, -angle / MAX_TURN.yaw)),
    aimPitch: -obs[OBS_LAYOUT.self + 7]! * 0.5,
  };
}

/** Asked to walk but this far or less over STUCK_TIME: stuck (m, s) */
const STUCK_DIST = 0.4;
const STUCK_TIME = 1;
const ESCAPE_TIME = 0.8;

/**
 * Getting unstuck while walking a route: the walk grid is a little more generous than the real
 * collision shapes, so a bot can wedge itself into a gap it can't fit through. When it's been trying to
 * move without getting anywhere, it sidesteps and hops (alternating sides) for a moment, then carries on.
 */
export class Unstuck {
  private anchor: { x: number; z: number; t: number } | null = null;
  private escapeUntil = -Infinity;
  private side = 1;

  /** `walk` as decided for a bot at (x, z) at time `now` (s); maybe replaced by an escape. */
  act(walk: BotAction, x: number, z: number, now: number): BotAction {
    if (now < this.escapeUntil) {
      return { ...walk, move: this.side > 0 ? 3 : 7, sprint: false, jump: true, aimYaw: this.side * 0.4 };
    }
    if (walk.move === 0) {
      this.anchor = null;
      return walk;
    }
    if (!this.anchor || Math.hypot(x - this.anchor.x, z - this.anchor.z) > STUCK_DIST) {
      this.anchor = { x, z, t: now };
      return walk;
    }
    if (now - this.anchor.t < STUCK_TIME) return walk;
    // Stuck: sidestep and hop the other way from last time.
    this.side = -this.side;
    this.escapeUntil = now + ESCAPE_TIME;
    this.anchor = null;
    return this.act(walk, x, z, now);
  }

  reset(): void {
    this.anchor = null;
    this.escapeUntil = -Infinity;
  }
}
