import * as THREE from 'three';
import { FIRE_DURATION, FIRE_RADIUS, MINE_ARM, MINE_DURATION } from './abilities';

/*
 * World effects for the newer abilities: molotov fire patches, deployed turrets, land mines and
 * the scan pulse ring. No lights are added (that would make every material recompile, see grenades.ts);
 * the glow is additive basic materials, compiled up front so the first use doesn't hitch.
 */

// ---------------------------------------------------------------- fire

let flameTexture: THREE.CanvasTexture | null = null;
/** A soft radial flame blob, white-hot in the middle. */
function flame(): THREE.CanvasTexture {
  if (flameTexture) return flameTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 40, 2, 32, 36, 30);
  grad.addColorStop(0, 'rgba(255,250,210,1)');
  grad.addColorStop(0.35, 'rgba(255,170,60,0.9)');
  grad.addColorStop(0.7, 'rgba(220,70,20,0.5)');
  grad.addColorStop(1, 'rgba(120,20,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  flameTexture = new THREE.CanvasTexture(c);
  flameTexture.colorSpace = THREE.SRGBColorSpace;
  return flameTexture;
}

interface Fire {
  id: string;
  owner: string;
  center: THREE.Vector3;
  until: number;
  group: THREE.Group;
  flames: { sprite: THREE.Sprite; phase: number; base: THREE.Vector3 }[];
  glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

const FLAMES = 18;

/** Burning patches left by molotovs. Each client decides for itself whether it's standing in one. */
export class FireField {
  private readonly fires = new Map<string, Fire>();
  private readonly spriteMat: THREE.SpriteMaterial;
  private readonly glowGeo = new THREE.CircleGeometry(FIRE_RADIUS, 32).rotateX(-Math.PI / 2);

  constructor(private readonly scene: THREE.Scene) {
    this.spriteMat = new THREE.SpriteMaterial({ map: flame(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    // Compile the shaders now: an invisible sprite and glow, rendered once and removed.
    const warm = new THREE.Group();
    warm.position.set(0, -60, 0);
    const s = new THREE.Sprite(this.spriteMat);
    const glow = new THREE.Mesh(this.glowGeo, this.glowMaterial());
    for (const o of [s, glow]) o.frustumCulled = false;
    warm.add(s, glow);
    glow.onAfterRender = () => {
      scene.remove(warm);
      glow.material.dispose();
    };
    scene.add(warm);
  }

  private glowMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color: 0xff6a1a, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }

  ignite(id: string, owner: string, at: THREE.Vector3, until: number): void {
    if (this.fires.has(id)) return;
    const group = new THREE.Group();
    group.position.copy(at);
    const glow = new THREE.Mesh(this.glowGeo, this.glowMaterial());
    glow.position.y = 0.02;
    group.add(glow);
    const flames: Fire['flames'] = [];
    for (let i = 0; i < FLAMES; i++) {
      const sprite = new THREE.Sprite(this.spriteMat);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * FIRE_RADIUS * 0.9;
      const base = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      sprite.position.copy(base);
      group.add(sprite);
      flames.push({ sprite, phase: Math.random() * 10, base });
    }
    this.scene.add(group);
    this.fires.set(id, { id, owner, center: at.clone(), until, group, flames, glow });
  }

  /** Fires `p` is standing in (within the radius, roughly level with the patch). */
  burning(p: THREE.Vector3): Fire[] {
    const out: Fire[] = [];
    for (const f of this.fires.values()) {
      const dx = p.x - f.center.x;
      const dz = p.z - f.center.z;
      if (dx * dx + dz * dz <= FIRE_RADIUS * FIRE_RADIUS && Math.abs(p.y - f.center.y) < 1.2) out.push(f);
    }
    return out;
  }

  update(serverNow: number, t: number): void {
    for (const [id, f] of this.fires) {
      const left = (f.until - serverNow) / 1000;
      if (left <= 0) {
        this.scene.remove(f.group);
        f.glow.material.dispose();
        this.fires.delete(id);
        continue;
      }
      // Grows in over the first half second, dies down over the last second.
      const life = Math.min(1, (FIRE_DURATION - left) * 2, left);
      f.glow.material.opacity = 0.3 * life * (0.85 + Math.sin(t * 11 + f.flames.length) * 0.15);
      for (const fl of f.flames) {
        const k = (t * 1.6 + fl.phase) % 1;
        const size = (0.7 + Math.sin(fl.phase * 3) * 0.25) * life * (1 - k * 0.6);
        fl.sprite.scale.set(size, size * 1.6, 1);
        fl.sprite.position.set(fl.base.x + Math.sin(t * 3 + fl.phase) * 0.08, 0.3 + k * 1.1, fl.base.z);
        fl.sprite.material.opacity = 1;
      }
    }
  }

  clear(): void {
    for (const f of this.fires.values()) {
      this.scene.remove(f.group);
      f.glow.material.dispose();
    }
    this.fires.clear();
  }
}

// ---------------------------------------------------------------- turrets

export interface Turret {
  id: string;
  owner: string;
  until: number;
  group: THREE.Group;
  /** Turns to aim; the muzzle is its child */
  head: THREE.Group;
  muzzle: THREE.Object3D;
  box: THREE.Box3;
  solid: THREE.Mesh;
  yaw: number;
  targetYaw: number;
  pitch: number;
  targetPitch: number;
  /** Seconds until it can fire again (owner only) */
  cooldown: number;
  flash: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  flashLeft: number;
}

const TURRET_SIZE = { w: 0.7, h: 1.25, d: 0.7 };
const metal = new THREE.MeshStandardMaterial({ color: 0x5c6670, metalness: 0.5, roughness: 0.5 });
const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.4, roughness: 0.6 });
const eye = new THREE.MeshBasicMaterial({ color: 0xff3b3b });

/** Deployed turrets: a solid you can hide behind, with a swivelling gun head. */
export class TurretField {
  private readonly turrets = new Map<string, Turret>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly colliders: THREE.Box3[],
    private readonly solids: THREE.Mesh[],
  ) {}

