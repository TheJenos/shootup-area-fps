import * as THREE from 'three';
import { RemotePlayer } from './remotePlayer';
import { lerpPose } from './poseBuffer';
import { simulateGrenade, type GrenadeFx } from './grenades';
import type { Effects } from './weapon';
import type { FlagCarrier, FlagField, FlagPlacement } from './flags';
import type { SmokeField } from './deployables';
import type { CharacterAsset } from './character';
import { GRENADE_RADIUS } from './abilities';
import { TEAMS } from './modes';
import * as sfx from './audio';
import type { GunKind, MvpInfo, PlayerState, Stance, Team, Vec3Tuple } from '../types';

/** Keep at most one pose per player per this many ms (about 12 a second). */
const SAMPLE_GAP = 80;
/** Seconds of context before and after the highlight */
const LEAD_IN = 1500;
const LEAD_OUT = 1500;
/** The replay must fit in the MVP screen; longer highlights play faster. */
const MAX_REPLAY = 9_000;
/**
 * The recording keeps the last minute (the kill cam looks a few seconds back) and the highlights that
 * may still become the MVP replay, with the replay's lead-in (plus the footage check's slack) and
 * lead-out. Trimmed every few seconds (ms).
 */
const KEEP_RECENT = 60_000;
const KEEP_BEFORE = LEAD_IN + 2_000;
const KEEP_AFTER = LEAD_OUT;
const TRIM_EVERY = 5_000;

interface PoseSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  alive: boolean;
  stance?: Stance;
  aim?: boolean;
  gun?: GunKind;
}

interface Track {
  name: string;
  color: string;
  samples: PoseSample[];
}

/** A stretch of the round (server ms) that may be replayed: a player's best highlight so far */
export interface Highlight {
  start: number;
  end: number;
}

interface FlagChange {
  t: number;
  placement: FlagPlacement;
}

export type ReplayEvent =
  | { t: number; kind: 'shot'; o: Vec3Tuple; e: Vec3Tuple; hit: boolean; w?: GunKind; ends?: Vec3Tuple[]; from?: string }
  | { t: number; kind: 'kill'; killer: string; victim: string; head: boolean }
  | { t: number; kind: 'knife'; from: string }
  | { t: number; kind: 'grenade'; id: string; o: Vec3Tuple; v: Vec3Tuple }
  | { t: number; kind: 'blast'; id: string; p: Vec3Tuple }
  | { t: number; kind: 'smoke'; id: string; o: Vec3Tuple; v: Vec3Tuple }
  | { t: number; kind: 'flag'; team: Team; placement: FlagPlacement };

/**
 * What this client saw during the round (poses and events, in server ms), so the kill cam can replay
 * the last few seconds and the MVP's highlight can be replayed when the round ends. Cleared at the
 * start of each round; in between it keeps the last minute and the highlights that may be the MVP's.
 */
export class ReplayRecorder {
  readonly tracks = new Map<string, Track>();
  readonly events: ReplayEvent[] = [];
  /** Flag positions when recording started (or as of the oldest change folded in by a trim) */
  private initialFlags: Partial<Record<Team, FlagPlacement>> = {};
  /** Each team's flag changes, in time order, so flagsAt doesn't scan every event */
  private readonly flagChanges: Partial<Record<Team, FlagChange[]>> = {};
  /** Every player's best highlight so far: kept past the last minute, any may be the MVP replay */
  private readonly highlights: () => Iterable<Highlight | null | undefined>;
  /** The latest time recorded, and when we last trimmed (server ms) */
  private latest = 0;
  private trimmedAt = 0;
  /** Replays playing from the recording: it isn't trimmed under them */
  private holds = 0;

  constructor(highlights: () => Iterable<Highlight | null | undefined> = () => []) {
    this.highlights = highlights;
  }

  reset(flags: Partial<Record<Team, FlagPlacement>> = {}): void {
    this.tracks.clear();
    this.events.length = 0;
    this.initialFlags = { ...flags };
    for (const team of TEAMS) delete this.flagChanges[team];
    this.latest = this.trimmedAt = 0;
  }

  pose(
    id: string, data: Pick<PlayerState, 'name' | 'color' | 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'alive' | 'stance' | 'aim' | 'gun'>, t: number,
  ): void {
    let track = this.tracks.get(id);
    if (!track) {
      track = { name: data.name, color: data.color, samples: [] };
      this.tracks.set(id, track);
    }
    track.name = data.name;
    track.color = data.color;
    const alive = data.alive !== false;
    const last = track.samples[track.samples.length - 1];
    const stance = data.stance ?? 'stand';
    const aim = !!data.aim;
    const gun = data.gun ?? 'rifle';
    // Always keep deaths, respawns, stance, aim and gun changes, otherwise thin out to the sample rate.
    if (last && t - last.t < SAMPLE_GAP && last.alive === alive && last.stance === stance && !!last.aim === aim && last.gun === gun) return;
    track.samples.push({
      t, x: data.x || 0, y: data.y || 0, z: data.z || 0, yaw: data.yaw || 0, pitch: data.pitch || 0, alive, stance, aim, gun,
    });
    this.tick(t);
  }

