import * as THREE from 'three';
import { Mover } from '../../movement';
import { PhysicsWorld, groups } from '../../physics';
import { generateMap, groundHeight, toSpec, type MapData, type MapSize } from '../../mapgen';
import { GUNS, shotDamage } from '../../gunStats';
import { FLAG_RADIUS, FLAG_RETURN_TIME, MELEE_COOLDOWN, MELEE_DAMAGE, MELEE_RANGE, otherTeam } from '../../modes';
import type { Ramp } from '../../ramps';
import type { GameMode, GunKind, SiteId, SndRecord } from '../../../types';
import {
  BOMB_BLAST_RADIUS, BOMB_PICKUP_RADIUS, DEFUSE_RADIUS, DEFUSE_TIME, PLANT_TIME, ROUND_END_TIME, attackersFor, bombHome, bombPlacement,
  bombSites, decide, newRound, phaseOf, siteAt, type Headcount,
} from '../../snd';
import type { Team } from '../../mapgen/types';
import { DECISION_DT, MAX_TURN, type BotAction } from '../policy';
import { goalFor, newPatrol, travelAction, Unstuck, type Patrol, type Point, type SndGoalView } from '../objective';
import { BotMemory, MEMORY_TIME, OBS_LAYOUT, observe, type BodyView, type CtfView, type FlagState } from '../observe';
import { AimController } from '../aim';
import { rollPersonality, type Personality } from '../brain';
import { callOut, hear } from '../team';
import { Steering, moveInputOf } from '../brain';
import { MapSenses, castWorld } from '../senses';
import { aimAngles, hitPlayer, lookDir, scatter, spreadOf, type Ray } from '../hitscan';

/*
 * The game without a screen, for training bots: a generated map, Rapier collision, the player's
 * own movement (movement.ts), guns as guns.ts has them, and the rules of FFA, TDM, CTF and S&D (snd.ts).
 * Abilities, grenades and pickups are left out. Every agent is driven from outside, one decision
 * every DECISION_DT, and gets back a reward.
 */

/** Physics steps per decision */
const SUBSTEPS = 3;
const TICK = DECISION_DT / SUBSTEPS;
const MAX_PITCH = Math.PI / 2 - 0.01;
const RESPAWN_TIME = 3;
/** Movement-only boxes (blocks: 'shots' ones) go in their own group so bullets stop at them */
const SHOTS_GROUP = 1 << 6;
const PERIMETER_HEIGHT = 6;
const BOUNDARY_THICKNESS = 4;
const BOUNDARY_HEIGHT = 200;
const CYLINDER_FIT = [[0.46, 0.19], [0.19, 0.46], [0.3535, 0.3535]] as const;
/** The largest aim error (yaw + pitch, radians) */
const WORST_AIM = Math.PI * 1.5;

/** Reward weights */
export const REWARD = {
  damageDealt: 0.006,
  // Dying costs less than a kill earns, but not too little. At 0.6 (+0.004/HP) self-play settled into both
  // teams avoiding fights; at 0.25 (+0.002/HP) bots learned to trade lives, which beats copies of themselves
  // but loses to anyone who aims well (held-out K/D fell from 0.85 to 0.45).
  damageTaken: 0.003,
  kill: 1,
  death: 0.4,
  /** Each teammate's share of a team kill (team modes) */
  teamKill: 0.25,
  flagTake: 1,
  flagReturn: 1,
  capture: 5,
  /** Every teammate's share when the team captures (or is captured on: negative) */
  teamCapture: 1.5,
  carrierKill: 1,
  /** S&D: picking up a dropped bomb, planting it, defusing it */
  bombPickup: 0.5,
  plant: 3,
  defuse: 3,
  /** S&D: every player's share when their team wins a round (losing it: negative) */
  round: 1.5,
  /** Getting closer to the objective, per metre (as a potential: walking back costs it again) */
  progress: 0.03,
  /** Turning toward a visible enemy, per radian of aim error closed (a potential too) */
  aim: 0.25,
  /** Per decision */
  time: 0.002,
  /** A shot that hits nobody */
  miss: 0.002,
} as const;

export interface ArenaConfig {
  seed: string;
  size: MapSize;
  mode: GameMode;
  /** Players per team (TDM / CTF) or in total (FFA) */
  players: number;
  /** Agents (from the end of the list) that are dummies: they wander and never shoot */
  dummies?: number;
  gun?: GunKind;
  /** Episode length in seconds of game time */
  seconds: number;
  /** Kills (FFA), team kills (TDM), captures (CTF) or rounds won (S&D) that end the episode */
  limit?: number;
  health?: number;
  /** Goals from the objective layer (objective.ts): on unless turned off */
  objectives?: boolean;
}

