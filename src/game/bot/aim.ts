import { aimAngles, wrapAngle, CHEST_Y, HEAD_Y } from './hitscan';
import { GUNS } from '../gunStats';
import type { GunKind, Stance } from '../../types';

/*
 * How a bot aims: like a person, not like the policy network (which learned aim through noisy relative
 * turns and was the weakest part of a bot). It picks a target, takes a moment to react, puts its
 * crosshair roughly on them, settles in, lags behind someone strafing, can only turn so fast and
 * fights its own recoil. Difficulty is just these numbers.
 *
 * The policy still decides how to move and whether it wants to shoot; the trigger is only pulled when
 * the crosshair is actually on the target.
 *
 * It also aims down the sights the way a player does: at range (any range with the scoped sniper) the
 * sights come up while it engages, tightening the gun's spread as the player's do (and slowing it down:
 * callers set the mover's `aiming`). It holds fire until they're up. Better bots do this more reliably.
 */

export interface AimSkill {
  /** Seconds before a newly seen target is engaged at all */
  reaction: number;
  /** First aim error (radians), before distance and own movement scale it up */
  initialError: number;
  /** Time constant (s) for the error to settle */
  settle: number;
  /** What's left once settled (radians) */
  trackError: number;
  /** Fastest turn (radians per second) */
  maxTurn: number;
  /** Chance an engagement goes for the head */
  headChance: number;
  /** Chance an engagement at range is fought down the sights (the sniper always is) */
  ads: number;
}

export type BotSkill = 'easy' | 'normal' | 'hard' | 'expert';
export const BOT_SKILLS: BotSkill[] = ['easy', 'normal', 'hard', 'expert'];

export const AIM_SKILLS: Record<BotSkill, AimSkill> = {
  easy: { reaction: 0.55, initialError: 0.25, settle: 0.6, trackError: 0.06, maxTurn: 4, headChance: 0, ads: 0.4 },
  normal: { reaction: 0.35, initialError: 0.15, settle: 0.4, trackError: 0.035, maxTurn: 6, headChance: 0.05, ads: 0.75 },
  hard: { reaction: 0.22, initialError: 0.09, settle: 0.25, trackError: 0.02, maxTurn: 9, headChance: 0.15, ads: 0.95 },
  expert: { reaction: 0.14, initialError: 0.05, settle: 0.15, trackError: 0.01, maxTurn: 14, headChance: 0.3, ads: 1 },
};

/** Targets at least this far away (m) are fought down the sights: the scope always, the shotgun only far out */
export const ADS_RANGE: Record<GunKind, number> = { rifle: 8, deagle: 8, sniper: 0, shotgun: 15 };
/** How fast the sights come up and go down: the player's rate (weapon.ts ADS_SPEED) */
const ADS_RATE = 14;
/** The trigger waits until the sights are this far up */
const ADS_READY = 0.8;

/** Someone the bot could aim at (feet position) */
export interface AimCandidate {
  id: string;
  x: number;
  y: number;
  z: number;
  stance: Stance;
  /** Carrying our flag: always first */
  carrying?: boolean;
}

export interface AimSelf {
  /** Eyes */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Horizontal speed (m/s): aiming on the move is harder */
  speed: number;
  gun: GunKind;
  /** 0..1: nerves make a hurt bot shakier */
  shaky: number;
  /** Reloading: the sights stay down */
  reloading?: boolean;
}

/** A lost target is still aimed at (where it was) this long, in case it pops back out */
const HOLD_TIME = 0.6;
/** Lag behind a moving target, as a share of the settle time */
const LAG = 0.5;
/** Body half-width (m), for the "on target" cone */
const BODY_HALF = 0.32;
const HEAD_HALF = 0.15;
const MAX_PITCH = Math.PI / 2 - 0.01;

export class AimController {
  target: string | null = null;
  private engagedAt = 0;
  private lastSeenAt = 0;
  private head = false;
  /** Current aim offset from the target (radians), decaying as the bot settles in */
  private errYaw = 0;
  private errPitch = 0;
  /** Smoothed tracking wobble */
  private wobbleYaw = 0;
  private wobblePitch = 0;
  private last: { x: number; z: number; t: number } | null = null;
  private angSpeed = 0;
  private angDir = 0;
  /** The target's position as last seen (aimed at for a moment after losing sight) */
  private lastPos: AimCandidate | null = null;
  /** Whether the crosshair is on the target this frame (the trigger may be pulled) */
  onTarget = false;
  /** Engaged but still reacting: nothing happens yet */
  reacting = false;
  /** How far the sights are up (0..1), and whether this engagement is fought down them */
  ads = 0;
  private adsChoice = false;

  constructor(public skill: AimSkill, private readonly rand: () => number = Math.random) {}

  /** Whether the bot is aiming at someone (then the aim is this controller's, not the policy's) */
  get engaged(): boolean {
    return this.target !== null;
  }

  reset(): void {
    this.target = null;
    this.ads = 0;
    this.lastPos = null;
    this.last = null;
    this.onTarget = false;
    this.reacting = false;
  }