  event(e: ReplayEvent): void {
    this.events.push(e);
    if (e.kind === 'flag') {
      const changes = (this.flagChanges[e.team] ??= []);
      // In time order (one can arrive a little late).
      let i = changes.length;
      while (i > 0 && changes[i - 1]!.t > e.t) i--;
      changes.splice(i, 0, { t: e.t, placement: e.placement });
    }
    this.tick(e.t);
  }

  /** Where each flag was at time `t` */
  flagsAt(t: number): Partial<Record<Team, FlagPlacement>> {
    const flags = { ...this.initialFlags };
    for (const team of TEAMS) {
      const changes = this.flagChanges[team];
      if (!changes?.length) continue;
      // The last change at or before `t`.
      let lo = 0;
      let hi = changes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (changes[mid]!.t <= t) lo = mid + 1;
        else hi = mid;
      }
      const change = changes[lo - 1];
      if (change) flags[team] = change.placement;
    }
    return flags;
  }

  /** A replay is playing from the recording: don't trim it until it's released. */
  hold(): void {
    this.holds++;
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
  }

  private tick(t: number): void {
    if (t > this.latest) this.latest = t;
    if (this.latest - this.trimmedAt >= TRIM_EVERY && !this.holds) this.trim(this.latest);
  }

  /**
   * Drop what's older than the last minute, except the highlights (and their lead-in and lead-out).
   * Each player keeps the pose from just before any stretch that's kept, so a replay starting there
   * has somewhere to put them (someone standing still sends few poses).
   */
  trim(now: number): void {
    this.trimmedAt = now;
    const cutoff = now - KEEP_RECENT;
    const windows: Highlight[] = [];
    for (const h of this.highlights()) {
      if (h && h.start > 0) windows.push({ start: h.start - KEEP_BEFORE, end: h.end + KEEP_AFTER });
    }
    const kept = (t: number) => t >= cutoff || windows.some((w) => t >= w.start && t <= w.end);

    for (const { samples } of this.tracks.values()) {
      const n = samples.length;
      // Nothing old enough to go
      if (!n || samples[0]!.t >= cutoff) continue;
      let w = 0;
      for (let i = 0; i < n; i++) {
        const s = samples[i]!;
        const next = samples[i + 1];
        if (kept(s.t) || i === n - 1 || (next && kept(next.t))) samples[w++] = s;
      }
      samples.length = w;
    }

    let w = 0;
    for (const e of this.events) if (kept(e.t)) this.events[w++] = e;
    this.events.length = w;

    // Flag changes before anything a replay can start from are folded into the starting positions.
    const floor = windows.reduce((m, h) => Math.min(m, h.start), cutoff);
    for (const team of TEAMS) {
      const changes = this.flagChanges[team];
      if (!changes) continue;
      let folded = 0;
      while (folded < changes.length && changes[folded]!.t <= floor) folded++;
      if (!folded) continue;
      this.initialFlags[team] = changes[folded - 1]!.placement;
      changes.splice(0, folded);
    }
  }
}

