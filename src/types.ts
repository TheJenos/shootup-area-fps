import type { ModeRules } from './game/rules';
import type { MapSize, MapSpec } from './game/mapgen/spec';

/** A player's record at rooms/{code}/players/{id}. */
export interface PlayerState {
  name: string;
  color: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  /** Shield ability active (shown as a bubble to others) */
  shield?: boolean;
  /** Cloak ability active: others see only a faint shimmer (teammates a ghost) */
  cloak?: boolean;
  /** Crouching or sliding; missing means standing */
  stance?: Stance;
  /** The gun in hand (others see it); missing means the rifle */
  gun?: GunKind;
  /** Aiming down sights (others see the gun raised to the eye) */
  aim?: boolean;
  /** Reloading (others see the hand go to the magazine) */
  rl?: boolean;
  /** Counts up on every throw, so others play the throw animation */
  th?: number;
  /** Watching rather than playing: no body, no hitboxes, not in the standings */
  spec?: boolean;
  /** Team in TDM / CTF; absent in free-for-all */
  team?: Team;
  /** Match stats, reported by each player about themselves */
  damage?: number;
  shots?: number;
  hits?: number;
  headshots?: number;
  streak?: number;
  best?: number;
  /** Flags captured (CTF) */
  captures?: number;
  /** Round trip to the Firebase server in ms, measured by this player */
  ping?: number;
  /** This player's best highlight of the round, used to pick the MVP; null clears it */
  moment?: Moment | null;
}

/** A highlight, e.g. a triple kill. Times are server ms. */
export interface Moment {
  score: number;
  title: string;
  start: number;
  end: number;
}

/** The round's MVP, decided by whoever ended the round so everyone shows the same one. */
export interface MvpInfo {
  id: string;
  name: string;
  color: string;
  team?: Team;
  title: string;
  /** The highlight to replay (server ms); 0 when there's nothing to replay */
  start: number;
  end: number;
  kills: number;
  deaths: number;
  captures: number;
  damage: number;
}

export interface RoundEnd {
  /** A player id (FFA), a team, or 'draw' */
  winner: string;
  name: string;
  /** Missing on rounds ended before time limits existed */
  reason?: 'time' | 'score';
  /** When the round ended (server ms) */
  at?: number;
  /** The map for the next round (same size and generator version as this one) */
  nextSeed?: string;
  mvp?: MvpInfo;
}

export type PlayerStats = Required<Pick<PlayerState, 'damage' | 'shots' | 'hits' | 'headshots' | 'streak' | 'best' | 'captures'>>;

export type Stance = 'stand' | 'crouch' | 'slide';

export type Pose = Pick<PlayerState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'stance' | 'aim' | 'rl' | 'th'>;

export type Vec3Tuple = [number, number, number];

export interface ShotEvent {
  type: 'shot';
  /** Muzzle position */
  o: Vec3Tuple;
  /** Where the bullet stopped (the first pellet, for shotguns) */
  e: Vec3Tuple;
  /** Id of the player that was hit, if any */
  hit?: string | null;
  dmg?: number;
  head?: boolean;
  /** Gun that fired; missing means the rifle */
  w?: GunKind;
  /** Shotgun: where the other pellets stopped (for tracers) */
  ends?: Vec3Tuple[];
  /** Shotgun: total damage dealt to each player hit, replacing hit/dmg */
  hits?: Record<string, number>;
  /** Fired by the sender's turret with this id (the turret aims at `e`; damage counts as the turret's) */
  tur?: string;
  /** Damage done to barriers and turrets, by their id */
  dep?: Record<string, number>;
}

/** Guns a player can hold. The rifle is always carried; the others are picked up on the map. */
export type GunKind = 'rifle' | 'shotgun' | 'sniper' | 'deagle';

/** What can kill: a gun, a grenade, or the enemy flag swung as a club (CTF carriers) */
export type WeaponKind = GunKind | 'grenade' | 'flag' | 'molotov' | 'turret' | 'mine';

export interface KillEvent {
  type: 'kill';
  killer: string;
  victim: string;
  head: boolean;
  weapon?: WeaponKind;
}

/** A grenade was thrown; every client simulates the same arc from `o` and `v`. */
export interface GrenadeEvent {
  type: 'grenade';
  id: string;
  o: Vec3Tuple;
  v: Vec3Tuple;
}

/** A flag carrier swung the flag; `hit` took `dmg` (melee range only). */
export interface MeleeEvent {
  type: 'melee';
  /** Where the swing came from (the swinger's eyes) */
  o: Vec3Tuple;
  hit: string | null;
  dmg: number;
  head: boolean;
}

/** A smoke canister was thrown; it bursts where the same arc lands. */
export interface SmokeEvent {
  type: 'smoke';
  id: string;
  o: Vec3Tuple;
  v: Vec3Tuple;
}

/** A barrier was deployed at (x, y, z), spanning `axis`, until server ms `until`. */
export interface WallEvent {
  type: 'wall';
  id: string;
  x: number;
  y: number;
  z: number;
  axis: 'x' | 'z';
  until: number;
  /** Owner's colour */
  c: string;
}

