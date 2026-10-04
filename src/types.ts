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
}

export type PlayerStats = Required<Pick<PlayerState, 'damage' | 'shots' | 'hits' | 'headshots' | 'streak' | 'best' | 'captures'>>;

export type Pose = Pick<PlayerState, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>;

export type Vec3Tuple = [number, number, number];

export interface ShotEvent {
  type: 'shot';
  /** Muzzle position */
  o: Vec3Tuple;
  /** Where the bullet stopped */
  e: Vec3Tuple;
  /** Id of the player that was hit, if any */
  hit?: string | null;
  dmg?: number;
  head?: boolean;
}

export type WeaponKind = 'rifle' | 'grenade';

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

/** The thrower's grenade exploded at `p`, dealing `hits[playerId]` damage. */
export interface BlastEvent {
  type: 'blast';
  id: string;
  p: Vec3Tuple;
  hits?: Record<string, number>;
}

export type OutgoingEvent = ShotEvent | KillEvent | GrenadeEvent | BlastEvent;

/** An event as stored in the database, stamped by the sender. */
export type GameEvent = OutgoingEvent & { from: string; t: number };

/** A room as shown in the lobby list. */
export interface RoomSummary {
  code: string;
  name: string;
  mode: GameMode;
  /** Map seed (see mapgen.ts) */
  seed: string;
  host: string;
  players: string[];
}

export interface LobbyRecord {
  name: string;
  /** Missing on rooms made before modes existed, which are free-for-all */
  mode?: GameMode;
  /** Map seed; missing on rooms made before seeds existed, which use the classic map */
  seed?: string;
  host: string;
  createdAt: number;
  members?: Record<string, string>;
}

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
  /** Set once someone reaches the score limit; the next round starts a few seconds later */
  ended?: { winner: string; name: string };
  /** Team modes: kills (TDM) or captures (CTF) */
  score?: Partial<Record<Team, number>>;
  flags?: Partial<Record<Team, FlagRecord>>;
}

/** A GameRecord with the parts Firebase may leave out filled in. */
export type GameState = GameRecord & Required<Pick<GameRecord, 'score' | 'flags'>>;

export type AbilityType = 'medkit' | 'shield' | 'speed' | 'dash' | 'grenade';

/** An ability lying on the map at rooms/{code}/pickups/{id}. */
export interface PickupRecord {
  type: AbilityType;
  x: number;
  z: number;
  /** Uses left, for abilities a player dropped; fresh pickups have the full amount */
  uses?: number;
}