export interface SimAgent {
  readonly id: string;
  readonly index: number;
  readonly team: Team | null;
  readonly dummy: boolean;
  readonly mover: Mover;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  respawnAt: number;
  gun: GunKind;
  ammo: number;
  reloadLeft: number;
  cooldown: number;
  burst: number;
  meleeCooldown: number;
  kills: number;
  deaths: number;
  /** Flags captured (CTF), or bombs planted and defused (S&D) */
  captures: number;
  /** S&D: seconds spent planting or defusing so far (standing still meanwhile) */
  channel: number;
  readonly memory: BotMemory;
  readonly steering: Steering;
  action: BotAction;
  /** Reward collected since the last step() */
  reward: number;
  /** All the reward this episode, by where it came from (for reports and the training view) */
  readonly rewardParts: Record<string, number>;
  /** Walking distance to the objective at the last decision (for the progress reward) */
  objective: number;
  /** Aim error to the nearest visible enemy at the last decision, or null (for the aim reward) */
  aimError: number | null;
  /** Where it's patrolling (FFA / TDM objective) */
  readonly patrol: Patrol;
  /** Getting out of tight spots while walking a route */
  readonly unstuck: Unstuck;
  /** Its character (how far it goes to help, when it backs off, how hurt shakes its aim) */
  readonly personality: Personality;
  /** The aim model, for agents that aim like a person (learners and their snapshots); null: steered */
  aim: AimController | null;
}

const _move = { forward: 0, strafe: 0, analog: false, sprint: false, crouch: false, jump: false };

/** The map's collision as the game builds it (world.ts): boxes, ramps, the perimeter and the boundary. */
export function buildPhysics(map: MapData): PhysicsWorld {
  const physics = new PhysicsWorld();
  const colliders: THREE.Box3[] = [];
  const ramps: Ramp[] = [];
  const shotBoxes: THREE.Box3[] = [];
  const W = map.half;
  const wallH = PERIMETER_HEIGHT + map.edge.height;
  for (const [x, z, w, d] of [[0, -W, W * 2 + 1, 1], [0, W, W * 2 + 1, 1], [-W, 0, 1, W * 2 + 1], [W, 0, 1, W * 2 + 1]] as const) {
    colliders.push(new THREE.Box3(new THREE.Vector3(x - w / 2, 0, z - d / 2), new THREE.Vector3(x + w / 2, wallH, z + d / 2)));
  }
  const T = BOUNDARY_THICKNESS;
  for (const [x0, z0, x1, z1] of [
    [-W - T, -W - T, W + T, -W + 0.5], [-W - T, W - 0.5, W + T, W + T],
    [-W - T, -W - T, -W + 0.5, W + T], [W - 0.5, -W - T, W + T, W + T],
  ] as const) {
    colliders.push(new THREE.Box3(new THREE.Vector3(x0, -10, z0), new THREE.Vector3(x1, BOUNDARY_HEIGHT, z1)));
  }
  for (const b of map.boxes) {
    if (b.ramp) {
      ramps.push({ box: new THREE.Box3(new THREE.Vector3(b.x - b.w / 2, b.y, b.z - b.d / 2), new THREE.Vector3(b.x + b.w / 2, b.y + b.h, b.z + b.d / 2)), dir: b.ramp });
      continue;
    }
    const blocks = b.blocks ?? 'all';
    const parts = b.shape === 'cylinder' ? CYLINDER_FIT : [[0.5, 0.5] as const];
    const list = blocks === 'shots' ? shotBoxes : colliders;
    for (const [fx, fz] of parts) {
      list.push(new THREE.Box3(new THREE.Vector3(b.x - b.w * fx, b.y, b.z - b.d * fz), new THREE.Vector3(b.x + b.w * fx, b.y + b.h, b.z + b.d * fz)));
    }
  }
  physics.setMap(colliders, ramps, map.ground);
  // Things that stop bullets but not people.
  const { R, world } = physics;
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  for (const box of shotBoxes) {
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    world.createCollider(R.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setTranslation(c.x, c.y, c.z).setCollisionGroups(groups(SHOTS_GROUP, 0xffff)), body);
  }
  world.step();
  return physics;
}

