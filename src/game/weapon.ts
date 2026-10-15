import * as THREE from 'three';
import { playEmpty, playReload } from './audio';
import { GUNS, buildGunModel, maxReserve, type GunModel } from './guns';
import type { GunKind } from '../types';
import { FpArms } from './fpArms';

/** The weapon camera's field of view: wide enough to see the hand on the grip */
const VIEW_FOV = 70;
/**
 * At the hip the gun points straight ahead, a little to the right of the eye and pitched up slightly,
 * the way the viewmodel rig the arms come from holds it (see fpArms.ts). Both blend to zero when aiming.
 */
export const HIP_CANT = { yaw: 0, pitch: 0.082 };
/** How quickly the gun moves between hip and sights (1/s) */
const ADS_SPEED = 14;
/** Seconds from the end of a sprint until the gun can fire (it's being brought back up) */
const SPRINT_RAISE = 0.15;
/** Lowering one gun and raising the other (s) */
const SWITCH_TIME = 0.35;
/** One swing of the flag, start to finish (s) */
const SWING_TIME = 0.4;
/** One knife slash, start to finish: in from below, across the view, and away (s) */
const KNIFE_TIME = 0.42;
/**
 * The knife in first person, in the hand's "gun space" (x right, y up, -z forward; the right hand closes
 * round a point 7 cm under the origin, as on a pistol grip): where the handle runs through the fist,
 * and how far the blade is tipped forward from upright.
 */
const KNIFE_GRIP = new THREE.Vector3(0, 0, 0.03);
const KNIFE_TIP_FORWARD = 0.5;
/** Ready (start of the slash, up on the right) and follow-through (low on the left), camera space */
const KNIFE_FROM = { x: 0.26, y: -0.1, z: -0.42, roll: 1.0, yaw: 0.35 };
const KNIFE_TO = { x: -0.14, y: -0.26, z: -0.42, roll: 1.5, yaw: -0.25 };
/** First-person flag: pole length (m), where its foot is held (camera space) and how it leans */
const FLAG_POLE = 1.5;
const FLAG_HOLD = { x: 0.22, y: -0.5, z: -0.38, pitch: -0.1, yaw: 0, roll: -0.06 };
/** Where the hands grip the pole (up from its foot): right hand high, left hand low */
const FLAG_GRIP = { upper: 0.6, lower: 0.35 };
/**
 * The hand holds are measured on the rifle, where the anchor is the barrel and the hand closes round the
 * grip below it. On the pole the anchor has to be shifted (pole space: x right, z toward us) so the pole
 * runs through the hollow of each fist, not the back of the hand. Measured from the finger bones.
 */
const FLAG_FIST = { right: new THREE.Vector3(-0.004, 0, 0.07), left: new THREE.Vector3(0.003, 0, -0.09) };
/** The cloth is turned back and out to the right (the hands follow the pole, not the cloth) */
const FLAG_CLOTH_YAW = 0.7;
/** A zombie's swipe of the claws, start to finish (s) */
const CLAW_TIME = 0.38;
/** A zombie's hands, camera space: reaching out low in front, and the right one's swipe (high on the right, raked down to the left) */
const CLAW_HOLD = { x: 0.17, y: -0.19, z: -0.42 };
const CLAW_FROM = { x: 0.26, y: 0.02, z: -0.36 };
const CLAW_TO = { x: -0.12, y: -0.3, z: -0.48 };

interface Held {
  kind: GunKind;
  mag: number;
  /** Spare rounds (Infinity in Gun Game) */
  reserve: number;
}

const _support = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _lower = new THREE.Vector3();

interface View extends GunModel {
  muzzleObj: THREE.Object3D;
  flash: THREE.Mesh;
}

/**
 * The guns in hand: the rifle (always) and one picked-up gun, with ammo, fire rate, reloads,
 * switching and the first-person model. Rendered in its own scene so it never clips into walls.
 */
export class Weapon {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  shotsInBurst = 0;
  /** 0 at the hip, 1 fully aimed down the sights */
  aim = 0;

