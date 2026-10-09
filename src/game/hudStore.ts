import type { SlotView } from './abilities';
import { baseRules, type ModeRules } from './rules';
import type { SndPhase } from './snd';
import type { GameMode, GunKind, PlayerState, SndRecord, Team, WeaponKind } from '../types';
import type { MapSize, MapSpec } from './mapgen';

const FEED_LIFETIME = 5_000;
const FEED_MAX = 5;
const TOAST_LIFETIME = 1_800;
/** Toasts waiting their turn; older ones beyond this are dropped */
const TOAST_QUEUE_MAX = 3;
const ANNOUNCE_LIFETIME = 2_200;

type Named = Pick<PlayerState, 'name' | 'color' | 'bot'>;

export type FeedEntry =
  | {
    id: number; kind: 'kill'; killer: Named; victim: Named; head: boolean; mine: boolean; weapon: WeaponKind;
    /** Teams in team modes, and which side of the kill we were on (for tags that don't rely on colour) */
    killerTeam: Team | null; victimTeam: Team | null; me: 'killer' | 'victim' | null;
  }
  | { id: number; kind: 'info'; text: string };

export interface ScoreRow {
  id: string;
  name: string;
  color: string;
  kills: number;
  deaths: number;
  damage: number;
  /** 0..1, or null before the first shot */
  accuracy: number | null;
  headshots: number;
  bestStreak: number;
  captures: number;
  /** Round trip to the server in ms; null until measured */
  ping: number | null;
  team: Team | null;
  me: boolean;
  /** A bot (its name carries its level; the list shows a badge) */
  bot: boolean;
  /** Watching, not playing */
  spectating: boolean;
}

/** The score shown at the top of the screen. */
export interface ScoreView {
  /** Team modes: kills (TDM) or captures (CTF) per team */
  red: number;
  blue: number;
  /** FFA: our kills, and the best of everyone else */
  mine: number;
  leader: { name: string; kills: number } | null;
}

export type FlagStatus =
  | { state: 'home' }
  | { state: 'dropped'; returnIn: number }
  | { state: 'carried'; carrier: string; mine: boolean };

/** Search & Destroy: the round as the HUD shows it */
export interface SndView {
  /** From 1 */
  round: number;
  attackers: Team;
  /** We're on the attacking team */
  attacking: boolean;
  phase: SndPhase;
  /** Seconds on the clock that matters now (freeze, attack time or fuse) */
  left: number;
  /** Where the bomb is, as far as we know: defenders only learn where once it's planted */
  bomb: 'mine' | 'carried' | 'ground' | 'planted' | 'hidden';
  /** A teammate carrying it */
  carrier: string | null;
  /** 'A' or 'B' once planted */
  site: string | null;
  alive: Record<Team, { size: number; alive: number }>;
  /** Planting or defusing, 0..1 */
  channel: { kind: 'plant' | 'defuse'; progress: number } | null;
  /** What the interact key would do here */
  prompt: string | null;
  over: { winner: Team; why: NonNullable<SndRecord['over']>['why'] } | null;
  /** Out of this round, watching a teammate */
  watching: boolean;
}

/** A red arc around the crosshair pointing at whoever just hurt us. */
export interface DamageIndicator {
  /** The attacker (one arc each) */
  id: string;
  /** Degrees clockwise from straight ahead */
  angle: number;
  opacity: number;
  /** 0..1, how big the hit was */
  strength: number;
}

export interface MvpView {
  name: string;
  color: string;
  title: string;
  kills: number;
  deaths: number;
  captures: number;
  damage: number;
  me: boolean;
}

/** The round is over: first the results, then (if anyone stood out) the MVP replay. */
export interface MatchEnd {
  phase: 'results' | 'mvp';
  title: string;
  /** We're on the winning side */
  won: boolean;
  draw: boolean;
  reason: 'time' | 'score';
  /** Best three players of the round */
  top: { name: string; color: string; score: string }[];
  mvp: MvpView | null;
  /** Seconds until the next phase (the MVP replay, or the next map) */
  nextIn: number;
  /** Seconds until the next round starts, across both phases */
  nextMapIn: number;
  nextMap: { name: string; seed: string } | null;
}

export interface MatchInfo {
  roomName: string;
  /** Epoch ms when the room was created */
  startedAt: number;
}

