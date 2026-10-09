import * as THREE from 'three';
import { Mover } from '../movement';
import { GUNS, shotDamage } from '../gunStats';
import {
  FLAG_BASES, FLAG_RADIUS, KNIFE_COOLDOWN, KNIFE_DAMAGE, KNIFE_RANGE, MELEE_COOLDOWN, MELEE_DAMAGE, MELEE_RANGE, MODES, TEAM_INFO, gunGameGun, otherTeam,
} from '../modes';
import { placementOf } from '../flags';
import { BOT_PREFIX, randomId, type RoomConnection } from '../../net/network';
import { DECISION_DT, Policy, type PolicyJson } from './policy';
import { BotBrain, SKILLS, type BotSkill } from './brain';
import { MAX_BOTS, botName, rosterEntries, type BotRoster, type BotSlot } from './roster';
import { MEMORY_TIME, OBS_SIZE, observe, type BodyView, type CtfView, type FlagState } from './observe';
import { MapSenses } from './senses';
import { goalFor, newPatrol, type Patrol, type Point, type SndGoalView } from './objective';
import {
  BOMB_PICKUP_RADIUS, DEFUSE_RADIUS, DEFUSE_TIME, PLANT_TIME, bombPlacement, canJoin, decide, phaseOf, siteAt,
} from '../snd';
import { Gear, type PickupRules } from './gear';
import { callOut, hear } from './team';
import {
  CLOAK_DURATION, DASH_SPEED, FIRE_DAMAGE, FIRE_TICK, FLASH_MAX, FLASH_RANGE, LIFESTEAL_DURATION, LIFESTEAL_FRACTION, MEDKIT_HEAL,
  SCAN_RADIUS, SHIELD_AMOUNT, SHIELD_DURATION, SPEED_DURATION, SPEED_MULTIPLIER,
} from '../abilities';
import { aimAngles, hitPlayer, lookDir, scatter, spreadOf, type Target } from './hitscan';
import type { PhysicsWorld } from '../physics';
import type { MapData } from '../mapgen';
import type { ModeRules } from '../rules';
import type {
  AbilityType, GameEvent, GameState, GunKind, PickupType, PlayerState, SiteId, SndRecord, Stance, Team, Vec3Tuple, WeaponKind,
} from '../../types';

/*
 * Bots in a real room. The room owner's client plays them: each bot is a body in the owner's
 * physics world, driven by the trained policy (policy.ts) through the same senses and controls it
 * was trained with, and published as an ordinary player record. Everyone else sees them as they
 * see any player.
 *
 * The game is client-authoritative, and the owner is each bot's client: it decides what a bot's
 * shots hit, applies the damage others' shots do to it, reports its deaths and takes, returns and
 * captures flags for it, exactly as a player's own client does for them.
 */

/** Stats go out at most this often (s), like a player's */
const STATS_INTERVAL = 1;
/** Pose updates per second for each bot */
/** A knife slash, start to finish (the gun waits) (s) */
const KNIFE_SLASH = 0.42;
const SEND_RATE = 10;
/** How often the number of bots is checked against the room (s) */
const SYNC_INTERVAL = 1;
const MAX_PITCH = Math.PI / 2 - 0.01;
/** A spawn point counts as taken while someone stands this close to it (m) */
const SPAWN_CLEARANCE = 1.2;
/** Pickups this close (m) are worth a detour; a medkit for a hurt bot, this close */
const DETOUR_RANGE = 14;
const MEDKIT_DETOUR = 25;
/** CTF: the flags come first, so only a pickup this close (practically on the way) is worth a detour */
const CTF_DETOUR_RANGE = 6;
/** Touching a pickup: as the player's (pickups.ts) */
const PICKUP_RADIUS = 1.1;
/** A throw is only made if it can land this close to where it's meant to (m) */
const THROW_TOLERANCE = 4;
const POLICY_URL = `${import.meta.env.BASE_URL}bots/policy.json`;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const arr = (x: number, y: number, z: number): Vec3Tuple => [r2(x), r2(y), r2(z)];

/** What the bots need from the game */
export interface BotHostApi {
  readonly selfId: string;
  readonly net: RoomConnection;
  joined(): boolean;
  physics(): PhysicsWorld | null;
  map(): MapData | null;
  rules(): ModeRules;
  game(): GameState;
  roundOver(): boolean;
  players(): Readonly<Record<string, PlayerState>>;
  /** Where a player is as this client sees them (ourselves included), or null when they're not in play */
  bodyOf(id: string): { x: number; y: number; z: number; stance: Stance; alive: boolean } | null;
  /** Distance along a ray to the first thing a bullet stops at (or `max`) */
  wallDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
  /** Height of whatever is under (x, y, z) */
  groundBelow(x: number, y: number, z: number): number;
  terrainAt(x: number, z: number): number;
  spawns(): readonly { pos: THREE.Vector3; team: Team | null }[];
  colorFor(id: string): string;
  /** A kill by `killerId` of someone on `victimTeam`: their kill count, the team score, the round */
  creditKill(killerId: string, victimTeam: Team | null): void;
  /** Mark the round over (inside a game transaction) */
  finishRound(g: GameState, winner: string, name: string, reason: 'score'): void;
  /** S&D: the defenders' sites this round */
  sites(): Record<SiteId, Point> | null;
  /** S&D: mark this round won by `winner` (inside a game transaction) */
  endSndRound(g: GameState, winner: Team, why: NonNullable<SndRecord['over']>['why']): void;
  /** S&D: who's on each team and how many are alive */
  headcount(): Record<Team, { size: number; alive: number }>;
  maxDamage(weapon: WeaponKind): number;
  /** Pickups lying on the map */
  pickups(): readonly { id: string; type: PickupType; uses?: number; x: number; y: number; z: number }[];
  /** Spots to scatter `n` dropped items around (x, z) */
  scatterAround(x: number, z: number, n: number): { x: number; z: number }[];
  /** Put a turret, barrier or mine down for a bot (false: no room there) */
  place(kind: 'turret' | 'wall' | 'mine', actor: BotActor): boolean;
  /** Throw a grenade, smoke, molotov or flashbang from `eye` along `dir` for a bot (blasts are timed and sent for it) */
  throwFor(botId: string, kind: 'grenade' | 'smoke' | 'molotov' | 'flash', eye: THREE.Vector3, dir: readonly [number, number, number]): void;
  /** Where a throw from `eye` along `dir` lands, and when (s) */
  landing(kind: 'grenade' | 'smoke' | 'molotov' | 'flash', eye: THREE.Vector3, dir: readonly [number, number, number]): { end: THREE.Vector3; duration: number };
  /** Where an arc thrown from `o` with velocity `v` (as sent in an event) lands, and when (s) */
  arcOf(kind: 'grenade' | 'smoke' | 'molotov' | 'flash', o: Vec3Tuple, v: Vec3Tuple): { end: THREE.Vector3; duration: number };
  /** The room's bot list (the owner plays exactly these) */
  botRoster(): BotRoster;
  /** Fires burning where (x, y, z) stands: whose they are and where they burn */
  firesAt(x: number, y: number, z: number): { owner: string; center: THREE.Vector3 }[];
}

/** A bot as something that places things */
export interface BotActor {
  id: string;
  pos: THREE.Vector3;
  yaw: number;
  onGround: boolean;
  color: string;
}

interface HostedBot {
  readonly id: string;
  /** Its entry in the room's bot list */
  readonly slot: string;
  skill: BotSkill;
  name: string;
  team: Team | null;
  readonly mover: Mover;
  attached: PhysicsWorld | null;
  readonly brain: BotBrain;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  respawnIn: number;
  gun: GunKind;
  ammo: number;
  reloadLeft: number;
  cooldown: number;
  burst: number;
  meleeCooldown: number;
  deaths: number;
  captures: number;
  decideIn: number;
  sendIn: number;
  flagBusy: boolean;
  /** S&D: seconds spent planting or defusing so far (0: not at it) */
  channel: number;
  /** Where it's patrolling (FFA / TDM objective) */
  readonly patrol: Patrol;
  /** Picked-up gun, abilities and their buffs */
  readonly gear: Gear;
  /** The pickup it's fetching, if any */
  detour: string | null;
  /** Its current goal and how far away (straight line) */
  goal: Point | null;
  goalDist: number;
  /** When it last spawned (bot host clock) */
  spawnedAt: number;
  /** Match stats, as players report their own (the scoreboard and the MVP pick read them) */
  stats: { damage: number; shots: number; hits: number; headshots: number; streak: number; best: number };
  /** Kills as last seen in its record (victims credit them), to count streaks */
  seenKills: number;
  /** The stats as last sent, and when */
  statsKey: string;
  statsAt: number;
}