/** Pose at time `t`, between the two samples around it. */
function sampleAt(samples: PoseSample[], t: number): PoseSample | null {
  if (!samples.length || t < (samples[0]?.t ?? 0)) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((samples[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = samples[lo] as PoseSample;
  const b = samples[lo + 1];
  if (!b || !a.alive || !b.alive) return a;
  const k = (t - a.t) / Math.max(1, b.t - a.t);
  const p = lerpPose(a, b, k, { t, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  return { ...p, t, alive: true, stance: a.stance, aim: a.aim, gun: a.gun };
}

const fromArr = (a: Vec3Tuple) => new THREE.Vector3(a[0], a[1], a[2]);

/**
 * Replay stand-ins, kept from one replay to the next: making one clones the character (skinned mesh,
 * materials, name tag, guns), which every kill cam used to do for every player. A few are made when
 * the game loads; a replay with more players makes the rest, and they're all kept for the next.
 */
export class StandIns {
  private readonly spare: RemotePlayer[] = [];
  private readonly all: RemotePlayer[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly character: CharacterAsset) {}

  /** Have at least `count` made. */
  warm(count: number): void {
    while (this.all.length < count) {
      const ghost = this.make({ name: '', color: '#ffffff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, hp: 100, kills: 0, deaths: 0 });
      ghost.park();
      this.spare.push(ghost);
    }
  }

  take(data: PlayerState): RemotePlayer {
    const ghost = this.spare.pop();
    if (!ghost) return this.make(data);
    ghost.reuse(data);
    return ghost;
  }

  give(ghost: RemotePlayer): void {
    ghost.park();
    this.spare.push(ghost);
  }

  dispose(): void {
    for (const ghost of this.all) ghost.dispose();
    this.all.length = 0;
    this.spare.length = 0;
  }

  private make(data: PlayerState): RemotePlayer {
    const ghost = new RemotePlayer('replay', data, this.scene, this.character);
    this.all.push(ghost);
    return ghost;
  }
}

export interface ReplayOptions {
  /** Whose eyes, and the moment to show (server ms) */
  mvp: Pick<MvpInfo, 'id' | 'start' | 'end'>;
  /** Context before and after the moment (ms), and the longest the replay may take (it plays faster to fit) */
  leadIn?: number;
  leadOut?: number;
  maxLength?: number;
  recorder: ReplayRecorder;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  character: CharacterAsset;
  /** Where the stand-ins come from and go back to (without: made for this replay, and thrown away) */
  standIns?: StandIns;
  effects: Effects;
  grenades: GrenadeFx;
  colliders: THREE.Box3[];
  /** The map's ground height, for grenade arcs */
  terrainAt(x: number, z: number): number;
  solids: THREE.Object3D[];
  flagField: FlagField | null;
  smoke?: SmokeField;
  /** Called for each kill as the replay reaches it (for the kill feed) */
  onKill(killer: string, victim: string, head: boolean): void;
}

/**
 * Plays back the MVP's highlight with stand-in avatars and a chase camera behind the MVP.
 * Without a recording of the moment (we joined later), it slowly circles the map instead.
 */
export class ReplayDirector {
  /** False when there's no recording of the moment and we show the fallback fly-around */
  readonly hasFootage: boolean;

  private readonly opts: ReplayOptions;
  private readonly ghosts = new Map<string, RemotePlayer>();
  private readonly start: number;
  private readonly end: number;
  private readonly rate: number;
  private time: number;
  private eventIndex = 0;
  private orbit = 0;
  /** Where each flag is at the replay's current time, so carriers' stand-ins stow their guns */
  private flags: Partial<Record<Team, FlagPlacement>> = {};
  private disposed = false;

  /** Whose eyes the replay is seen through */
  get viewerId(): string {
    return this.opts.mvp.id;
  }

  constructor(opts: ReplayOptions) {
    this.opts = opts;
    const { mvp, recorder } = opts;
    // Its events are played by index, and the kill cam's end is still being recorded: no trimming meanwhile.
    recorder.hold();
    this.start = mvp.start - (opts.leadIn ?? LEAD_IN);
    this.end = mvp.end + (opts.leadOut ?? LEAD_OUT);
    this.rate = Math.max(1, (this.end - this.start) / (opts.maxLength ?? MAX_REPLAY));
    this.time = this.start;

    const track = recorder.tracks.get(mvp.id);
    this.hasFootage = mvp.start > 0
      && !!track?.samples.some((s) => s.t >= this.start - 2_000 && s.t <= this.end);
    if (!this.hasFootage) return;

    for (const [id, t] of recorder.tracks) {
      const first = sampleAt(t.samples, this.start) ?? t.samples.find((s) => s.t <= this.end);
      if (!first) continue;
      const data: PlayerState = { ...first, name: t.name, color: t.color, hp: 100, kills: 0, deaths: 0 };
      const ghost = opts.standIns?.take(data) ?? new RemotePlayer(`replay:${id}`, data, opts.scene, opts.character);
      this.ghosts.set(id, ghost);
    }
    this.eventIndex = recorder.events.findIndex((e) => e.t > this.start);
    if (this.eventIndex < 0) this.eventIndex = recorder.events.length;
    this.flags = recorder.flagsAt(this.start);
    for (const team of TEAMS) opts.flagField?.set(team, this.flags[team] ?? { at: 'base' });
  }

  /** Where a carried flag should be drawn during the replay */
  carrier(id: string): FlagCarrier | null {
    const ghost = this.ghosts.get(id);
    return ghost?.alive ? { position: ghost.position, yaw: ghost.yaw, hand: ghost.handPosition(new THREE.Vector3()), swing: ghost.flagSwing } : null;
  }

  update(dt: number): void {
    if (!this.hasFootage) {
      this.flyAround(dt);
      return;
    }
    const before = this.time;
    // Hold on the last frame once the highlight is over.
    this.time = Math.min(this.end, this.time + dt * 1000 * this.rate);
    this.playEvents(before, this.time);

    for (const [id, ghost] of this.ghosts) {
      const track = this.opts.recorder.tracks.get(id);
      const pose = track ? sampleAt(track.samples, this.time) : null;
      ghost.setVisible(!!pose);
      if (pose) {
        ghost.setData({
          x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch, alive: pose.alive, stance: pose.stance ?? 'stand', aim: !!pose.aim,
          gun: pose.gun ?? 'rifle',
        });
      }
      ghost.setCarrying(TEAMS.some((t) => { const f = this.flags[t]; return f?.at === 'carried' && f.carrier === id; }));
      ghost.update(dt);
    }
  }

  /** Played to the end (it holds on the last frame after that) */
  get finished(): boolean {
    return !this.hasFootage || this.time >= this.end;
  }

  /** Whose highlight this is */
  get mvpId(): string {
    return this.opts.mvp.id;
  }

  /** The team whose flag `id` is carrying at the replay's current time */
  carriedFlag(id: string): Team | undefined {
    return TEAMS.find((t) => { const f = this.flags[t]; return f?.at === 'carried' && f.carrier === id; });
  }

  /** Whose eyes the replay is seen through: the MVP, while their stand-in is on screen. */
  get pov(): RemotePlayer | null {
    if (!this.hasFootage) return null;
    const ghost = this.ghosts.get(this.opts.mvp.id);
    return ghost && ghost.alive && ghost.visible ? ghost : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opts.recorder.release();
    const { standIns } = this.opts;
    for (const ghost of this.ghosts.values()) {
      if (standIns) standIns.give(ghost);
      else ghost.dispose();
    }
    this.ghosts.clear();
  }

  private playEvents(from: number, to: number): void {
    const { events } = this.opts.recorder;
    const { effects, grenades, colliders, terrainAt, flagField, camera, onKill, smoke } = this.opts;
    while (this.eventIndex < events.length) {
      const e = events[this.eventIndex];
      if (!e || e.t > to) break;
      this.eventIndex++;
      if (e.t <= from) continue;
      if (e.kind === 'shot') {
        const shooter = e.from ? this.ghosts.get(e.from) : undefined;
        shooter?.showGun(e.w ?? 'rifle');
        shooter?.noteShot();
        const o = fromArr(e.o);
        for (const p of [e.e, ...(e.ends ?? [])]) {
          const end = fromArr(p);
          effects.tracer(o, end, 0xffa27a);
          effects.impact(end, e.hit ? 0xff3b3b : 0xffc35c);
        }
        sfx.playShot(0.6 / (1 + o.distanceTo(camera.position) / 10), e.w ?? 'rifle');
      } else if (e.kind === 'knife') {
        this.ghosts.get(e.from)?.noteKnife();
        sfx.playKnife(0.8 / (1 + (this.ghosts.get(e.from)?.position.distanceTo(camera.position) ?? 0) / 10));
      } else if (e.kind === 'kill') {
        onKill(e.killer, e.victim, e.head);
        // The victim's stand-in goes down as a ragdoll, shoved away from the killer.
        const killer = this.ghosts.get(e.killer);
        if (killer && e.killer !== e.victim) this.ghosts.get(e.victim)?.knockback(killer.position, 4, e.head);
      } else if (e.kind === 'grenade') {
        grenades.launch(`replay:${e.id}`, simulateGrenade(fromArr(e.o), fromArr(e.v), colliders, 'grenade', terrainAt));
      } else if (e.kind === 'blast') {
        const p = fromArr(e.p);
        grenades.explode(`replay:${e.id}`, p, GRENADE_RADIUS);
        sfx.playExplosion(0.8 / (1 + p.distanceTo(camera.position) / 12));
      } else if (e.kind === 'smoke') {
        const arc = simulateGrenade(fromArr(e.o), fromArr(e.v), colliders, 'smoke', terrainAt);
        grenades.launch(`replay:${e.id}`, arc);
        smoke?.spawn(`replay:${e.id}`, arc.end);
      } else if (e.kind === 'flag') {
        this.flags[e.team] = e.placement;
        flagField?.set(e.team, e.placement);
      }
    }
  }

  /** No recording of the moment: slowly circle the arena instead. */
  private flyAround(dt: number): void {
    const { camera } = this.opts;
    this.orbit += dt * 0.12;
    camera.position.set(Math.sin(this.orbit) * 34, 20, Math.cos(this.orbit) * 34);
    camera.lookAt(0, 0, 0);
  }
}
