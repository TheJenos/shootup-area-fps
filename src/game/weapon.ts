import * as THREE from 'three';
import { playEmpty, playReload } from './audio';
import { woodTexture, wornMetalTexture } from './textures';

const FIRE_INTERVAL = 0.1;
const MAG_SIZE = 30;
const RELOAD_TIME = 1.4;

function buildGun(): THREE.Group {
  const gun = new THREE.Group();
  const metal = wornMetalTexture();
  const wood = woodTexture();
  const dark = new THREE.MeshStandardMaterial({ map: metal, roughness: 0.5, metalness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.8 });
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    gun.add(m);
    return m;
  };
  part(new THREE.BoxGeometry(0.09, 0.11, 0.5), dark, 0, 0, 0);
  const barrel = part(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 10), dark, 0, 0.02, -0.38, Math.PI / 2);
  barrel.castShadow = false;
  part(new THREE.BoxGeometry(0.06, 0.18, 0.08), dark, 0, -0.13, -0.05, 0.2);
  part(new THREE.BoxGeometry(0.07, 0.16, 0.09), accent, 0, -0.12, 0.17, -0.3);
  part(new THREE.BoxGeometry(0.08, 0.09, 0.2), accent, 0, -0.01, 0.32);
  part(new THREE.BoxGeometry(0.03, 0.04, 0.12), dark, 0, 0.075, -0.05);
  return gun;
}

/** Viewmodel + ammo/fire-rate state. Rendered in its own scene so it never clips into walls. */
export class Weapon {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly magSize = MAG_SIZE;
  ammo = MAG_SIZE;
  shotsInBurst = 0;

  private readonly model = buildGun();
  private readonly basePos = new THREE.Vector3(0.22, -0.22, -0.5);
  private readonly muzzle = new THREE.Object3D();
  private readonly flash: THREE.Mesh;
  private cooldown = 0;
  private reloadTimer = 0;
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

    this.model.position.copy(this.basePos);
    this.camera.add(this.model);

    this.muzzle.position.set(0, 0.02, -0.55);
    this.model.add(this.muzzle);

    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.muzzle.add(this.flash);
    this.flash.visible = false;
  }

  get reloading(): boolean {
    return this.reloadTimer > 0;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Muzzle position in the main camera's local space. */
  muzzleOffset(): THREE.Vector3 {
    this.model.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(new THREE.Vector3());
  }

  reload(): void {
    if (this.reloading || this.ammo === this.magSize) return;
    this.reloadTimer = RELOAD_TIME;
    playReload();
  }

  /** Returns true if a bullet should be fired this frame. */
  tryFire(): boolean {
    if (this.reloading || this.cooldown > 0) return false;
    if (this.ammo <= 0) {
      playEmpty();
      this.cooldown = 0.25;
      this.reload();
      return false;
    }
    this.ammo--;
    this.cooldown = FIRE_INTERVAL;
    this.kick = Math.min(this.kick + 1, 3);
    this.flashTimer = 0.04;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.shotsInBurst++;
    return true;
  }

  releaseTrigger(): void {
    this.shotsInBurst = 0;
  }

  reset(): void {
    this.ammo = this.magSize;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.kick = 0;
  }

  update(dt: number, speed: number, sprinting: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.ammo = this.magSize;
      }
    }
    this.kick *= Math.exp(-12 * dt);
    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;

    this.bobTime += dt * (speed > 0.5 ? speed * 1.6 : 0);
    const bob = Math.min(speed / 9, 1);
    const reloadDip = this.reloading ? Math.sin((1 - this.reloadTimer / RELOAD_TIME) * Math.PI) : 0;
    const sprintDip = sprinting ? 1 : 0;

    this.model.position.set(
      this.basePos.x + Math.cos(this.bobTime) * 0.012 * bob,
      this.basePos.y - Math.abs(Math.sin(this.bobTime)) * 0.015 * bob - reloadDip * 0.15 - sprintDip * 0.05,
      this.basePos.z + this.kick * 0.04,
    );
    this.model.rotation.set(
      this.kick * 0.05 - reloadDip * 0.6 - sprintDip * 0.3,
      sprintDip * 0.5,
      reloadDip * 0.4,
    );
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