  /**
   * One frame: choose a target among the enemies in view (`visible`), preferring a flag carrier, then
   * whoever just shot us (`shooter`), then the current target, then the nearest. Returns the new
   * yaw and pitch for the bot (unchanged when there's no one to aim at).
   */
  update(dt: number, now: number, self: AimSelf, visible: readonly AimCandidate[], shooter: string | null = null): { yaw: number; pitch: number } {
    const pick = this.choose(self, visible, shooter);
    if (pick) {
      if (pick.id !== this.target) this.engage(pick, self, now);
      this.lastSeenAt = now;
      this.lastPos = pick;
    } else if (this.target && now - this.lastSeenAt > HOLD_TIME) {
      this.reset();
    }
    this.onTarget = false;
    this.reacting = false;
    const t = pick ?? this.lastPos;
    // Sights up at range while engaged (down while reloading, or with nobody to aim at).
    const adsWanted = !!this.target && !!t && this.adsChoice && !self.reloading
      && Math.hypot(t.x - self.x, t.z - self.z) >= ADS_RANGE[self.gun];
    this.ads += ((adsWanted ? 1 : 0) - this.ads) * (1 - Math.exp(-ADS_RATE * dt));
    if (!adsWanted && this.ads < 0.01) this.ads = 0;
    if (!this.target || !t) return { yaw: self.yaw, pitch: self.pitch };

    // Reacting: the crosshair hasn't moved yet.
    if (now - this.engagedAt < this.skill.reaction) {
      this.reacting = true;
      return { yaw: self.yaw, pitch: self.pitch };
    }

    // Where the target is, and how fast it crosses our view (we lag behind that).
    const aimY = t.y + (this.head ? HEAD_Y[t.stance] : CHEST_Y[t.stance]);
    const [targetYaw, targetPitch] = aimAngles(self.x, self.y, self.z, t.x, aimY, t.z);
    if (this.last && now > this.last.t) {
      const [prevYaw] = aimAngles(self.x, self.y, self.z, this.last.x, aimY, this.last.z);
      const w = wrapAngle(targetYaw - prevYaw) / (now - this.last.t);
      this.angSpeed += (Math.abs(w) - this.angSpeed) * Math.min(1, dt * 8);
      this.angDir = Math.sign(w) || this.angDir;
    }
    this.last = { x: t.x, z: t.z, t: now };

    // Settle in: the first error fades toward a small wobble.
    const decay = Math.exp(-dt / this.skill.settle);
    this.errYaw *= decay;
    this.errPitch *= decay;
    const wob = this.skill.trackError * (1 + self.shaky);
    const k = Math.min(1, dt * 3);
    this.wobbleYaw += (gauss(this.rand) * wob - this.wobbleYaw) * k;
    this.wobblePitch += (gauss(this.rand) * wob * 0.6 - this.wobblePitch) * k;
    const lag = -this.angDir * this.angSpeed * this.skill.settle * LAG;

    const wantYaw = targetYaw + this.errYaw + this.wobbleYaw + lag;
    const wantPitch = targetPitch + this.errPitch + this.wobblePitch;
    // Turn toward it, no faster than a person can.
    const step = this.skill.maxTurn * dt;
    const dYaw = clamp(wrapAngle(wantYaw - self.yaw), -step, step);
    const dPitch = clamp(wantPitch - self.pitch, -step, step);
    const yaw = self.yaw + dYaw;
    const pitch = clamp(self.pitch + dPitch, -MAX_PITCH, MAX_PITCH);

    // On target: the crosshair (plus the gun's own spread) is within the body (or head) at that range.
    if (pick) {
      const dist = Math.hypot(t.x - self.x, aimY - self.y, t.z - self.z);
      const half = this.head ? HEAD_HALF : BODY_HALF;
      const def = GUNS[self.gun];
      const cone = Math.atan2(half, Math.max(dist, 0.5)) + def.spread * (1 + (def.adsSpread - 1) * this.ads) * 0.5;
      // Going down the sights: wait for them to come up rather than firing from the hip.
      const ready = !adsWanted || this.ads >= ADS_READY;
      this.onTarget = ready && Math.abs(wrapAngle(targetYaw - yaw)) < cone * 1.2 && Math.abs(targetPitch - pitch) < cone * 2;
    }
    return { yaw, pitch };
  }

  private choose(self: AimSelf, visible: readonly AimCandidate[], shooter: string | null): AimCandidate | null {
    if (!visible.length) return null;
    const dist = (c: AimCandidate) => Math.hypot(c.x - self.x, c.z - self.z);
    const carrier = visible.filter((c) => c.carrying && dist(c) < 25).sort((a, b) => dist(a) - dist(b))[0];
    if (carrier) return carrier;
    const current = visible.find((c) => c.id === this.target);
    const fromShooter = shooter ? visible.find((c) => c.id === shooter) : undefined;
    // Stick with the current target unless someone else is shooting at us and our target isn't.
    if (current && (!fromShooter || fromShooter === current)) return current;
    if (fromShooter) return fromShooter;
    return [...visible].sort((a, b) => dist(a) - dist(b))[0] ?? null;
  }

  private engage(c: AimCandidate, self: AimSelf, now: number): void {
    this.target = c.id;
    this.engagedAt = now;
    this.last = null;
    this.angSpeed = 0;
    this.head = this.rand() < this.skill.headChance;
    // Nobody hits anything with an unscoped sniper: that one is always fought through the scope.
    this.adsChoice = self.gun === 'sniper' || this.rand() < this.skill.ads;
    // The first aim is off by more at range and on the move.
    const dist = Math.hypot(c.x - self.x, c.z - self.z);
    const size = this.skill.initialError * (1 + dist / 40) * (1 + self.speed / 8) * (1 + self.shaky);
    const angle = this.rand() * Math.PI * 2;
    this.errYaw = Math.cos(angle) * size;
    this.errPitch = Math.sin(angle) * size * 0.5;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function gauss(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
