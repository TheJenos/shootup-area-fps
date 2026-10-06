import * as THREE from 'three';
import { RemotePlayer } from './remotePlayer';
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
}

interface Track {
  name: string;
  color: string;
  samples: PoseSample[];
}

export type ReplayEvent =
  | { t: number; kind: 'shot'; o: Vec3Tuple; e: Vec3Tuple; hit: boolean; w?: GunKind; ends?: Vec3Tuple[]; from?: string }
  | { t: number; kind: 'kill'; killer: string; victim: string; head: boolean }
  | { t: number; kind: 'grenade'; id: string; o: Vec3Tuple; v: Vec3Tuple }
  | { t: number; kind: 'blast'; id: string; p: Vec3Tuple }
  | { t: number; kind: 'smoke'; id: string; o: Vec3Tuple; v: Vec3Tuple }
  | { t: number; kind: 'flag'; team: Team; placement: FlagPlacement };

/**
 * Everything this client saw during the round (poses and events, in server ms), so the
 * MVP's highlight can be replayed when the round ends. Cleared at the start of each round.
 */
export class ReplayRecorder {
  readonly tracks = new Map<string, Track>();
  readonly events: ReplayEvent[] = [];
  /** Flag positions when recording started */
  private initialFlags: Partial<Record<Team, FlagPlacement>> = {};

  reset(flags: Partial<Record<Team, FlagPlacement>> = {}): void {
    this.tracks.clear();
    this.events.length = 0;
    this.initialFlags = { ...flags };
  }

  pose(
    id: string, data: Pick<PlayerState, 'name' | 'color' | 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'alive' | 'stance' | 'aim'>, t: number,
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
    // Always keep deaths, respawns, stance and aim changes, otherwise thin out to the sample rate.
    if (last && t - last.t < SAMPLE_GAP && last.alive === alive && last.stance === stance && !!last.aim === aim) return;
    track.samples.push({
      t, x: data.x || 0, y: data.y || 0, z: data.z || 0, yaw: data.yaw || 0, pitch: data.pitch || 0, alive, stance, aim,
    });
  }

  event(e: ReplayEvent): void {
    this.events.push(e);
  }

  /** Where each flag was at time `t` */
  flagsAt(t: number): Partial<Record<Team, FlagPlacement>> {
    const flags = { ...this.initialFlags };
    for (const e of this.events) if (e.kind === 'flag' && e.t <= t) flags[e.team] = e.placement;
    return flags;
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
  let dYaw = (b.yaw - a.yaw) % (Math.PI * 2);
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  return {
    t,
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    yaw: a.yaw + dYaw * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    alive: true,
    stance: a.stance,
    aim: a.aim,
  };
}

const fromArr = (a: Vec3Tuple) => new THREE.Vector3(a[0], a[1], a[2]);

export interface ReplayOptions {
  mvp: MvpInfo;
  recorder: ReplayRecorder;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  character: CharacterAsset;
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

  constructor(opts: ReplayOptions) {
    this.opts = opts;
    const { mvp, recorder } = opts;
    this.start = mvp.start - LEAD_IN;
    this.end = mvp.end + LEAD_OUT;
    this.rate = Math.max(1, (this.end - this.start) / MAX_REPLAY);
    this.time = this.start;

    const track = recorder.tracks.get(mvp.id);
    this.hasFootage = mvp.start > 0
      && !!track?.samples.some((s) => s.t >= this.start - 2_000 && s.t <= this.end);
    if (!this.hasFootage) return;

    for (const [id, t] of recorder.tracks) {
      const first = sampleAt(t.samples, this.start) ?? t.samples.find((s) => s.t <= this.end);
      if (!first) continue;
      const ghost = new RemotePlayer(`replay:${id}`, { ...first, name: t.name, color: t.color, hp: 100, kills: 0, deaths: 0 }, opts.scene, opts.character);
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
        ghost.setData({ x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch, alive: pose.alive, stance: pose.stance ?? 'stand', aim: !!pose.aim });
      }
      ghost.setCarrying(TEAMS.some((t) => { const f = this.flags[t]; return f?.at === 'carried' && f.carrier === id; }));
      ghost.update(dt);
    }
  }

  /** Whose eyes the replay is seen through: the MVP, while their stand-in is on screen. */
  get pov(): RemotePlayer | null {
    if (!this.hasFootage) return null;
    const ghost = this.ghosts.get(this.opts.mvp.id);
    return ghost && ghost.alive && ghost.visible ? ghost : null;
  }

  dispose(): void {
    for (const ghost of this.ghosts.values()) ghost.dispose();
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
        if (e.from) this.ghosts.get(e.from)?.noteShot();
        const o = fromArr(e.o);
        for (const p of [e.e, ...(e.ends ?? [])]) {
          const end = fromArr(p);
          effects.tracer(o, end, 0xffa27a);
          effects.impact(end, e.hit ? 0xff3b3b : 0xffc35c);
        }
        sfx.playShot(0.6 / (1 + o.distanceTo(camera.position) / 10), e.w ?? 'rifle');
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