export class Arena {
  readonly map: MapData;
  readonly physics: PhysicsWorld;
  readonly senses: MapSenses;
  readonly agents: SimAgent[] = [];
  readonly mode: GameMode;
  /** Game time (s) */
  time = 0;
  score: Record<string, number> = {};
  flags: Record<Team, FlagState> = { red: { at: 'base' }, blue: { at: 'base' } };
  private flagDroppedAt: Record<Team, number> = { red: 0, blue: 0 };
  readonly bases: Record<Team, { x: number; y: number; z: number }>;
  /** S&D: this round (times in ms of arena time), the defenders' sites, and the site the attackers go for */
  snd: SndRecord | null = null;
  sites: Record<SiteId, Point> | null = null;
  private sndTarget: SiteId = 'a';
  done = false;
  /** Every kill so far, by agent index */
  readonly killLog: { killer: number; victim: number }[] = [];
  /** Shots fired since the watcher last emptied it; null (the default) records nothing */
  shotTrace: { from: number; x0: number; z0: number; x1: number; z1: number; hit: boolean }[] | null = null;
  private readonly limit: number;
  /** Places worth patrolling, with whose half they're in */
  private readonly patrolPoints: (Point & { team: Team | null })[];
  private readonly maxHp: number;
  private readonly obsInfo = { attackDist: Infinity };

  constructor(readonly config: ArenaConfig, private readonly rand: () => number = Math.random) {
    this.mode = config.mode;
    this.map = generateMap(toSpec(config.seed, config.size));
    this.physics = buildPhysics(this.map);
    this.senses = new MapSenses(this.map, this.physics);
    this.maxHp = config.health ?? 100;
    this.limit = config.limit ?? (config.mode === 'ctf' || config.mode === 'snd' ? 3 : config.mode === 'tdm' ? 30 : 15);
    this.patrolPoints = [
      ...this.map.spawns.map((sp) => ({ x: sp.x, y: sp.y, z: sp.z, team: sp.team })),
      // Red's half is +z.
      ...this.map.pickupSpots.map((sp) => ({ x: sp.x, y: sp.y, z: sp.z, team: (sp.z > 3 ? 'red' : sp.z < -3 ? 'blue' : null) as Team | null })),
    ];
    const f = this.map.flags;
    this.bases = { red: { x: f.red[0], y: f.red[1], z: f.red[2] }, blue: { x: f.blue[0], y: f.blue[1], z: f.blue[2] } };

    const teams = config.mode !== 'ffa';
    const total = teams ? config.players * 2 : config.players;
    const dummies = config.dummies ?? 0;
    for (let i = 0; i < total; i++) {
      const team: Team | null = teams ? (i % 2 === 0 ? 'red' : 'blue') : null;
      const mover = new Mover();
      mover.attachPhysics(this.physics, false);
      mover.setTerrain((x, z) => groundHeight(this.map.ground, x, z));
      const gun = config.gun ?? 'rifle';
      this.agents.push({
        id: `a${i}`, index: i, team, dummy: i >= total - dummies, mover, yaw: 0, pitch: 0, hp: this.maxHp, alive: true, respawnAt: 0,
        gun, ammo: GUNS[gun].mag, reloadLeft: 0, cooldown: 0, burst: 0, meleeCooldown: 0, kills: 0, deaths: 0, captures: 0, channel: 0,
        memory: new BotMemory(), steering: new Steering(), action: { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 },
        reward: 0, rewardParts: {}, objective: Infinity, aimError: null, patrol: newPatrol(), unstuck: new Unstuck(), personality: rollPersonality(rand), aim: null,
      });
    }
    for (const a of this.agents) this.spawn(a);
    if (this.mode === 'snd') this.startSndRound(0);
  }

  dispose(): void {
    for (const a of this.agents) a.mover.detachPhysics();
    this.physics.dispose();
  }

  // ---------------------------------------------------------------- views

  private carrying(a: SimAgent): boolean {
    if (!a.team) return false;
    const f = this.flags[otherTeam(a.team)];
    return f.at === 'carried' && f.carrier === a.id;
  }

  private bodyView(a: SimAgent): BodyView {
    const p = a.mover.position;
    return { id: a.id, x: p.x, y: p.y, z: p.z, stance: a.mover.stance, alive: a.alive, hp: a.hp, maxHp: this.maxHp, team: a.team, carrying: this.carrying(a) };
  }

  private ctfView(a: SimAgent): CtfView | null {
    if (this.mode !== 'ctf' || !a.team) return null;
    const enemy = otherTeam(a.team);
    return { ownBase: this.bases[a.team], enemyBase: this.bases[enemy], own: this.flags[a.team], enemy: this.flags[enemy] };
  }