/** Personal stats that only matter to this player, shown under the scoreboard. */
export interface MyMatch {
  pickups: number;
  abilitiesUsed: number;
  dropped: number;
}

export interface HudState {
  connecting: boolean;
  paused: boolean;
  hp: number;
  /** Full health in this mode (100 normally; custom modes change it) */
  maxHp: number;
  /** The room's mode rules: name, badge, limit, loadout… */
  rules: ModeRules;
  ammo: number;
  magSize: number;
  /** The gun in hand, its spare rounds (null = endless), and the picked-up gun if any */
  gun: GunKind;
  reserve: number | null;
  special: GunKind | null;
  /** Rounds left in the picked-up gun (shown in the inventory) */
  specialRounds: number | null;
  /** Looking through the sniper scope */
  scoped: boolean;
  /** Carrying the enemy flag: guns stowed, the flag is a melee weapon */
  melee: boolean;
  reloading: boolean;
  /** `n` increments on every hit so the UI can restart the animation. */
  hitmarker: { n: number; head: boolean };
  /** Increments every time we take damage. */
  damageFlash: number;
  /** Aiming down sights: the crosshair shrinks to a dot */
  aiming: boolean;
  damageIndicators: DamageIndicator[];
  feed: FeedEntry[];
  scoreboardOpen: boolean;
  scoreboard: ScoreRow[];
  /** Set while we're dead. */
  death: {
    killerName: string;
    /** Our own doing (e.g. our grenade) */
    self: boolean;
    weapon: WeaponKind;
    head: boolean;
    /** Something fell out of our hands where we died */
    dropped: boolean;
    /** Seconds; -1 = not until the next round (Search & Destroy) */
    respawnIn: number;
    /** Not dead: joined (or switched team) in the middle of an S&D round */
    late?: boolean;
  } | null;
  /** Watching the kill cam: who killed us, and how */
  killcam: { killerName: string; color: string; weapon: WeaponKind; head: boolean } | null;
  /** Increments when we come back from the dead (for a flash) */
  respawnFlash: number;
  /** Health given back for a kill; `n` restarts the "+50 HP" animation */
  heal: { n: number; amount: number } | null;
  /** An ability slot refused (cooldown): shake it; `n` restarts the animation */
  slotDenied: { n: number; slot: number } | null;
  /** The three ability slots */
  slots: (SlotView | null)[];
  /** Active timed effects; seconds / points left, rounded for display */
  buffs: { speed: number | null; shield: number | null; cloak: number | null; lifesteal: number | null; scan: number | null };
  /** Flashbang white-out: how strong (0..1) and how long it lasts (s); `n` restarts the fade */
  flash: { n: number; strength: number; seconds: number } | null;
  /** We're cloaked (the screen edges get a cool tint) */
  cloaked: boolean;
  /** Short message near the slots, e.g. "Slots full"; `n` restarts the animation */
  toast: { n: number; text: string } | null;
  inventoryOpen: boolean;
  match: MatchInfo | null;
  myMatch: MyMatch;
  /** The map being played */
  map: { name: string; seed: string; size: MapSize; spec: MapSpec } | null;
  /** This build can't play the room's map (another generator version): reload to update */
  mapError: string | null;
  mode: GameMode;
  /** Our team, in team modes */
  team: Team | null;
  /** Who owns the room (they can restart it with another mode or map); null until known */
  owner: { name: string; me: boolean } | null;
  score: ScoreView;
  /** CTF only */
  flags: Record<Team, FlagStatus> | null;
  /** Search & Destroy only */
  snd: SndView | null;
  /** Seconds left in the round; null before the round clock is known */
  clock: { left: number; urgent: boolean } | null;
  /** Set while the round-over screen is up */
  matchEnd: MatchEnd | null;
  /** Announcer banner (multi-kills, streaks); `n` restarts the animation, `ms` is how long it stays */
  announce: { n: number; text: string; sub: string; ms: number } | null;
  /** Watching the match: who we're following (null = free camera) and how many players there are to follow */
  spectate: { target: string | null; count: number } | null;
  /** Players in the match (not spectating), including us */
  playerCount: number;
  /** The connection to the server dropped; it reconnects by itself */
  offline: boolean;
  /** Standing on a gun: what the interact key would do with it ("Pick up Shotgun", "Swap Deagle for Shotgun") */
  gunPrompt: string | null;
}