  private readonly slots: [Held, Held | null] = [{ kind: 'rifle', mag: GUNS.rifle.mag, reserve: GUNS.rifle.reserve }, null];
  /** Modes that fix the guns (Gun Game, Sniper Only, …): the first, with endless ammo, no pickups */
  private forced: GunKind | null = null;
  /** A two-gun loadout's second gun: in the second slot like a picked-up one, but the mode's (never dropped) */
  private forcedSecond: GunKind | null = null;
  private slot: 0 | 1 = 0;
  private readonly views = new Map<GunKind, View>();
  private cooldown = 0;
  private reloadTimer = 0;
  private switchTimer = 0;
  /** Semi-automatic guns fire once per trigger pull */
  private triggerLatched = false;
  /** Seconds until the gun is back up after a sprint (no shooting meanwhile) */
  private raiseLeft = 0;
  private kick = 0;
  private flashTimer = 0;
  private bobTime = 0;
  /** Carrying the enemy flag: guns stowed, the flag is held instead */
  private melee = false;
  private flagView: { group: THREE.Group; cloth: THREE.MeshStandardMaterial } | null = null;
  /** Your arms holding the gun (or the flag), once the character model has loaded */
  private arms: FpArms | null = null;
  private swingTimer = 0;
  private swingCooldown = 0;
  /** The knife: mid-slash for this long (the gun is lowered meanwhile), and its model */
  private knifeTimer = 0;
  private knifeCooldown = 0;
  private knifeView: THREE.Group | null = null;
  /** A zombie: no guns, the hands are claws (each swipe runs clawTimer down) */
  private claws = false;
  private clawTimer = 0;
  private clawCooldown = 0;
  /** Where each hand is (camera space), made on first need */
  private clawHands: [THREE.Object3D, THREE.Object3D] | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(VIEW_FOV, aspect, 0.01, 10);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 2, 1);
    this.scene.add(key);
    this.showModel();
  }

  private get held(): Held {
    return this.slots[this.slot] ?? this.slots[0];
  }

  /** The gun in hand */
  get gun(): GunKind {
    return this.held.kind;
  }

  /** The gun in the second slot, if any (whether or not it's in hand): a picked-up one, or a two-gun loadout's */
  get special(): GunKind | null {
    return this.slots[1]?.kind ?? null;
  }

  /** The gun in the first slot: the rifle, or the mode's gun */
  get primary(): GunKind {
    return this.slots[0].kind;
  }

  /** The second slot is the mode's (a two-gun loadout), not a pickup: it can't be dropped or swapped */
  get kit(): boolean {
    return this.forcedSecond !== null;
  }

  get ammo(): number {
    return this.held.mag;
  }

  get magSize(): number {
    return GUNS[this.gun].mag;
  }

  /** Spare rounds, or null when endless (Gun Game) */
  get reserve(): number | null {
    return Number.isFinite(this.held.reserve) ? this.held.reserve : null;
  }

  /** Whether an ammo box would give us anything */
  get needsAmmo(): boolean {
    const rifle = this.slots[0];
    const special = this.slots[1];
    return (Number.isFinite(rifle.reserve) && rifle.reserve < GUNS.rifle.reserve)
      || (!!special && special.reserve < maxReserve(special.kind));
  }

  /** Nothing to shoot with at all: empty magazine and no spares */
  get dry(): boolean {
    return this.held.mag <= 0 && this.held.reserve <= 0;
  }

  /**
   * An ammo box: the rifle's spare rounds back to full and a magazine for the picked-up gun.
   * Returns false when neither needed any.
   */
  takeAmmo(): boolean {
    const rifle = this.slots[0];
    const special = this.slots[1];
    const rifleRoom = Number.isFinite(rifle.reserve) && rifle.reserve < GUNS.rifle.reserve;
    const specialRoom = !!special && special.reserve < maxReserve(special.kind);
    if (!rifleRoom && !specialRoom) return false;
    if (rifleRoom) rifle.reserve = GUNS.rifle.reserve;
    if (special && specialRoom) special.reserve = Math.min(special.reserve + GUNS[special.kind].mag, maxReserve(special.kind));
    return true;
  }

  /**
   * Modes that fix the guns: hold only `kind` (and, in a two-gun loadout, `second` a switch away), both
   * with endless spare rounds. Null goes back to the normal loadout.
   */
  setForcedGun(kind: GunKind | null, second: GunKind | null = null): void {
    this.forced = kind;
    this.forcedSecond = kind ? second : null;
    if (kind) {
      this.slots[0] = { kind, mag: GUNS[kind].mag, reserve: Infinity };
      this.slots[1] = second ? { kind: second, mag: GUNS[second].mag, reserve: Infinity } : null;
      this.slot = 0;
      this.reloadTimer = 0;
      this.switchTimer = SWITCH_TIME;
      this.triggerLatched = false;
      this.aim = 0;
      this.showModel();
    } else {
      this.reset();
    }
  }

  get reloading(): boolean {
    return this.reloadTimer > 0;
  }

  /**
   * Play the reload (the dip, the hand to the magazine) without doing one: for the viewmodel seen
   * through someone else's eyes, whose rounds aren't this weapon's. Their client plays the sound.
   */
  showReload(): void {
    if (this.melee || this.claws || this.knifing || this.reloading) return;
    this.reloadTimer = GUNS[this.held.kind].reloadTime;
  }

  get switching(): boolean {
    return this.switchTimer > 0;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Muzzle position in the main camera's local space. */
  muzzleOffset(): THREE.Vector3 {
    const view = this.view();
    view.group.updateMatrixWorld(true);
    return view.muzzleObj.getWorldPosition(new THREE.Vector3());
  }

  /**
   * Take a picked-up gun into the empty second slot and switch to it, or, for the gun we already
   * carry, just take its ammo. Returns false when the slot holds a different gun (drop it first).
   */
  giveGun(kind: GunKind, rounds: number): boolean {
    if (this.forcedSecond) return false;
    const def = GUNS[kind];
    const old = this.slots[1];
    if (old?.kind === kind) {
      old.reserve = Math.min(old.reserve + rounds, maxReserve(kind));
      return true;
    }
    if (old) return false;
    const mag = Math.min(def.mag, rounds);
    this.slots[1] = { kind, mag, reserve: Math.max(0, rounds - mag) };
    this.selectSlot(1);
    return true;
  }

  /** Rounds left in the picked-up gun (magazine + spare), or null without one (a two-gun loadout's isn't one). */
  get specialRounds(): number | null {
    const held = this.slots[1];
    return held && !this.forcedSecond ? held.mag + held.reserve : null;
  }

  /** Rifle <-> picked-up gun. Returns false when there's nothing to switch to. */
  switchGun(): boolean {
    if (!this.slots[1]) return false;
    this.selectSlot(this.slot === 0 ? 1 : 0);
    return true;
  }

  /** Takes the picked-up gun out of our hands with its rounds left (to drop it), or null. */
  takeSpecial(): { kind: GunKind; rounds: number } | null {
    const held = this.slots[1];
    if (!held || this.forcedSecond) return null;
    this.removeSpecial();
    return { kind: held.kind, rounds: held.mag + held.reserve };
  }

  /** Lose the picked-up gun (new round). */
  removeSpecial(): void {
    if (this.forcedSecond) return;
    this.slots[1] = null;
    if (this.slot === 1) this.selectSlot(0);
  }

  reload(): void {
    const held = this.held;
    if (this.melee || this.claws || this.knifing) return;
    if (this.reloading || this.switching || held.mag === GUNS[held.kind].mag || held.reserve <= 0) return;
    this.reloadTimer = GUNS[held.kind].reloadTime;
    playReload(1, held.kind);
  }

  /** Mid-slash with the knife */
  get knifing(): boolean {
    return this.knifeTimer > 0;
  }

  /** The knife can slash again */
  get knifeReady(): boolean {
    return !this.melee && !this.claws && this.knifeTimer <= 0 && this.knifeCooldown <= 0;
  }

  /**
   * Slash with the knife: the gun drops out of view (a reload in progress is abandoned), the knife
   * comes up on the right and cuts across. False while the last slash is still recovering, or when
   * holding the flag. `cooldown`: seconds before the next one (0 when just showing someone else's).
   */
  startKnife(cooldown: number): boolean {
    // A zombie's slash is a swipe of the claws (someone else's, watched through their eyes, too).
    if (this.claws) return this.tryClaw(cooldown);
    if (this.melee || this.knifeTimer > 0 || this.knifeCooldown > 0) return false;
    this.knifeTimer = KNIFE_TIME;
    this.knifeCooldown = cooldown;
    this.reloadTimer = 0;
    this.aim = 0;
    this.triggerLatched = true;
    this.knife().visible = true;
    for (const v of this.views.values()) v.group.visible = false;
    return true;
  }

  /** Show your arms holding the gun. */
  setArms(asset: THREE.Object3D): void {
    if (this.arms) return;
    this.arms = new FpArms(asset);
    this.camera.add(this.arms.root);
  }

  /** Watching through someone's eyes: hold whatever gun they hold. */
  showGun(kind: GunKind): void {
    if (this.gun !== kind) this.setForcedGun(kind);
  }

  /** Their shot, shown here: muzzle flash and kick, no ammo involved. */
  flashShot(): void {
    const def = GUNS[this.gun];
    this.kick = Math.min(this.kick + (def.pellets > 1 || def.scope ? 2.5 : 1), 3);
    this.flashTimer = 0.04;
    this.view().flash.rotation.z = Math.random() * Math.PI;
  }

  /** Hold the flag (guns stowed) or go back to the guns. `color` tints the cloth. */
  setMelee(on: boolean, color = '#ffffff'): void {
    if (on === this.melee) return;
    this.melee = on;
    this.aim = 0;
    this.reloadTimer = 0;
    this.triggerLatched = false;
    this.switchTimer = SWITCH_TIME;
    const flag = this.flag();
    flag.cloth.color.set(color);
    flag.cloth.emissive.set(color);
    flag.group.visible = on;
    if (on) for (const v of this.views.values()) v.group.visible = false;
    else this.showModel();
  }

  /** No guns in hand: carrying the flag, or a zombie's claws */
  get meleeMode(): boolean {
    return this.melee || this.claws;
  }

  get clawsMode(): boolean {
    return this.claws;
  }

  /**
   * Turn into a zombie (guns gone, hands out as claws, the arms in `tint`), or back. Picked-up guns aren't
   * kept: the game drops them when someone turns.
   */
  setClaws(on: boolean, tint: string | null = null): void {
    if (on === this.claws) return;
    this.claws = on;
    this.aim = 0;
    this.reloadTimer = 0;
    this.knifeTimer = 0;
    this.clawTimer = 0;
    this.clawCooldown = 0;
    this.triggerLatched = false;
    this.switchTimer = SWITCH_TIME;
    if (this.knifeView) this.knifeView.visible = false;
    this.arms?.setTint(on ? tint : null);
    this.showModel();
  }

  /** Start a swipe of the claws if the last one has finished. True when it starts. */
  tryClaw(cooldown: number): boolean {
    if (!this.claws || this.clawCooldown > 0 || this.switching) return false;
    this.clawTimer = CLAW_TIME;
    this.clawCooldown = cooldown;
    return true;
  }

  /** Start a swing if the last one has finished. Returns true when it starts. */
  trySwing(cooldown: number): boolean {
    if (!this.melee || this.swingCooldown > 0 || this.switching) return false;
    this.swingTimer = SWING_TIME;
    this.swingCooldown = cooldown;
    return true;
  }

  /** Returns true if a shot should be fired this frame (the trigger is held). */
  tryFire(): boolean {
    const def = GUNS[this.gun];
    if (this.melee || this.claws || this.knifing || this.reloading || this.switching || this.cooldown > 0 || this.raiseLeft > 0) return false;
    if (!def.auto && this.triggerLatched) return false;
    if (this.held.mag <= 0) {
      playEmpty();
      this.cooldown = 0.25;
      this.triggerLatched = true;
      this.reload();
      return false;
    }
    this.held.mag--;
    this.cooldown = def.fireInterval;
    this.kick = Math.min(this.kick + (def.pellets > 1 || def.scope ? 2.5 : 1), 3);
    this.flashTimer = 0.04;
    this.view().flash.rotation.z = Math.random() * Math.PI;
    this.shotsInBurst++;
    this.triggerLatched = true;
    return true;
  }

  /** The picked-up gun has nothing left at all (back to the rifle). */
  get specialEmpty(): boolean {
    const s = this.slots[1];
    return !!s && s.mag <= 0 && s.reserve <= 0;
  }

  releaseTrigger(): void {
    this.shotsInBurst = 0;
    this.triggerLatched = false;
  }

  /** Respawn: full rifle (or the mode's guns), no picked-up gun. */
  reset(): void {
    const kind = this.forced ?? 'rifle';
    this.slots[0] = { kind, mag: GUNS[kind].mag, reserve: this.forced ? Infinity : GUNS.rifle.reserve };
    const second = this.forcedSecond;
    this.slots[1] = second ? { kind: second, mag: GUNS[second].mag, reserve: Infinity } : null;
    this.slot = 0;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.switchTimer = 0;
    this.kick = 0;
    this.knifeTimer = 0;
    this.knifeCooldown = 0;
    this.clawTimer = 0;
    this.clawCooldown = 0;
    if (this.knifeView) this.knifeView.visible = false;
    this.showModel();
  }

  /** @param aiming aim down the sights (blends in over a moment) */
  update(dt: number, speed: number, sprinting: boolean, aiming = false): void {
    this.knifeCooldown = Math.max(0, this.knifeCooldown - dt);
    // Sprinting carries the gun low: it takes a moment to bring it up before it can fire.
    this.raiseLeft = sprinting ? SPRINT_RAISE : Math.max(0, this.raiseLeft - dt);
    if (this.claws) {
      this.updateClaws(dt, speed, sprinting);
      return;
    }
    if (this.melee) {
      this.updateFlag(dt, speed, sprinting);
      return;
    }
    if (this.knifeTimer > 0) {
      this.updateKnife(dt);
      return;
    }
    const def = GUNS[this.gun];
    this.aim += ((aiming && !this.reloading && !this.switching ? 1 : 0) - this.aim) * (1 - Math.exp(-ADS_SPEED * dt));
    if (this.aim < 0.001) this.aim = 0;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        const held = this.held;
        const take = Math.min(def.mag - held.mag, held.reserve);
        held.mag += take;
        held.reserve -= take;
      }
    }
    this.kick *= Math.exp(-12 * dt);
    this.flashTimer -= dt;
    const view = this.view();
    view.flash.visible = this.flashTimer > 0;

    this.bobTime += dt * (speed > 0.5 ? speed * 1.6 : 0);
    const bob = Math.min(speed / 9, 1);
    const reloadDip = this.reloading ? Math.sin((1 - this.reloadTimer / def.reloadTime) * Math.PI) : 0;
    const switchDip = this.switching ? Math.sin((this.switchTimer / SWITCH_TIME) * Math.PI) : 0;
    const sprintDip = sprinting ? 1 : 0;

    // Aiming steadies the gun: much less bob and kick.
    const steady = 1 - 0.8 * this.aim;
    const hip = view.hip;
    const hipX = hip.x + Math.cos(this.bobTime) * 0.012 * bob;
    const hipY = hip.y - Math.abs(Math.sin(this.bobTime)) * 0.015 * bob - reloadDip * 0.15 - sprintDip * 0.05 - switchDip * 0.3;
    view.group.position.set(
      THREE.MathUtils.lerp(hipX, Math.cos(this.bobTime) * 0.002 * bob, this.aim),
      THREE.MathUtils.lerp(hipY, -view.sightHeight - Math.abs(Math.sin(this.bobTime)) * 0.003 * bob, this.aim),
      THREE.MathUtils.lerp(hip.z, view.adsZ, this.aim) + this.kick * 0.04 * steady,
    );
    const cant = 1 - this.aim;
    view.group.rotation.set(
      HIP_CANT.pitch * cant + this.kick * 0.05 * steady - reloadDip * 0.6 - sprintDip * 0.3 - switchDip * 0.8,
      HIP_CANT.yaw * cant + sprintDip * 0.5,
      reloadDip * 0.4,
    );
    this.poseArms(view, reloadDip);
  }

  /** Right hand on the grip, left on the fore-end; mid-reload the left hand drops to the magazine. */
  private poseArms(view: View, reloadDip: number): void {
    if (!this.arms) return;
    this.arms.visible = view.group.visible;
    if (!view.group.visible) return;
    view.group.updateMatrixWorld(true);
    _support.copy(view.support);
    if (reloadDip > 0) _support.lerp(view.mag, reloadDip);
    this.arms.holdGun(view.group, view.grip, _support, this.aim, this.gun === 'deagle');
  }

  /**
   * The flag held upright on the right, both hands on the pole (right hand high, left low), the top
   * leaning a little in and away; a swing chops the top forward and across to the left and back.
   */
  private updateFlag(dt: number, speed: number, sprinting: boolean): void {
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.swingTimer = Math.max(0, this.swingTimer - dt);
    this.swingCooldown = Math.max(0, this.swingCooldown - dt);
    this.bobTime += dt * (speed > 0.5 ? speed * 1.6 : 0);
    const bob = Math.min(speed / 9, 1);
    const raise = this.switchTimer > 0 ? Math.sin((this.switchTimer / SWITCH_TIME) * Math.PI) : 0;
    const k = this.swingTimer > 0 ? 1 - this.swingTimer / SWING_TIME : 0;
    // Wind up (top back toward us), then chop forward and across, and come back.
    const sweep = k === 0 ? 0 : k < 0.25 ? -0.25 * (k / 0.25) : Math.sin(((k - 0.25) / 0.75) * Math.PI) * 1.2 - 0.25 * (1 - (k - 0.25) / 0.75);
    const g = this.flag().group;
    g.position.set(
      FLAG_HOLD.x + Math.cos(this.bobTime) * 0.012 * bob - sweep * 0.08,
      FLAG_HOLD.y - Math.abs(Math.sin(this.bobTime)) * 0.015 * bob - raise * 0.35 - (sprinting ? 0.05 : 0),
      FLAG_HOLD.z - Math.max(0, sweep) * 0.06,
    );
    // Sprinting tips it forward a little more; the sweep throws the top forward and to the left.
    g.rotation.set(
      FLAG_HOLD.pitch - (sprinting ? 0.12 : 0) - sweep * 0.75,
      FLAG_HOLD.yaw,
      FLAG_HOLD.roll + sweep * 0.55,
    );
    if (this.arms) {
      this.arms.visible = true;
      g.updateMatrixWorld(true);
      this.arms.holdPole(g, _upper.copy(FLAG_FIST.right).setY(FLAG_GRIP.upper), _lower.copy(FLAG_FIST.left).setY(FLAG_GRIP.lower));
    }
  }

  /**
   * A zombie's hands: reaching out low in front, bobbing as it runs. A swipe raises the right one high and
   * wide, then rakes it down and across to the left while the left one lunges.
   */
  private updateClaws(dt: number, speed: number, sprinting: boolean): void {
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.clawTimer = Math.max(0, this.clawTimer - dt);
    this.clawCooldown = Math.max(0, this.clawCooldown - dt);
    this.aim = 0;
    this.bobTime += dt * (speed > 0.5 ? speed * 1.6 : 0);
    const bob = Math.min(speed / 9, 1);
    const raise = this.switchTimer > 0 ? Math.sin((this.switchTimer / SWITCH_TIME) * Math.PI) : 0;
    const k = this.clawTimer > 0 ? 1 - this.clawTimer / CLAW_TIME : 0;
    // 0..0.3 up into the wind-up, 0.3..0.7 the rake, then back.
    const rake = k === 0 ? 0 : k < 0.3 ? 0 : k < 0.7 ? easeInOut((k - 0.3) / 0.4) : 1;
    const swing = k === 0 ? 0 : Math.min(1, k / 0.3, (1 - k) / 0.25);
    const [right, left] = this.claw();
    const lerp = THREE.MathUtils.lerp;
    for (const [hand, side] of [[right, 1], [left, -1]] as const) {
      const sway = Math.sin(this.bobTime + (side > 0 ? 0 : Math.PI)) * 0.02 * bob;
      hand.position.set(
        CLAW_HOLD.x * side + sway,
        CLAW_HOLD.y - Math.abs(Math.sin(this.bobTime)) * 0.02 * bob - raise * 0.35 - (sprinting ? 0.04 : 0),
        CLAW_HOLD.z,
      );
      hand.rotation.set(0.25, 0, -0.35 * side);
    }
    if (swing > 0) {
      const from = new THREE.Vector3(lerp(CLAW_FROM.x, CLAW_TO.x, rake), lerp(CLAW_FROM.y, CLAW_TO.y, rake), lerp(CLAW_FROM.z, CLAW_TO.z, rake));
      right.position.lerp(from, swing);
      right.rotation.z = lerp(-0.35, lerp(-1.1, 0.4, rake), swing);
      left.position.z -= 0.08 * swing * rake;
    }
    if (this.arms) {
      this.arms.visible = true;
      right.updateMatrixWorld(true);
      left.updateMatrixWorld(true);
      this.arms.holdClaws(right, left);
    }
  }

  private claw(): [THREE.Object3D, THREE.Object3D] {
    if (this.clawHands) return this.clawHands;
    const right = new THREE.Object3D();
    const left = new THREE.Object3D();
    this.camera.add(right, left);
    this.clawHands = [right, left];
    return this.clawHands;
  }

  /**
   * The knife slash: up from below on the right, a fast cut across and down to the left, then out of
   * view while the gun comes back up.
   */
  private updateKnife(dt: number): void {
    this.knifeTimer = Math.max(0, this.knifeTimer - dt);
    const g = this.knife();
    if (this.knifeTimer === 0) {
      // Done: the gun comes back up.
      g.visible = false;
      this.switchTimer = SWITCH_TIME;
      this.showModel();
      return;
    }
    const k = 1 - this.knifeTimer / KNIFE_TIME;
    // 0..0.25 raise into the ready spot, 0.25..0.65 the cut, then drop away.
    const cut = k < 0.25 ? 0 : k < 0.65 ? easeInOut((k - 0.25) / 0.4) : 1;
    const raise = k < 0.25 ? 1 - k / 0.25 : k > 0.75 ? (k - 0.75) / 0.25 : 0;
    const lerp = THREE.MathUtils.lerp;
    g.position.set(
      lerp(KNIFE_FROM.x, KNIFE_TO.x, cut),
      lerp(KNIFE_FROM.y, KNIFE_TO.y, cut) - raise * 0.3,
      lerp(KNIFE_FROM.z, KNIFE_TO.z, cut),
    );
    g.rotation.set(-0.15 - raise * 0.6, lerp(KNIFE_FROM.yaw, KNIFE_TO.yaw, cut), lerp(KNIFE_FROM.roll, KNIFE_TO.roll, cut));
    if (this.arms) {
      this.arms.visible = true;
      g.updateMatrixWorld(true);
      this.arms.holdGun(g, KNIFE_GRIP, KNIFE_GRIP, 0, true);
    }
  }

  /** The knife model: a dark grip through the fist, a guard, and the blade standing up out of the hand. */
  private knife(): THREE.Group {
    if (this.knifeView) return this.knifeView;
    const group = new THREE.Group();
    const inner = buildKnifeModel();
    // The handle runs through the fist (7 cm under the origin), the blade tipped forward from upright.
    inner.position.set(KNIFE_GRIP.x + 0.03, KNIFE_GRIP.y - 0.065, KNIFE_GRIP.z - 0.01);
    inner.rotation.x = -KNIFE_TIP_FORWARD;
    group.add(inner);
    group.visible = false;
    this.camera.add(group);
    this.knifeView = group;
    return group;
  }

  private flag(): { group: THREE.Group; cloth: THREE.MeshStandardMaterial } {
    if (this.flagView) return this.flagView;
    const group = new THREE.Group();
    // Life size: the pole runs from below the screen to above it, the cloth at the top.
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.017, FLAG_POLE, 12).translate(0, FLAG_POLE / 2, 0),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35 }),
    );
    const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.25, side: THREE.DoubleSide, roughness: 0.8 });
    const flagCloth = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.24).translate(0.18, FLAG_POLE - 0.14, 0), cloth);
    flagCloth.rotation.y = FLAG_CLOTH_YAW;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8).translate(0, FLAG_POLE, 0), pole.material);
    group.add(pole, flagCloth, cap);
    group.visible = false;
    this.camera.add(group);
    this.flagView = { group, cloth };
    return this.flagView;
  }

  private selectSlot(slot: 0 | 1): void {
    if (!this.slots[slot]) return;
    this.slot = slot;
    this.reloadTimer = 0;
    this.switchTimer = SWITCH_TIME;
    this.triggerLatched = false;
    this.aim = 0;
    this.showModel();
  }

  private view(): View {
    let view = this.views.get(this.gun);
    if (!view) {
      const model = buildGunModel(this.gun);
      const muzzleObj = new THREE.Object3D();
      muzzleObj.position.copy(model.muzzle);
      model.group.add(muzzleObj);
      const flash = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.22),
        new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      flash.visible = false;
      muzzleObj.add(flash);
      model.group.position.copy(model.hip);
      model.group.scale.setScalar(model.fpScale);
      model.sightHeight *= model.fpScale;
      this.camera.add(model.group);
      view = { ...model, muzzleObj, flash };
      this.views.set(this.gun, view);
    }
    return view;
  }

  private showModel(): void {
    const current = this.view();
    for (const v of this.views.values()) v.group.visible = v === current && !this.melee && !this.claws;
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * A combat knife, life size, standing up along +Y from the middle of its handle (origin): a rubbery
 * black handle, a steel guard, and a blade with a darker spine and a point.
 */
export function buildKnifeModel(): THREE.Group {
  const group = new THREE.Group();
  const handleMat = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.85, roughness: 0.25 });
  const spineMat = new THREE.MeshStandardMaterial({ color: 0x5b6168, metalness: 0.8, roughness: 0.4 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.11, 10), handleMat);
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.012, 10).translate(0, -0.061, 0), steel);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.008, 0.022).translate(0, 0.058, 0), steel);
  // The blade: flat (thin along z), edge toward -z, tapering to a point.
  const shape = new THREE.Shape();
  shape.moveTo(-0.004, 0);
  shape.lineTo(0.016, 0);
  shape.lineTo(0.016, 0.12);
  shape.quadraticCurveTo(0.012, 0.15, -0.004, 0.17);
  shape.lineTo(-0.004, 0);
  const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.003, bevelEnabled: false }), steel);
  blade.geometry.translate(0, 0, -0.0015);
  blade.rotation.y = Math.PI / 2;
  blade.position.y = 0.062;
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.11, 0.005).translate(0, 0.117, 0.003), spineMat);
  group.add(handle, pommel, guard, blade, spine);
  return group;
}