  /** The space a turret at (x, y, z) takes up. */
  static boxFor(x: number, y: number, z: number): THREE.Box3 {
    return new THREE.Box3(
      new THREE.Vector3(x - TURRET_SIZE.w / 2, y, z - TURRET_SIZE.d / 2),
      new THREE.Vector3(x + TURRET_SIZE.w / 2, y + TURRET_SIZE.h, z + TURRET_SIZE.d / 2),
    );
  }

  place(id: string, owner: string, x: number, y: number, z: number, yaw: number, until: number, color: number): void {
    if (this.turrets.has(id)) return;
    const group = new THREE.Group();
    group.position.set(x, y, z);
    // Tripod and post
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.75, 6), dark);
      leg.position.set(Math.cos(a) * 0.22, 0.3, Math.sin(a) * 0.22);
      // Feet out, tops in under the post.
      leg.rotation.set(-Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45);
      group.add(leg);
    }
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.55, 8), metal);
    post.position.y = 0.6;
    group.add(post);
    const head = new THREE.Group();
    head.position.y = 0.95;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.5), new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.5 }));
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 8).rotateX(Math.PI / 2), dark);
    barrel.position.set(0, 0.02, -0.45);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eye);
    light.position.set(0.12, 0.08, -0.26);
    head.add(body, barrel, light);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -0.74);
    head.add(muzzle);
    const flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    flash.visible = false;
    muzzle.add(flash);
    group.add(head);
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    head.rotation.y = yaw;
    this.scene.add(group);
    const box = TurretField.boxFor(x, y, z);
    // Bullets stop on it like cover; it can't be destroyed.
    const solid = new THREE.Mesh(new THREE.BoxGeometry(TURRET_SIZE.w, TURRET_SIZE.h, TURRET_SIZE.d), new THREE.MeshBasicMaterial());
    solid.visible = false;
    solid.position.set(x, y + TURRET_SIZE.h / 2, z);
    solid.updateMatrixWorld();
    this.colliders.push(box);
    this.solids.push(solid);
    this.turrets.set(id, {
      id, owner, until, group, head, muzzle, box, solid, yaw, targetYaw: yaw, pitch: 0, targetPitch: 0, cooldown: 0.6, flash, flashLeft: 0,
    });
  }

  get(id: string): Turret | undefined {
    return this.turrets.get(id);
  }

  ownedBy(owner: string): Turret[] {
    return [...this.turrets.values()].filter((t) => t.owner === owner);
  }

  /** Point the head at a world position (smoothly, in update). */
  aimAt(t: Turret, at: THREE.Vector3): void {
    const from = t.head.getWorldPosition(new THREE.Vector3());
    const d = at.clone().sub(from);
    t.targetYaw = Math.atan2(-d.x, -d.z);
    t.targetPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  /** Show its muzzle flash (it fired). */
  fired(t: Turret): void {
    t.flashLeft = 0.05;
    t.flash.rotation.z = Math.random() * Math.PI;
  }

  update(serverNow: number, dt: number): void {
    for (const [id, t] of this.turrets) {
      if (serverNow >= t.until) {
        this.remove(id);
        continue;
      }
      const k = 1 - Math.exp(-10 * dt);
      let dy = t.targetYaw - t.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      t.yaw += dy * k;
      t.pitch += (t.targetPitch - t.pitch) * k;
      t.head.rotation.set(t.pitch, t.yaw, 0, 'YXZ');
      t.flashLeft -= dt;
      t.flash.visible = t.flashLeft > 0;
    }
  }

  remove(id: string): void {
    const t = this.turrets.get(id);
    if (!t) return;
    this.scene.remove(t.group);
    const c = this.colliders.indexOf(t.box);
    if (c >= 0) this.colliders.splice(c, 1);
    const s = this.solids.indexOf(t.solid);
    if (s >= 0) this.solids.splice(s, 1);
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material as THREE.Material;
      if (mat !== metal && mat !== dark && mat !== eye) mat.dispose();
    });
    this.turrets.delete(id);
  }

  removeOwnedBy(owner: string): void {
    for (const t of this.ownedBy(owner)) this.remove(t.id);
  }

  clear(): void {
    for (const id of [...this.turrets.keys()]) this.remove(id);
  }
}