  /** The agent's observation (raw), into `out`. */
  observe(a: SimAgent, out: Float32Array): Float32Array {
    const p = a.mover.position;
    const v = a.mover.velocity;
    const others = this.agents.filter((b) => b !== a).map((b) => this.bodyView(b));
    const ctf = this.ctfView(a);
    const carrying = this.carrying(a);
    const known = [...a.memory.seen.values()].filter((m) => this.time - m.t <= MEMORY_TIME);
    const snd = this.sndView(a);
    const goal = this.config.objectives === false ? null : goalFor({
      self: { id: a.id, team: a.team, x: p.x, y: p.y, z: p.z, carrying: carrying || !!snd?.carrying },
      others, mode: this.mode, ctf, snd, patrolPoints: this.patrolPoints, patrol: a.patrol, now: this.time, rand: this.rand,
      hp: a.hp / this.maxHp, known, aggression: a.personality.aggression,
    });
    observe({
      self: {
        x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, yaw: a.yaw, pitch: a.pitch, onGround: a.mover.onGround, stance: a.mover.stance,
        hp: a.hp, maxHp: this.maxHp, team: a.team, gun: a.gun, ammo: a.ammo, mag: GUNS[a.gun].mag, reloading: a.reloadLeft > 0, carrying: this.carrying(a),
      },
      others, mode: this.mode, ctf, now: this.time, memory: a.memory, senses: this.senses, info: this.obsInfo,
      // As in the game (botHost.ts): the policy has never had S&D inputs, so its fights look like TDM to it.
      goal, asMode: this.mode === 'snd' || (goal && this.mode === 'ctf') ? 'tdm' : undefined,
    }, out);
    // Whoever it just saw, its teammates hear about.
    if (a.team) callOut(a.memory, this.agents.filter((b) => b !== a && b.team === a.team && b.alive).map((b) => b.memory), this.time);
    return out;
  }

  /** The aim model for this tick (agents that have one): whether it's aiming at someone. */
  private aimAt(a: SimAgent, dt: number): boolean {
    if (!a.aim) return false;
    const inView = new Set(a.memory.inView(this.time, DECISION_DT * 2.5));
    const visible = inView.size
      ? this.agents.filter((b) => b !== a && b.alive && inView.has(b.id) && this.isEnemy(a, b)).map((b) => {
        const q = b.mover.position;
        return { id: b.id, x: q.x, y: q.y, z: q.z, stance: b.mover.stance, carrying: this.carrying(b) };
      })
      : [];
    const p = a.mover.position;
    const aimed = a.aim.update(dt, this.time, {
      x: p.x, y: p.y + a.mover.eyeHeight, z: p.z, yaw: a.yaw, pitch: a.pitch, speed: a.mover.horizontalSpeed, gun: a.gun,
      shaky: a.personality.nerves * (1 - a.hp / this.maxHp), reloading: a.reloadLeft > 0,
    }, visible, this.time - a.memory.hurtAt < 2 ? a.memory.hurtBy : null);
    // Down the sights: slower on its feet and no sprinting, as in the game.
    a.mover.aiming = a.aim.ads > 0.5;
    if (!a.aim.engaged) return false;
    a.yaw = aimed.yaw;
    a.pitch = aimed.pitch;
    return true;
  }

  /** The objective layer walking `a` to its goal (getting unstuck if it has to), from its observation `obs` */
  travel(a: SimAgent, obs: Float32Array): BotAction {
    const p = a.mover.position;
    return a.unstuck.act(travelAction(obs), p.x, p.z, this.time);
  }

  /** Walking distance to the agent's objective, as of its last observe() */
  get lastObjectiveDistance(): number {
    return this.obsInfo.attackDist;
  }

  // ---------------------------------------------------------------- stepping

  private give(a: SimAgent, part: string, amount: number): void {
    a.reward += amount;
    a.rewardParts[part] = (a.rewardParts[part] ?? 0) + amount;
  }

  /** Act on every agent's decision for one DECISION_DT. Rewards land in each agent's `reward`. */
  step(actions: readonly BotAction[]): void {
    for (const a of this.agents) {
      const act = actions[a.index]!;
      a.action = act;
      a.steering.set(act.aimYaw * MAX_TURN.yaw, act.aimPitch * MAX_TURN.pitch);
      this.give(a, 'time', -REWARD.time);
    }
    for (let s = 0; s < SUBSTEPS && !this.done; s++) this.tick();
    if (this.time >= this.config.seconds) this.done = true;
  }