interface Effect {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
  max: number;
  grow: boolean;
  /** Where it goes back to when it's done */
  spares: Effect[];
}

/**
 * Most tracers and sparks alive at once; past that the oldest is reused. Shots keep arriving while
 * the tab is hidden, but no frames run to fade them out, so without a cap they'd pile up.
 */
const MAX_EFFECTS = 160;

/**
 * Short-lived bullet tracers and impact sparks in the world scene. Each fades on its own, so each has
 * its own material; finished ones (mesh and material) are hidden and reused, so firing allocates nothing.
 * (Not one instanced mesh: that sorts as one object, and sparks on a player would draw behind them.)
 */
export class Effects {
  private readonly scene: THREE.Scene;
  /** Alive, oldest first */
  private readonly items: Effect[] = [];
  private readonly spareTracers: Effect[] = [];
  private readonly spareSparks: Effect[] = [];
  private readonly tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private readonly sparkGeo = new THREE.SphereGeometry(0.06, 6, 4);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffe08a): void {
    const it = this.take(this.spareTracers, 0.07, false, () => new THREE.Mesh(
      this.tracerGeo,
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    ));
    it.mesh.material.color.setHex(color);
    it.mesh.material.opacity = 0.9;
    it.mesh.position.copy(from);
    it.mesh.lookAt(to);
    it.mesh.scale.set(0.025, 0.025, from.distanceTo(to));
  }

  impact(point: THREE.Vector3, color = 0xffc35c): void {
    const it = this.take(this.spareSparks, 0.18, true, () => new THREE.Mesh(
      this.sparkGeo,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    ));
    it.mesh.material.color.setHex(color);
    it.mesh.material.opacity = 1;
    it.mesh.position.copy(point);
    it.mesh.scale.setScalar(1);
  }

  /** A spare effect of this kind (or a new one), alive for `life` seconds. */
  private take(spares: Effect[], life: number, grow: boolean, make: () => Effect['mesh']): Effect {
    if (this.items.length >= MAX_EFFECTS) this.retire(this.items.shift()!);
    let it = spares.pop();
    if (!it) {
      it = { mesh: make(), life, max: life, grow, spares };
      this.scene.add(it.mesh);
    }
    it.life = it.max = life;
    it.mesh.visible = true;
    this.items.push(it);
    return it;
  }

  /** Done: hidden (it stays in the scene) until it's reused. */
  private retire(it: Effect): void {
    it.mesh.visible = false;
    it.spares.push(it);
  }

  update(dt: number): void {
    // In place, keeping the order (oldest first).
    let kept = 0;
    for (const it of this.items) {
      it.life -= dt;
      const k = Math.max(it.life / it.max, 0);
      it.mesh.material.opacity = k;
      if (it.grow) it.mesh.scale.setScalar(1 + (1 - k) * 2);
      if (it.life > 0) this.items[kept++] = it;
      else this.retire(it);
    }
    this.items.length = kept;
  }
}