/** The thrower's grenade exploded at `p`, dealing `hits[playerId]` damage. */
export interface BlastEvent {
  type: 'blast';
  id: string;
  p: Vec3Tuple;
  hits?: Record<string, number>;
  /** Set when a land mine (with this id) went off instead of a grenade */
  mine?: boolean;
  /** Damage done to barriers and turrets, by their id */
  dep?: Record<string, number>;
}

/** A molotov or flashbang was thrown; every client simulates the arc and sets it off where it lands. */
export interface ThrownEvent {
  type: 'molotov' | 'flash';
  id: string;
  o: Vec3Tuple;
  v: Vec3Tuple;
}

/** A turret was deployed at (x, y, z) until server ms `until`. Its owner's client aims and fires it. */
export interface TurretEvent {
  type: 'turret';
  id: string;
  x: number;
  y: number;
  z: number;
  /** Which way it starts facing */
  yaw: number;
  until: number;
  /** Owner's colour */
  c: string;
}

/** A land mine was put down at (x, y, z); it's live until server ms `until`. Its owner's client sets it off. */
export interface MineEvent {
  type: 'mine';
  id: string;
  x: number;
  y: number;
  z: number;
  until: number;
}

/** A scan pulse went out from `p` with radius `r`: enemies inside it are shown through walls. */
export interface ScanEvent {
  type: 'scan';
  p: Vec3Tuple;
  r: number;
}

export type OutgoingEvent =
  | ShotEvent | KillEvent | GrenadeEvent | BlastEvent | SmokeEvent | WallEvent | MeleeEvent | ThrownEvent | TurretEvent | ScanEvent | MineEvent;

/** An event as stored in the database, stamped by the sender. */
export type GameEvent = OutgoingEvent & { from: string; t: number };

/** A room as shown in the lobby list. */
export interface RoomSummary {
  code: string;
  name: string;
  mode: GameMode;
  /** The room's mode rules (prebuilt or custom) */
  rules: ModeRules;
  /** The map (see game/mapgen) */
  map: MapSpec;
  host: string;
  players: string[];
}

export interface LobbyRecord {
  name: string;
  /** Base mode. Older rooms may hold a legacy name ('sniper', 'gungame', …) mapped to a preset. */
  mode?: string;
  /** The mode's rules (see game/rules.ts); missing on rooms made before custom modes */
  rules?: ModeRules;
  /** Map seed; missing on rooms made before seeds existed, which use the classic map */
  seed?: string;
  /** Map size; missing on rooms made before sizes existed (medium) */
  size?: MapSize;
  /** Map generator version (GENERATOR_VERSION); missing on rooms made before versions existed (1) */
  gen?: number;
  host: string;
  /** The room owner's player id; missing on rooms made before owners existed */
  hostId?: string;
  createdAt: number;
  members?: Record<string, string>;
}

/** Base mode types; prebuilt and custom modes are rule sets on top (see game/rules.ts). */
export type GameMode = 'ffa' | 'tdm' | 'ctf';

export type Team = 'red' | 'blue';

/**
 * A team's flag at rooms/{code}/game/flags/{team}. Absent means it's at its base;
 * `by` means someone is carrying it; `x`/`z` means it's lying where its carrier died.
 */
export interface FlagRecord {
  by?: string;
  x?: number;
  y?: number;
  z?: number;
}

/** Round state at rooms/{code}/game, changed only through transactions. */
export interface GameRecord {
  /** Increments every time a new round starts */
  round: number;
  /** This round's map; changes every round */
  seed?: string;
  /** Map size and generator version, fixed for the room (see LobbyRecord) */
  size?: MapSize;
  gen?: number;
  /** Fingerprint of this round's map as the first client built it, to catch clients that differ */
  mapHash?: number;
  /** When this round started (server ms), for the time limit */
  startedAt?: number;
  /** Set at the time or score limit; results, the MVP replay, then the next round follow */
  ended?: RoundEnd;
  /** Team modes: kills (TDM) or captures (CTF) */
  score?: Partial<Record<Team, number>>;
  flags?: Partial<Record<Team, FlagRecord>>;
  /** The mode rules, once the owner has changed them mid-room; missing means the lobby's */
  rules?: ModeRules;
}

/** A GameRecord with the parts Firebase may leave out filled in. */
export type GameState = GameRecord & Required<Pick<GameRecord, 'score' | 'flags'>>;

export type AbilityType =
  | 'medkit' | 'shield' | 'speed' | 'dash' | 'grenade' | 'smoke' | 'wall' | 'cloak'
  | 'scan' | 'molotov' | 'flash' | 'turret' | 'lifesteal' | 'mine';

/** Things lying on the map: abilities, guns and ammo boxes */
export type PickupType = AbilityType | Exclude<GunKind, 'rifle'> | 'ammo';

/** An ability, a gun or an ammo box lying on the map at rooms/{code}/pickups/{id}. */
export interface PickupRecord {
  type: PickupType;
  x: number;
  z: number;
  /**
   * What's left in a dropped item: uses for abilities, rounds for guns. Fresh pickups have the
   * full amount.
   */
  uses?: number;
}