const initialState: HudState = {
  connecting: true,
  paused: false,
  hp: 100,
  maxHp: 100,
  rules: baseRules('ffa'),
  ammo: 0,
  magSize: 0,
  gun: 'rifle',
  reserve: null,
  special: null,
  specialRounds: null,
  scoped: false,
  melee: false,
  reloading: false,
  hitmarker: { n: 0, head: false },
  damageFlash: 0,
  aiming: false,
  damageIndicators: [],
  feed: [],
  scoreboardOpen: false,
  scoreboard: [],
  death: null,
  killcam: null,
  respawnFlash: 0,
  heal: null,
  slotDenied: null,
  gunPrompt: null,
  slots: [null, null, null],
  buffs: { speed: null, shield: null, cloak: null, lifesteal: null, scan: null },
  flash: null,
  cloaked: false,
  toast: null,
  inventoryOpen: false,
  match: null,
  myMatch: { pickups: 0, abilitiesUsed: 0, dropped: 0 },
  map: null,
  mapError: null,
  mode: 'ffa',
  team: null,
  owner: null,
  score: { red: 0, blue: 0, mine: 0, leader: null },
  flags: null,
  snd: null,
  clock: null,
  matchEnd: null,
  announce: null,
  spectate: null,
  playerCount: 0,
  offline: false,
};

/**
 * Immutable HUD state written by the game engine and read by React through
 * `useSyncExternalStore`. Updates that don't change anything are dropped, so the
 * engine can call `update()` every frame without causing re-renders.
 */
export class HudStore {
  private state: HudState = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private nextFeedId = 1;
  private toastQueue: string[] = [];

  readonly get = (): HudState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<HudState>): void {
    const changed = (Object.keys(patch) as (keyof HudState)[]).some((k) => patch[k] !== this.state[k]);
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  hitmarker(head: boolean): void {
    this.update({ hitmarker: { n: this.state.hitmarker.n + 1, head } });
  }

  flashDamage(): void {
    this.update({ damageFlash: this.state.damageFlash + 1 });
  }

  pushKill(
    killer: Named, victim: Named, head: boolean, mine: boolean, weapon: WeaponKind = 'rifle',
    teams: { killerTeam: Team | null; victimTeam: Team | null; me: 'killer' | 'victim' | null } = { killerTeam: null, victimTeam: null, me: null },
  ): void {
    this.pushFeed({ id: this.nextFeedId++, kind: 'kill', killer, victim, head, mine, weapon, ...teams });
  }

  /**
   * Short message near the bottom of the screen. Toasts play one after another rather than
   * replacing each other; repeats of what's showing or already waiting are dropped.
   */
  toast(text: string): void {
    if (this.state.toast?.text === text || this.toastQueue.includes(text)) return;
    if (this.state.toast) {
      if (this.toastQueue.length < TOAST_QUEUE_MAX) this.toastQueue.push(text);
      return;
    }
    this.showToast(text);
  }

  private showToast(text: string): void {
    const n = (this.state.toast?.n ?? 0) + 1;
    this.update({ toast: { n, text } });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state.toast?.n !== n) return;
      this.update({ toast: null });
      const next = this.toastQueue.shift();
      if (next) this.showToast(next);
    }, TOAST_LIFETIME);
    this.timers.add(timer);
  }

  /** Drop whatever is showing and waiting (a new round starts). */
  clearToasts(): void {
    this.toastQueue = [];
    this.update({ toast: null });
  }

  /** Big centre-screen banner for a moment or two (`ms` for longer ones, like the intro). */
  announce(text: string, sub = '', ms = ANNOUNCE_LIFETIME): void {
    const n = (this.state.announce?.n ?? 0) + 1;
    this.update({ announce: { n, text, sub, ms } });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state.announce?.n === n) this.update({ announce: null });
    }, ms);
    this.timers.add(timer);
  }

  pushInfo(text: string): void {
    this.pushFeed({ id: this.nextFeedId++, kind: 'info', text });
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.listeners.clear();
  }

  private pushFeed(entry: FeedEntry): void {
    this.update({ feed: [entry, ...this.state.feed].slice(0, FEED_MAX) });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.update({ feed: this.state.feed.filter((e) => e.id !== entry.id) });
    }, FEED_LIFETIME);
    this.timers.add(timer);
  }
}