// ---------------------------------------------------------------- land mines

export interface Mine {
  id: string;
  owner: string;
  at: THREE.Vector3;
  until: number;
  /** Server ms when it goes live */
  armedAt: number;
  group: THREE.Group;
  light: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
}

const mineBody = new THREE.MeshStandardMaterial({ color: 0x4a4d3a, metalness: 0.4, roughness: 0.7 });
const mineGeo = new THREE.CylinderGeometry(0.2, 0.23, 0.07, 16).translate(0, 0.035, 0);
const plateGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.03, 12).translate(0, 0.085, 0);
const blinkGeo = new THREE.SphereGeometry(0.045, 8, 6);

/**
 * Land mines: a flat disc on the floor. Its owner and their team see a blinking light on it;
 * enemies only see the dull disc, so a careful player can spot it and walk round.
 */
export class MineField {
  private readonly mines = new Map<string, Mine>();

  constructor(private readonly scene: THREE.Scene) {}

  place(id: string, owner: string, x: number, y: number, z: number, until: number): void {
    if (this.mines.has(id)) return;
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const body = new THREE.Mesh(mineGeo, mineBody);
    const plate = new THREE.Mesh(plateGeo, mineBody);
    body.receiveShadow = plate.receiveShadow = true;
    const light = new THREE.Mesh(blinkGeo, new THREE.MeshBasicMaterial({ color: 0xffb020 }));
    light.position.set(0.13, 0.08, 0);
    group.add(body, plate, light);
    this.scene.add(group);
    const armedAt = until - (MINE_DURATION - MINE_ARM) * 1000;
    this.mines.set(id, { id, owner, at: new THREE.Vector3(x, y, z), until, armedAt, group, light });
  }

  get(id: string): Mine | undefined {
    return this.mines.get(id);
  }

  /** Oldest first */
  ownedBy(owner: string): Mine[] {
    return [...this.mines.values()].filter((m) => m.owner === owner).sort((a, b) => a.until - b.until);
  }

  /** `friendly(owner)`: whether we may see that player's mine lights (ours and our team's). */
  update(serverNow: number, friendly: (owner: string) => boolean): void {
    for (const [id, m] of this.mines) {
      if (serverNow >= m.until) {
        this.remove(id);
        continue;
      }
      const armed = serverNow >= m.armedAt;
      // Amber while arming, then a red blink.
      m.light.visible = friendly(m.owner) && (!armed || serverNow % 900 < 320);
      m.light.material.color.setHex(armed ? 0xff2a2a : 0xffb020);
    }
  }

  remove(id: string): void {
    const m = this.mines.get(id);
    if (!m) return;
    this.scene.remove(m.group);
    m.light.material.dispose();
    this.mines.delete(id);
  }

  removeOwnedBy(owner: string): void {
    for (const m of this.ownedBy(owner)) this.remove(m.id);
  }

  clear(): void {
    for (const id of [...this.mines.keys()]) this.remove(id);
  }
}

// ---------------------------------------------------------------- scan pulse

interface Pulse {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  started: number;
  radius: number;
}

const PULSE_TIME = 0.9;

/** The scan pulse: a cyan ring that sweeps out across the floor. */
export class ScanPulses {
  private pulses: Pulse[] = [];
  private readonly geo = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);

  constructor(private readonly scene: THREE.Scene) {}

  emit(at: THREE.Vector3, radius: number): void {
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      color: 0x3fe0c8, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.position.copy(at).setY(at.y + 0.08);
    this.scene.add(mesh);
    this.pulses.push({ mesh, started: performance.now(), radius });
  }

  update(): void {
    const now = performance.now();
    this.pulses = this.pulses.filter((p) => {
      const k = (now - p.started) / 1000 / PULSE_TIME;
      if (k >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        return false;
      }
      p.mesh.scale.setScalar(Math.max(0.01, p.radius * k));
      p.mesh.material.opacity = 0.8 * (1 - k);
      return true;
    });
  }
}
