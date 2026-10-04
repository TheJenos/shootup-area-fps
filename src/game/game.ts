import * as THREE from 'three';
import { ARENA_HALF, buildWorld, type World } from './world';
import { overRamp, rampHeightAt, type Ramp } from './ramps';
import { setRagdollWorld } from './ragdoll';
import { generateMap, normalizeSeed, randomSeed, CLASSIC_SEED } from './mapgen';
import { LocalPlayer } from './player';
import { RemotePlayer, type HitboxData } from './remotePlayer';
import { loadCharacter, type CharacterAsset } from './character';
import { Weapon, Effects } from './weapon';
import {
  HudStore, type DamageIndicator, type HudState, type MatchEnd, type MyMatch, type ScoreRow,
} from './hudStore';
import {
  ABILITIES, ABILITY_TYPES, Inventory, DASH_SPEED, GRENADE_DAMAGE, GRENADE_RADIUS, MEDKIT_HEAL,
  SHIELD_AMOUNT, SHIELD_DURATION, SPEED_DURATION, SPEED_MULTIPLIER,
} from './abilities';
import { MAX_AMMO_PICKUPS, MAX_GUN_PICKUPS, MAX_PICKUPS, PickupField, kindOf, type PickupKind } from './pickups';
import { SmokeField, WALL_DISTANCE, WALL_DURATION, WallField, type WallAxis } from './deployables';
import { GUNS, PICKUP_GUNS, isPickupGun, maxShotDamage, shotDamage } from './guns';
import { GrenadeFx, simulateGrenade, THROW_LIFT, THROW_SPEED } from './grenades';
import { FlagField, placementOf, type FlagPlacement } from './flags';
import {
  CLOCK_WARNING, FLAG_BASES, FLAG_RADIUS, FLAG_RETURN_TIME, GUN_GAME_LADDER, MELEE_COOLDOWN, MELEE_DAMAGE, MELEE_HEAD_DAMAGE,
  MELEE_RANGE, MODES, MVP_TIME, RESULTS_TIME, TEAMS, TEAM_INFO, gunGameGun, otherTeam, teamSpawns,
} from './modes';
import { MomentTracker } from './moments';
import { ReplayDirector, ReplayRecorder } from './replay';
import { RoomConnection, randomId } from '../net/network';
import { recordRound } from '../net/leaderboard';
import { baseRules, goalOf, type ModeRules } from './rules';
import * as sfx from './audio';
import { actionFor, keyFor, keyLabel, settings, type Action, type Quality } from './settings';
import { IN_DISCORD } from '../discord/patch';
import { setDiscordActivity } from '../discord/discord';
import { TOUCH } from './device';
import { StepTracker, type StepEvent } from './footsteps';
import { hints, type HintId } from './hints';
import type {
  GameEvent, GameMode, GameState, GunKind, MvpInfo, PickupRecord, PlayerState, PlayerStats, Pose, Team, Vec3Tuple, WeaponKind,
} from '../types';

const SEND_INTERVAL = 1 / 15;
const HEARTBEAT = 2;
/** Most damage one hit of each kind can deal; anything above that from another client is clamped. */
const maxDamage = (weapon: WeaponKind) =>
  (weapon === 'grenade' ? GRENADE_DAMAGE : weapon === 'flag' ? MELEE_HEAD_DAMAGE : maxShotDamage(weapon));
/** Dropped items land this far in front of the player */
const DROP_DISTANCE = 1.6;
const ABILITY_ACTIONS: Action[] = ['ability1', 'ability2', 'ability3'];
const UNKNOWN_PLAYER = { name: '?', color: '#888888' };
const EMPTY_STATS: PlayerStats = { damage: 0, shots: 0, hits: 0, headshots: 0, streak: 0, best: 0, captures: 0 };
const EMPTY_MY_MATCH: MyMatch = { pickups: 0, abilitiesUsed: 0, dropped: 0 };
/** Before trusting that a flag carrier has left, give the player list time to load */
const REFEREE_GRACE_MS = 3_000;
/** Other players' footsteps can't be heard further away than this (m) */
const STEP_HEARING_RANGE = 35;
/** How often we measure our ping (s) */
const PING_INTERVAL = 2;
/** How long a damage direction arc stays fully visible, then how long it takes to fade (s) */
const INDICATOR_HOLD = 0.6;
const INDICATOR_FADE = 1;
/** How often we record our own pose for the MVP replay (s) */
const RECORD_INTERVAL = 0.1;
/** Fraction of full health a kill gives back */
const KILL_HEAL = 0.5;
/** How hard a killing hit shoves the body, per weapon (m/s at the chest) */
const KNOCKBACK: Partial<Record<WeaponKind, number>> = { rifle: 3, deagle: 4, shotgun: 6, sniper: 6, grenade: 7, flag: 4.5 };

/** Fraction of full health at or below which the screen darkens at the edges and the heart pounds */
export const LOW_HEALTH = 0.3;
/** Resolution cap per graphics quality setting (device pixel ratio) */
const PIXEL_RATIO: Record<Quality, number> = { low: 1, medium: 1.5, high: 2 };
/** How often to check whether teammates are hidden behind cover (s) */
const ALLY_SIGHT_INTERVAL = 0.1;
/** Radians of turn per pixel of finger drag, at sensitivity 1 */
const TOUCH_LOOK = 0.0045;

