import * as THREE from 'three';
import { playEmpty, playReload } from './audio';
import { GUNS, buildGunModel, type GunModel } from './guns';
import type { GunKind } from '../types';

/** How quickly the gun moves between hip and sights (1/s) */
const ADS_SPEED = 14;
/** Lowering one gun and raising the other (s) */
const SWITCH_TIME = 0.35;

interface Held {
  kind: GunKind;
  mag: number;
  /** Spare rounds; Infinity for the rifle */
  reserve: number;
}

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

  private readonly slots: [Held, Held | null] = [{ kind: 'rifle', mag: GUNS.rifle.mag, reserve: Infinity }, null];
  private slot: 0 | 1 = 0;
  private readonly views = new Map<GunKind, View>();
  private cooldown = 0;
  private reloadTimer = 0;
  private switchTimer = 0;
  /** Semi-automatic guns fire once per trigger pull */
  private triggerLatched = false;
  private kick = 0;
  private flashTimer = 0;
  private bobTime = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.01, 10);
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

  /** The picked-up gun, if any (whether or not it's in hand) */
  get special(): GunKind | null {
    return this.slots[1]?.kind ?? null;
  }

  get ammo(): number {
    return this.held.mag;
  }

  get magSize(): number {
    return GUNS[this.gun].mag;
  }

  /** Spare rounds, or null for the rifle's endless supply */
  get reserve(): number | null {
    return Number.isFinite(this.held.reserve) ? this.held.reserve : null;
  }

  get reloading(): boolean {
    return this.reloadTimer > 0;
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
    const def = GUNS[kind];
    const old = this.slots[1];
    if (old?.kind === kind) {
      old.reserve = Math.min(old.reserve + rounds, def.mag * 4);
      return true;
    }
    if (old) return false;
    const mag = Math.min(def.mag, rounds);
    this.slots[1] = { kind, mag, reserve: Math.max(0, rounds - mag) };
    this.selectSlot(1);
    return true;
  }

  /** Rounds left in the picked-up gun (magazine + spare), or null without one. */
  get specialRounds(): number | null {
    const held = this.slots[1];
    return held ? held.mag + held.reserve : null;
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
    if (!held) return null;
    this.removeSpecial();
    return { kind: held.kind, rounds: held.mag + held.reserve };
  }

  /** Lose the picked-up gun (new round). */
  removeSpecial(): void {
    this.slots[1] = null;
    if (this.slot === 1) this.selectSlot(0);
  }

  reload(): void {
    const held = this.held;
    if (this.reloading || this.switching || held.mag === GUNS[held.kind].mag || held.reserve <= 0) return;
    this.reloadTimer = GUNS[held.kind].reloadTime;
    playReload();
  }

  /** Returns true if a shot should be fired this frame (the trigger is held). */
  tryFire(): boolean {
    const def = GUNS[this.gun];
    if (this.reloading || this.switching || this.cooldown > 0) return false;
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

  /** Respawn: full rifle, no picked-up gun. */
  reset(): void {
    this.slots[0] = { kind: 'rifle', mag: GUNS.rifle.mag, reserve: Infinity };
    this.slots[1] = null;
    this.slot = 0;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.switchTimer = 0;
    this.kick = 0;
    this.showModel();
  }

  /** @param aiming aim down the sights (blends in over a moment) */
  update(dt: number, speed: number, sprinting: boolean, aiming = false): void {
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
    view.group.rotation.set(
      this.kick * 0.05 * steady - reloadDip * 0.6 - sprintDip * 0.3 - switchDip * 0.8,
      sprintDip * 0.5,
      reloadDip * 0.4,
    );
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
      this.camera.add(model.group);
      view = { ...model, muzzleObj, flash };
      this.views.set(this.gun, view);
    }
    return view;
  }

  private showModel(): void {
    const current = this.view();
    for (const v of this.views.values()) v.group.visible = v === current;
  }
}

interface Effect {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
  max: number;
  grow: boolean;
}

/** Short-lived bullet tracers and impact sparks in the world scene. */
export class Effects {
  private readonly scene: THREE.Scene;
  private items: Effect[] = [];
  private readonly tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private readonly sparkGeo = new THREE.SphereGeometry(0.06, 6, 4);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffe08a): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.tracerGeo, mat);
    mesh.position.copy(from);
    mesh.lookAt(to);
    mesh.scale.set(0.025, 0.025, from.distanceTo(to));
    this.add(mesh, 0.07);
  }

  impact(point: THREE.Vector3, color = 0xffc35c): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(this.sparkGeo, mat);
    mesh.position.copy(point);
    this.add(mesh, 0.18, true);
  }

  private add(mesh: Effect['mesh'], life: number, grow = false): void {
    this.scene.add(mesh);
    this.items.push({ mesh, life, max: life, grow });
  }

  update(dt: number): void {
    this.items = this.items.filter((it) => {
      it.life -= dt;
      const k = Math.max(it.life / it.max, 0);
      it.mesh.material.opacity = k;
      if (it.grow) it.mesh.scale.setScalar(1 + (1 - k) * 2);
      if (it.life > 0) return true;
      this.scene.remove(it.mesh);
      it.mesh.material.dispose();
      return false;
    });
  }
}
