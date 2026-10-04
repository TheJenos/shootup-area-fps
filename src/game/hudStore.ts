import type { SlotView } from './abilities';
import type { GameMode, PlayerState, Team, WeaponKind } from '../types';

const FEED_LIFETIME = 5_000;
const FEED_MAX = 5;
const TOAST_LIFETIME = 1_800;

type Named = Pick<PlayerState, 'name' | 'color'>;

export type FeedEntry =
  | { id: number; kind: 'kill'; killer: Named; victim: Named; head: boolean; mine: boolean; weapon: WeaponKind }
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
  team: Team | null;
  me: boolean;
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

export type FlagStatus = { state: 'home' } | { state: 'dropped' } | { state: 'carried'; carrier: string; mine: boolean };

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

export interface MatchEnd {
  title: string;
  /** true/false when we're on the winning/losing side */
  won: boolean;
  /** Seconds until the next round */
  nextIn: number;
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
  ammo: number;
  magSize: number;
  reloading: boolean;
  /** `n` increments on every hit so the UI can restart the animation. */
  hitmarker: { n: number; head: boolean };
  /** Increments every time we take damage. */
  damageFlash: number;
  damageIndicators: DamageIndicator[];
  feed: FeedEntry[];
  scoreboardOpen: boolean;
  scoreboard: ScoreRow[];
  /** Set while we're dead. */
  death: { killerName: string; respawnIn: number } | null;
  /** The three ability slots */
  slots: (SlotView | null)[];
  /** Active timed effects; seconds / points left, rounded for display */
  buffs: { speed: number | null; shield: number | null };
  /** Short message near the slots, e.g. "Slots full"; `n` restarts the animation */
  toast: { n: number; text: string } | null;
  inventoryOpen: boolean;
  match: MatchInfo | null;
  myMatch: MyMatch;
  /** The arena's theme name and seed */
  map: { name: string; seed: string } | null;
  mode: GameMode;
  /** Our team, in team modes */
  team: Team | null;
  score: ScoreView;
  /** CTF only */
  flags: Record<Team, FlagStatus> | null;
  /** Set while the round-over screen is up */
  matchEnd: MatchEnd | null;
}

const initialState: HudState = {
  connecting: true,
  paused: false,
  hp: 100,
  ammo: 0,
  magSize: 0,
  reloading: false,
  hitmarker: { n: 0, head: false },
  damageFlash: 0,
  damageIndicators: [],
  feed: [],
  scoreboardOpen: false,
  scoreboard: [],
  death: null,
  slots: [null, null, null],
  buffs: { speed: null, shield: null },
  toast: null,
  inventoryOpen: false,
  match: null,
  myMatch: { pickups: 0, abilitiesUsed: 0, dropped: 0 },
  map: null,
  mode: 'ffa',
  team: null,
  score: { red: 0, blue: 0, mine: 0, leader: null },
  flags: null,
  matchEnd: null,
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

  pushKill(killer: Named, victim: Named, head: boolean, mine: boolean, weapon: WeaponKind = 'rifle'): void {
    this.pushFeed({ id: this.nextFeedId++, kind: 'kill', killer, victim, head, mine, weapon });
  }

  toast(text: string): void {
    const n = (this.state.toast?.n ?? 0) + 1;
    this.update({ toast: { n, text } });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state.toast?.n === n) this.update({ toast: null });
    }, TOAST_LIFETIME);
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