  private tick(): void {
    const dt = TICK;
    this.time += dt;
    // S&D holds everyone at their spawn before a round; planting and defusing mean standing still.
    const frozen = !!this.snd && phaseOf(this.snd, this.time * 1000) === 'freeze';
    for (const a of this.agents) {
      if (!a.alive) {
        if (this.time >= a.respawnAt) this.spawn(a);
        continue;
      }
      const [dYaw, dPitch] = a.steering.step(dt);
      if (this.aimAt(a, dt)) {
        a.steering.reset();
      } else {
        a.yaw = wrap(a.yaw + dYaw);
        a.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, a.pitch + dPitch));
      }
      a.mover.step(dt, a.yaw, frozen || a.channel > 0 ? null : moveInputOf(a.action, _move));
      if (a.mover.position.y < -5) this.kill(a, null, false);
    }
    // Step the world as the game does every frame: Rapier queues every collider move until a step,
    // and a world that's never stepped makes each movement query slower than the last.
    this.physics.world.step();
    for (const a of this.agents) {
      if (!a.alive) continue;
      a.cooldown = Math.max(0, a.cooldown - dt);
      a.meleeCooldown = Math.max(0, a.meleeCooldown - dt);
      if (a.reloadLeft > 0) {
        a.reloadLeft -= dt;
        if (a.reloadLeft <= 0) a.ammo = GUNS[a.gun].mag;
      }
      // With the aim model, the trigger is only pulled with the crosshair on someone (a carrier swings).
      const shoot = a.action.fire && (!a.aim || this.carrying(a) || (a.aim.engaged && a.aim.onTarget));
      if (!shoot) a.burst = 0;
      else if (this.carrying(a)) this.swing(a);
      else this.fire(a);
    }
    if (this.mode === 'ctf') this.updateFlags();
    if (this.mode === 'snd') this.updateSnd(dt);
  }

  private eye(a: SimAgent): THREE.Vector3 {
    const p = a.mover.position;
    return new THREE.Vector3(p.x, p.y + a.mover.eyeHeight, p.z);
  }

  private isEnemy(a: SimAgent, b: SimAgent): boolean {
    return a !== b && (!a.team || a.team !== b.team);
  }

  private fire(a: SimAgent): void {
    if (a.cooldown > 0 || a.reloadLeft > 0) return;
    const def = GUNS[a.gun];
    if (a.ammo <= 0) {
      a.reloadLeft = def.reloadTime;
      return;
    }
    a.ammo--;
    a.cooldown = def.fireInterval;
    const moving = a.mover.horizontalSpeed > 1;
    const spread = spreadOf(a.gun, moving, a.mover.onGround, a.mover.stance, a.burst, a.aim?.ads ?? 0);
    a.burst++;
    const eye = this.eye(a);
    const look = lookDir(a.yaw, a.pitch);
    const damage = new Map<SimAgent, number>();
    let head = false;
    for (let p = 0; p < def.pellets; p++) {
      const d = scatter(look, spread, this.rand);
      const ray: Ray = { ox: eye.x, oy: eye.y, oz: eye.z, dx: d[0], dy: d[1], dz: d[2] };
      const wall = castWorld(this.physics, eye.x, eye.y, eye.z, d[0], d[1], d[2], def.range, SHOTS_GROUP);
      let best: SimAgent | null = null;
      let bestHit: { dist: number; head: boolean } | null = null;
      for (const b of this.agents) {
        if (!b.alive || !this.isEnemy(a, b)) continue;
        const p2 = b.mover.position;
        const hit = hitPlayer(ray, { id: b.id, x: p2.x, y: p2.y, z: p2.z, stance: b.mover.stance }, Math.min(wall, bestHit?.dist ?? Infinity));
        if (hit) { best = b; bestHit = hit; }
      }
      if (this.shotTrace) {
        const reach = bestHit?.dist ?? wall;
        this.shotTrace.push({ from: a.index, x0: eye.x, z0: eye.z, x1: eye.x + d[0] * reach, z1: eye.z + d[2] * reach, hit: !!best });
      }
      if (best && bestHit) {
        head ||= bestHit.head;
        damage.set(best, (damage.get(best) ?? 0) + shotDamage(a.gun, bestHit.head, bestHit.dist));
      }
    }
    // Gunfire gives the shooter away to enemies within earshot.
    for (const b of this.agents) {
      if (b !== a && b.alive && this.isEnemy(b, a)) hear(b.memory, a.id, a.gun, eye.x, a.mover.position.y, eye.z, b.mover.position.x, b.mover.position.z, this.time, this.rand);
    }
    if (!damage.size) this.give(a, 'miss', -REWARD.miss);
    for (const [b, dmg] of damage) this.hurt(b, a, dmg, head);
    // Recoil, as the player gets it (bots don't aim down sights).
    a.pitch = Math.min(MAX_PITCH, a.pitch + def.recoil);
    a.yaw += (this.rand() - 0.5) * def.recoil * 0.5;
  }

  /** The flag as a club: the nearest enemy within reach, roughly where we're looking. */
  private swing(a: SimAgent): void {
    if (a.meleeCooldown > 0) return;
    a.meleeCooldown = MELEE_COOLDOWN;
    const eye = this.eye(a);
    let best: SimAgent | null = null;
    let bestD = MELEE_RANGE;
    for (const b of this.agents) {
      if (!b.alive || !this.isEnemy(a, b)) continue;
      const p = b.mover.position;
      const d = eye.distanceTo(new THREE.Vector3(p.x, p.y + 1, p.z));
      if (d > bestD) continue;
      const [yaw] = aimAngles(eye.x, eye.y, eye.z, p.x, p.y + 1, p.z);
      if (Math.abs(wrap(yaw - a.yaw)) > 0.6) continue;
      best = b;
      bestD = d;
    }
    if (best) this.hurt(best, a, MELEE_DAMAGE, false);
  }

  private hurt(victim: SimAgent, from: SimAgent, dmg: number, head: boolean): void {
    if (!victim.alive) return;
    const real = Math.min(dmg, victim.hp);
    victim.hp -= dmg;
    this.give(from, 'damage', REWARD.damageDealt * real);
    this.give(victim, 'hurt', -REWARD.damageTaken * real);
    const p = from.mover.position;
    victim.memory.hurt(this.time, { x: p.x, z: p.z }, from.id);
    if (victim.hp <= 0) this.kill(victim, from, head);
  }

  private kill(victim: SimAgent, killer: SimAgent | null, _head: boolean): void {
    // In S&D the bomb carrier, a planter and a defuser are worth as much as a flag carrier.
    const carried = this.carrying(victim) || this.snd?.bomb.by === victim.id || victim.channel > 0;
    victim.alive = false;
    victim.mover.setSolid(false);
    victim.hp = 0;
    victim.deaths++;
    victim.channel = 0;
    // S&D: no respawns; the next round brings everyone back.
    victim.respawnAt = this.mode === 'snd' ? Infinity : this.time + RESPAWN_TIME;
    if (this.snd?.bomb.by === victim.id) {
      const p = victim.mover.position;
      this.snd.bomb = { x: p.x, y: groundHeight(this.map.ground, p.x, p.z), z: p.z };
    }
    this.give(victim, 'death', -REWARD.death);
    victim.memory.reset();
    if (this.carrying(victim)) {
      const p = victim.mover.position;
      const flagTeam = otherTeam(victim.team!);
      this.flags[flagTeam] = { at: 'ground', x: p.x, y: groundHeight(this.map.ground, p.x, p.z), z: p.z };
      this.flagDroppedAt[flagTeam] = this.time;
    }
    if (!killer || killer === victim) return;
    this.killLog.push({ killer: killer.index, victim: victim.index });
    killer.kills++;
    this.give(killer, 'kill', REWARD.kill + (carried ? REWARD.carrierKill : 0));
    if (killer.team) {
      for (const mate of this.agents) if (mate !== killer && mate.team === killer.team) this.give(mate, 'teamKill', REWARD.teamKill);
    }
    if (this.mode === 'ffa') {
      if (killer.kills >= this.limit) this.done = true;
    } else if (this.mode === 'tdm' && killer.team) {
      this.score[killer.team] = (this.score[killer.team] ?? 0) + 1;
      if (this.score[killer.team]! >= this.limit) this.done = true;
    }
  }

  private spawn(a: SimAgent): void {
    const enemies = this.agents.filter((b) => b.alive && b !== a && this.isEnemy(a, b)).map((b) => b.mover.position);
    const standing = this.agents.filter((b) => b.alive && b !== a).map((b) => b.mover.position);
    const all = this.map.spawns.filter((s) => (a.team ? s.team === a.team : true));
    // Never onto someone: bodies are solid, as in the game.
    const free = all.filter((s) => standing.every((o) => Math.hypot(o.x - s.x, o.z - s.z) > 1.2));
    const points = free.length ? free : all;
    const scored = points.map((s) => ({
      s, d: enemies.length ? Math.min(...enemies.map((e) => Math.hypot(e.x - s.x, e.z - s.z))) : this.rand() * 100,
    }));
    scored.sort((x, y) => y.d - x.d);
    const pick = scored[Math.floor(this.rand() * Math.min(3, scored.length))]?.s ?? { x: 0, y: 0, z: 0 };
    a.mover.teleport(new THREE.Vector3(pick.x + (this.rand() - 0.5), pick.y, pick.z + (this.rand() - 0.5)));
    a.yaw = Math.atan2(pick.x, pick.z);
    a.pitch = 0;
    a.hp = this.maxHp;
    a.alive = true;
    a.mover.setSolid(true);
    a.ammo = GUNS[a.gun].mag;
    a.reloadLeft = 0;
    a.cooldown = 0;
    a.burst = 0;
    a.objective = Infinity;
    a.aimError = null;
    a.steering.reset();
    a.aim?.reset();
    a.mover.aiming = false;
  }

  private updateFlags(): void {
    for (const team of ['red', 'blue'] as const) {
      const f = this.flags[team];
      if (f.at === 'ground' && this.time - this.flagDroppedAt[team] > FLAG_RETURN_TIME) this.flags[team] = { at: 'base' };
    }
    for (const a of this.agents) {
      if (!a.alive || !a.team) continue;
      const me = a.mover.position;
      const near = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - me.x, p.z - me.z) < FLAG_RADIUS && Math.abs(p.y - me.y) < 1.5;
      const enemy = otherTeam(a.team);
      const theirs = this.flags[enemy];
      const theirSpot = theirs.at === 'base' ? this.bases[enemy] : theirs.at === 'ground' ? theirs : null;
      if (theirSpot && near(theirSpot)) {
        this.flags[enemy] = { at: 'carried', carrier: a.id };
        this.give(a, 'flag', REWARD.flagTake);
        continue;
      }
      const ours = this.flags[a.team];
      if (ours.at === 'ground' && near(ours)) {
        this.flags[a.team] = { at: 'base' };
        this.give(a, 'flag', REWARD.flagReturn);
        continue;
      }
      if (this.carrying(a) && ours.at === 'base' && near(this.bases[a.team])) {
        this.flags[enemy] = { at: 'base' };
        a.captures++;
        this.give(a, 'flag', REWARD.capture);
        for (const b of this.agents) {
          if (b === a || !b.team) continue;
          this.give(b, 'flag', b.team === a.team ? REWARD.teamCapture : -REWARD.teamCapture);
        }
        this.score[a.team] = (this.score[a.team] ?? 0) + 1;
        if (this.score[a.team]! >= this.limit) this.done = true;
      }
    }
  }

  // ---------------------------------------------------------------- search & destroy

  /** This S&D round as `a`'s objective layer sees it (as botHost.ts builds it in the game) */
  private sndView(a: SimAgent): SndGoalView | null {
    const s = this.snd;
    if (!s || !this.sites || !a.team) return null;
    const attacking = a.team === s.atk;
    const b = bombPlacement(s.bomb);
    const bomb = !b ? null
      : b.at === 'carried' ? (attacking ? { at: 'carried' as const, carrier: b.carrier } : null)
        : b.at === 'planted' ? { at: 'planted' as const, x: b.x, y: b.y, z: b.z }
          : attacking ? { at: 'ground' as const, x: b.x, y: b.y, z: b.z } : null;
    return { attacking, sites: this.sites, target: this.sndTarget, bomb, carrying: s.bomb.by === a.id };
  }

  /** S&D round `n`: everyone back at their spawn, the bomb with a random attacker. */
  private startSndRound(n: number): void {
    const atk = attackersFor(n, this.limit);
    const attackers = this.agents.filter((a) => a.team === atk);
    const carrier = attackers.length ? attackers[Math.floor(this.rand() * attackers.length)]!.id : null;
    this.snd = newRound(n, this.limit, this.time * 1000, carrier, bombHome(this.map, atk));
    this.sites = bombSites(this.map, otherTeam(atk));
    this.sndTarget = this.rand() < 0.5 ? 'a' : 'b';
    for (const a of this.agents) {
      a.channel = 0;
      a.patrol.target = null;
      a.memory.reset();
      a.unstuck.reset();
      this.spawn(a);
    }
  }

  private headcount(): Headcount {
    const heads: Headcount = { red: { size: 0, alive: 0 }, blue: { size: 0, alive: 0 } };
    for (const a of this.agents) {
      if (!a.team) continue;
      heads[a.team].size++;
      if (a.alive) heads[a.team].alive++;
    }
    return heads;
  }

  /** The bomb and the round, every tick: what game.ts and botHost.ts do between them. */
  private updateSnd(dt: number): void {
    const s = this.snd;
    const sites = this.sites;
    if (!s || !sites) return;
    const now = this.time * 1000;
    if (s.over) {
      if (now >= s.over.at + ROUND_END_TIME * 1000 && !this.done) this.startSndRound(s.n + 1);
      return;
    }
    for (const a of this.agents) {
      if (!a.alive || !a.team) continue;
      const me = a.mover.position;
      const near = (p: Point, r: number) => Math.hypot(p.x - me.x, p.z - me.z) < r && Math.abs(p.y - me.y) < 1.8;
      const phase = phaseOf(s, now);
      const b = bombPlacement(s.bomb);
      if (a.team === s.atk) {
        if (b?.at === 'ground' && near(b, BOMB_PICKUP_RADIUS)) {
          s.bomb = { by: a.id };
          this.give(a, 'bomb', REWARD.bombPickup);
          continue;
        }
        const site = s.bomb.by === a.id && phase === 'live' && a.mover.onGround ? siteAt(sites, me) : null;
        if (!site) {
          a.channel = 0;
          continue;
        }
        a.channel += dt;
        if (a.channel < PLANT_TIME) continue;
        a.channel = 0;
        s.bomb = { x: me.x, y: me.y, z: me.z, site, plantedAt: now, planter: a.id };
        a.captures++;
        this.give(a, 'bomb', REWARD.plant);
        continue;
      }
      if (phase !== 'planted' || b?.at !== 'planted' || !near(b, DEFUSE_RADIUS)) {
        a.channel = 0;
        continue;
      }
      a.channel += dt;
      if (a.channel < DEFUSE_TIME) continue;
      a.channel = 0;
      a.captures++;
      this.give(a, 'bomb', REWARD.defuse);
      this.endSndRound(a.team, 'defuse');
      return;
    }
    const result = decide(s, now, this.headcount());
    if (result) this.endSndRound(result.winner, result.why);
  }

  private endSndRound(winner: Team, why: NonNullable<SndRecord['over']>['why']): void {
    const s = this.snd!;
    s.over = { winner, why, at: this.time * 1000 };
    for (const a of this.agents) a.channel = 0;
    if (why === 'bomb') {
      // Everyone close by goes with it; the planter takes the credit for enemies.
      const b = bombPlacement(s.bomb);
      const planter = b?.at === 'planted' ? this.agents.find((x) => x.id === b.planter) ?? null : null;
      if (b && b.at !== 'carried') {
        for (const a of this.agents) {
          const p = a.mover.position;
          if (a.alive && Math.hypot(p.x - b.x, p.z - b.z) < BOMB_BLAST_RADIUS) this.kill(a, planter && this.isEnemy(planter, a) ? planter : null, false);
        }
      }
    }
    this.score[winner] = (this.score[winner] ?? 0) + 1;
    for (const a of this.agents) if (a.team) this.give(a, 'round', a.team === winner ? REWARD.round : -REWARD.round);
    if (this.score[winner]! >= this.limit) this.done = true;
  }

  /**
   * Shaping rewards for the decision just observed (`obs`, raw): progress toward the objective and
   * aim closing in on the nearest visible enemy. Both are potentials, so they add up to nothing
   * over a round trip and can't be farmed.
   */
  shape(a: SimAgent, obs: Float32Array): void {
    this.progress(a, this.obsInfo.attackDist);
    // Nobody in sight counts as the worst aim there is: otherwise looking away while they're hidden and
    // back when they show up again would pay every time (it did, before this). (Also paying for facing an
    // enemy known but out of sight was tried: no better on held-out play, 0.58 against 0.63 over 8M steps.)
    const e = OBS_LAYOUT.enemies;
    const err = a.alive && obs[e]! > 0.5 ? Math.abs(obs[e + 5]! * Math.PI) + Math.abs(obs[e + 6]! * (Math.PI / 2)) : WORST_AIM;
    if (a.aimError !== null) this.give(a, 'aim', REWARD.aim * (a.aimError - err));
    a.aimError = a.alive ? err : null;
  }

  /**
   * The progress reward, given the walking distance to the objective just observed: what's been
   * closed since the last decision (a potential, so going back and forth earns nothing).
   */
  progress(a: SimAgent, dist: number): void {
    const weight = this.mode === 'ctf' || this.mode === 'snd' ? 1 : 0.3;
    if (Number.isFinite(dist) && Number.isFinite(a.objective) && a.alive) {
      // Don't count teleports (respawns, capturing resets the objective).
      const closed = a.objective - dist;
      if (Math.abs(closed) < 5) this.give(a, 'progress', REWARD.progress * weight * closed);
    }
    a.objective = dist;
  }
}

const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