export function colorFor(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = ((h >>> 8) * 0.618033988749895) % 1;
  return `#${new THREE.Color().setHSL(hue, 0.75, 0.55).getHexString()}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const toArr = (v: THREE.Vector3): Vec3Tuple => [r2(v.x), r2(v.y), r2(v.z)];
const fromArr = (a: Vec3Tuple) => new THREE.Vector3(a[0], a[1], a[2]);

/** Keyboard Lock API (Chrome / Edge, fullscreen only); not in TypeScript's DOM types yet. */
interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}
const keyboardLock = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

/**
 * Keys to take from the browser while playing fullscreen: every bound key (crouch is Ctrl, and
 * Ctrl+1 / Ctrl+Tab would switch tabs), plus the letters of tab / window shortcuts. Esc is left
 * alone so it still releases the mouse and leaves fullscreen.
 */
function keysToLock(): string[] {
  const keys = new Set<string>(Object.values(settings.get().bindings));
  for (const code of ['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'Tab']) keys.add(code);
  for (let d = 1; d <= 9; d++) keys.add(`Digit${d}`);
  keys.delete('Escape');
  return [...keys];
}

export interface GameOptions {
  /** Element the WebGL canvas is mounted into */
  host: HTMLElement;
  roomCode: string;
  playerId: string;
  name: string;
  /** Map seed; every client generates the same arena from it */
  seed: string;
  /** Leaderboard identity (finished rounds are added to it) */
  profileId: string;
}

export class Game {
  readonly roomCode: string;
  readonly playerId: string;
  readonly name: string;
  readonly hud = new HudStore();
  /** Phone / tablet: on-screen controls instead of mouse and keyboard */
  readonly touch = TOUCH;
  /** Our tint: unique per player in FFA, the team color otherwise */
  private color: string;
  joined = false;

  private readonly abort = new AbortController();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** The current map; rebuilt every round. The two arrays are filled in place. */
  private world!: World;
  private mapSeed = '';
  private readonly colliders: THREE.Box3[] = [];
  private readonly solids: THREE.Mesh[] = [];
  private readonly ramps: Ramp[] = [];
  private readonly obstacles: THREE.Box3[] = [];
  private readonly player: LocalPlayer;
  private readonly weapon: Weapon;
  private readonly effects: Effects;
  private readonly net: RoomConnection;
  private readonly raycaster = new THREE.Raycaster();
  private readonly timer = new THREE.Timer();

  private readonly remotes = new Map<string, RemotePlayer>();
  private readonly players: Record<string, PlayerState> = {};
  private hp = 100;
  /** The room's mode rules (base type plus loadout, pickups, health, speed…) */
  private rules: ModeRules = baseRules('ffa');
  private alive = true;
  private kills = 0;
  private deaths = 0;
  private respawnTimer = 0;
  private triggerHeld = false;
  /** Right mouse button: aim down sights (held, or toggled in settings) */
  private aimHeld = false;
  private allySightTimer = 0;
  private readonly sightRay = new THREE.Raycaster();
  private locked = false;
  private joinedAt = 0;
  private sendTimer = 0;
  private heartbeat = 0;
  private lastSent = '';
  private scoreTimer = 0;
  private disposed = false;
  private character: CharacterAsset | null = null;

  // Abilities
  private readonly inventory = new Inventory();
  private readonly pickups: PickupField;
  private readonly grenades: GrenadeFx;
  private readonly smoke: SmokeField;
  private readonly walls: WallField;
  /** Smoke canisters in the air (ours), waiting to land */
  private pendingSmokes: { id: string; at: number; p: THREE.Vector3 }[] = [];
  private dryToastAt = 0;
  /** How many things we've thrown this session (others animate the throw when it changes) */
  private throws = 0;
  private readonly losRay = new THREE.Raycaster();
  private claimingPickup: string | null = null;
  private fullToastFor: string | null = null;
  private spawnTimer = 1;
  private shieldHp = 0;
  private shieldUntil = 0;
  private speedUntil = 0;
  private pendingBlasts: { id: string; at: number; p: THREE.Vector3 }[] = [];
  private lastSlotsKey = '';
  /** A pickup we just dropped; ignored until we've moved away from where it landed */
  private ignorePickup: { id: string; x: number; z: number } | null = null;
  private inventoryOpen = false;

  // Match stats (synced so everyone's scoreboard can show them)
  private stats: PlayerStats = { ...EMPTY_STATS };
  private lastStatsKey = '';
  private myMatch: MyMatch = { ...EMPTY_MY_MATCH };

  // Game mode, teams and rounds
  private mode: GameMode = 'ffa';
  private team: Team | null = null;
  private game: GameState = { round: 0, score: {}, flags: {} };
  private gameLoaded = false;
  /** When the current round ended (server ms) */
  private endedAt = 0;
  private nextRoundRequested = -1;
  private timeUpRequested = -1;
  private clockFixRequested = -1;
  private lastScoreKey = '';
  // Capture the flag
  private flagField: FlagField | null = null;
  private flagBusy = false;
  private refereeBusy = false;
  private flagHomeToast = false;
  /** When each flag was dropped, as seen by this client, so it can be sent home after a while */
  private flagDroppedAt: Partial<Record<Team, number>> = {};

  // MVP: our own highlights, everything we saw this round, and the replay when it's on
  private readonly moments = new MomentTracker();
  private readonly recorder = new ReplayRecorder();
  private replay: ReplayDirector | null = null;
  private replayRound = -1;
  private recordTimer = 0;
  /** When we took the enemy flag, and kills since (for flag-run highlights) */
  private carry: { since: number; kills: number } | null = null;
  /** Who last dropped each team's flag, so killing the carrier still counts if the drop lands first */
  private lastDrop: Partial<Record<Team, { id: string; at: number }>> = {};

  // Footsteps
  private floorSurface: sfx.Surface = 'hard';
  private readonly steps = new StepTracker();
  private readonly remoteSteps = new Map<string, StepTracker>();

  /** Where recent hits came from, keyed by attacker */
  private readonly hitSources = new Map<string, { at: THREE.Vector3; time: number; damage: number }>();
  private lastIndicatorKey = '';

  /** Whose eyes we're watching through (spectating or the MVP replay), and their gun in our view */
  private pov: RemotePlayer | null = null;
  private readonly povWeapon: Weapon;

  // Spectating: following one player through their eyes, or flying free when there's nobody
  private spectating = false;
  private specTarget: string | null = null;
  private specFree = false;
  private readonly specPos = new THREE.Vector3();
  private specKey = '';

  /** Discord rich presence: what we last showed and when */
  private presenceKey = '';
  private presenceTimer = 0;

  /** Free-for-all: who's in the outright lead (null = nobody yet, or a tie), and whether we've looked yet */
  private ffaLeader: string | null = null;
  private leadKnown = false;

  /** Onboarding: the mode banner on the first click to play, and how long we've been sprinting (slide tip) */
  private introDone = false;
  private sprintFor = 0;
  private deniedAt = 0;
  private offline = false;

  /** Camera shake left from recent hits (0..1) and the low-health heartbeat timer */
  private shake = 0;
  private heartbeatTimer = 0;
  private roundBedOn = false;

  /** Our smoothed round trip to the server in ms */
  private ping: number | null = null;
  private pingTimer = 0;
  private pingInFlight = false;

  private readonly profileId: string;
  /** The last round we added to the leaderboard, so a round is never counted twice */
  private rankedRound = -1;

  constructor({ host, roomCode, playerId, name, seed, profileId }: GameOptions) {
    this.profileId = profileId;
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.name = name;
    this.color = colorFor(playerId);
    const signal = this.abort.signal;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);

    const aspect = host.clientWidth / host.clientHeight;
    this.camera = new THREE.PerspectiveCamera(settings.get().fov, aspect, 0.05, 300);
    this.scene.add(this.camera);

    this.loadMap(seed);
    this.applyQuality();
    signal.addEventListener('abort', settings.subscribe(() => this.applyQuality()), { once: true });
    this.player = new LocalPlayer(this.camera, this.colliders, this.ramps, signal);
    this.weapon = new Weapon(aspect);
    this.povWeapon = new Weapon(aspect);
    this.effects = new Effects(this.scene);
    this.pickups = new PickupField(this.scene, this.obstacles);
    // Dead bodies land on the current map (these arrays are refilled in place for each new map).
    setRagdollWorld(this.colliders, this.ramps);
    this.grenades = new GrenadeFx(this.scene);
    this.smoke = new SmokeField(this.scene);
    this.walls = new WallField(this.scene, this.colliders, this.solids);
    this.hud.update({ ammo: this.weapon.ammo, magSize: this.weapon.magSize });

    this.net = new RoomConnection(roomCode, playerId, {
      onPlayerAdded: (id, data) => this.onPlayerAdded(id, data),
      onPlayerChanged: (id, data) => this.onPlayerChanged(id, data),
      onPlayerRemoved: (id) => this.onPlayerRemoved(id),
      onEvent: (evt) => this.onEvent(evt),
      onPickupAdded: (id, pickup) => this.pickups.add(id, pickup),
      onPickupRemoved: (id) => this.pickups.remove(id),
      onGame: (game) => this.onGame(game),
      onConnection: (connected) => this.onConnection(connected),
    });

    this.bindInput(signal);
  }

  /** Build the arena for `seed`, replacing the current one. */
  private loadMap(seed: string): void {
    const map = generateMap(seed);
    this.world?.dispose();
    this.walls?.clear();
    this.world = buildWorld(this.scene, map, {
      colliders: this.colliders, solids: this.solids, ramps: this.ramps, obstacles: this.obstacles,
    });
    if (this.appliedQuality) this.world.setShadowQuality(this.appliedQuality);
    this.mapSeed = map.seed;
    this.floorSurface = map.theme.surface;
    this.hud.update({ map: { name: map.theme.name, seed: map.seed } });
  }

  /** Resolution and shadows from the quality setting; applied live when it changes. */
  private appliedQuality: Quality | null = null;
  private applyQuality(): void {
    const quality = settings.get().quality;
    if (quality === this.appliedQuality) return;
    this.appliedQuality = quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO[quality]));
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.needsUpdate = true;
    this.world.setShadowQuality(quality);
  }

  /** Capture the mouse (and go fullscreen) to start playing. Must be called from a user gesture. */
  requestPointerLock(): void {
    // Fullscreen first: it needs the click, and pointer lock doesn't once we're fullscreen.
    // Not inside Discord, which manages its own window.
    if (settings.get().fullscreen && !IN_DISCORD) this.enterFullscreen();
    if (this.touch) this.startTouchPlay();
    else this.lockPointer();
  }

  // ---------------------------------------------------------------- touch controls

  /** Touch devices have no pointer lock: "tap to play" just starts taking input. */
  private startTouchPlay(): void {
    if (!this.joined) return;
    this.locked = true;
    this.player.setEnabled(true);
    this.hud.update({ paused: false });
  }

  /** The on-screen menu button: back to the pause menu. */
  pauseTouchPlay(): void {
    this.locked = false;
    this.triggerHeld = false;
    this.aimHeld = false;
    this.weapon.releaseTrigger();
    this.player.setEnabled(false);
    this.hud.update({ paused: this.joined, scoreboardOpen: false });
  }

  /** Finger drag on the look area (or the fire button), in screen pixels. */
  touchLook(dx: number, dy: number): void {
    if (!this.locked) return;
    const { sensitivity, invertY } = settings.get();
    const scale = TOUCH_LOOK * sensitivity * this.player.lookScale;
    this.player.look(-dx * scale, -dy * scale * (invertY ? -1 : 1));
  }

  /** Move stick: x right, y forward, each -1..1; null when released. Pushed all the way forward sprints. */
  setTouchMove(move: { x: number; y: number } | null): void {
    this.player.touchMove = move;
    this.player.touchSprint = !!move && move.y > 0.75 && Math.hypot(move.x, move.y) > 0.92;
  }

  setTouchFire(down: boolean): void {
    if (down && this.locked && this.alive) {
      this.triggerHeld = true;
    } else {
      this.triggerHeld = false;
      this.weapon.releaseTrigger();
    }
  }

  toggleTouchAim(): void {
    if (this.locked) this.aimHeld = !this.aimHeld;
  }

  setTouchJump(down: boolean): void {
    this.player.touchJump = down;
  }

  /**
   * Crouch toggles. Tapped while sprinting it slides instead, and you're back on your feet
   * when the slide ends (like letting go of the crouch key).
   */
  tapTouchCrouch(): void {
    if (!this.locked) return;
    if (this.player.sprintHeld && this.player.stance === 'stand') {
      this.player.touchCrouch = true;
      setTimeout(() => { this.player.touchCrouch = false; }, 80);
      return;
    }
    this.player.touchCrouch = !this.player.touchCrouch;
  }

  get touchCrouched(): boolean {
    return this.player.touchCrouch;
  }

  touchReload(): void {
    if (this.alive && this.locked) this.weapon.reload();
  }

  touchAbility(slot: number): void {
    if (this.alive && this.locked) this.useAbility(slot);
  }

  setTouchScoreboard(open: boolean): void {
    this.hud.update({ scoreboardOpen: open, ...(open ? { scoreboard: this.scoreRows() } : {}) });
  }

  /**
   * Discord's iframe may refuse pointer lock. Then aim with the free cursor instead (hidden over
   * the game; look follows mouse movement, though it stops at the edge of the window). Esc pauses.
   */
  private freeMouse = false;
  private enterFreeMouse(): void {
    if (this.freeMouse || this.locked || !this.joined) return;
    this.freeMouse = true;
    this.locked = true;
    this.player.setEnabled(true);
    this.renderer.domElement.style.cursor = 'none';
    this.hud.update({ paused: false });
  }
  private exitFreeMouse(): void {
    if (!this.freeMouse) return;
    this.freeMouse = false;
    this.locked = false;
    this.triggerHeld = false;
    this.aimHeld = false;
    this.player.setEnabled(false);
    this.renderer.domElement.style.cursor = '';
    this.hud.update({ paused: this.joined && !this.inventoryOpen });
  }

  private lockPointer(): void {
    if (document.pointerLockElement === this.renderer.domElement) return;
    // Browsers throttle re-locking right after Esc; older ones return void instead of a promise.
    const result = this.renderer.domElement.requestPointerLock() as Promise<void> | undefined;
    // Browsers refuse a lock for about a second after Esc; the click looks like it did nothing otherwise.
    result?.catch(() => { if (!IN_DISCORD) this.hud.toast('Click again to resume'); });
  }

  /**
   * Fullscreen, then ask the browser to hand us our keys even with Ctrl / Cmd held, so crouching
   * (Ctrl) plus W, 1, Tab... can't close or switch the tab mid-game. Keyboard Lock only works in
   * fullscreen and only in Chrome / Edge; elsewhere the "leave site?" prompt is the safety net.
   */
  private enterFullscreen(): void {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        if (this.touch) {
          // Phones: hold the screen in landscape (Android; iOS can't, so the HUD asks to rotate).
          const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
          return orientation.lock?.('landscape').catch(() => {});
        }
        // Entering fullscreen can cancel a pointer lock that was requested in the same click.
        this.lockPointer();
        return keyboardLock()?.lock(keysToLock());
      })
      .catch(() => { /* refused or unsupported: play windowed */ });
  }

  private bindInput(signal: AbortSignal): void {
    const canvas = this.renderer.domElement;

    window.addEventListener('resize', () => this.resize(), { signal });

    document.addEventListener('pointerlockerror', () => {
      if (IN_DISCORD) this.enterFreeMouse();
      else if (!this.touch) this.hud.toast('Click again to resume');
    }, { signal });
    document.addEventListener('pointerlockchange', () => {
      if (this.freeMouse) return;
      this.locked = document.pointerLockElement === canvas;
      this.player.setEnabled(this.locked);
      if (!this.locked) {
        this.triggerHeld = false;
        this.aimHeld = false;
      }
      if (this.locked && this.inventoryOpen) this.closeInventory(false);
      this.hud.update({ paused: !this.locked && this.joined && !this.inventoryOpen });
    }, { signal });
    canvas.addEventListener('click', () => { if (!this.locked) this.requestPointerLock(); }, { signal });

    // On a Mac, Ctrl+click is a right-click; crouching (Ctrl) and shooting must still shoot.
    const isFire = (e: MouseEvent) => e.button === 0 || (e.button === 2 && e.ctrlKey);
    window.addEventListener('mousedown', (e) => {
      if (this.spectating) {
        if (this.locked && (e.button === 0 || e.button === 2)) this.cycleSpectate(e.button === 0 ? 1 : -1);
        return;
      }
      if (isFire(e) && this.locked) this.triggerHeld = true;
      else if (e.button === 2 && this.locked) this.aimHeld = settings.get().aimToggle ? !this.aimHeld : true;
    }, { signal });
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); }, { signal });
    // Mouse wheel switches guns too (one switch per flick).
    let lastWheel = 0;
    window.addEventListener('wheel', (e) => {
      if (!this.locked || Math.abs(e.deltaY) < 1) return;
      const now = performance.now();
      if (now - lastWheel > 250) this.switchGun();
      lastWheel = now;
    }, { signal, passive: true });
    // Rebinding keys mid-game: lock the new set.
    signal.addEventListener('abort', settings.subscribe(() => {
      if (document.fullscreenElement) keyboardLock()?.lock(keysToLock()).catch(() => {});
    }), { once: true });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2 && !e.ctrlKey && !settings.get().aimToggle) this.aimHeld = false;
      if (isFire(e)) {
        this.triggerHeld = false;
        this.weapon.releaseTrigger();
      }
    }, { signal });

    window.addEventListener('keydown', (e) => {
      // Ctrl+W / Cmd+W would close the tab. This only reaches us while the key is locked (see enterFullscreen).
      if (e.code === 'KeyW' && (e.ctrlKey || e.metaKey)) e.preventDefault();
      // While playing, Ctrl means crouch: stop Ctrl+S (save), Ctrl+D (bookmark), Ctrl+A, Ctrl+R...
      if (this.locked && e.ctrlKey && !e.metaKey) e.preventDefault();
      const action = actionFor(e.code);
      // Keep bound keys (Tab, Space, ...) from also moving focus or scrolling the page.
      if (action && this.locked) e.preventDefault();
      if (action === 'scoreboard') {
        e.preventDefault();
        this.hud.update({ scoreboardOpen: true, scoreboard: this.scoreRows() });
      }
      if (action === 'reload' && this.alive && this.locked) this.weapon.reload();
      if (action === 'swap' && !e.repeat && this.locked) this.switchGun();
      const slot = action ? ABILITY_ACTIONS.indexOf(action) : -1;
      if (slot >= 0 && !e.repeat && this.alive && this.locked) this.useAbility(slot);
      if (action === 'inventory' && !e.repeat) {
        if (this.inventoryOpen) this.closeInventory(true);
        else this.openInventory();
      }
      if (e.code === 'Escape' && this.inventoryOpen) this.closeInventory(false);
      else if (e.code === 'Escape') this.exitFreeMouse();
    }, { signal });
    window.addEventListener('keyup', (e) => {
      if (actionFor(e.code) === 'scoreboard') this.hud.update({ scoreboardOpen: false });
    }, { signal });

    // Closing or reloading the tab mid-game (e.g. a stray Ctrl+W) asks first. Leaving through
    // the menu doesn't, because the game is disposed (and this listener removed) before that.
    window.addEventListener('beforeunload', (e) => {
      // Inside Discord, closing the Activity must never be held up by a prompt.
      if (!this.joined || IN_DISCORD) return;
      e.preventDefault();
      e.returnValue = '';
    }, { signal });
  }

  async start(): Promise<void> {
    this.hud.update({ connecting: true, paused: false });
    this.renderer.setAnimationLoop(() => this.frame());

    // Remote players are built as soon as we join, so the model has to be ready first.
    const [character, info] = await Promise.all([
      loadCharacter(),
      this.net.roomInfo().catch((err: unknown) => {
        console.warn('Could not load room info', err);
        return null;
      }),
    ]);
    this.character = character;
    if (this.disposed) return;
    this.rules = info?.rules ?? baseRules('ffa');
    this.mode = this.rules.base;
    this.applyRules();
    this.applyLoadout();
    if (MODES[this.mode].teams) this.setTeam(await this.pickTeam());
    if (this.mode === 'ctf') this.flagField = new FlagField(this.scene);
    if (info) this.hud.update({ match: { roomName: info.name, startedAt: info.createdAt } });
    this.hud.update({ mode: this.mode, rules: this.rules });
    if (this.disposed) return;

    const spawn = this.pickSpawn();
    this.player.teleport(spawn, Math.atan2(spawn.x, spawn.z));
    await this.net.join(() => this.fullState());
    if (this.disposed) return;

    this.joined = true;
    this.joinedAt = performance.now();
    this.hud.update({ connecting: false, paused: !this.locked });
  }

  /** Join whichever team is smaller. */
  private async pickTeam(): Promise<Team> {
    const players = Object.values(await this.net.players().catch(() => ({})));
    const count = (t: Team) => players.filter((p) => p.team === t).length;
    const red = count('red');
    const blue = count('blue');
    if (red === blue) return Math.random() < 0.5 ? 'red' : 'blue';
    return red < blue ? 'red' : 'blue';
  }

  private setTeam(team: Team): void {
    this.team = team;
    this.color = TEAM_INFO[team].color;
    this.hud.update({ team });
  }

  // ---------------------------------------------------------------- spectating

  get isSpectating(): boolean {
    return this.spectating;
  }

  /** Step out of the match and watch: no body, no hitboxes, not in the standings. */
  startSpectating(): void {
    if (this.spectating || !this.joined) return;
    this.spectating = true;
    this.specFree = false;
    this.specTarget = null;
    void this.dropFlag();
    this.clearAbilities();
    this.weapon.releaseTrigger();
    this.triggerHeld = false;
    this.aimHeld = false;
    this.alive = false;
    this.hp = 0;
    this.respawnTimer = 0;
    this.hitSources.clear();
    this.specPos.copy(this.camera.position);
    this.hud.update({ death: null, hp: 0 });
    void this.net.sendState({ alive: false, hp: 0, spec: true, shield: false });
    this.cycleSpectate(1);
    this.hud.toast(this.touch ? 'Spectating · tap: next player' : 'Spectating · click: next player · right-click: previous');
  }

  /** Back into the fight: respawn as usual. */
  stopSpectating(): void {
    if (!this.spectating) return;
    this.spectating = false;
    this.specTarget = null;
    this.specKey = '';
    this.pov?.setFirstPerson(false);
    this.pov = null;
    this.hud.update({ spectate: null });
    void this.net.sendState({ spec: false });
    this.respawn();
  }

  /** The players we can follow: everyone alive who isn't spectating themselves. */
  private spectatable(): string[] {
    return [...this.remotes.entries()]
      .filter(([id, r]) => r.alive && !this.players[id]?.spec)
      .map(([id]) => id)
      .sort();
  }

  /** Follow the next (or previous) player. */
  private cycleSpectate(step: 1 | -1): void {
    const ids = this.spectatable();
    if (!ids.length) {
      this.specTarget = null;
      this.specFree = true;
      return;
    }
    this.specFree = false;
    const i = this.specTarget ? ids.indexOf(this.specTarget) : -1;
    this.specTarget = ids[((i < 0 ? (step > 0 ? -1 : 0) : i) + step + ids.length) % ids.length] ?? null;
  }

  /**
   * Watch through the eyes of whoever we're following (see applyPov); with nobody to follow,
   * fly free on the movement keys.
   */
  private updateSpectator(dt: number): void {
    const target = this.specTarget ? this.remotes.get(this.specTarget) : null;
    if (this.specTarget && (!target || !target.alive || this.players[this.specTarget]?.spec)) {
      this.cycleSpectate(1);
      return;
    }
    // Someone to watch again after flying around alone: go back to their eyes.
    if (this.specFree && this.spectatable().length) this.cycleSpectate(1);
    const cam = this.camera;
    if (target && !this.specFree) {
      this.specPos.copy(target.eyePosition());
    } else {
      // Free camera: look with the mouse, fly with the movement keys (sprint for speed).
      const k = this.player.keys;
      const held = (a: Action) => (k.has(settings.get().bindings[a]) ? 1 : 0);
      const forward = held('forward') - held('back');
      const strafe = held('right') - held('left');
      // E / jump climbs, crouch descends.
      const rise = (k.has('KeyE') || held('jump') ? 1 : 0) - held('crouch');
      const speed = (held('sprint') ? 24 : 11) * dt;
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      this.specPos.addScaledVector(dir, forward * speed).addScaledVector(right, strafe * speed);
      this.specPos.y = THREE.MathUtils.clamp(this.specPos.y + rise * speed, 0.5, 60);
      this.specPos.x = THREE.MathUtils.clamp(this.specPos.x, -ARENA_HALF, ARENA_HALF);
      this.specPos.z = THREE.MathUtils.clamp(this.specPos.z, -ARENA_HALF, ARENA_HALF);
      cam.position.copy(this.specPos);
      cam.rotation.set(this.player.pitch, this.player.yaw, 0);
    }
    const view = { target: target && !this.specFree ? target.name : null, count: this.spectatable().length };
    const key = JSON.stringify(view);
    if (key !== this.specKey) {
      this.specKey = key;
      this.hud.update({ spectate: view });
    }
  }

  /** Move to the other team (pause menu). Respawns at the new team's side. */
  switchTeam(): void {
    if (!this.team || !this.joined) return;
    void this.dropFlag();
    this.setTeam(otherTeam(this.team));
    void this.net.sendState({ team: this.team, color: this.color });
    this.hud.toast(`Joined ${TEAM_INFO[this.team].name} team`);
    if (this.alive) this.respawn();
  }

  /** A teammate (never ourselves). Teammates can't hurt each other. */
  private isAlly(id: string): boolean {
    return !!this.team && id !== this.playerId && this.players[id]?.team === this.team;
  }

  /** The player with the lowest id runs shared chores (pickups, flag returns). */
  private isLeader(): boolean {
    return Object.keys(this.players).sort()[0] === this.playerId;
  }

  /** Fighting is paused while the round-over screen is up. */
  private get roundOver(): boolean {
    return !!this.game.ended;
  }

  private fullState(): PlayerState {
    return {
      name: this.name,
      color: this.color,
      ...(this.team ? { team: this.team } : {}),
      gun: this.weapon.gun,
      ...this.poseState(),
      hp: Math.max(0, this.hp),
      alive: this.alive,
      kills: this.kills,
      deaths: this.deaths,
      ...this.stats,
    };
  }

  private poseState(): Pose {
    const p = this.player.position;
    return {
      x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r3(this.player.yaw), pitch: r3(this.player.pitch), stance: this.player.stance,
      aim: this.player.aiming, rl: this.weapon.reloading, th: this.throws,
    };
  }

  // ---------------------------------------------------------------- network

  private onPlayerAdded(id: string, data: PlayerState): void {
    this.players[id] = data;
    if (id === this.playerId) return;
    if (!this.character) return;
    this.remotes.get(id)?.dispose();
    const remote = new RemotePlayer(id, data, this.scene, this.character);
    remote.setVisible(!data.spec && !this.replay);
    this.remotes.set(id, remote);
    if (this.joined && performance.now() - this.joinedAt > 1000) this.hud.pushInfo(`${data.name} joined`);
  }

  private onPlayerChanged(id: string, data: PlayerState): void {
    this.players[id] = data;
    if (id === this.playerId) {
      // Kills are incremented by our victims, so take them from the server copy.
      const kills = data.kills || 0;
      if (kills > this.kills) {
        this.stats.streak += kills - this.kills;
        this.stats.best = Math.max(this.stats.best, this.stats.streak);
        if (this.rules.loadout === 'gungame') this.gunGameLevelUp(kills);
      }
      this.kills = kills;
      return;
    }
    const remote = this.remotes.get(id);
    remote?.setData(data);
    if (remote && !this.replay) remote.setVisible(!data.spec);
    if (!data.spec) this.recorder.pose(id, data, this.net.serverNow());
  }

  private onPlayerRemoved(id: string): void {
    if (id === this.playerId) return; // presence is re-registered when the connection recovers
    const remote = this.remotes.get(id);
    if (remote) {
      this.hud.pushInfo(`${this.players[id]?.name || 'Someone'} left`);
      remote.dispose();
      this.remotes.delete(id);
    }
    this.remoteSteps.delete(id);
    delete this.players[id];
  }

  private onEvent(evt: GameEvent): void {
    // Server timestamp of the event, for the replay recording.
    const t = typeof evt.t === 'number' ? evt.t : this.net.serverNow();
    if (evt.type === 'shot' && evt.from !== this.playerId && evt.o && evt.e) {
      this.recorder.event({
        t, kind: 'shot', o: evt.o, e: evt.e, hit: !!(evt.hit || evt.hits), from: evt.from,
        ...(evt.w ? { w: evt.w } : {}), ...(evt.ends ? { ends: evt.ends } : {}),
      });
    } else if (evt.type === 'grenade' && evt.from !== this.playerId) {
      this.recorder.event({ t, kind: 'grenade', id: evt.id, o: evt.o, v: evt.v });
    } else if (evt.type === 'blast' && evt.from !== this.playerId) {
      this.recorder.event({ t, kind: 'blast', id: evt.id, p: evt.p });
    } else if (evt.type === 'smoke' && evt.from !== this.playerId) {
      this.recorder.event({ t, kind: 'smoke', id: evt.id, o: evt.o, v: evt.v });
    } else if (evt.type === 'kill') {
      this.recorder.event({ t, kind: 'kill', killer: evt.killer, victim: evt.victim, head: evt.head });
    }

    if (evt.type === 'shot') {
      if (evt.from === this.playerId || !evt.o || !evt.e) return;
      this.remotes.get(evt.from)?.noteShot();
      const origin = fromArr(evt.o);
      const gun = evt.w && evt.w in GUNS ? evt.w : 'rifle';
      for (const e of [evt.e, ...(evt.ends ?? [])]) {
        const end = fromArr(e);
        this.effects.tracer(origin, end, 0xffa27a);
        this.effects.impact(end, evt.hit || evt.hits ? 0xff3b3b : 0xffc35c);
      }
      const dist = origin.distanceTo(this.camera.position);
      sfx.playShot(1 / (1 + dist / 10), gun);
      // Shotguns send damage per player hit; everything else a single hit.
      const pellets = evt.hits?.[this.playerId];
      if (pellets) this.takeDamage(pellets, evt.from, false, gun, origin);
      else if (evt.hit === this.playerId) this.takeDamage(evt.dmg, evt.from, !!evt.head, gun, origin);
    } else if (evt.type === 'grenade') {
      if (evt.from === this.playerId) return;
      this.grenades.launch(evt.id, simulateGrenade(fromArr(evt.o), fromArr(evt.v), this.world.colliders));
    } else if (evt.type === 'melee') {
      if (evt.from === this.playerId || !evt.o) return;
      const origin = fromArr(evt.o);
      const heard = this.heardFrom(origin);
      if (heard) sfx.playSwing(heard.volume * 1.6, heard.pan);
      if (evt.hit === this.playerId) {
        sfx.playMeleeHit(0.9);
        this.takeDamage(evt.dmg, evt.from, !!evt.head, 'flag', origin);
      }
    } else if (evt.type === 'smoke') {
      if (evt.from === this.playerId) return;
      const arc = simulateGrenade(fromArr(evt.o), fromArr(evt.v), this.world.colliders);
      this.grenades.launch(evt.id, arc);
      this.pendingSmokes.push({ id: evt.id, at: performance.now() + arc.duration * 1000, p: arc.end });
    } else if (evt.type === 'wall') {
      if (evt.from === this.playerId) return;
      const color = new THREE.Color(this.players[evt.from]?.color ?? evt.c ?? '#6fa8ff').getHex();
      this.walls.place(evt.id, evt.x, evt.y, evt.z, evt.axis, evt.until, color);
      sfx.playAbility();
    } else if (evt.type === 'blast') {
      if (evt.from === this.playerId) return;
      const at = fromArr(evt.p);
      this.grenades.explode(evt.id, at, GRENADE_RADIUS);
      this.liftBodies(at);
      sfx.playExplosion(1 / (1 + at.distanceTo(this.camera.position) / 12));
      const dmg = evt.hits?.[this.playerId];
      if (dmg) this.takeDamage(dmg, evt.from, false, 'grenade', at);
    } else if (evt.type === 'kill') {
      this.shoveBody(evt.victim, evt.killer, evt.head, evt.weapon ?? 'rifle');
      const victim = this.players[evt.victim] ?? UNKNOWN_PLAYER;
      // No killer means they took themselves out (their own grenade): name them on both sides.
      const killer = evt.killer ? this.players[evt.killer] ?? UNKNOWN_PLAYER : victim;
      const mine = evt.killer === this.playerId || evt.victim === this.playerId;
      const teamOf = (id: string) => (id === this.playerId ? this.team : this.players[id]?.team) ?? null;
      this.hud.pushKill(killer, victim, evt.head, mine, evt.weapon ?? 'rifle', {
        killerTeam: teamOf(evt.killer),
        victimTeam: teamOf(evt.victim),
        me: evt.victim === this.playerId ? 'victim' : evt.killer === this.playerId ? 'killer' : null,
      });
      if (evt.killer === this.playerId && evt.victim !== this.playerId) {
        sfx.playKill();
        this.healForKill();
        this.onOwnKill(evt.victim, evt.head, t);
      }
    }
  }

  /** Modes that decide what you hold: the Gun Game ladder starts on its first gun, Sniper Only is snipers. */
  private applyLoadout(): void {
    const { loadout } = this.rules;
    if (loadout === 'gungame') this.weapon.setForcedGun(gunGameGun(0));
    else if (loadout !== 'standard') this.weapon.setForcedGun(loadout);
  }

  /** The mode's movement, gravity and health (custom mode rules). */
  private applyRules(): void {
    this.player.speedScale = this.rules.speed;
    this.player.gravityScale = this.rules.gravity;
    this.hp = this.rules.health;
    this.hud.update({ hp: this.hp, maxHp: this.rules.health });
  }

  /** Gun Game: a kill hands us the next gun on the ladder. */
  private gunGameLevelUp(kills: number): void {
    const gun = gunGameGun(kills);
    if (gun === this.weapon.gun && kills < GUN_GAME_LADDER.length) return;
    if (kills >= GUN_GAME_LADDER.length) return;
    this.weapon.setForcedGun(gun);
    this.aimHeld = false;
    const left = GUN_GAME_LADDER.length - kills;
    this.hud.toast(`Level ${kills + 1}: ${GUNS[gun].name} · ${left} to go`);
    sfx.playSwitch();
  }

  /** A grenade went off: bodies lying close by get thrown (the living ones are handled by damage). */
  private liftBodies(at: THREE.Vector3): void {
    for (const r of this.remotes.values()) {
      if (!r.alive && r.position.distanceTo(at) < GRENADE_RADIUS * 1.2) r.knockback(at, 9, false, true);
    }
  }

  /** A kill: push the victim's body away from the killer, harder for heavy guns (ragdoll). */
  private shoveBody(victimId: string, killerId: string, head: boolean, weapon: WeaponKind): void {
    const body = this.remotes.get(victimId);
    if (!body) return;
    const from = killerId === this.playerId ? this.player.position : this.remotes.get(killerId)?.position;
    if (!from || killerId === victimId) return;
    body.knockback(from, KNOCKBACK[weapon] ?? 3, head, weapon === 'grenade');
  }

  /** Connection dropped or came back: tell the player, and hold pose updates while offline. */
  private onConnection(connected: boolean): void {
    if (!this.joined || this.offline === !connected) return;
    this.offline = !connected;
    this.hud.update({ offline: this.offline });
    this.hud.pushInfo(connected ? 'Back online' : 'Connection lost');
  }

  /** Show a tip once per browser. */
  private hint(id: HintId, text: () => string): void {
    if (hints.once(id)) this.hud.toast(text());
  }

  /** Every kill gives back half of full health (never above full), as a reward for winning the fight. */
  private healForKill(): void {
    if (!this.alive || this.roundOver) return;
    const max = this.rules.health;
    const amount = Math.min(Math.round(max * KILL_HEAL), max - this.hp);
    if (amount <= 0) return;
    this.hp += amount;
    this.hud.update({ hp: this.hp, heal: { n: (this.hud.get().heal?.n ?? 0) + 1, amount } });
    void this.net.sendState({ hp: this.hp });
  }

  /** Feed our kills into the highlight tracker. */
  private onOwnKill(victim: string, head: boolean, t: number): void {
    if (this.roundOver) return;
    let stoppedCarrier = false;
    if (this.team) {
      const drop = this.lastDrop[this.team];
      stoppedCarrier = this.game.flags[this.team]?.by === victim
        || (drop?.id === victim && performance.now() - drop.at < 2_000);
    }
    if (this.carry) this.carry.kills++;
    const { chain, streak } = this.moments.onKill(t, { head, stoppedCarrier });
    this.announceKill(chain, streak);
  }

  /** Multi-kill and streak call-outs: a banner and a stinger. */
  private announceKill(chain: number, streak: number): void {
    const names: Record<number, string> = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL' };
    if (chain >= 2) {
      this.hud.announce(names[chain] ?? 'RAMPAGE', chain >= 5 ? `${chain} kills` : '');
      sfx.playMultiKill(chain);
    } else if (streak >= 5 && streak % 5 === 0) {
      this.hud.announce(`${streak} KILL STREAK`, streak >= 10 ? 'Unstoppable' : 'On fire');
      sfx.playStreak();
    }
  }

  // ---------------------------------------------------------------- rounds

  private onGame(next: GameState): void {
    const prev = this.game;
    this.game = next;
    const first = !this.gameLoaded;
    this.gameLoaded = true;
    const newRound = !first && next.round > prev.round;

    // Every round has its own map. A late joiner may also find the room has moved on from the lobby's seed.
    if (next.seed && (normalizeSeed(next.seed) || CLASSIC_SEED) !== this.mapSeed) this.loadMap(next.seed);

    if (next.ended && (first || !prev.ended || newRound)) {
      this.endedAt = next.ended.at ?? this.net.serverNow();
      this.triggerHeld = false;
      if (!first) {
        this.announceWinner();
        this.recordRanking();
      }
    }
    if (newRound) this.startRound();

    if (this.mode === 'ctf') {
      const now = performance.now();
      const t = this.net.serverNow();
      for (const team of TEAMS) {
        const was = placementOf(prev.flags[team]);
        const is = placementOf(next.flags[team]);
        if (!this.replay) this.flagField?.set(team, is);
        if (is.at !== 'ground') delete this.flagDroppedAt[team];
        else if (first || !samePlacement(was, is)) this.flagDroppedAt[team] = now;
        if (!samePlacement(was, is)) this.recorder.event({ t, kind: 'flag', team, placement: is });
        if (was.at === 'carried' && is.at !== 'carried') this.lastDrop[team] = { id: was.carrier, at: now };
        // Our flag run starts when we pick up their flag.
        if (team !== this.team && is.at === 'carried' && is.carrier === this.playerId && was.at !== 'carried') {
          this.carry = { since: t, kills: 0 };
        } else if (team !== this.team && is.at !== 'carried' && was.at === 'carried' && was.carrier === this.playerId) {
          if (is.at === 'ground') this.carry = null;
        }
        if (!first && !newRound) this.announceFlag(team, was, is);
      }
    }
    this.refreshScore();
  }

  /**
   * The round just ended: add our part of it to the global leaderboard. Only rounds we were
   * playing in (not spectating, not joined during the results) count, once each.
   */
  private recordRanking(): void {
    const ended = this.game.ended;
    if (!ended || this.spectating || this.rankedRound === this.game.round) return;
    if (this.kills + this.deaths + this.stats.captures === 0 && performance.now() - this.joinedAt < 60_000) return;
    this.rankedRound = this.game.round;
    const won = ended.winner !== 'draw' && (this.team ? ended.winner === this.team : ended.winner === this.playerId);
    recordRound(this.profileId, this.name, { kills: this.kills, deaths: this.deaths, captures: this.stats.captures, won })
      .catch((err: unknown) => console.warn('Could not update the leaderboard', err));
  }

  private announceWinner(): void {
    const ended = this.game.ended;
    if (!ended) return;
    this.stopRoundBed();
    if (ended.winner === 'draw') {
      this.hud.pushInfo('The round is a draw');
      sfx.playRoundEnd('draw');
      return;
    }
    const won = this.team ? ended.winner === this.team : ended.winner === this.playerId;
    sfx.playRoundEnd(won ? 'won' : 'lost');
    this.hud.pushInfo(this.team ? `${ended.name} team wins the round` : `${ended.name} wins the round`);
  }

  /** Feed messages for flags changing hands. */
  private announceFlag(team: Team, was: FlagPlacement, is: FlagPlacement): void {
    if (samePlacement(was, is)) return;
    const flag = `${TEAM_INFO[team].name} flag`;
    const who = (id: string) => (id === this.playerId ? 'You' : this.players[id]?.name || 'Someone');
    const ours = team === this.team;
    if (is.at === 'carried') {
      this.hud.pushInfo(`${who(is.carrier)} took the ${flag}`);
      if (is.carrier === this.playerId) {
        sfx.playPickup();
        this.hud.announce('FLAG TAKEN', 'Guns stowed — swing the flag to fight · run it home');
      } else if (ours) {
        sfx.playDenied();
        this.hud.announce('YOUR FLAG IS GONE', `${who(is.carrier)} has it`);
      }
    } else if (was.at === 'carried' && is.at === 'ground') {
      this.hud.pushInfo(`${who(was.carrier)} dropped the ${flag}`);
    } else if (was.at === 'carried' && is.at === 'base') {
      this.hud.pushInfo(`${who(was.carrier)} captured the ${flag}!`);
      if (!ours) {
        sfx.playKill();
        this.hud.announce('CAPTURED', `${who(was.carrier)} scored`);
      } else {
        this.hud.announce('ENEMY SCORED', '');
      }
    } else if (is.at === 'base') {
      this.hud.pushInfo(`The ${flag} was returned`);
      if (ours) this.hud.announce('FLAG RETURNED', '');
    }
  }

  /** A new round began (on a new map): everyone resets their own score and respawns. */
  private startRound(): void {
    this.stopReplay();
    this.hud.clearToasts();
    this.kills = 0;
    this.applyLoadout();
    this.deaths = 0;
    this.stats = { ...EMPTY_STATS };
    this.myMatch = { ...EMPTY_MY_MATCH };
    this.flagHomeToast = false;
    this.moments.reset();
    this.recorder.reset();
    this.carry = null;
    this.lastDrop = {};
    // Everyone's back on zero: nobody leads until someone scores.
    this.ffaLeader = null;
    this.leadKnown = false;
    this.clearAbilities();
    this.hud.update({ myMatch: this.myMatch });
    this.respawn();
    void this.net.sendState({ kills: 0, deaths: 0, shield: false, moment: null, ...this.stats });
    const map = this.hud.get().map;
    this.hud.toast(`Round ${this.game.round + 1}${map ? ` · ${map.name}` : ''} — fight!`);
    sfx.playRoundStart();
  }

  /** The last-30-seconds music: on while the clock is in the red, faster as it runs out. */
  private updateRoundBed(): void {
    const clock = this.hud.get().clock;
    const on = !!clock && clock.urgent && !this.roundOver && this.joined;
    if (on) {
      if (!this.roundBedOn) sfx.startRoundBed();
      this.roundBedOn = true;
      sfx.setRoundBedUrgency(1 - clock.left / CLOCK_WARNING);
    } else if (this.roundBedOn) {
      this.stopRoundBed();
    }
  }

  private stopRoundBed(): void {
    if (!this.roundBedOn) return;
    this.roundBedOn = false;
    sfx.stopRoundBed();
  }

  /** How long the round-over screens last: results, then the MVP replay if there is an MVP. */
  private intermissionMs(): number {
    return (RESULTS_TIME + (this.game.ended?.mvp ? MVP_TIME : 0)) * 1000;
  }

  /** Whoever's intermission runs out first starts the next round, on the map picked when the last one ended. */
  private requestNextRound(): void {
    const round = this.game.round;
    if (this.nextRoundRequested === round) return;
    this.nextRoundRequested = round;
    let seed = '';
    this.net.mutateGame((g) => {
      if (g.round !== round || !g.ended) return false;
      seed = g.ended.nextSeed || randomSeed();
      g.round = round + 1;
      g.seed = seed;
      g.startedAt = this.net.serverNow();
      delete g.ended;
      g.score = {};
      g.flags = {};
      return true;
    })
      .then((committed) => {
        if (!committed) return;
        // Pickups were placed for the old walls, and the lobby should list the new map.
        void this.net.clearPickups();
        void this.net.setLobbySeed(seed);
      })
      .catch((err: unknown) => console.warn('Could not start the next round', err));
  }

  /**
   * Mark the round as over (inside a transaction). Also picks the next map and the MVP here,
   * so every client shows the same ones.
   */
  private finishRound(g: GameState, winner: string, name: string, reason: 'time' | 'score'): void {
    const current = g.seed ?? this.mapSeed;
    let nextSeed = randomSeed();
    while (nextSeed === current) nextSeed = randomSeed();
    const mvp = this.pickMvp();
    g.ended = { winner, name, reason, at: this.net.serverNow(), nextSeed, ...(mvp ? { mvp } : {}) };
  }

  /** End the round if `winner` (a player id in FFA, a team otherwise) is still in this one. */
  private endRound(round: number, winner: string, name: string): void {
    this.net.mutateGame((g) => {
      if (g.round !== round || g.ended) return false;
      this.finishRound(g, winner, name, 'score');
      return true;
    }).catch((err: unknown) => console.warn('Could not end the round', err));
  }

  /** One point for `team`; the point that reaches the limit ends the round. */
  private addTeamScore(team: Team): void {
    const round = this.game.round;
    const limit = this.rules.limit;
    this.net.mutateGame((g) => {
      if (g.round !== round || g.ended) return false;
      const score = (g.score[team] ?? 0) + 1;
      g.score[team] = score;
      if (score >= limit) this.finishRound(g, team, TEAM_INFO[team].name, 'score');
      return true;
    }).catch((err: unknown) => console.warn('Could not add score', err));
  }

  /** Who's ahead right now: a team, a player id, or 'draw'. */
  private standings(g: GameState): [winner: string, name: string] {
    if (this.team) {
      const red = g.score.red ?? 0;
      const blue = g.score.blue ?? 0;
      if (red === blue) return ['draw', 'Nobody'];
      return red > blue ? ['red', TEAM_INFO.red.name] : ['blue', TEAM_INFO.blue.name];
    }
    const kills = Object.entries(this.players)
      .filter(([, p]) => !p.spec)
      .map(([id, p]) => ({ id, name: p.name, kills: id === this.playerId ? this.kills : p.kills || 0 }))
      .sort((a, b) => b.kills - a.kills);
    const [top, second] = kills;
    if (!top || top.kills === 0 || (second && second.kills === top.kills)) return ['draw', 'Nobody'];
    return [top.id, top.name];
  }

  /** The round's time is up: the best score wins. Any client can do this; the transaction keeps it to one. */
  private checkTimeLimit(): void {
    const g = this.game;
    if (this.roundOver || !g.startedAt || this.timeUpRequested === g.round) return;
    if (this.net.serverNow() < g.startedAt + this.rules.minutes * 60_000) return;
    this.timeUpRequested = g.round;
    const round = g.round;
    this.net.mutateGame((next) => {
      if (next.round !== round || next.ended) return false;
      const [winner, name] = this.standings(next);
      this.finishRound(next, winner, name, 'time');
      return true;
    }).catch((err: unknown) => console.warn('Could not end the round on time', err));
  }

  /** Rooms made before time limits (or before this round had a clock) get one now. */
  private ensureRoundClock(): void {
    const g = this.game;
    if (g.startedAt || this.roundOver || !this.isLeader() || this.clockFixRequested === g.round) return;
    this.clockFixRequested = g.round;
    const round = g.round;
    const seed = this.mapSeed;
    this.net.mutateGame((next) => {
      if (next.round !== round || next.startedAt) return false;
      next.startedAt = this.net.serverNow();
      next.seed ??= seed;
      return true;
    }).catch((err: unknown) => console.warn('Could not start the round clock', err));
  }

  /**
   * The round's MVP: the best highlight, with overall performance as a smaller factor.
   * Players who didn't kill or capture anything can't be MVP.
   */
  private pickMvp(): MvpInfo | null {
    const candidates = Object.entries(this.players).filter(([, p]) => !p.spec).map(([id, p]) => {
      const me = id === this.playerId;
      const kills = me ? this.kills : p.kills || 0;
      const captures = me ? this.stats.captures : p.captures || 0;
      const damage = Math.round(me ? this.stats.damage : p.damage || 0);
      const moment = me ? this.moments.get() : p.moment ?? null;
      const performance = kills * 4 + captures * 25 + damage / 40;
      return { id, p, kills, captures, damage, deaths: me ? this.deaths : p.deaths || 0, moment,
        rating: (moment?.score ?? 0) + 0.3 * performance };
    }).filter((c) => c.kills > 0 || c.captures > 0);
    candidates.sort((a, b) => b.rating - a.rating || (a.id < b.id ? -1 : 1));
    const best = candidates[0];
    if (!best) return null;
    const team = best.id === this.playerId ? this.team : best.p.team;
    return {
      id: best.id,
      name: best.p.name,
      color: best.id === this.playerId ? this.color : best.p.color,
      ...(team ? { team } : {}),
      title: best.moment?.title ?? 'Top fragger',
      start: best.moment?.start ?? 0,
      end: best.moment?.end ?? 0,
      kills: best.kills,
      deaths: best.deaths,
      captures: best.captures,
      damage: best.damage,
    };
  }

  /** Which round-over screen we're on, or null while playing. */
  private intermissionPhase(): 'results' | 'mvp' | null {
    const ended = this.game.ended;
    if (!ended) return null;
    const since = this.net.serverNow() - this.endedAt;
    return ended.mvp && since >= RESULTS_TIME * 1000 ? 'mvp' : 'results';
  }

  /** Start the MVP replay when its screen comes up, and stop it when the next round starts. */
  private updateReplay(dt: number): void {
    const mvp = this.game.ended?.mvp;
    const phase = this.intermissionPhase();
    if (phase === 'mvp' && mvp && !this.replay && this.replayRound !== this.game.round && this.character) {
      this.replayRound = this.game.round;
      this.replay = new ReplayDirector({
        mvp,
        recorder: this.recorder,
        scene: this.scene,
        camera: this.camera,
        character: this.character,
        effects: this.effects,
        grenades: this.grenades,
        colliders: this.colliders,
        solids: this.solids,
        flagField: this.flagField,
        smoke: this.smoke,
        onKill: (killer, victim, head) => {
          const k = this.players[killer] ?? this.recorder.tracks.get(killer) ?? UNKNOWN_PLAYER;
          const v = this.players[victim] ?? this.recorder.tracks.get(victim) ?? UNKNOWN_PLAYER;
          this.hud.pushKill(k, v, head, killer === mvp.id);
        },
      });
      for (const r of this.remotes.values()) r.setVisible(false);
      this.hud.update({ scoreboardOpen: false });
    }
    if (phase !== 'mvp' && this.replay) this.stopReplay();
    this.replay?.update(dt);
  }

  private stopReplay(): void {
    if (!this.replay) return;
    if (this.pov && this.pov === this.replay.pov) this.pov = null;
    this.replay.dispose();
    this.replay = null;
    for (const [id, r] of this.remotes) r.setVisible(!this.players[id]?.spec);
    // Put the flags back where they really are.
    for (const team of TEAMS) this.flagField?.set(team, placementOf(this.game.flags[team]));
  }

  /** Push the score bar / clock / flags / round-over state to the HUD when it changes. */
  /**
   * Free-for-all modes: tell players when the outright lead changes hands. Taking it gets a big
   * banner; losing it says who took it; anyone else's change is a line in the feed. A tie at the
   * top isn't a lead, so the call comes when someone pulls clear.
   */
  private updateLead(): void {
    if (this.team || !this.joined || this.roundOver) return;
    let top = 0;
    let holders: string[] = [];
    for (const [id, p] of Object.entries(this.players)) {
      if (p.spec) continue;
      const kills = id === this.playerId ? this.kills : p.kills || 0;
      if (kills > top) {
        top = kills;
        holders = [id];
      } else if (kills === top && kills > 0) {
        holders.push(id);
      }
    }
    // Nobody has scored yet (a fresh round, or we joined before the first kill): the first lead is news.
    if (top === 0) this.leadKnown = true;
    const leader = top > 0 && holders.length === 1 ? holders[0]! : null;
    // Ties and nobody-scored keep the last leader until someone is clearly ahead.
    if (!leader || leader === this.ffaLeader) return;
    const previous = this.ffaLeader;
    this.ffaLeader = leader;
    // Joining a match already under way: the first look just learns who's ahead.
    if (!this.leadKnown) {
      this.leadKnown = true;
      return;
    }
    const name = (id: string) => this.players[id]?.name || 'Someone';
    const unit = this.rules.loadout === 'gungame' ? `level ${top + 1}` : `${top} kill${top === 1 ? '' : 's'}`;
    if (leader === this.playerId) {
      this.hud.announce('YOU TOOK THE LEAD', previous ? `Ahead of ${name(previous)} · ${unit}` : unit);
      sfx.playLeadGained();
    } else if (previous === this.playerId) {
      this.hud.announce('LEAD LOST', `${name(leader)} took the lead · ${unit}`);
      sfx.playLeadLost();
    } else {
      this.hud.pushInfo(`👑 ${name(leader)} took the lead (${unit})`);
    }
  }

  private refreshScore(): void {
    this.updateLead();
    let leader: { name: string; kills: number } | null = null;
    for (const [id, p] of Object.entries(this.players)) {
      if (id === this.playerId) continue;
      const kills = p.kills || 0;
      if (!leader || kills > leader.kills) leader = { name: p.name, kills };
    }
    const g = this.game;
    const score = { red: g.score.red ?? 0, blue: g.score.blue ?? 0, mine: this.kills, leader };
    const now = this.net.serverNow();

    const flags = this.mode === 'ctf'
      ? Object.fromEntries(TEAMS.map((team) => {
        const at = placementOf(g.flags[team]);
        if (at.at === 'carried') {
          const carrier = at.carrier === this.playerId ? 'You' : this.players[at.carrier]?.name || 'Someone';
          return [team, { state: 'carried', carrier, mine: at.carrier === this.playerId }];
        }
        if (at.at !== 'ground') return [team, { state: 'home' }];
        const droppedAt = this.flagDroppedAt[team];
        const returnIn = droppedAt === undefined
          ? FLAG_RETURN_TIME
          : Math.max(0, Math.ceil(FLAG_RETURN_TIME - (performance.now() - droppedAt) / 1000));
        return [team, { state: 'dropped', returnIn }];
      })) as HudState['flags']
      : null;

    let clock: HudState['clock'] = null;
    if (g.startedAt) {
      const left = g.ended ? 0 : Math.max(0, Math.ceil((g.startedAt + this.rules.minutes * 60_000 - now) / 1000));
      clock = { left, urgent: !g.ended && left <= CLOCK_WARNING };
    }

    const matchEnd = this.matchEndView(now);
    const playerCount = Object.values(this.players).filter((p) => !p.spec).length;
    const key = JSON.stringify([score, flags, clock, matchEnd, playerCount]);
    if (key === this.lastScoreKey) return;
    this.lastScoreKey = key;
    this.hud.update({ score, flags, clock, matchEnd, playerCount });
  }

  private matchEndView(now: number): MatchEnd | null {
    const ended = this.game.ended;
    const phase = this.intermissionPhase();
    if (!ended || !phase) return null;
    const draw = ended.winner === 'draw';
    const won = !draw && (this.team ? ended.winner === this.team : ended.winner === this.playerId);
    const title = draw
      ? "It's a draw!"
      : this.team ? `${ended.name} team wins!` : won ? 'You win!' : `${ended.name} wins!`;
    const ctf = this.mode === 'ctf';
    const top = this.scoreRows().slice(0, 3).map((r) => ({
      name: r.name,
      color: r.color,
      score: ctf ? `${r.captures} cap · ${r.kills} K` : `${r.kills} K / ${r.deaths} D`,
    }));
    const mvp = ended.mvp
      ? {
        name: ended.mvp.name,
        color: ended.mvp.color,
        title: ended.mvp.title,
        kills: ended.mvp.kills,
        deaths: ended.mvp.deaths,
        captures: ended.mvp.captures,
        damage: ended.mvp.damage,
        me: ended.mvp.id === this.playerId,
      }
      : null;
    const phaseEnds = this.endedAt + (phase === 'results' ? RESULTS_TIME * 1000 : this.intermissionMs());
    const next = ended.nextSeed ? this.mapInfo(ended.nextSeed) : null;
    return {
      phase,
      title,
      won,
      draw,
      reason: ended.reason ?? 'score',
      top,
      mvp,
      nextIn: Math.max(0, Math.ceil((phaseEnds - now) / 1000)),
      nextMapIn: Math.max(0, Math.ceil((this.endedAt + this.intermissionMs() - now) / 1000)),
      nextMap: next,
    };
  }

  private nextMapCache: { seed: string; name: string } | null = null;
  /** Theme name for a seed; generated once, since the HUD asks every frame. */
  private mapInfo(seed: string): { name: string; seed: string } {
    if (this.nextMapCache?.seed !== seed) {
      const map = generateMap(seed);
      this.nextMapCache = { seed, name: map.theme.name };
      return { name: map.theme.name, seed: map.seed };
    }
    return { name: this.nextMapCache.name, seed: normalizeSeed(seed) || CLASSIC_SEED };
  }

  // ---------------------------------------------------------------- capture the flag

  /** Where a flag can be touched, or null while someone carries it. */
  private flagSpot(team: Team): { x: number; y: number; z: number } | null {
    const at = placementOf(this.game.flags[team]);
    if (at.at === 'carried') return null;
    return at.at === 'base' ? FLAG_BASES[team] : at;
  }

  private carryingFlag(): boolean {
    return !!this.team && this.game.flags[otherTeam(this.team)]?.by === this.playerId;
  }

  /** Take the enemy flag, return our own, or score by bringing theirs to our base. */
  private updateFlags(): void {
    const team = this.team;
    if (!team || this.flagBusy || this.roundOver) return;
    const enemy = otherTeam(team);
    const me = this.player.position;
    const near = (p: { x: number; y: number; z: number }) =>
      Math.hypot(p.x - me.x, p.z - me.z) < FLAG_RADIUS && Math.abs(p.y - me.y) < 1.5;
    const round = this.game.round;
    const guard = (g: GameState) => g.round === round && !g.ended;

    const theirs = this.flagSpot(enemy);
    if (theirs && near(theirs)) {
      this.flagTransaction((g) => {
        if (!guard(g) || g.flags[enemy]?.by) return false;
        g.flags[enemy] = { by: this.playerId };
        return true;
      });
      return;
    }

    const ours = placementOf(this.game.flags[team]);
    if (ours.at === 'ground' && near(ours)) {
      this.flagTransaction((g) => {
        if (!guard(g) || placementOf(g.flags[team]).at !== 'ground') return false;
        delete g.flags[team];
        return true;
      });
      return;
    }

    if (!this.carryingFlag() || !near(FLAG_BASES[team])) {
      this.flagHomeToast = false;
      return;
    }
    if (ours.at !== 'base') {
      if (!this.flagHomeToast) this.hud.toast('Your flag must be at your base to score');
      this.flagHomeToast = true;
      return;
    }
    const limit = this.rules.limit;
    this.flagTransaction((g) => {
      if (!guard(g) || g.flags[enemy]?.by !== this.playerId || placementOf(g.flags[team]).at !== 'base') return false;
      delete g.flags[enemy];
      const score = (g.score[team] ?? 0) + 1;
      g.score[team] = score;
      if (score >= limit) this.finishRound(g, team, TEAM_INFO[team].name, 'score');
      return true;
    }, () => {
      this.stats.captures++;
      const carry = this.carry;
      this.carry = null;
      const t = this.net.serverNow();
      this.moments.onCapture(t, carry?.since ?? t, carry?.kills ?? 0);
    });
  }

  private flagTransaction(change: (g: GameState) => boolean, onCommit?: () => void): void {
    this.flagBusy = true;
    this.net.mutateGame(change)
      .then((committed) => { if (committed) onCommit?.(); })
      .catch((err: unknown) => console.warn('Flag update failed', err))
      .finally(() => { this.flagBusy = false; });
  }

  /** Drop the enemy flag where we stand (on death, switching team or leaving). */
  private dropFlag(): Promise<unknown> {
    if (!this.team || !this.carryingFlag()) return Promise.resolve();
    const enemy = otherTeam(this.team);
    const p = this.player.position;
    const spot = { x: r2(p.x), y: r2(this.groundBelow(p)), z: r2(p.z) };
    return this.net.mutateGame((g) => {
      if (g.flags[enemy]?.by !== this.playerId) return false;
      g.flags[enemy] = spot;
      return true;
    }).catch((err: unknown) => console.warn('Could not drop the flag', err));
  }

  /** Height of whatever is under `p`, so a flag dropped mid-jump lands on the floor or a crate. */
  private groundBelow(p: THREE.Vector3): number {
    let y = 0;
    for (const c of this.world.colliders) {
      if (p.x > c.min.x && p.x < c.max.x && p.z > c.min.z && p.z < c.max.z && c.max.y <= p.y + 0.05) {
        y = Math.max(y, c.max.y);
      }
    }
    for (const r of this.world.ramps) {
      if (!overRamp(r, p.x, p.z)) continue;
      const h = rampHeightAt(r, p.x, p.z);
      if (h <= p.y + 0.3) y = Math.max(y, h);
    }
    return y;
  }

  /** Leader only: send flags home when left lying around too long or their carrier disappeared. */
  private refereeFlags(): void {
    if (this.refereeBusy || this.roundOver || !this.isLeader()) return;
    if (performance.now() - this.joinedAt < REFEREE_GRACE_MS) return;
    const now = performance.now();
    for (const team of TEAMS) {
      const flag = this.game.flags[team];
      const at = placementOf(flag);
      const droppedAt = this.flagDroppedAt[team];
      const expired = at.at === 'ground' && droppedAt !== undefined && now - droppedAt > FLAG_RETURN_TIME * 1000;
      const orphaned = at.at === 'carried' && !this.players[at.carrier];
      if (!expired && !orphaned) continue;
      const snapshot = JSON.stringify(flag);
      this.refereeBusy = true;
      this.net.mutateGame((g) => {
        // Only if nobody touched it in the meantime.
        if (JSON.stringify(g.flags[team]) !== snapshot) return false;
        delete g.flags[team];
        return true;
      })
        .catch((err: unknown) => console.warn('Could not return the flag', err))
        .finally(() => { this.refereeBusy = false; });
      return;
    }
  }

  // ---------------------------------------------------------------- combat

  /** @param source where the hit came from (the shooter's muzzle, or the grenade blast) */
  private takeDamage(
    dmg: number | undefined, fromId: string, head: boolean, weapon: WeaponKind, source: THREE.Vector3,
  ): void {
    if (!this.alive || this.roundOver || this.isAlly(fromId)) return;
    // Headshots-only modes: body hits and blasts don't count (the flag club still does).
    if (this.rules.headshotsOnly && !head && weapon !== 'flag') return;
    // Never trust the number another client sent beyond what the game allows.
    let amount = Math.min(Math.max(Number(dmg) || 0, 0), maxDamage(weapon));
    // Show where it came from even when the shield soaks it up.
    this.hitSources.set(fromId, { at: source, time: performance.now(), damage: amount });
    if (this.shieldHp > 0) {
      const absorbed = Math.min(this.shieldHp, amount);
      this.shieldHp -= absorbed;
      amount -= absorbed;
      if (this.shieldHp <= 0) this.endShield();
    }
    this.hp -= amount;
    this.hud.update({ hp: Math.max(0, this.hp) });
    this.hud.flashDamage();
    this.shake = Math.min(1, this.shake + 0.25 + amount / 80);
    sfx.playHurt();
    if (this.hp <= 0) this.die(fromId, head, weapon);
    else if (amount > 0) void this.net.sendState({ hp: this.hp });
  }

  private die(killerId: string, head: boolean, weapon: WeaponKind): void {
    this.alive = false;
    this.hp = 0;
    this.deaths++;
    this.respawnTimer = this.rules.respawn;
    this.triggerHeld = false;
    this.aimHeld = false;
    // Our picked-up gun and abilities fall around the body for anyone to grab; their effects end.
    const dropped = this.dropLoot();
    this.clearAbilities();
    this.stats.streak = 0;
    this.moments.onDeath();
    this.carry = null;
    void this.dropFlag();
    void this.net.sendState({ alive: false, hp: 0, deaths: this.deaths, shield: false });
    this.net.sendEvent({ type: 'kill', killer: killerId, victim: this.playerId, head, weapon });
    if (killerId && killerId !== this.playerId) this.creditKiller(killerId);
    const self = !killerId || killerId === this.playerId;
    this.hud.update({
      hp: 0,
      death: {
        killerName: self ? '' : this.players[killerId]?.name || 'someone', self, weapon, head, dropped, respawnIn: this.rules.respawn,
      },
    });
  }

  /** Scatter the picked-up gun and abilities (with their ammo / uses left) on the floor around where we died. */
  private dropLoot(): boolean {
    if (!this.rules.guns && !this.rules.abilities && !this.rules.ammo) return false;
    const gun = this.weapon.takeSpecial();
    const items: PickupRecord[] = [
      ...(gun && gun.rounds > 0 && isPickupGun(gun.kind) ? [{ type: gun.kind, uses: gun.rounds, x: 0, z: 0 }] : []),
      ...this.inventory.takeAll().map((a) => ({ type: a.type, uses: a.usesLeft, x: 0, z: 0 })),
    ];
    if (!items.length) return false;
    const p = this.player.position;
    const spots = this.pickups.scatterAround(p.x, p.z, items.length);
    items.forEach((item, i) => void this.net.spawnPickup({ ...item, ...spots[i]! }));
    return true;
  }

  /** Give the kill to `killerId`, and the point to their team in TDM. */
  private creditKiller(killerId: string): void {
    const round = this.game.round;
    const killer = this.players[killerId];
    // Team modes without flags score a point per kill (TDM, Sniper TDM).
    if (MODES[this.mode].teams && this.mode !== 'ctf' && killer?.team && killer.team !== this.team) this.addTeamScore(killer.team);
    this.net.creditKill(killerId)
      .then((kills) => {
        if (!MODES[this.mode].teams && kills !== null && kills >= this.rules.limit) {
          this.endRound(round, killerId, killer?.name || 'Someone');
        }
      })
      .catch((err: unknown) => console.warn('Could not credit the kill', err));
  }

  private clearAbilities(): void {
    this.inventory.clear();
    if (this.inventoryOpen) this.closeInventory(false);
    this.shieldHp = 0;
    this.speedUntil = 0;
    this.player.speedMultiplier = 1;
  }

  private respawn(): void {
    const spawn = this.pickSpawn();
    this.player.teleport(spawn, Math.atan2(spawn.x, spawn.z));
    this.hp = this.rules.health;
    this.alive = true;
    this.weapon.reset();
    this.hitSources.clear();
    const wasDead = !!this.hud.get().death;
    this.hud.update({ hp: this.hp, death: null });
    if (wasDead) this.hud.update({ respawnFlash: this.hud.get().respawnFlash + 1 });
    void this.net.sendState({ ...this.poseState(), hp: this.hp, alive: true });
  }

  /** Prefer spawn points far away from living enemies. */
  private pickSpawn(): THREE.Vector3 {
    const enemies = [...this.remotes]
      .filter(([id, r]) => r.alive && !this.isAlly(id))
      .map(([, r]) => r.target);
    const points = this.team ? teamSpawns(this.world.spawnPoints, this.team) : this.world.spawnPoints;
    const scored = points.map((p) => ({
      p,
      d: enemies.length ? Math.min(...enemies.map((e) => e.distanceTo(p))) : Math.random() * 100,
    }));
    scored.sort((a, b) => b.d - a.d);
    const choice = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
    return (choice?.p ?? new THREE.Vector3()).clone();
  }

  private shoot(): void {
    const gun = this.weapon.gun;
    const def = GUNS[gun];
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const forward = this.camera.getWorldDirection(new THREE.Vector3());

    const moving = this.player.horizontalSpeed > 1;
    // Crouching steadies your aim (sliding doesn't); aiming down sights tightens it far more.
    const steady = (this.player.stance === 'crouch' ? 0.6 : 1) * THREE.MathUtils.lerp(1, def.adsSpread, this.weapon.aim);
    const spread = (def.spread
      + (moving ? def.movingSpread : 0)
      + (this.player.onGround ? 0 : def.airSpread)
      + (def.auto ? Math.min(this.weapon.shotsInBurst, 10) * 0.0015 : 0)) * steady;

    const targets: THREE.Object3D[] = [...this.world.solids];
    // Bullets pass through teammates.
    for (const [id, r] of this.remotes) if (!this.isAlly(id)) targets.push(...r.hitboxes);
    this.raycaster.far = def.range;

    // One ray per pellet (the shotgun fires nine); damage adds up per player hit.
    const ends: THREE.Vector3[] = [];
    const damageTo = new Map<string, number>();
    let anyHead = false;
    for (let p = 0; p < def.pellets; p++) {
      const dir = forward.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(spread)).normalize();
      this.raycaster.set(origin, dir);
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, def.range);
      ends.push(end);
      const hitbox = hit?.object.userData as Partial<HitboxData> | undefined;
      const id = hitbox?.playerId;
      if (hit) this.effects.impact(end, id ? 0xff3b3b : 0xffc35c);
      if (!id || !hit) continue;
      const head = !!hitbox?.head;
      // Headhunter rules: a body shot does nothing.
      if (this.rules.headshotsOnly && !head) continue;
      anyHead ||= head;
      damageTo.set(id, (damageTo.get(id) ?? 0) + shotDamage(gun, head, hit.distance));
    }

    this.stats.shots++;
    if (damageTo.size) {
      this.stats.hits++;
      if (anyHead) this.stats.headshots++;
      for (const [id, dmg] of damageTo) {
        const target = this.remotes.get(id);
        if (target) {
          this.stats.damage += Math.min(dmg, target.displayedHp);
          target.reveal(dmg);
        }
      }
      this.hud.hitmarker(anyHead);
      sfx.playHit(anyHead);
    }

    const muzzle = this.camera.localToWorld(this.weapon.muzzleOffset());
    for (const end of ends) this.effects.tracer(muzzle, end);
    sfx.playShot(0.7, gun);
    const recoil = def.recoil * (1 - 0.45 * this.weapon.aim);
    this.player.look((Math.random() - 0.5) * recoil * 0.5, recoil);

    const [first, ...rest] = ends.map(toArr);
    const shot = { o: toArr(muzzle), e: first ?? toArr(origin) };
    const extra = { ...(gun !== 'rifle' ? { w: gun } : {}), ...(rest.length ? { ends: rest } : {}) };
    if (def.pellets > 1) {
      // Firebase rejects undefined, so hits only goes in when something was hit.
      const hits = Object.fromEntries([...damageTo].map(([id, d]) => [id, Math.round(d)]));
      this.net.sendEvent({ type: 'shot', ...shot, ...extra, ...(damageTo.size ? { hits } : {}) });
    } else {
      const [hitId, dmg] = [...damageTo][0] ?? [null, 0];
      this.net.sendEvent({ type: 'shot', ...shot, ...extra, hit: hitId, dmg, head: anyHead });
    }
    this.recorder.event({ t: this.net.serverNow(), kind: 'shot', ...shot, ...extra, hit: damageTo.size > 0, from: this.playerId });
  }

  /**
   * Swing the carried flag: short rays fanned across the view (a club is forgiving to aim)
   * find the nearest enemy within reach. Walls in the way block it. Shown to others as a throw.
   */
  private swingFlag(): void {
    this.throws++;
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const targets: THREE.Object3D[] = [...this.world.solids];
    for (const [id, r] of this.remotes) if (!this.isAlly(id)) targets.push(...r.hitboxes);
    this.raycaster.far = MELEE_RANGE;
    let best: { id: string; head: boolean; distance: number } | null = null;
    for (const yaw of [0, -0.22, 0.22, -0.42, 0.42]) {
      for (const pitch of [0, -0.18]) {
        const dir = forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        dir.y += pitch;
        this.raycaster.set(origin, dir.normalize());
        const hit = this.raycaster.intersectObjects(targets, false)[0];
        const box = hit?.object.userData as Partial<HitboxData> | undefined;
        if (!hit || !box?.playerId) continue;
        if (!best || hit.distance < best.distance) best = { id: box.playerId, head: !!box.head, distance: hit.distance };
      }
    }
    sfx.playSwing(0.8);
    this.stats.shots++;
    const dmg = best ? (best.head ? MELEE_HEAD_DAMAGE : MELEE_DAMAGE) : 0;
    if (best) {
      this.stats.hits++;
      if (best.head) this.stats.headshots++;
      const target = this.remotes.get(best.id);
      if (target) {
        this.stats.damage += Math.min(dmg, target.displayedHp);
        target.reveal(dmg);
      }
      this.hud.hitmarker(best.head);
      sfx.playMeleeHit();
    }
    this.net.sendEvent({ type: 'melee', o: toArr(origin), hit: best?.id ?? null, dmg, head: !!best?.head });
  }

  /** Q / mouse wheel / the touch swap button: rifle <-> picked-up gun. */
  switchGun(): void {
    if (!this.alive || this.roundOver || this.weapon.meleeMode) return;
    if (this.weapon.switchGun()) {
      this.aimHeld = false;
      sfx.playSwitch();
    }
  }


  // ---------------------------------------------------------------- abilities

  private useAbility(slot: number): void {
    if (this.roundOver) return;
    const now = performance.now();
    const check = this.inventory.check(slot, now);
    if (!check.ok) {
      if (now - this.deniedAt < 700) return;
      this.deniedAt = now;
      const view = this.inventory.view(now)[slot];
      if (check.reason === 'empty' || !view) {
        this.hud.toast('Empty slot — pick up an ability');
      } else {
        this.hud.toast(`${ABILITIES[view.type].name} ready in ${view.cooldown.toFixed(1)} s`);
        this.hud.update({ slotDenied: { n: (this.hud.get().slotDenied?.n ?? 0) + 1, slot } });
      }
      sfx.playDenied();
      return;
    }
    const type = check.type;
    // Refuse instead of wasting a use
    if (type === 'medkit' && this.hp >= this.rules.health) {
      this.hud.toast('Already at full health');
      sfx.playDenied();
      return;
    }

    switch (type) {
      case 'medkit':
        this.hp = Math.min(this.rules.health, this.hp + MEDKIT_HEAL);
        this.hud.update({ hp: this.hp });
        void this.net.sendState({ hp: this.hp });
        break;
      case 'shield':
        this.shieldHp = SHIELD_AMOUNT;
        this.shieldUntil = now + SHIELD_DURATION * 1000;
        void this.net.sendState({ shield: true });
        break;
      case 'speed':
        this.speedUntil = now + SPEED_DURATION * 1000;
        this.player.speedMultiplier = SPEED_MULTIPLIER;
        break;
      case 'dash':
        this.player.dash(DASH_SPEED);
        break;
      case 'grenade':
        if (this.weapon.meleeMode) {
          this.hud.toast("Hands full — you can't throw while carrying the flag");
          sfx.playDenied();
          return;
        }
        this.throwGrenade();
        break;
      case 'smoke':
        this.throwSmoke();
        break;
      case 'wall':
        if (!this.placeWall()) {
          this.hud.toast('No room for a barrier here');
          sfx.playDenied();
          return;
        }
        break;
    }

    sfx.playAbility();
    this.bumpMyMatch('abilitiesUsed');
    if (this.inventory.consume(slot, now)) this.hud.toast(`${ABILITIES[type].name} used up`);
  }

  // ---------------------------------------------------------------- inventory

  private openInventory(): void {
    if (!this.alive || !this.joined) return;
    this.inventoryOpen = true;
    this.triggerHeld = false;
    // Free the mouse so the panel's buttons can be clicked.
    if (document.pointerLockElement) document.exitPointerLock();
    this.exitFreeMouse();
    this.hud.update({ inventoryOpen: true, paused: false });
  }

  /** @param resume grab the mouse again (only works from a key press or click) */
  closeInventory(resume: boolean): void {
    if (!this.inventoryOpen) return;
    this.inventoryOpen = false;
    this.hud.update({ inventoryOpen: false, paused: !this.locked && !resume });
    if (resume && !this.locked) this.requestPointerLock();
  }

  /** Put the ability in `slot` on the floor in front of us, with its remaining uses. */
  dropAbility(slot: number): void {
    if (!this.alive || !this.joined) return;
    const item = this.inventory.remove(slot);
    if (!item) return;
    const spot = this.dropSpot();
    const id = this.net.spawnPickup({ type: item.type, uses: item.usesLeft, ...spot });
    if (id) this.ignorePickup = { id, ...spot };
    this.bumpMyMatch('dropped');
    this.hud.toast(`Dropped ${ABILITIES[item.type].name}`);
    sfx.playAbility();
  }

  /** Put our picked-up gun on the floor in front of us, with its rounds left (back to the rifle). */
  dropGun(): void {
    if (!this.alive || !this.joined) return;
    const gun = this.weapon.takeSpecial();
    if (!gun || !isPickupGun(gun.kind)) return;
    if (gun.rounds > 0) {
      const spot = this.dropSpot();
      const id = this.net.spawnPickup({ type: gun.kind, uses: gun.rounds, ...spot });
      if (id) this.ignorePickup = { id, ...spot };
    }
    this.hud.toast(`Dropped ${GUNS[gun.kind].name}`);
    sfx.playSwitch();
  }

  /** The on-screen bag button: open the inventory (touch devices have no keyboard). */
  touchInventory(): void {
    // The on-screen controls hide behind the panel, so let go of anything they were holding.
    this.setTouchMove(null);
    this.setTouchFire(false);
    this.openInventory();
  }

  private dropSpot(): { x: number; z: number } {
    const p = this.player.position;
    const ahead = { x: p.x - Math.sin(this.player.yaw) * DROP_DISTANCE, z: p.z - Math.cos(this.player.yaw) * DROP_DISTANCE };
    const inside = (x: number, z: number) => this.world.colliders.some((c) =>
      x > c.min.x - 0.3 && x < c.max.x + 0.3 && z > c.min.z - 0.3 && z < c.max.z + 0.3 && c.max.y > p.y + 0.2);
    // Facing a wall: drop it at our feet instead (we'll ignore it until we step away).
    const spot = inside(ahead.x, ahead.z) ? { x: p.x, z: p.z } : ahead;
    return { x: Math.round(spot.x * 100) / 100, z: Math.round(spot.z * 100) / 100 };
  }

  private bumpMyMatch(key: keyof MyMatch): void {
    this.myMatch = { ...this.myMatch, [key]: this.myMatch[key] + 1 };
    this.hud.update({ myMatch: this.myMatch });
  }

  private endShield(): void {
    this.shieldHp = 0;
    void this.net.sendState({ shield: false });
  }

  private throwGrenade(): void {
    this.throws++;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const start = this.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.6);
    const velocity = dir.multiplyScalar(THROW_SPEED).add(new THREE.Vector3(0, THROW_LIFT, 0));
    // Simulate from the rounded values we send, so every client computes the identical arc.
    const o = toArr(start);
    const v = toArr(velocity);
    const trajectory = simulateGrenade(fromArr(o), fromArr(v), this.world.colliders);
    const id = randomId(8);
    this.grenades.launch(id, trajectory);
    this.net.sendEvent({ type: 'grenade', id, o, v });
    this.recorder.event({ t: this.net.serverNow(), kind: 'grenade', id, o, v });
    this.pendingBlasts.push({ id, at: performance.now() + trajectory.duration * 1000, p: trajectory.end });
  }

  /** A smoke canister flies like a grenade and bursts where it lands. */
  private throwSmoke(): void {
    this.throws++;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const start = this.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.6);
    const velocity = dir.multiplyScalar(THROW_SPEED).add(new THREE.Vector3(0, THROW_LIFT, 0));
    const o = toArr(start);
    const v = toArr(velocity);
    const arc = simulateGrenade(fromArr(o), fromArr(v), this.world.colliders);
    const id = randomId(8);
    this.grenades.launch(id, arc);
    this.net.sendEvent({ type: 'smoke', id, o, v });
    this.recorder.event({ t: this.net.serverNow(), kind: 'smoke', id, o, v });
    this.pendingSmokes.push({ id, at: performance.now() + arc.duration * 1000, p: arc.end });
  }

  /**
   * Put a barrier down in front of us, square to whichever axis we're facing most. Refused
   * (returns false) when it would cut into cover, another player or the arena edge.
   */
  private placeWall(): boolean {
    const p = this.player.position;
    const yaw = this.player.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // Facing along z means the wall runs across x.
    const axis: WallAxis = Math.abs(fz) >= Math.abs(fx) ? 'x' : 'z';
    const x = r2(p.x + fx * WALL_DISTANCE);
    const z = r2(p.z + fz * WALL_DISTANCE);
    const foot = new THREE.Vector3(x, p.y + 0.1, z);
    const y = r2(this.groundBelow(foot));
    const box = WallField.boxFor(x, y, z, axis);
    const limit = ARENA_HALF - 0.8;
    if (Math.abs(box.min.x) > limit || Math.abs(box.max.x) > limit || Math.abs(box.min.z) > limit || Math.abs(box.max.z) > limit) return false;
    if (this.world.colliders.some((c) => c.intersectsBox(box))) return false;
    const padded = box.clone().expandByScalar(0.4);
    for (const r of this.remotes.values()) {
      if (r.alive && padded.containsPoint(r.position.clone().setY(r.position.y + 0.5))) return false;
    }
    if (padded.containsPoint(p.clone().setY(p.y + 0.5))) return false;
    const id = randomId(8);
    const until = this.net.serverNow() + WALL_DURATION * 1000;
    this.walls.place(id, x, y, z, axis, until, new THREE.Color(this.color).getHex());
    this.net.sendEvent({ type: 'wall', id, x, y, z, axis, until, c: this.color });
    return true;
  }

  /** Our grenade went off: work out who it hurt (walls block it) and tell everyone. */
  private detonate(blast: { id: string; p: THREE.Vector3 }): void {
    const hits: Record<string, number> = {};
    for (const [id, remote] of this.remotes) {
      if (!remote.alive || this.isAlly(id)) continue;
      const chest = remote.position.clone().setY(remote.position.y + remote.chestHeight);
      const dist = chest.distanceTo(blast.p);
      if (dist > GRENADE_RADIUS) continue;
      const from = blast.p.clone().setY(blast.p.y + 0.2);
      this.losRay.set(from, chest.clone().sub(from).normalize());
      this.losRay.far = from.distanceTo(chest);
      if (this.losRay.intersectObjects(this.world.solids, false).length > 0) continue;
      const dmg = Math.round(GRENADE_DAMAGE * (1 - dist / GRENADE_RADIUS));
      if (dmg < 5) continue;
      hits[id] = dmg;
      this.stats.damage += Math.min(dmg, remote.displayedHp);
      remote.reveal(dmg);
    }

    this.grenades.explode(blast.id, blast.p, GRENADE_RADIUS);
    this.liftBodies(blast.p);
    sfx.playExplosion(1 / (1 + blast.p.distanceTo(this.camera.position) / 12));
    const hitAnyone = Object.keys(hits).length > 0;
    if (hitAnyone) {
      this.hud.hitmarker(false);
      sfx.playHit(false);
    }
    // Firebase rejects undefined fields, so only include hits when there are some.
    this.net.sendEvent({ type: 'blast', id: blast.id, p: toArr(blast.p), ...(hitAnyone ? { hits } : {}) });
    this.recorder.event({ t: this.net.serverNow(), kind: 'blast', id: blast.id, p: toArr(blast.p) });
  }

  private updateAbilities(dt: number): void {
    const now = performance.now();

    if (this.shieldHp > 0 && now >= this.shieldUntil) this.endShield();
    if (this.speedUntil && now >= this.speedUntil) {
      this.speedUntil = 0;
      this.player.speedMultiplier = 1;
    }

    const due = this.pendingBlasts.filter((b) => now >= b.at);
    if (due.length) {
      this.pendingBlasts = this.pendingBlasts.filter((b) => now < b.at);
      due.forEach((b) => this.detonate(b));
    }
    const landed = this.pendingSmokes.filter((b) => now >= b.at);
    if (landed.length) {
      this.pendingSmokes = this.pendingSmokes.filter((b) => now < b.at);
      for (const smoke of landed) {
        this.grenades.land(smoke.id);
        this.smoke.spawn(smoke.id, smoke.p);
        const heard = this.heardFrom(smoke.p);
        if (heard) sfx.playSlide('sand', heard.volume * 1.2, heard.pan);
      }
    }

    this.pickups.update(now / 1000);
    this.grenades.update();
    this.smoke.update();
    this.walls.update(this.net.serverNow());
    if (this.joined && this.alive) this.tryPickup();
    if (this.joined) this.runSpawner(dt);

    const slots = this.inventory.view(now);
    const buffs = {
      speed: this.speedUntil ? Math.ceil((this.speedUntil - now) / 100) / 10 : null,
      shield: this.shieldHp > 0 ? Math.ceil(this.shieldHp) : null,
    };
    const key = JSON.stringify([slots, buffs]);
    if (key !== this.lastSlotsKey) {
      this.lastSlotsKey = key;
      this.hud.update({ slots, buffs });
    }
  }

  private tryPickup(): void {
    const p = this.player.position;
    const ignored = this.ignorePickup;
    if (ignored && Math.hypot(p.x - ignored.x, p.z - ignored.z) > 1.5) this.ignorePickup = null;
    const id = this.pickups.touching(p);
    if (!id || id === this.ignorePickup?.id) {
      this.fullToastFor = null;
      return;
    }
    if (this.claimingPickup) return; // one claim at a time, so two can't race for the last slot
    const touchingType = this.pickups.typeOf(id);
    const kind = touchingType ? kindOf(touchingType) : null;
    if (kind === 'ammo' && !this.weapon.needsAmmo) {
      if (this.fullToastFor !== id) this.hud.toast('Ammo full');
      this.fullToastFor = id;
      return;
    }
    if (kind === 'ability' && !this.inventory.hasRoom) {
      if (this.fullToastFor !== id) {
        this.hud.toast('Slots full — use an ability to make room');
        this.hint('full-slots', () => (this.touch ? 'Open 🎒 to drop an ability' : `Open the inventory (${keyLabel(keyFor('inventory'))}) to drop one`));
      }
      this.fullToastFor = id;
      return;
    }
    // One picked-up gun at a time: a different one stays on the floor until ours is dropped.
    const carried = this.weapon.special;
    if (touchingType && isPickupGun(touchingType) && carried && carried !== touchingType) {
      if (this.fullToastFor !== id) {
        const how = this.touch ? 'the 🎒 button' : `${keyLabel(settings.get().bindings.inventory)} → Inventory`;
        this.hud.toast(`Drop your ${GUNS[carried].name} first (${how})`);
      }
      this.fullToastFor = id;
      return;
    }
    this.claimingPickup = id;
    this.net.claimPickup(id)
      .then((pickup) => {
        if (!pickup || !this.alive) return;
        if (pickup.type === 'ammo') {
          this.weapon.takeAmmo();
          this.hud.toast('Ammo restocked');
          this.bumpMyMatch('pickups');
          sfx.playPickup();
        } else if (isPickupGun(pickup.type)) {
          this.takeGun(pickup.type, pickup.uses);
        } else {
          const i = this.inventory.add(pickup.type, pickup.uses);
          if (i >= 0) {
            const def = ABILITIES[pickup.type];
            this.hud.toast(`Picked up ${def.name}`);
            this.hint(`ability:${pickup.type}`, () =>
              `${def.name}: ${def.description} — ${this.touch ? 'tap the slot' : keyLabel(settings.get().bindings[ABILITY_ACTIONS[i] ?? 'ability1'])}`);
            this.bumpMyMatch('pickups');
            sfx.playPickup();
          }
        }
      })
      .catch((err: unknown) => console.warn('Pickup claim failed', err))
      .finally(() => { this.claimingPickup = null; });
  }

  /** One player (the lowest id) keeps the map stocked; if they leave, the next one takes over. */
  private runSpawner(dt: number): void {
    if (!this.isLeader()) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    // What spawns is up to the mode (a fixed-gun loadout already switched guns and ammo off).
    const { guns, abilities, ammo } = this.rules;
    const stock: { kind: PickupKind; have: number; max: number }[] = [
      { kind: 'ability', have: this.pickups.countOf('ability'), max: abilities ? MAX_PICKUPS : 0 },
      { kind: 'gun', have: this.pickups.countOf('gun'), max: guns ? MAX_GUN_PICKUPS : 0 },
      { kind: 'ammo', have: this.pickups.countOf('ammo'), max: ammo ? MAX_AMMO_PICKUPS : 0 },
    ];
    // Fill up quickly when the map is bare, then trickle in.
    this.spawnTimer = stock.some((s) => s.have < s.max / 2) ? 1.5 : 7;
    // Top up whichever kind is furthest below its target (each is stocked separately).
    const short = stock.filter((s) => s.have < s.max).sort((a, b) => a.have / a.max - b.have / b.max)[0];
    if (!short) return;
    const spot = this.pickups.randomSpot();
    if (!spot) return;
    const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    const type = short.kind === 'gun' ? pick(PICKUP_GUNS) ?? 'shotgun'
      // Headshots-only modes leave grenades out: a blast can't land a headshot.
      : short.kind === 'ammo' ? 'ammo' : pick(ABILITY_TYPES.filter((t) => !this.rules.headshotsOnly || t !== 'grenade')) ?? 'medkit';
    const pickup: PickupRecord = { type, ...spot };
    void this.net.spawnPickup(pickup);
  }

  /** Walked over a gun: it goes in the empty second slot, or adds ammo to the same gun. */
  private takeGun(kind: Exclude<GunKind, 'rifle'>, rounds: number | undefined): void {
    const def = GUNS[kind];
    const had = this.weapon.special;
    const total = rounds ?? def.mag + def.reserve;
    if (!this.weapon.giveGun(kind, total)) {
      // We picked up another gun while this claim was in flight: put this one back.
      const spot = this.dropSpot();
      const id = this.net.spawnPickup({ type: kind, uses: total, ...spot });
      if (id) this.ignorePickup = { id, ...spot };
      return;
    }
    this.aimHeld = false;
    this.hud.toast(had === kind ? `+${def.name} ammo` : `Picked up ${def.name}`);
    if (had !== kind) this.hint('gun-swap', () => (this.touch ? '⇄ switches guns' : `${keyLabel(keyFor('swap'))} / wheel to switch guns`));
    this.bumpMyMatch('pickups');
    sfx.playSwitch();
  }

  // ---------------------------------------------------------------- loop

  private resize(): void {
    const host = this.renderer.domElement.parentElement;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.weapon.setAspect(w / h);
    this.povWeapon.setAspect(w / h);
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.update(dt);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.alive && !this.replay && !this.hud.get().scoped) {
      this.renderer.clearDepth();
      this.renderer.render(this.weapon.scene, this.weapon.camera);
    } else if (this.pov) {
      this.renderer.clearDepth();
      this.renderer.render(this.povWeapon.scene, this.povWeapon.camera);
    }
  }

  private update(dt: number): void {
    if (!this.alive && this.joined && !this.spectating) {
      this.respawnTimer -= dt;
      const respawnIn = Math.max(0, Math.ceil(this.respawnTimer));
      const death = this.hud.get().death;
      if (death && death.respawnIn !== respawnIn) this.hud.update({ death: { ...death, respawnIn } });
      if (this.respawnTimer <= 0) this.respawn();
    }

    if (this.joined && this.locked && !this.introDone) {
      // First click to play: say what this mode is about (the pause card repeats it).
      this.introDone = true;
      this.hud.announce(this.rules.name, goalOf(this.rules), 3800);
    }
    // Carrying the enemy flag: guns stowed, the flag is the only weapon.
    const melee = this.alive && this.carryingFlag();
    this.weapon.setMelee(melee, this.team ? TEAM_INFO[otherTeam(this.team)].color : undefined);
    const aiming = this.aimHeld && this.alive && this.locked && !this.roundOver && !this.inventoryOpen && !melee;
    this.player.aiming = aiming;
    if (aiming) {
      this.hint('ads', () => `Aiming down sights: tighter spread, slower moves${settings.get().aimToggle ? ' — right-click again to stop' : ''}`);
    }
    // Nobody moves between rounds.
    this.player.update(dt, this.alive && !this.roundOver);
    if (this.spectating && !this.replay) this.updateSpectator(dt);
    this.applyShake(dt);
    this.updateHeartbeat(dt);
    const speed = this.player.horizontalSpeed;
    const sprinting = this.player.sprintHeld && speed > 7;
    this.sprintFor = sprinting && this.alive ? this.sprintFor + dt : 0;
    if (this.sprintFor > 0.6) {
      this.hint('slide', () => (this.touch ? 'Tap ⤓ while sprinting to slide' : `Press ${keyLabel(keyFor('crouch'))} while sprinting to slide`));
    }

    const canAttack = this.triggerHeld && this.alive && this.locked && this.joined && !this.roundOver;
    if (canAttack && melee) {
      if (this.weapon.trySwing(MELEE_COOLDOWN)) this.swingFlag();
    } else if (canAttack && this.weapon.tryFire()) {
      this.shoot();
    }
    if (this.weapon.specialEmpty) {
      this.weapon.removeSpecial();
      this.hud.toast('Out of ammo — back to the rifle');
    }
    if (this.alive && this.weapon.dry && this.triggerHeld && performance.now() - this.dryToastAt > 2500) {
      this.dryToastAt = performance.now();
      // Rifle dry but a picked-up gun has rounds: switch to it rather than clicking.
      if (this.weapon.gun === 'rifle' && this.weapon.special && !this.weapon.specialEmpty) this.switchGun();
      else this.hud.toast(this.weapon.special ? 'Out of ammo — find an ammo box' : 'Out of ammo — find an ammo box or a gun');
    }
    this.publishGun();
    this.weapon.update(dt, speed, sprinting && !this.triggerHeld && !aiming, aiming);
    this.updateZoom();
    this.hud.update({
      ammo: this.weapon.ammo,
      magSize: this.weapon.magSize,
      reserve: this.weapon.reserve,
      gun: this.weapon.gun,
      special: this.weapon.special,
      specialRounds: this.weapon.specialRounds,
      melee,
      reloading: this.weapon.reloading,
    });

    if (this.alive) {
      if (this.player.slideStarted) sfx.playSlide(this.surfaceAt(this.player.position), 0.7);
      // Feet don't step during a slide.
      const sliding = this.player.stance === 'slide';
      const step = this.steps.update(dt, sliding ? 0 : speed, this.player.onGround);
      if (step) this.playStep(step, this.player.position, false, this.player.stance === 'crouch');
    }

    for (const [id, r] of this.remotes) {
      r.setAlly(this.isAlly(id));
      r.setMaxHealth(this.rules.health);
      r.setCarrying(this.mode === 'ctf' && TEAMS.some((t) => this.game.flags[t]?.by === id));
      r.update(dt);
      this.updateRemoteSteps(id, r, dt);
      if (r.consumeReloadStart()) {
        const heard = this.heardFrom(r.position);
        if (heard) sfx.playReload(heard.volume * 1.5);
      }
    }
    this.updateAllySight(dt);
    this.effects.update(dt);
    this.world.sky.position.copy(this.camera.position);
    this.updateDamageIndicators();
    this.updateAbilities(dt);
    this.updateMode();
    // After the player update, so the replay's camera wins.
    this.updateReplay(dt);
    this.applyPov(dt);
    this.recordSelf(dt);

    if (this.joined) this.updatePing(dt);

    if (this.joined) {
      this.sendTimer += dt;
      this.heartbeat += dt;
      if (this.sendTimer >= SEND_INTERVAL) {
        this.sendTimer = 0;
        const pose = this.poseState();
        const key = JSON.stringify(pose);
        const moment = this.moments.get();
        const statsKey = JSON.stringify([this.stats, moment]);
        const statsChanged = statsKey !== this.lastStatsKey;
        if (!this.offline && (key !== this.lastSent || statsChanged || this.heartbeat > HEARTBEAT)) {
          this.lastSent = key;
          this.lastStatsKey = statsKey;
          this.heartbeat = 0;
          void this.net.sendState(statsChanged ? { ...pose, ...this.stats, ...(moment ? { moment } : {}) } : pose);
        }
      }
    }

    this.scoreTimer += dt;
    if (this.scoreTimer > 0.25 && this.hud.get().scoreboardOpen) {
      this.scoreTimer = 0;
      this.hud.update({ scoreboard: this.scoreRows() });
    }
  }

  /**
   * Spectating someone, or the MVP replay: see through their eyes. The camera sits at their eye
   * height looking where they look, their body is hidden from us, and their gun is drawn in
   * first person (raised when they aim, flashing when they fire, zoomed like theirs).
   */
  private applyPov(dt: number): void {
    const target = this.replay
      ? this.replay.pov
      : this.spectating && !this.specFree && this.specTarget ? this.remotes.get(this.specTarget) ?? null : null;
    if (target !== this.pov) {
      this.pov?.setFirstPerson(false);
      this.pov = target;
      target?.setFirstPerson(true);
    }
    if (!target) return;
    const cam = this.camera;
    target.eyePosition(cam.position);
    cam.rotation.set(target.lookPitch, target.yaw, 0);

    const gun = target.heldGun;
    const pv = this.povWeapon;
    // A flag carrier holds the flag they took, in its team's colour.
    const carried = !this.replay && this.specTarget ? TEAMS.find((t) => this.game.flags[t]?.by === this.specTarget) : undefined;
    pv.setMelee(target.carryingFlag, carried ? TEAM_INFO[carried].color : undefined);
    pv.showGun(gun);
    if (target.consumeShotFlash()) pv.flashShot();
    const aim = target.aimAmount;
    pv.update(dt, target.moveSpeed, target.sprinting && aim < 0.5, aim > 0.5);
    const fov = THREE.MathUtils.lerp(settings.get().fov, GUNS[gun].adsFov, aim);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Kick the camera around a little after being hit; dies down over about half a second. */
  private applyShake(dt: number): void {
    if (this.shake <= 0.001) {
      this.shake = 0;
      return;
    }
    this.shake *= Math.exp(-6 * dt);
    if (!settings.get().screenShake || this.replay) return;
    const a = this.shake * 0.035;
    const t = performance.now() / 1000;
    this.camera.rotation.x += Math.sin(t * 61) * a;
    this.camera.rotation.z += Math.sin(t * 47 + 1.3) * a * 0.8;
    this.camera.rotation.y += Math.sin(t * 53 + 2.1) * a * 0.5;
  }

  /** Below 30 health the heart pounds, faster and louder the closer to death. */
  private updateHeartbeat(dt: number): void {
    const low = this.rules.health * LOW_HEALTH;
    if (!this.alive || !this.joined || this.hp > low) {
      this.heartbeatTimer = 0;
      return;
    }
    this.heartbeatTimer -= dt;
    if (this.heartbeatTimer > 0) return;
    const danger = 1 - Math.max(0, this.hp) / low;
    this.heartbeatTimer = 1.1 - 0.5 * danger;
    sfx.playHeartbeat(0.45 + 0.55 * danger);
  }

  /**
   * Point an arc at each recent attacker. Recomputed every frame from their position
   * at the time of the hit, so the arc swings around as we turn.
   */
  private updateDamageIndicators(): void {
    const now = performance.now();
    const p = this.player.position;
    const yaw = this.player.yaw;
    const indicators: DamageIndicator[] = [];
    for (const [id, hit] of this.hitSources) {
      const age = (now - hit.time) / 1000;
      if (age > INDICATOR_HOLD + INDICATOR_FADE) {
        this.hitSources.delete(id);
        continue;
      }
      const dx = hit.at.x - p.x;
      const dz = hit.at.z - p.z;
      // Project onto our facing (forward = -z at yaw 0) and right vectors.
      const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
      const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
      const opacity = age < INDICATOR_HOLD ? 1 : 1 - (age - INDICATOR_HOLD) / INDICATOR_FADE;
      indicators.push({
        id,
        // Rounded so the HUD only re-renders when the arc visibly moves.
        angle: Math.round(THREE.MathUtils.radToDeg(Math.atan2(right, ahead))),
        opacity: Math.round(opacity * 20) / 20,
        strength: Math.round(Math.min(1, 0.4 + hit.damage / 60) * 10) / 10,
      });
    }
    const key = JSON.stringify(indicators);
    if (key === this.lastIndicatorKey) return;
    this.lastIndicatorKey = key;
    this.hud.update({ damageIndicators: indicators });
  }

  /**
   * Teammates behind cover get a glowing outline (and their name tag) drawn through it.
   * Hidden means both their chest and head are blocked from our eyes by the map.
   */
  private updateAllySight(dt: number): void {
    this.allySightTimer -= dt;
    if (this.allySightTimer > 0) return;
    this.allySightTimer = ALLY_SIGHT_INTERVAL;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    for (const r of this.remotes.values()) {
      if (!r.isAlly || !r.alive) {
        r.setOccluded(false);
        continue;
      }
      const hidden = r.sightPoints().every((point) => {
        const toPoint = point.clone().sub(eye);
        const distance = toPoint.length();
        this.sightRay.set(eye, toPoint.normalize());
        this.sightRay.far = Math.max(0, distance - 0.1);
        return this.sightRay.intersectObjects(this.solids, false).length > 0;
      });
      r.setOccluded(hidden);
    }
  }

  /**
   * Zoom with the aim: narrower field of view, and mouse look slowed by the same ratio so
   * the same hand movement covers the same part of the screen (times the aim sensitivity setting).
   */
  private updateZoom(): void {
    const aim = this.weapon.aim;
    const hipFov = settings.get().fov;
    const fov = THREE.MathUtils.lerp(hipFov, GUNS[this.weapon.gun].adsFov, aim);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const zoom = Math.tan(THREE.MathUtils.degToRad(fov / 2)) / Math.tan(THREE.MathUtils.degToRad(hipFov / 2));
    this.player.lookScale = zoom * THREE.MathUtils.lerp(1, settings.get().aimSensitivity, aim);
    // The sniper's scope takes over the screen once it's up to the eye.
    const scoped = GUNS[this.weapon.gun].scope && aim > 0.85;
    this.hud.update({ aiming: aim > 0.6, scoped });
  }

  private lastGunSent: GunKind = 'rifle';
  /** Tell everyone which gun we're holding, so our avatar shows it. */
  private publishGun(): void {
    const gun = this.weapon.gun;
    if (gun === this.lastGunSent || !this.joined) return;
    this.lastGunSent = gun;
    void this.net.sendState({ gun });
  }

  /** Our own movement for the replay recording (other players' come in with their updates). */
  private recordSelf(dt: number): void {
    if (!this.joined || this.roundOver) return;
    this.recordTimer -= dt;
    if (this.recordTimer > 0) return;
    this.recordTimer = RECORD_INTERVAL;
    this.recorder.pose(this.playerId, { name: this.name, color: this.color, ...this.poseState(), alive: this.alive }, this.net.serverNow());
  }

  /** Measure our ping every couple of seconds and publish it for everyone's scoreboard. */
  private updatePing(dt: number): void {
    this.pingTimer -= dt;
    if (this.pingTimer > 0 || this.pingInFlight) return;
    this.pingTimer = PING_INTERVAL;
    this.pingInFlight = true;
    this.net.measurePing(this.ping)
      .then((rtt) => {
        if (rtt === null) return;
        // Smooth out one-off spikes.
        this.ping = Math.round(this.ping === null ? rtt : this.ping * 0.6 + rtt * 0.4);
      })
      .catch((err: unknown) => console.warn('Ping failed', err))
      .finally(() => { this.pingInFlight = false; });
  }

  // ---------------------------------------------------------------- footsteps

  /** Other players' footsteps, quieter with distance and panned toward where they are. */
  private updateRemoteSteps(id: string, remote: RemotePlayer, dt: number): void {
    if (!remote.alive) {
      this.remoteSteps.delete(id);
      return;
    }
    let tracker = this.remoteSteps.get(id);
    if (!tracker) {
      tracker = new StepTracker();
      this.remoteSteps.set(id, tracker);
    }
    // We only get their position, so "on the ground" means standing on the floor or on top of a box.
    const pos = remote.position;
    const grounded = pos.y - this.groundBelow(pos) < 0.08;
    if (remote.consumeSlideStart() && this.joined) {
      const heard = this.heardFrom(pos);
      if (heard) sfx.playSlide(this.surfaceAt(pos), heard.volume * 1.4, heard.pan);
    }
    const step = tracker.update(dt, remote.stance === 'slide' ? 0 : remote.moveSpeed, grounded);
    if (step && this.joined) this.playStep(step, pos, true, remote.stance === 'crouch');
  }

  private surfaceAt(at: THREE.Vector3): sfx.Surface {
    return this.groundBelow(at) > 0.05 ? 'wood' : this.floorSurface;
  }

  /** How loud, and from which side, a sound at `at` reaches us; null when out of hearing range. */
  private heardFrom(at: THREE.Vector3): { volume: number; pan: number } | null {
    const distance = at.distanceTo(this.camera.position);
    if (distance > STEP_HEARING_RANGE) return null;
    // Fade out smoothly toward the edge of hearing range.
    const edge = 1 - Math.max(0, (distance - STEP_HEARING_RANGE * 0.7) / (STEP_HEARING_RANGE * 0.3));
    const local = this.camera.worldToLocal(at.clone());
    const pan = distance > 0.5 ? THREE.MathUtils.clamp(local.x / distance, -1, 1) * 0.85 : 0;
    return { volume: edge / (1 + distance / 5), pan };
  }

  /** @param crouched crouch-walking is much quieter */
  private playStep(step: StepEvent, at: THREE.Vector3, remote = false, crouched = false): void {
    const land = step.kind === 'land';
    // Our own steps: quiet and centered. Bigger drops land harder.
    let volume = land ? Math.min(1, 0.35 + step.airTime * 0.5) : step.running ? 0.5 : 0.38;
    if (crouched && !land) volume *= 0.4;
    let pan = 0;
    if (remote) {
      const heard = this.heardFrom(at);
      if (!heard) return;
      volume *= 1.8 * heard.volume;
      pan = heard.pan;
    }
    sfx.playFootstep(this.surfaceAt(at), volume, pan, land);
  }

  private updateMode(): void {
    if (this.flagField) {
      this.flagField.update(performance.now() / 1000, (id) => {
        // During the replay, carried flags ride on the replay's stand-ins (including ours).
        if (this.replay) return this.replay.carrier(id);
        const r = id === this.playerId ? undefined : this.remotes.get(id);
        return r?.alive ? { position: r.position, yaw: r.yaw } : null;
      });
    }
    if (!this.joined) return;
    if (this.mode === 'ctf') {
      if (this.alive) this.updateFlags();
      this.refereeFlags();
    }
    this.ensureRoundClock();
    this.checkTimeLimit();
    if (this.roundOver && this.net.serverNow() >= this.endedAt + this.intermissionMs()) this.requestNextRound();
    // Keeps the round-over countdown ticking; does nothing when the score hasn't changed.
    this.refreshScore();
    this.updateRoundBed();
    this.updatePresence();
  }

  /** Keep the Discord profile line current (mode, map, score, player count); at most every few seconds. */
  private updatePresence(): void {
    if (!IN_DISCORD) return;
    this.presenceTimer -= 1 / 60;
    if (this.presenceTimer > 0) return;
    this.presenceTimer = 5;
    const map = this.hud.get().map;
    const g = this.game;
    const count = Object.values(this.players).filter((p) => !p.spec).length;
    const details = `${this.rules.name}${map ? ` on ${map.name}` : ''}`;
    let state: string;
    if (this.spectating) state = 'Spectating';
    else if (this.roundOver) state = 'Round over';
    else if (this.team) state = `Red ${g.score.red ?? 0} – ${g.score.blue ?? 0} Blue`;
    else if (this.rules.loadout === 'gungame') state = `Level ${Math.min(this.kills + 1, GUN_GAME_LADDER.length)} of ${GUN_GAME_LADDER.length}`;
    else state = `${this.kills} kill${this.kills === 1 ? '' : 's'}`;
    const key = `${details}|${state}|${count}`;
    if (key === this.presenceKey) return;
    this.presenceKey = key;
    setDiscordActivity({ details, state, partySize: count, partyMax: 16 });
  }

  private scoreRows(): ScoreRow[] {
    return Object.entries(this.players)
      .map(([id, p]) => {
        // Our own stats are fresher locally than the last copy we sent.
        const s = id === this.playerId ? this.stats : p;
        return {
          id,
          name: p.name,
          color: p.color,
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          damage: Math.round(s.damage || 0),
          accuracy: s.shots ? (s.hits || 0) / s.shots : null,
          headshots: s.headshots || 0,
          bestStreak: s.best || 0,
          // Ours is fresher locally than the copy we published.
          ping: id === this.playerId ? this.ping : typeof p.ping === 'number' && p.ping > 0 ? Math.round(p.ping) : null,
          captures: s.captures || 0,
          team: (id === this.playerId ? this.team : p.team) ?? null,
          me: id === this.playerId,
          spectating: id === this.playerId ? this.spectating : !!p.spec,
        };
      })
      .sort((a, b) => Number(a.spectating) - Number(b.spectating) || b.captures - a.captures || b.kills - a.kills
        || b.damage - a.damage || a.deaths - b.deaths);
  }

  /** Stop the game, free GPU resources and leave the room. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.abort.abort();
    this.stopRoundBed();
    if (document.pointerLockElement) document.exitPointerLock();
    keyboardLock()?.unlock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.pickups.dispose();
    this.grenades.dispose();
    this.smoke.dispose();
    this.walls.dispose();
    this.stopReplay();
    this.flagField?.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.hud.dispose();
    await this.dropFlag();
    await this.net.leave();
  }
}

function samePlacement(a: FlagPlacement, b: FlagPlacement): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