let policyPromise: Promise<Policy | null> | null = null;

/** The trained policy (fetched once, the first time a room wants bots). Null if there isn't a usable one. */
function loadPolicy(): Promise<Policy | null> {
  policyPromise ??= fetch(POLICY_URL)
    .then((r) => (r.ok ? r.json() as Promise<PolicyJson> : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
    .then((json) => Policy.fromJSON(json))
    .catch((err: unknown) => {
      console.warn('Bots are unavailable: no usable policy at', POLICY_URL, err);
      return null;
    });
  return policyPromise;
}

export class BotHost {
  private readonly bots = new Map<string, HostedBot>();
  private owner = false;
  private policy: Policy | null = null;
  private loading = false;
  private syncIn = 0;
  /** Bots being added or removed (the writes are in flight) */
  private pending = 0;
  private senses: MapSenses | null = null;
  private readonly obs = new Float32Array(OBS_SIZE);
  /** Seconds since we started, for the bots' memories */
  private clock = 0;
  private patrolMap: MapData | null = null;
  /** Flashbangs in the air: when and where they go off */
  private flashes: { at: number; p: THREE.Vector3 }[] = [];
  private patrolList: (Point & { team: Team | null })[] = [];

  constructor(private readonly api: BotHostApi) {}

  /** Whether this client owns the room (and so plays its bots) */
  setOwner(owner: boolean): void {
    this.owner = owner;
    this.syncIn = 0;
  }

  /** The player id of the bot playing list entry `slot`, if we play it */
  playerOf(slot: string): string | null {
    for (const b of this.bots.values()) if (b.slot === slot) return b.id;
    return null;
  }

  /** The room's bot list changed: catch up right away */
  rosterChanged(): void {
    this.syncIn = 0;
  }

  /** Ids of the bots we play */
  ids(): string[] {
    return [...this.bots.keys()];
  }

  has(id: string): boolean {
    return this.bots.has(id);
  }

  /** The bots this client should be playing: the room's list, if we own the room */
  private wanted(): [string, BotSlot][] {
    const { api } = this;
    if (!this.owner || !api.joined()) return [];
    return rosterEntries(api.botRoster()).slice(0, MAX_BOTS);
  }

  /** Play exactly the bots on the room's list: add the missing, remove the dropped, follow level and team changes. */
  private sync(): void {
    if (this.pending) return;
    const want = this.wanted();
    if (want.length && !this.policy) {
      if (!this.loading) {
        this.loading = true;
        void loadPolicy().then((p) => { this.policy = p; this.syncIn = 0; });
      }
      return;
    }
    const slots = new Map(want);
    // Removed from the list (or we're not the owner any more): they go.
    for (const bot of [...this.bots.values()]) if (!slots.has(bot.slot)) this.remove(bot);
    const playing = new Map([...this.bots.values()].map((b) => [b.slot, b]));
    for (const [slotId, slot] of want) {
      const bot = playing.get(slotId);
      if (!bot) {
        // One at a time, so teams balance as they fill.
        this.add(slotId, slot);
        return;
      }
      this.follow(bot, slot);
    }
  }

  /** A bot's entry was edited: take on the new level (and name), or switch team. */
  private follow(bot: HostedBot, slot: BotSlot): void {
    if (bot.skill !== slot.skill) {
      bot.skill = slot.skill;
      bot.brain.setSkill(SKILLS[slot.skill]);
    }
    const name = botName(slot);
    if (name !== bot.name) {
      bot.name = name;
      void this.api.net.renameBot(bot.id, name).catch((err: unknown) => console.warn('Could not rename a bot', err));
    }
    const teams = MODES[this.api.rules().base].teams;
    if (teams && slot.team && slot.team !== bot.team) {
      void this.dropFlag(bot);
      bot.team = slot.team;
      void this.api.net.sendStateAs(bot.id, { team: bot.team, color: TEAM_INFO[bot.team].color });
      this.respawn(bot);
    }
  }

  private teamCounts(): Record<Team, number> {
    const counts: Record<Team, number> = { red: 0, blue: 0 };
    for (const [id, p] of Object.entries(this.api.players())) {
      if (p.spec || this.bots.has(id)) continue;
      if (p.team) counts[p.team]++;
    }
    for (const b of this.bots.values()) if (b.team) counts[b.team]++;
    return counts;
  }

  private add(slotId: string, slot: BotSlot): void {
    const { api } = this;
    const policy = this.policy!;
    const rules = api.rules();
    const id = `${BOT_PREFIX}${randomId(8)}`;
    const name = botName(slot);
    let team: Team | null = null;
    if (MODES[rules.base].teams) {
      if (slot.team) {
        team = slot.team;
      } else {
        const counts = this.teamCounts();
        team = counts.red === counts.blue ? (Math.random() < 0.5 ? 'red' : 'blue') : counts.red < counts.blue ? 'red' : 'blue';
      }
    }
    const mover = new Mover();
    mover.setTerrain((x, z) => api.terrainAt(x, z));
    const bot: HostedBot = {
      id, slot: slotId, skill: slot.skill, name, team, mover, attached: null, brain: new BotBrain(policy, SKILLS[slot.skill]),
      yaw: 0, pitch: 0, hp: rules.health, alive: true, respawnIn: 0, gun: 'rifle', ammo: 0, reloadLeft: 0, cooldown: 0, burst: 0,
      meleeCooldown: 0, deaths: 0, captures: 0, decideIn: Math.random() * DECISION_DT, sendIn: 0, flagBusy: false, channel: 0, patrol: newPatrol(), gear: new Gear(), detour: null, goal: null, goalDist: 0, spawnedAt: 0,
      stats: { damage: 0, shots: 0, hits: 0, headshots: 0, streak: 0, best: 0 }, seenKills: 0, statsKey: '', statsAt: 0,
    };
    this.bots.set(id, bot);
    this.placeAtSpawn(bot);
    // S&D: a bot added mid-round plays from the next one, like a player who joins then.
    const snd = rules.base === 'snd' ? api.game().snd : undefined;
    if (snd && !canJoin(snd, api.net.serverNow())) {
      bot.alive = false;
      bot.hp = 0;
      bot.respawnIn = Infinity;
      bot.mover.setSolid(false);
    }
    this.pending++;
    api.net.addBot(id, {
      name, color: team ? TEAM_INFO[team].color : api.colorFor(id), ...(team ? { team } : {}), bot: true,
      ...this.pose(bot), gun: bot.gun, hp: bot.hp, alive: bot.alive, kills: 0, deaths: 0,
      damage: 0, shots: 0, hits: 0, headshots: 0, streak: 0, best: 0, captures: 0,
    })
      .catch((err: unknown) => {
        console.warn('Could not add a bot', err);
        this.drop(bot);
      })
      .finally(() => { this.pending--; });
  }

  private remove(bot: HostedBot): void {
    this.drop(bot);
    this.pending++;
    void this.dropFlag(bot);
    void this.dropBomb(bot);
    this.api.net.removeBot(bot.id)
      .catch((err: unknown) => console.warn('Could not remove a bot', err))
      .finally(() => { this.pending--; });
  }

  /** Forget a bot locally (its body leaves the physics world). */
  private drop(bot: HostedBot): void {
    this.bots.delete(bot.id);
    bot.mover.detachPhysics();
    bot.attached = null;
  }

  /** Remove every bot (e.g. the mode changed between teams and free-for-all: they rejoin fresh). */
  removeAll(): void {
    for (const bot of [...this.bots.values()]) this.remove(bot);
  }

  rulesChanged(): void {
    this.removeAll();
    this.syncIn = 0;
  }

  /** A new round: every bot's score is back to zero, and they respawn. */
  startRound(): void {
    for (const bot of this.bots.values()) {
      bot.deaths = 0;
      bot.captures = 0;
      bot.brain.reset();
      bot.gear.reset();
      bot.stats = { damage: 0, shots: 0, hits: 0, headshots: 0, streak: 0, best: 0 };
      bot.seenKills = 0;
      bot.statsKey = '';
      bot.mover.speedMultiplier = 1;
      this.respawn(bot, { kills: 0, deaths: 0, captures: 0, streak: 0, best: 0, damage: 0, shots: 0, hits: 0, headshots: 0, shield: false, cloak: false });
    }
  }

  /** A new S&D round: everyone back at their spawn; the survivors keep what they carry. */
  startSndRound(): void {
    for (const bot of this.bots.values()) {
      bot.channel = 0;
      bot.patrol.target = null;
      if (!bot.alive) {
        bot.brain.reset();
        this.respawn(bot);
        continue;
      }
      this.placeAtSpawn(bot);
      void this.api.net.sendStateAs(bot.id, { ...this.pose(bot), gun: bot.gun, hp: bot.hp, alive: true });
    }
  }

  /** The S&D bomb went off at `at`: our bots within `radius` go with it. */
  bombBlast(at: THREE.Vector3, radius: number, planter: string | null): void {
    for (const bot of this.bots.values()) {
      if (bot.alive && bot.mover.position.distanceTo(at) < radius) this.die(bot, planter && planter !== bot.id ? planter : '', false, 'bomb');
    }
  }

  dispose(): void {
    for (const bot of [...this.bots.values()]) this.drop(bot);
  }

  // ---------------------------------------------------------------- playing

  update(dt: number): void {
    const { api } = this;
    this.clock += dt;
    this.syncIn -= dt;
    if (this.syncIn <= 0) {
      this.syncIn = SYNC_INTERVAL;
      this.sync();
    }
    if (!this.bots.size) return;
    const physics = api.physics();
    const map = api.map();
    if (!physics || !map) return;
    if (this.senses?.map !== map) this.senses = new MapSenses(map, physics);
    const roundOver = api.roundOver();
    const rules = api.rules();
    const snd = rules.base === 'snd' ? api.game().snd ?? null : null;
    // S&D holds everyone at their spawn until the round's fight starts.
    const frozen = !!snd && phaseOf(snd, api.net.serverNow()) === 'freeze';
    this.updateFlashes();

    for (const bot of this.bots.values()) {
      if (bot.attached !== physics) {
        bot.mover.attachPhysics(physics, false);
        bot.attached = physics;
      }
      bot.mover.speedScale = rules.speed;
      bot.mover.gravityScale = rules.gravity;
      if (!bot.alive) {
        bot.respawnIn -= dt;
        if (bot.respawnIn <= 0 && !roundOver) this.respawn(bot);
        continue;
      }
      bot.decideIn -= dt;
      let decided = false;
      if (bot.decideIn <= 0) {
        bot.decideIn += DECISION_DT;
        bot.brain.decide(this.observe(bot), rules.base === 'ctf' || rules.base === 'snd', bot.mover.position);
        decided = true;
      }
      // Someone in view: the aim model aims. Otherwise the decision's turn (walking, looking about).
      const [dYaw, dPitch] = bot.brain.steering.step(dt);
      if (this.aimAt(bot, dt)) {
        bot.brain.steering.reset();
      } else {
        bot.yaw += dYaw;
        bot.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, bot.pitch + dPitch));
      }
      // Planting or defusing (S&D) means standing still.
      bot.mover.step(dt, bot.yaw, roundOver || frozen || bot.channel > 0 ? null : bot.brain.moveInput);
      // The same backstop as the player's: never outside the map.
      const edge = map.half - 0.9;
      const p = bot.mover.position;
      p.x = Math.max(-edge, Math.min(edge, p.x));
      p.z = Math.max(-edge, Math.min(edge, p.z));

      bot.gun = this.gunFor(bot);
      bot.cooldown = Math.max(0, bot.cooldown - dt);
      bot.meleeCooldown = Math.max(0, bot.meleeCooldown - dt);
      if (bot.reloadLeft > 0) {
        bot.reloadLeft -= dt;
        if (bot.reloadLeft <= 0) this.reloaded(bot);
      }
      if (!roundOver) this.updateGear(bot, dt, decided);
      // Flashed: no idea where to shoot for a moment.
      const blind = bot.gear.blindUntil > this.clock;
      // The trigger: the policy wants to shoot and the crosshair is on someone (a carrier swings the flag).
      const aim = bot.brain.aim;
      const shoot = bot.brain.action.fire && (this.carrying(bot) || (aim.engaged && aim.onTarget));
      if (!shoot || roundOver || blind) bot.burst = 0;
      else if (this.carrying(bot)) this.swing(bot);
      else if (!this.stab(bot)) this.fire(bot);
      if (rules.base === 'ctf' && !roundOver) this.updateFlags(bot);
      if (snd && !roundOver) this.updateBomb(bot, snd, dt);
    }

    for (const bot of this.bots.values()) {
      bot.sendIn -= dt;
      if (bot.sendIn > 0) continue;
      bot.sendIn = 1 / SEND_RATE;
      // Kills are credited by the victims: a new one extends the streak.
      const kills = api.players()[bot.id]?.kills ?? 0;
      if (kills > bot.seenKills) {
        bot.stats.streak += kills - bot.seenKills;
        bot.stats.best = Math.max(bot.stats.best, bot.stats.streak);
      }
      bot.seenKills = kills;
      const key = JSON.stringify(bot.stats);
      const stats = key !== bot.statsKey && this.clock - bot.statsAt >= STATS_INTERVAL ? { ...bot.stats } : null;
      if (stats) {
        bot.statsKey = key;
        bot.statsAt = this.clock;
      }
      void api.net.sendStateAs(bot.id, { ...this.pose(bot), gun: bot.gun, ...stats });
    }
  }

  private pose(bot: HostedBot) {
    const p = bot.mover.position;
    return {
      x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r3(bot.yaw), pitch: r3(bot.pitch), stance: bot.mover.stance, aim: false, rl: bot.reloadLeft > 0,
      th: bot.gear.throws,
    };
  }

  /** The gun the rules give a bot (bots don't pick guns up) */
  private gunFor(bot: HostedBot): GunKind {
    const { loadout } = this.api.rules();
    if (loadout === 'standard') return bot.gear.special?.kind ?? 'rifle';
    if (loadout === 'gungame') return gunGameGun(this.api.players()[bot.id]?.kills ?? 0);
    return loadout;
  }

  private isEnemyOf(bot: HostedBot, id: string): boolean {
    if (id === bot.id) return false;
    if (!bot.team) return true;
    const team = this.bots.get(id)?.team ?? this.api.players()[id]?.team;
    return team !== bot.team;
  }

  /** Everyone else in play, as the bot's senses need them */
  private others(bot: HostedBot): BodyView[] {
    const { api } = this;
    const maxHp = api.rules().health;
    const carriers = new Set(Object.values(api.game().flags).map((f) => f?.by).filter(Boolean));
    const out: BodyView[] = [];
    for (const [id, p] of Object.entries(api.players())) {
      if (id === bot.id || p.spec) continue;
      const mine = this.bots.get(id);
      const body = mine
        ? { x: mine.mover.position.x, y: mine.mover.position.y, z: mine.mover.position.z, stance: mine.mover.stance, alive: mine.alive }
        : api.bodyOf(id);
      if (!body) continue;
      out.push({ id, ...body, hp: mine ? mine.hp : p.hp, maxHp, team: mine ? mine.team : p.team ?? null, carrying: carriers.has(id) });
    }
    return out;
  }

  private carrying(bot: HostedBot): boolean {
    return !!bot.team && this.api.game().flags[otherTeam(bot.team)]?.by === bot.id;
  }

  private ctfView(bot: HostedBot): CtfView | null {
    if (this.api.rules().base !== 'ctf' || !bot.team) return null;
    const flag = (team: Team): FlagState => {
      const at = placementOf(this.api.game().flags[team]);
      return at.at === 'carried' ? { at: 'carried', carrier: at.carrier } : at.at === 'ground' ? { at: 'ground', x: at.x, y: at.y, z: at.z } : { at: 'base' };
    };
    const enemy = otherTeam(bot.team);
    const base = (t: Team) => ({ x: FLAG_BASES[t].x, y: FLAG_BASES[t].y, z: FLAG_BASES[t].z });
    return { ownBase: base(bot.team), enemyBase: base(enemy), own: flag(bot.team), enemy: flag(enemy) };
  }

  /** Places worth patrolling on this map, with whose half they're in (red's is +z) */
  private patrolPoints(map: MapData): (Point & { team: Team | null })[] {
    if (this.patrolMap !== map) {
      this.patrolMap = map;
      this.patrolList = [
        ...map.spawns.map((sp) => ({ x: sp.x, y: sp.y, z: sp.z, team: sp.team })),
        ...map.pickupSpots.map((sp) => ({ x: sp.x, y: sp.y, z: sp.z, team: (sp.z > 3 ? 'red' : sp.z < -3 ? 'blue' : null) as Team | null })),
      ];
    }
    return this.patrolList;
  }

  private observe(bot: HostedBot): Float32Array {
    const p = bot.mover.position;
    const v = bot.mover.velocity;
    const rules = this.api.rules();
    const others = this.others(bot);
    const ctf = this.ctfView(bot);
    const carrying = this.carrying(bot);
    const map = this.api.map();
    const known = [...bot.brain.memory.seen.values()].filter((m) => this.clock - m.t <= MEMORY_TIME);
    const snd = this.sndView(bot);
    const objective = map ? goalFor({
      self: { id: bot.id, team: bot.team, x: p.x, y: p.y, z: p.z, carrying: carrying || !!snd?.carrying },
      others, mode: rules.base, ctf, snd, patrolPoints: this.patrolPoints(map), patrol: bot.patrol, now: this.clock,
      hp: bot.hp / rules.health, known, aggression: bot.brain.personality.aggression,
    }) : null;
    // Something worth picking up close by: fetch it first.
    const goal = objective ? this.detourFor(bot, ctf) ?? objective : null;
    bot.goal = goal;
    bot.goalDist = goal ? Math.hypot(goal.x - p.x, goal.z - p.z) : 0;
    const obs = observe({
      self: {
        x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, yaw: bot.yaw, pitch: bot.pitch, onGround: bot.mover.onGround, stance: bot.mover.stance,
        hp: bot.hp, maxHp: rules.health, team: bot.team, gun: bot.gun, ammo: this.magOf(bot), mag: GUNS[bot.gun].mag, reloading: bot.reloadLeft > 0,
        carrying,
      },
      others, mode: rules.base, ctf, now: this.clock, memory: bot.brain.memory, senses: this.senses!,
      // The policy was trained on FFA, TDM and CTF: S&D fights look like TDM to it.
      goal, asMode: rules.base === 'snd' || (goal && rules.base === 'ctf') ? 'tdm' : undefined,
    }, this.obs);
    // Whoever it just saw, its teammates hear about.
    if (bot.team) {
      const mates = [...this.bots.values()].filter((b) => b !== bot && b.team === bot.team && b.alive).map((b) => b.brain.memory);
      if (mates.length) callOut(bot.brain.memory, mates, this.clock);
    }
    return obs;
  }

  // ---------------------------------------------------------------- combat

  private eye(bot: HostedBot): THREE.Vector3 {
    const p = bot.mover.position;
    return new THREE.Vector3(p.x, p.y + bot.mover.eyeHeight, p.z);
  }

  private fire(bot: HostedBot): void {
    if (bot.cooldown > 0 || bot.reloadLeft > 0) return;
    const { api } = this;
    const def = GUNS[bot.gun];
    if (this.magOf(bot) <= 0) {
      const special = bot.gear.special;
      // The picked-up gun is spent: back to the rifle.
      if (special && special.reserve <= 0) {
        bot.gear.special = null;
        bot.gun = this.gunFor(bot);
        return;
      }
      bot.reloadLeft = def.reloadTime;
      return;
    }
    if (bot.gear.special) bot.gear.special.mag--;
    else bot.ammo--;
    this.endCloak(bot);
    bot.cooldown = def.fireInterval;
    const spread = spreadOf(bot.gun, bot.mover.horizontalSpeed > 1, bot.mover.onGround, bot.mover.stance, bot.burst);
    bot.burst++;
    const eye = this.eye(bot);
    const look = lookDir(bot.yaw, bot.pitch);
    const targets: Target[] = this.others(bot)
      .filter((b) => b.alive && this.isEnemyOf(bot, b.id))
      .map((b) => ({ id: b.id, x: b.x, y: b.y, z: b.z, stance: b.stance }));
    const headshotsOnly = api.rules().headshotsOnly;
    const ends: Vec3Tuple[] = [];
    const damageTo = new Map<string, number>();
    let anyHead = false;
    for (let pellet = 0; pellet < def.pellets; pellet++) {
      const d = scatter(look, spread);
      const ray = { ox: eye.x, oy: eye.y, oz: eye.z, dx: d[0], dy: d[1], dz: d[2] };
      let dist = api.wallDistance(eye.x, eye.y, eye.z, d[0], d[1], d[2], def.range);
      let hit: { id: string; head: boolean } | null = null;
      for (const t of targets) {
        const h = hitPlayer(ray, t, dist);
        if (h) {
          dist = h.dist;
          hit = { id: t.id, head: h.head };
        }
      }
      ends.push(arr(eye.x + d[0] * dist, eye.y + d[1] * dist, eye.z + d[2] * dist));
      if (!hit || (headshotsOnly && !hit.head)) continue;
      anyHead ||= hit.head;
      damageTo.set(hit.id, (damageTo.get(hit.id) ?? 0) + shotDamage(bot.gun, hit.head, dist));
    }
    bot.stats.shots++;
    if (damageTo.size) {
      bot.stats.hits++;
      if (anyHead) bot.stats.headshots++;
      for (const [id, dmg] of damageTo) bot.stats.damage += Math.min(dmg, this.api.players()[id]?.hp ?? dmg);
    }
    // Lifesteal: a share of the damage dealt comes back as health.
    if (damageTo.size && bot.gear.lifestealUntil > this.clock) {
      const dealt = [...damageTo].reduce((sum, [id, dmg]) => sum + Math.min(dmg, this.api.players()[id]?.hp ?? dmg), 0);
      this.heal(bot, Math.round(dealt * LIFESTEAL_FRACTION));
    }
    // Recoil, as the player gets it (bots never aim down sights).
    bot.pitch = Math.min(MAX_PITCH, bot.pitch + def.recoil);
    bot.yaw += (Math.random() - 0.5) * def.recoil * 0.5;

    const [first, ...rest] = ends;
    const shot = { o: arr(eye.x, eye.y - 0.1, eye.z), e: first ?? arr(eye.x, eye.y, eye.z) };
    const extra = { ...(bot.gun !== 'rifle' ? { w: bot.gun } : {}), ...(rest.length ? { ends: rest } : {}) };
    if (def.pellets > 1) {
      const hits = Object.fromEntries([...damageTo].map(([id, dmg]) => [id, Math.round(dmg)]));
      api.net.sendEventAs(bot.id, { type: 'shot', ...shot, ...extra, ...(damageTo.size ? { hits } : {}) });
    } else {
      const [hitId, dmg] = [...damageTo][0] ?? [null, 0];
      api.net.sendEventAs(bot.id, { type: 'shot', ...shot, ...extra, ...(hitId ? { hit: hitId, dmg: Math.round(dmg), head: anyHead } : {}) });
    }
  }

  /** Carrying the enemy flag: swing it at the nearest enemy in reach, roughly where the bot looks. */
  private swing(bot: HostedBot): void {
    if (bot.meleeCooldown > 0) return;
    bot.meleeCooldown = MELEE_COOLDOWN;
    this.endCloak(bot);
    const eye = this.eye(bot);
    const best = this.inReach(bot, MELEE_RANGE);
    this.api.net.sendEventAs(bot.id, { type: 'melee', o: arr(eye.x, eye.y, eye.z), hit: best, dmg: best ? MELEE_DAMAGE : 0, head: false });
  }

  /**
   * Someone right in the bot's face: knife them instead of shooting (as players do). Returns whether
   * it slashed; the gun waits until the slash is over.
   */
  private stab(bot: HostedBot): boolean {
    if (bot.meleeCooldown > 0) return false;
    const best = this.inReach(bot, KNIFE_RANGE * 0.8);
    if (!best) return false;
    bot.meleeCooldown = KNIFE_COOLDOWN;
    bot.cooldown = Math.max(bot.cooldown, KNIFE_SLASH);
    bot.burst = 0;
    this.endCloak(bot);
    const eye = this.eye(bot);
    bot.stats.shots++;
    bot.stats.hits++;
    bot.stats.damage += Math.min(KNIFE_DAMAGE, this.api.players()[best]?.hp ?? KNIFE_DAMAGE);
    this.api.net.sendEventAs(bot.id, { type: 'melee', w: 'knife', o: arr(eye.x, eye.y, eye.z), hit: best, dmg: KNIFE_DAMAGE, head: false });
    return true;
  }

  /** The nearest enemy within `range` of the bot's eyes, roughly where it looks. */
  private inReach(bot: HostedBot, range: number): string | null {
    const eye = this.eye(bot);
    let best: string | null = null;
    let bestD = range;
    for (const b of this.others(bot)) {
      if (!b.alive || !this.isEnemyOf(bot, b.id)) continue;
      const d = Math.hypot(b.x - eye.x, b.y + 1 - eye.y, b.z - eye.z);
      if (d > bestD) continue;
      const [yaw] = aimAngles(eye.x, eye.y, eye.z, b.x, b.y + 1, b.z);
      if (Math.abs(Math.atan2(Math.sin(yaw - bot.yaw), Math.cos(yaw - bot.yaw))) > 0.6) continue;
      best = b.id;
      bestD = d;
    }
    return best;
  }

  /** Every event in the room: the ones that hurt our bots are applied here (we're their client). */
  onEvent(evt: GameEvent): void {
    if (!this.bots.size) return;
    if (evt.type === 'flash' && evt.o && evt.v) {
      // It goes off where it lands: work out where and when, and blind whoever's looking.
      const arc = this.api.arcOf('flash', evt.o, evt.v);
      this.flashes.push({ at: this.clock + arc.duration, p: arc.end });
      return;
    }
    if (evt.type === 'shot') {
      const weapon: WeaponKind = evt.tur ? 'turret' : evt.w && evt.w in GUNS ? evt.w : 'rifle';
      // Gunfire nearby gives the shooter away (roughly).
      if (evt.o && !evt.tur) {
        const gun: GunKind = evt.w && evt.w in GUNS ? evt.w : 'rifle';
        for (const bot of this.bots.values()) {
          if (!bot.alive || evt.from === bot.id || !this.isEnemyOf(bot, evt.from)) continue;
          const p = bot.mover.position;
          hear(bot.brain.memory, evt.from, gun, evt.o[0], evt.o[1] - 1.5, evt.o[2], p.x, p.z, this.clock);
        }
      }
      for (const bot of this.bots.values()) {
        const pellets = evt.hits?.[bot.id];
        if (pellets) this.hurt(bot, pellets, evt.from, false, weapon, evt.o);
        else if (evt.hit === bot.id) this.hurt(bot, evt.dmg, evt.from, !!evt.head, weapon, evt.o);
      }
    } else if (evt.type === 'melee' && evt.hit) {
      const bot = this.bots.get(evt.hit);
      if (bot) this.hurt(bot, evt.dmg, evt.from, !!evt.head, evt.w === 'knife' ? 'knife' : 'flag', evt.o);
    } else if (evt.type === 'blast' && evt.hits) {
      for (const bot of this.bots.values()) {
        const dmg = evt.hits[bot.id];
        if (dmg) this.hurt(bot, dmg, evt.from, false, evt.mine ? 'mine' : 'grenade', evt.p);
      }
    }
  }

  private hurt(bot: HostedBot, dmg: number | undefined, fromId: string, head: boolean, weapon: WeaponKind, source: Vec3Tuple | undefined): void {
    const { api } = this;
    if (!bot.alive || api.roundOver()) return;
    // Teammates can't hurt each other (and a bot can't shoot itself).
    if (fromId === bot.id || (bot.team && !this.isEnemyOf(bot, fromId))) return;
    if (api.rules().headshotsOnly && !head && weapon !== 'flag' && weapon !== 'knife') return;
    let amount = Math.min(Math.max(Number(dmg) || 0, 0), api.maxDamage(weapon));
    if (!amount) return;
    // A shield soaks it up first.
    const gear = bot.gear;
    if (gear.shieldHp > 0 && gear.shieldUntil > this.clock) {
      const absorbed = Math.min(gear.shieldHp, amount);
      gear.shieldHp -= absorbed;
      amount -= absorbed;
      if (gear.shieldHp <= 0) this.endShield(bot);
      if (!amount) return;
    }
    bot.hp -= amount;
    bot.brain.memory.hurt(this.clock, source ? { x: source[0], z: source[2] } : null, fromId);
    if (bot.hp <= 0) this.die(bot, fromId, head, weapon);
    else void api.net.sendStateAs(bot.id, { hp: bot.hp });
  }

  private die(bot: HostedBot, killerId: string, head: boolean, weapon: WeaponKind): void {
    const { api } = this;
    void this.dropFlag(bot);
    void this.dropBomb(bot);
    bot.alive = false;
    bot.channel = 0;
    bot.mover.setSolid(false);
    bot.hp = 0;
    bot.deaths++;
    // S&D: no respawns, the next round brings everyone back (startSndRound).
    bot.respawnIn = api.rules().base === 'snd' ? Infinity : api.rules().respawn;
    bot.brain.reset();
    this.dropLoot(bot);
    bot.gear.reset();
    bot.mover.speedMultiplier = 1;
    bot.stats.streak = 0;
    void api.net.sendStateAs(bot.id, { alive: false, hp: 0, deaths: bot.deaths, streak: 0, shield: false, cloak: false });
    api.net.sendEventAs(bot.id, { type: 'kill', killer: killerId, victim: bot.id, head, weapon });
    if (killerId && killerId !== bot.id) api.creditKill(killerId, bot.team);
  }

  private placeAtSpawn(bot: HostedBot): void {
    const { api } = this;
    const others = this.others(bot).filter((b) => b.alive);
    const enemies = others.filter((b) => this.isEnemyOf(bot, b.id));
    const all = api.spawns().filter((s) => (bot.team ? s.team === bot.team : true)).map((s) => s.pos);
    // Never onto someone (bodies are solid).
    const free = all.filter((p) => others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > SPAWN_CLEARANCE));
    const points = free.length ? free : all;
    const scored = points.map((p) => ({ p, d: enemies.length ? Math.min(...enemies.map((e) => Math.hypot(e.x - p.x, e.z - p.z))) : Math.random() * 100 }));
    scored.sort((a, b) => b.d - a.d);
    const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))]?.p ?? new THREE.Vector3();
    bot.mover.teleport(pick.clone().add(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5)));
    bot.yaw = Math.atan2(pick.x, pick.z);
    bot.pitch = 0;
    bot.hp = api.rules().health;
    bot.alive = true;
    bot.mover.setSolid(true);
    bot.spawnedAt = this.clock;
    bot.detour = null;
    bot.gun = this.gunFor(bot);
    bot.ammo = GUNS[bot.gun].mag;
    bot.reloadLeft = bot.cooldown = bot.burst = 0;
    bot.brain.steering.reset();
  }

  private respawn(bot: HostedBot, extra: Partial<PlayerState> = {}): void {
    this.placeAtSpawn(bot);
    void this.api.net.sendStateAs(bot.id, { ...this.pose(bot), gun: bot.gun, hp: bot.hp, alive: true, ...extra });
  }

  /**
   * The aim model, for this frame: aim at the enemy in view it picks (whoever shot us first, a flag
   * carrier before anyone). Returns whether it's aiming at someone (then yaw and pitch are its).
   */
  private aimAt(bot: HostedBot, dt: number): boolean {
    const memory = bot.brain.memory;
    const inView = new Set(memory.inView(this.clock));
    const visible = inView.size
      ? this.others(bot).filter((o) => o.alive && inView.has(o.id) && this.isEnemyOf(bot, o.id))
      : [];
    const eye = this.eye(bot);
    const hurt = 1 - bot.hp / this.api.rules().health;
    const aimed = bot.brain.aim.update(dt, this.clock, {
      x: eye.x, y: eye.y, z: eye.z, yaw: bot.yaw, pitch: bot.pitch, speed: bot.mover.horizontalSpeed, gun: bot.gun,
      shaky: bot.brain.personality.nerves * hurt,
    }, visible, this.clock - memory.hurtAt < 2 ? memory.hurtBy : null);
    if (!bot.brain.aim.engaged) return false;
    bot.yaw = aimed.yaw;
    bot.pitch = aimed.pitch;
    return true;
  }

  // ---------------------------------------------------------------- gear: guns, abilities, pickups

  /** Rounds in the magazine of the gun in hand */
  private magOf(bot: HostedBot): number {
    return bot.gear.special ? bot.gear.special.mag : bot.ammo;
  }

  /** A reload finished: the picked-up gun's from its spare rounds, the rifle's from nowhere (bots never run dry). */
  private reloaded(bot: HostedBot): void {
    const special = bot.gear.special;
    if (!special) {
      bot.ammo = GUNS[bot.gun].mag;
      return;
    }
    const take = Math.min(GUNS[special.kind].mag - special.mag, special.reserve);
    special.mag += take;
    special.reserve -= take;
  }

  private heal(bot: HostedBot, amount: number): void {
    const hp = Math.min(this.api.rules().health, bot.hp + amount);
    if (hp <= bot.hp) return;
    bot.hp = hp;
    void this.api.net.sendStateAs(bot.id, { hp });
  }

  private endCloak(bot: HostedBot): void {
    if (bot.gear.cloakUntil <= 0) return;
    bot.gear.cloakUntil = 0;
    void this.api.net.sendStateAs(bot.id, { cloak: false });
  }

  private endShield(bot: HostedBot): void {
    bot.gear.shieldHp = 0;
    bot.gear.shieldUntil = 0;
    void this.api.net.sendStateAs(bot.id, { shield: false });
  }

  /** On death, the picked-up gun and the abilities fall around the body for anyone to grab. */
  private dropLoot(bot: HostedBot): void {
    const rules = this.api.rules();
    if (!rules.guns && !rules.abilities && !rules.ammo) return;
    const items = bot.gear.dropAll();
    if (!items.length) return;
    const p = bot.mover.position;
    const spots = this.api.scatterAround(p.x, p.z, items.length);
    items.forEach((item, i) => {
      const spot = spots[i] ?? { x: p.x, z: p.z };
      this.api.net.spawnPickup({ type: item.type, uses: item.uses, x: spot.x, z: spot.z });
    });
  }

  private pickupRules(): PickupRules {
    const r = this.api.rules();
    return { standard: r.loadout === 'standard', guns: r.guns, abilities: r.abilities, ammo: r.ammo };
  }

  /** Every frame: buffs running out, fire underfoot, things to pick up, and (each decision) abilities to use. */
  private updateGear(bot: HostedBot, dt: number, decided: boolean): void {
    const { gear } = bot;
    const now = this.clock;
    bot.mover.speedMultiplier = gear.speedUntil > now ? SPEED_MULTIPLIER : 1;
    if (gear.shieldHp > 0 && gear.shieldUntil <= now) this.endShield(bot);
    if (gear.cloakUntil > 0 && gear.cloakUntil <= now) this.endCloak(bot);
    // Standing in an enemy's fire burns (each victim's own client applies it; we're the bot's).
    gear.fireTick -= dt;
    if (gear.fireTick <= 0) {
      gear.fireTick = FIRE_TICK;
      const p = bot.mover.position;
      const fire = this.api.firesAt(p.x, p.y, p.z).find((f) => f.owner !== bot.id && this.isEnemyOf(bot, f.owner));
      if (fire) this.hurt(bot, FIRE_DAMAGE, fire.owner, false, 'molotov', arr(fire.center.x, fire.center.y, fire.center.z));
      if (!bot.alive) return;
    }
    this.tryPickup(bot);
    if (decided) this.useAbilities(bot);
  }

  /** Standing on something worth having: claim it (a transaction: only one player gets each). */
  private tryPickup(bot: HostedBot): void {
    const { gear } = bot;
    if (gear.claiming || this.carrying(bot)) return;
    const p = bot.mover.position;
    const rules = this.pickupRules();
    for (const k of this.api.pickups()) {
      if (Math.hypot(k.x - p.x, k.z - p.z) >= PICKUP_RADIUS || p.y >= k.y + 1.5 || p.y < k.y - 1) continue;
      if (!gear.wants(k.type, rules)) continue;
      gear.claiming = true;
      this.api.net.claimPickup(k.id)
        .then((record) => {
          if (!record) return;
          // Gone or dead in the meantime: put it back.
          if (!this.bots.has(bot.id) || !bot.alive) {
            this.api.net.spawnPickup(record);
            return;
          }
          const left = gear.take(record.type, record.uses);
          if (left) this.api.net.spawnPickup({ type: left, x: record.x, z: record.z });
          bot.gun = this.gunFor(bot);
          if (bot.gear.special && bot.gear.special.kind === bot.gun) bot.reloadLeft = 0;
        })
        .catch((err: unknown) => console.warn('Bot pickup failed', err))
        .finally(() => { gear.claiming = false; });
      return;
    }
  }

  /**
   * A worthwhile pickup close by, to fetch on the way. In CTF only one practically on the way, and none
   * while a flag is on the move (carried or lying loose: a carrier to escort or chase, a flag to race
   * for). One bot per pickup.
   */
  private detourFor(bot: HostedBot, ctf: CtfView | null): Point | null {
    if (this.carrying(bot) || (ctf && (ctf.own.at !== 'base' || ctf.enemy.at !== 'base'))) return null;
    const rules = this.pickupRules();
    const p = bot.mover.position;
    const taken = new Set([...this.bots.values()].filter((b) => b !== bot && b.detour).map((b) => b.detour));
    let best: { id: string; x: number; y: number; z: number } | null = null;
    let bestD = ctf ? CTF_DETOUR_RANGE : DETOUR_RANGE;
    // Hurt with nothing to heal with: a medkit is worth going further for (and comes first), except in CTF.
    const needsHealing = !ctf && bot.hp / this.api.rules().health < 0.5 && !bot.gear.has('medkit');
    for (const k of this.api.pickups()) {
      if (taken.has(k.id) || Math.abs(k.y - p.y) > 3 || !bot.gear.wants(k.type, rules)) continue;
      const medkit = needsHealing && k.type === 'medkit';
      const d = Math.hypot(k.x - p.x, k.z - p.z) * (medkit ? DETOUR_RANGE / MEDKIT_DETOUR : 1);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    bot.detour = best?.id ?? null;
    return best;
  }

  /**
   * Abilities, used the way a sensible player would: heal when hurt, shield or wall up under fire,
   * grenades at enemies out of easy reach, speed and cloak on a flag run, turrets and mines to hold a
   * base, a scan when nobody's been seen for a while. One at a time.
   */
  private useAbilities(bot: HostedBot): void {
    const { gear } = bot;
    const now = this.clock;
    if (now < gear.nextAbility || !bot.alive) return;
    const nowMs = now * 1000;
    const rules = this.api.rules();
    const hpFrac = bot.hp / rules.health;
    const eye = this.eye(bot);
    const memory = bot.brain.memory;
    // Enemies it knows about: seen this decision (visible) or in the last few seconds.
    const known: { id: string; x: number; y: number; z: number; d: number; visible: boolean }[] = [];
    for (const [id, m] of memory.seen) {
      if (now - m.t > MEMORY_TIME) continue;
      known.push({ id, x: m.x, y: m.y, z: m.z, d: Math.hypot(m.x - eye.x, m.z - eye.z), visible: now - m.t < 0.2 });
    }
    known.sort((a, b) => a.d - b.d);
    const visible = known.find((k) => k.visible) ?? null;
    const nearest = known[0] ?? null;
    const traveling = !nearest && now - memory.hurtAt > 2;
    const carrying = this.carrying(bot);
    const onGround = bot.mover.onGround;
    const defending = !!bot.goal && rules.base === 'ctf' && !!bot.team
      && Math.hypot(bot.goal.x - FLAG_BASES[bot.team].x, bot.goal.z - FLAG_BASES[bot.team].z) < 1
      && Math.hypot(eye.x - bot.goal.x, eye.z - bot.goal.z) < 6;
    const faceToward = (t: { x: number; z: number }) => { bot.yaw = Math.atan2(-(t.x - eye.x), -(t.z - eye.z)); };

    const tryUse = (type: AbilityType, when: boolean, act: () => boolean): boolean => {
      if (!when) return false;
      const slot = gear.ready(type, nowMs);
      if (slot < 0) return false;
      if (!act()) {
        // Couldn't (no room for a turret, nowhere to throw it): try again a little later.
        gear.nextAbility = now + 0.5;
        return false;
      }
      gear.use(slot, nowMs);
      gear.nextAbility = now + 1;
      return true;
    };

    const used =
      tryUse('medkit', hpFrac <= 0.45, () => { this.heal(bot, MEDKIT_HEAL); return true; })
      || tryUse('shield', !!visible && hpFrac <= 0.75 && gear.shieldHp <= 0, () => {
        gear.shieldHp = SHIELD_AMOUNT;
        gear.shieldUntil = now + SHIELD_DURATION;
        void this.api.net.sendStateAs(bot.id, { shield: true });
        return true;
      })
      || tryUse('wall', !!visible && visible.d < 25 && hpFrac <= 0.5 && onGround, () => {
        faceToward(visible!);
        return this.api.place('wall', this.actor(bot));
      })
      || tryUse('lifesteal', !!visible && gear.lifestealUntil <= now, () => { gear.lifestealUntil = now + LIFESTEAL_DURATION; return true; })
      || tryUse('flash', !!visible && visible.d > 8 && visible.d < 20 && !carrying, () => this.throwAt(bot, 'flash', visible!))
      || tryUse('grenade', !!nearest && nearest.d > 7 && nearest.d < 24 && !carrying, () => this.throwAt(bot, 'grenade', nearest!))
      || tryUse('molotov', !!visible && visible.d > 6 && visible.d < 20 && !carrying, () => this.throwAt(bot, 'molotov', visible!))
      || tryUse('smoke', !!visible && hpFrac <= 0.35, () => {
        // Between us and them, a few metres out.
        const t = { x: eye.x + (visible!.x - eye.x) * 0.3, y: visible!.y, z: eye.z + (visible!.z - eye.z) * 0.3 };
        return this.throwAt(bot, 'smoke', t);
      })
      || tryUse('turret', onGround && ((!!visible && visible.d < 22) || defending), () => {
        if (visible) faceToward(visible);
        return this.api.place('turret', this.actor(bot));
      })
      || tryUse('mine', onGround && defending && !nearest, () => this.api.place('mine', this.actor(bot)))
      || tryUse('scan', traveling && now - this.lastSeenAny(bot) > 6, () => this.scan(bot))
      || tryUse('speed', carrying || (traveling && bot.goalDist > 30), () => { gear.speedUntil = now + SPEED_DURATION; return true; })
      || tryUse('cloak', carrying || (traveling && bot.goalDist > 20 && rules.base === 'ctf'), () => {
        gear.cloakUntil = now + CLOAK_DURATION;
        void this.api.net.sendStateAs(bot.id, { cloak: true });
        return true;
      })
      || tryUse('dash', carrying && traveling && onGround && bot.goalDist > 12, () => { bot.mover.dash(bot.yaw, DASH_SPEED); return true; });
    void used;
  }

  /** When this bot last saw any enemy (on its clock), from its memory */
  private lastSeenAny(bot: HostedBot): number {
    let last = -Infinity;
    for (const m of bot.brain.memory.seen.values()) last = Math.max(last, m.t);
    return Math.max(last, bot.spawnedAt);
  }

  /** A scan pulse: every enemy within reach is known to the bot (as they are to a player, for a moment). */
  private scan(bot: HostedBot): boolean {
    const p = bot.mover.position;
    this.api.net.sendEventAs(bot.id, { type: 'scan', p: arr(p.x, p.y + 1, p.z), r: SCAN_RADIUS });
    for (const o of this.others(bot)) {
      if (!o.alive || !this.isEnemyOf(bot, o.id) || Math.hypot(o.x - p.x, o.z - p.z) > SCAN_RADIUS) continue;
      bot.brain.memory.seen.set(o.id, { x: o.x, y: o.y, z: o.z, stance: o.stance, t: this.clock });
    }
    return true;
  }

  /** Throw `kind` so it lands at `target`: try a few arcs and keep the closest (false if none gets near). */
  private throwAt(bot: HostedBot, kind: 'grenade' | 'smoke' | 'molotov' | 'flash', target: { x: number; y: number; z: number }): boolean {
    const eye = this.eye(bot);
    const yaw = Math.atan2(-(target.x - eye.x), -(target.z - eye.z));
    let best: [number, number, number] | null = null;
    let bestErr = Infinity;
    for (let pitch = -0.3; pitch <= 0.9; pitch += 0.15) {
      const dir = lookDir(yaw, pitch);
      const land = this.api.landing(kind, eye, dir);
      const err = Math.hypot(land.end.x - target.x, land.end.z - target.z);
      if (err < bestErr) {
        bestErr = err;
        best = dir;
      }
    }
    if (!best || bestErr > THROW_TOLERANCE) return false;
    bot.yaw = yaw;
    this.endCloak(bot);
    bot.gear.throws++;
    this.api.throwFor(bot.id, kind, eye, best);
    return true;
  }

  private actor(bot: HostedBot): BotActor {
    return {
      id: bot.id, pos: bot.mover.position, yaw: bot.yaw, onGround: bot.mover.onGround,
      color: bot.team ? TEAM_INFO[bot.team].color : this.api.colorFor(bot.id),
    };
  }

  /** Flashbangs going off: everyone looking their way is blinded for a while (we're the bots' eyes). */
  private updateFlashes(): void {
    const due = this.flashes.filter((f) => f.at <= this.clock);
    if (!due.length) return;
    this.flashes = this.flashes.filter((f) => f.at > this.clock);
    for (const f of due) {
      for (const bot of this.bots.values()) {
        if (!bot.alive) continue;
        const eye = this.eye(bot);
        const to = f.p.clone().setY(f.p.y + 0.25).sub(eye.clone().setY(eye.y - 0.3));
        const dist = to.length();
        if (dist > FLASH_RANGE || dist < 1e-3) continue;
        const dir = to.clone().divideScalar(dist);
        // Hidden behind something: nothing to see.
        const from = eye.clone().setY(eye.y - 0.3);
        if (this.api.wallDistance(from.x, from.y, from.z, dir.x, dir.y, dir.z, dist) < dist - 0.2) continue;
        const look = lookDir(bot.yaw, bot.pitch);
        const facing = look[0] * dir.x + look[1] * dir.y + look[2] * dir.z;
        const near = Math.pow(1 - dist / FLASH_RANGE, 0.6);
        const strength = near * (facing > 0.2 ? 0.55 + 0.45 * facing : 0.25);
        if (strength < 0.1) continue;
        bot.gear.blindUntil = Math.max(bot.gear.blindUntil, this.clock + 0.5 + FLASH_MAX * strength);
      }
    }
  }

  // ---------------------------------------------------------------- flags

  /** Take the enemy flag, return our own, or score: what a player's client does for them (game.ts updateFlags). */
  private updateFlags(bot: HostedBot): void {
    const team = bot.team;
    if (!team || bot.flagBusy) return;
    const { api } = this;
    const enemy = otherTeam(team);
    const me = bot.mover.position;
    const near = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - me.x, p.z - me.z) < FLAG_RADIUS && Math.abs(p.y - me.y) < 1.5;
    const g = api.game();
    const round = g.round;
    const guard = (next: GameState) => next.round === round && !next.ended;
    const spot = (t: Team) => {
      const at = placementOf(g.flags[t]);
      return at.at === 'carried' ? null : at.at === 'base' ? FLAG_BASES[t] : at;
    };

    const theirs = spot(enemy);
    if (theirs && near(theirs)) {
      this.flagTransaction(bot, (next) => {
        if (!guard(next) || next.flags[enemy]?.by) return false;
        next.flags[enemy] = { by: bot.id };
        return true;
      });
      return;
    }
    const ours = placementOf(g.flags[team]);
    if (ours.at === 'ground' && near(ours)) {
      this.flagTransaction(bot, (next) => {
        if (!guard(next) || placementOf(next.flags[team]).at !== 'ground') return false;
        delete next.flags[team];
        return true;
      });
      return;
    }
    if (!this.carrying(bot) || ours.at !== 'base' || !near(FLAG_BASES[team])) return;
    const limit = api.rules().limit;
    this.flagTransaction(bot, (next) => {
      if (!guard(next) || next.flags[enemy]?.by !== bot.id || placementOf(next.flags[team]).at !== 'base') return false;
      delete next.flags[enemy];
      const score = (next.score[team] ?? 0) + 1;
      next.score[team] = score;
      if (score >= limit) api.finishRound(next, team, TEAM_INFO[team].name, 'score');
      return true;
    }, () => {
      bot.captures++;
      void api.net.sendStateAs(bot.id, { captures: bot.captures });
    });
  }

  private flagTransaction(bot: HostedBot, change: (g: GameState) => boolean, onCommit?: () => void): void {
    bot.flagBusy = true;
    this.api.net.mutateGame(change)
      .then((committed) => { if (committed) onCommit?.(); })
      .catch((err: unknown) => console.warn('Bot flag update failed', err))
      .finally(() => { bot.flagBusy = false; });
  }

  // ---------------------------------------------------------------- search & destroy

  /** This S&D round as the bot's objective layer sees it */
  private sndView(bot: HostedBot): SndGoalView | null {
    const { api } = this;
    const s = api.rules().base === 'snd' ? api.game().snd : undefined;
    const sites = api.sites();
    if (!s || !sites || !bot.team) return null;
    const attacking = bot.team === s.atk;
    const b = bombPlacement(s.bomb);
    const bomb = !b ? null
      : b.at === 'carried' ? (attacking ? { at: 'carried' as const, carrier: b.carrier } : null)
        : b.at === 'planted' ? { at: 'planted' as const, x: b.x, y: b.y, z: b.z }
          : attacking ? { at: 'ground' as const, x: b.x, y: b.y, z: b.z } : null;
    // The attackers pick a site per round, the same for all of them.
    const target = (api.game().round * 3 + s.n) % 2 === 0 ? 'a' : 'b';
    return { attacking, sites, target, bomb, carrying: s.bomb.by === bot.id };
  }

  /** What a player's client does for them (game.ts updateBomb): pick the bomb up, plant it, defuse it. */
  private updateBomb(bot: HostedBot, s: SndRecord, dt: number): void {
    const { api } = this;
    if (!bot.team || !bot.alive || bot.flagBusy) return;
    const now = api.net.serverNow();
    const phase = phaseOf(s, now);
    const me = bot.mover.position;
    const b = bombPlacement(s.bomb);
    const round = api.game().round;
    const same = (next: GameState) => next.round === round && !next.ended && next.snd?.n === s.n && !next.snd.over;
    const near = (p: Point, r: number) => Math.hypot(p.x - me.x, p.z - me.z) < r && Math.abs(p.y - me.y) < 1.8;
    if (bot.team === s.atk) {
      if (b?.at === 'ground' && phase !== 'over' && near(b, BOMB_PICKUP_RADIUS)) {
        this.flagTransaction(bot, (next) => {
          if (!same(next) || next.snd!.bomb.by || next.snd!.bomb.plantedAt !== undefined) return false;
          next.snd!.bomb = { by: bot.id };
          return true;
        });
        return;
      }
      const sites = api.sites();
      const site = s.bomb.by === bot.id && phase === 'live' && sites ? siteAt(sites, me) : null;
      if (!site || !bot.mover.onGround) {
        bot.channel = 0;
        return;
      }
      bot.channel += dt;
      if (bot.channel < PLANT_TIME) return;
      bot.channel = 0;
      const spot = { x: r2(me.x), y: r2(api.groundBelow(me.x, me.y + 0.1, me.z)), z: r2(me.z) };
      this.flagTransaction(bot, (next) => {
        if (!same(next) || next.snd!.bomb.by !== bot.id || phaseOf(next.snd!, api.net.serverNow()) !== 'live') return false;
        next.snd!.bomb = { ...spot, site, plantedAt: api.net.serverNow(), planter: bot.id };
        return true;
      }, () => {
        bot.captures++;
        void api.net.sendStateAs(bot.id, { captures: bot.captures });
      });
      return;
    }
    if (phase !== 'planted' || b?.at !== 'planted' || !near(b, DEFUSE_RADIUS)) {
      bot.channel = 0;
      return;
    }
    bot.channel += dt;
    if (bot.channel < DEFUSE_TIME) return;
    bot.channel = 0;
    const team = bot.team;
    this.flagTransaction(bot, (next) => {
      if (!same(next) || phaseOf(next.snd!, api.net.serverNow()) !== 'planted') return false;
      if (decide(next.snd!, api.net.serverNow(), api.headcount())?.why === 'bomb') return false;
      api.endSndRound(next, team, 'defuse');
      return true;
    }, () => {
      bot.captures++;
      void api.net.sendStateAs(bot.id, { captures: bot.captures });
    });
  }

  /** Drop the bomb where the bot stands (it died or left). */
  private dropBomb(bot: HostedBot): Promise<unknown> {
    const { api } = this;
    if (api.rules().base !== 'snd' || api.game().snd?.bomb.by !== bot.id) return Promise.resolve();
    const p = bot.mover.position;
    const at = { x: r2(p.x), y: r2(api.groundBelow(p.x, p.y + 0.1, p.z)), z: r2(p.z) };
    return api.net.mutateGame((g) => {
      if (g.snd?.bomb.by !== bot.id) return false;
      g.snd.bomb = at;
      return true;
    }).catch((err: unknown) => console.warn('Could not drop the bot\'s bomb', err));
  }

  /** Drop the enemy flag where the bot stands (it died or left). */
  private dropFlag(bot: HostedBot): Promise<unknown> {
    if (!bot.team || !this.carrying(bot)) return Promise.resolve();
    const enemy = otherTeam(bot.team);
    const p = bot.mover.position;
    const at = { x: r2(p.x), y: r2(this.api.groundBelow(p.x, p.y + 0.1, p.z)), z: r2(p.z) };
    return this.api.net.mutateGame((g) => {
      if (g.flags[enemy]?.by !== bot.id) return false;
      g.flags[enemy] = at;
      return true;
    }).catch((err: unknown) => console.warn('Could not drop the bot\'s flag', err));
  }
}
