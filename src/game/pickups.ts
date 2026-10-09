import * as THREE from 'three';
import { ABILITIES } from './abilities';
import type { World } from './world';
import { boxTexture } from './textures';
import { GUNS, buildGunModel, isPickupGun } from './guns';
import type { AbilityType, PickupRecord, PickupType } from '../types';

/** Abilities, guns and ammo boxes are stocked separately, so none crowds out the others */
export const MAX_PICKUPS = 6;
export const MAX_GUN_PICKUPS = 3;
export const MAX_AMMO_PICKUPS = 3;
export const AMMO_COLOR = 0xffd166;

export type PickupKind = 'gun' | 'ability' | 'ammo';
export const kindOf = (type: PickupType): PickupKind => (type === 'ammo' ? 'ammo' : isPickupGun(type) ? 'gun' : 'ability');
const PICKUP_RADIUS = 1.1;
/** Keep pickups this far from walls/crates and from each other */
const CLEARANCE = 1;
const SPACING = 4;
/** Items dropped by a dead player: rings around the body, kept apart so they don't stack */
const SCATTER_RADII = [1.3, 2, 2.8, 3.6];
const SCATTER_SPACING = 1.5;
const SCATTER_CLEARANCE = 0.5;
/** Rings searched around a dropped item's spot when something already lies there (m) */
const NEAR_RADII = [0.9, 1.5, 2.2, 3, 3.8];

const ringGeo = new THREE.RingGeometry(0.45, 0.6, 32).rotateX(-Math.PI / 2);
const pedestalGeo = new THREE.CylinderGeometry(0.62, 0.72, 0.12, 24).translate(0, 0.06, 0);
const beamGeo = new THREE.CylinderGeometry(0.04, 0.04, 5, 6, 1, true).translate(0, 2.5, 0);

function iconMesh(type: AbilityType, mat: THREE.Material): THREE.Object3D {
  switch (type) {
    case 'medkit': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.18), mat));
      const white = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 });
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.2), white));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.2), white));
      return g;
    }
    case 'shield':
      return new THREE.Mesh(new THREE.IcosahedronGeometry(0.28), mat);
    case 'speed':
      return new THREE.Mesh(new THREE.OctahedronGeometry(0.3), mat);
    case 'dash':
      return new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 20), mat);
    case 'grenade': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), mat));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 8).translate(0, 0.25, 0), mat));
      return g;
    }
    case 'smoke': {
      // A canister with a ring of little puffs
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.36, 12), mat));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        g.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6).translate(Math.cos(a) * 0.22, 0.24, Math.sin(a) * 0.22), mat));
      }
      return g;
    }
    case 'cloak': {
      // A hooded ghost: a capsule body with two dark eyes
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.2, 4, 12), mat));
      const dark = new THREE.MeshStandardMaterial({ color: 0x1a1030 });
      for (const x of [-0.06, 0.06]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), dark);
        eye.position.set(x, 0.1, 0.14);
        g.add(eye);
      }
      return g;
    }
    case 'scan': {
      // A radar dish: a flat ring around a small core
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 8, 24).rotateX(Math.PI / 2), mat));
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 8, 20).rotateX(Math.PI / 2), mat));
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat));
      return g;
    }
    case 'molotov': {
      // A bottle with a rag in the neck
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.3, 12), mat));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.14, 8).translate(0, 0.22, 0), mat));
      g.add(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 6).translate(0, 0.34, 0), new THREE.MeshBasicMaterial({ color: 0xffd060 })));
      return g;
    }
    case 'flash': {
      // A stubby canister with a pin ring
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.32, 12), mat));
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.015, 6, 12).translate(0.09, 0.2, 0), mat));
      return g;
    }
    case 'turret': {
      // A small gun head on a post
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 8).translate(0, -0.12, 0), mat));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.3).translate(0, 0.08, 0), mat));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 8).rotateX(Math.PI / 2).translate(0, 0.08, -0.26), mat));
      return g;
    }
    case 'mine': {
      // A flat disc with a pressure plate on top
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.1, 16), mat));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12).translate(0, 0.07, 0), mat));
      return g;
    }
    case 'lifesteal': {
      // A drop: a sphere with a cone on top
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), mat));
      g.add(new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.24, 14).translate(0, 0.2, 0), mat));
      return g;
    }
    case 'wall': {
      // A folded barrier: two slabs in a shallow V
      const g = new THREE.Group();
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.06), mat);
      a.position.x = -0.14;
      a.rotation.y = 0.35;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.06), mat);
      b.position.x = 0.14;
      b.rotation.y = -0.35;
      g.add(a, b);
      return g;
    }
  }
}

/** An ammo box: a crate with a few bullet tips standing in it. */
function ammoMesh(mat: THREE.Material): THREE.Object3D {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.26, 0.3), mat));
  const brass = new THREE.MeshStandardMaterial({ color: 0xe0b060, metalness: 0.7, roughness: 0.3 });
  for (let i = 0; i < 4; i++) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.22, 8), brass);
    tip.position.set(-0.15 + i * 0.1, 0.22, 0);
    g.add(tip);
  }
  return g;
}

interface PickupView {
  record: PickupRecord;
  group: THREE.Group;
  icon: THREE.Object3D;
  materials: THREE.Material[];
  phase: number;
}

/** Ability pickups lying on the map. Mirrors rooms/{code}/pickups. */
export class PickupField {
  private readonly scene: THREE.Scene;
  /** Everything taking up floor space (cover, ramps), so pickups don't land inside it */
  private readonly colliders: THREE.Box3[];
  /** The current map: its size, and the ground to stand pickups on */
  private readonly map: () => Pick<World, 'half' | 'groundAt' | 'pickupSpots'>;
  private readonly pickups = new Map<string, PickupView>();

  private pedestal: THREE.MeshStandardMaterial | null = null;

  constructor(scene: THREE.Scene, obstacles: THREE.Box3[], map: () => Pick<World, 'half' | 'groundAt' | 'pickupSpots'>) {
    this.scene = scene;
    this.colliders = obstacles;
    this.map = map;
  }

  /** Height of the floor (or hillside) at (x, z), ignoring anything standing there. */
  private floorAt(x: number, z: number): number {
    return this.map().groundAt(new THREE.Vector3(x, 0, z)).y;
  }

  /** Metal plate under every pickup; one material shared by all of them. */
  private pedestalMaterial(): THREE.MeshStandardMaterial {
    const map = boxTexture('metal');
    this.pedestal ??= new THREE.MeshStandardMaterial({
      color: 0x9aa3ad, map, bumpMap: map, bumpScale: 0.8, roughness: 0.5, metalness: 0.4,
    });
    return this.pedestal;
  }

  get count(): number {
    return this.pickups.size;
  }

  /** What kind of pickup `id` is */
  typeOf(id: string): PickupRecord['type'] | undefined {
    return this.pickups.get(id)?.record.type;
  }

  /** How many guns / abilities / ammo boxes are lying around */
  countOf(kind: PickupKind): number {
    let n = 0;
    for (const p of this.pickups.values()) if (kindOf(p.record.type) === kind) n++;
    return n;
  }

  add(id: string, record: PickupRecord): void {
    const type = record.type;
    const kind = kindOf(type);
    if (this.pickups.has(id) || (kind === 'ability' && !ABILITIES[type as AbilityType])) return;
    const color = kind === 'gun' ? GUNS[type as Exclude<PickupType, AbilityType | 'ammo'>].color
      : kind === 'ammo' ? AMMO_COLOR : ABILITIES[type as AbilityType].color;
    const iconMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 });
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const group = new THREE.Group();
    group.position.set(record.x, this.floorAt(record.x, record.z), record.z);
    let icon: THREE.Object3D;
    if (kind === 'gun') {
      // A full-size copy of the gun itself, spinning on its side.
      const model = buildGunModel(type as Exclude<PickupType, AbilityType | 'ammo'>).group;
      model.scale.setScalar(1.6);
      model.rotation.z = Math.PI / 2;
      icon = new THREE.Group().add(model);
    } else if (kind === 'ammo') {
      icon = ammoMesh(iconMat);
    } else {
      icon = iconMesh(type as AbilityType, iconMat);
    }
    icon.position.y = 0.9;
    const ring = new THREE.Mesh(ringGeo, glowMat);
    ring.position.y = 0.13;
    const beam = new THREE.Mesh(beamGeo, glowMat);
    const pedestal = new THREE.Mesh(pedestalGeo, this.pedestalMaterial());
    pedestal.receiveShadow = true;
    group.add(pedestal, icon, ring, beam);
    this.scene.add(group);
    this.pickups.set(id, { record, group, icon, materials: [iconMat, glowMat], phase: Math.random() * Math.PI * 2 });
  }

  remove(id: string): void {
    const p = this.pickups.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.materials.forEach((m) => m.dispose());
    // Icon geometries are per pickup; the ring and beam are shared. A gun icon is a copy of the gun
    // model, whose geometry is shared with every gun in hand: disposing it would make the GPU
    // upload it again.
    if (kindOf(p.record.type) !== 'gun') p.icon.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.pickups.delete(id);
  }

  update(time: number): void {
    for (const p of this.pickups.values()) {
      p.icon.rotation.y = time * 1.5 + p.phase;
      p.icon.position.y = 0.9 + Math.sin(time * 2 + p.phase) * 0.12;
    }
  }

  /** The pickup the player is standing on, if any. */
  /** Everything lying on the map: where it is (its stand's height included) and what it is */
  list(): { id: string; type: PickupType; uses?: number; x: number; y: number; z: number }[] {
    return [...this.pickups].map(([id, p]) => ({ id, type: p.record.type, ...(p.record.uses !== undefined ? { uses: p.record.uses } : {}), x: p.record.x, y: p.group.position.y, z: p.record.z }));
  }

  touching(pos: THREE.Vector3): string | null {
    for (const [id, p] of this.pickups) {
      const dx = p.record.x - pos.x;
      const dz = p.record.z - pos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && pos.y < p.group.position.y + 1.5) return id;
    }
    return null;
  }

  /** A spot for a new pickup: one the map set aside if any is free, else random open floor. */
  randomSpot(): { x: number; z: number } | null {
    const spots = this.map().pickupSpots;
    for (let i = 0, start = Math.floor(Math.random() * spots.length); i < spots.length; i++) {
      const s = spots[(start + i) % spots.length]!;
      if (![...this.pickups.values()].some((p) => Math.hypot(p.record.x - s.x, p.record.z - s.z) < SPACING)) return { x: s.x, z: s.z };
    }
    const limit = this.map().half - 2;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;
      const blocked = this.colliders.some((c) =>
        x > c.min.x - CLEARANCE && x < c.max.x + CLEARANCE && z > c.min.z - CLEARANCE && z < c.max.z + CLEARANCE);
      if (blocked) continue;
      const crowded = [...this.pickups.values()].some((p) => Math.hypot(p.record.x - x, p.record.z - z) < SPACING);
      if (crowded) continue;
      return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
    }
    return null;
  }

  /**
   * `count` spots on open floor in a ring around (x, z), spread apart rather than stacked:
   * evenly spaced angles, pushed further out when cover or the arena edge is in the way.
   */
  scatterAround(x: number, z: number, count: number): { x: number; z: number }[] {
    const limit = this.map().half - 1;
    const spots: { x: number; z: number }[] = [];
    const free = (sx: number, sz: number) => this.isOpen(sx, sz, spots);
    const start = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const base = start + (i / count) * Math.PI * 2;
      let spot: { x: number; z: number } | null = null;
      search: for (const r of SCATTER_RADII) {
        // Try the item's own direction first, then swing either way around the body.
        for (let k = 0; k < 12; k++) {
          const a = base + Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (Math.PI / 6);
          const sx = x + Math.sin(a) * r;
          const sz = z + Math.cos(a) * r;
          if (free(sx, sz)) {
            spot = { x: sx, z: sz };
            break search;
          }
        }
      }
      // Boxed in on every side: fall back to the body itself.
      spot ??= { x: THREE.MathUtils.clamp(x, -limit, limit), z: THREE.MathUtils.clamp(z, -limit, limit) };
      spots.push({ x: Math.round(spot.x * 100) / 100, z: Math.round(spot.z * 100) / 100 });
    }
    return spots;
  }

  /**
   * Where to put one dropped item meant for (x, z): right there if it's clear, otherwise the nearest
   * clear spot around it, so drops spread out instead of piling onto each other.
   */
  spotNear(x: number, z: number): { x: number; z: number } {
    const limit = this.map().half - 1;
    const round = (v: number) => Math.round(v * 100) / 100;
    if (this.isOpen(x, z)) return { x: round(x), z: round(z) };
    const start = Math.random() * Math.PI * 2;
    for (const r of NEAR_RADII) {
      for (let k = 0; k < 12; k++) {
        const a = start + (k / 12) * Math.PI * 2;
        const sx = x + Math.sin(a) * r;
        const sz = z + Math.cos(a) * r;
        if (this.isOpen(sx, sz)) return { x: round(sx), z: round(sz) };
      }
    }
    // Nowhere clear nearby: the spot asked for, then.
    return { x: round(THREE.MathUtils.clamp(x, -limit, limit)), z: round(THREE.MathUtils.clamp(z, -limit, limit)) };
  }

  /** Open floor inside the arena, clear of cover, and not on top of another pickup (or `taken` spot). */
  private isOpen(x: number, z: number, taken: readonly { x: number; z: number }[] = []): boolean {
    const limit = this.map().half - 1;
    if (Math.abs(x) >= limit || Math.abs(z) >= limit) return false;
    const blocked = this.colliders.some((c) =>
      x > c.min.x - SCATTER_CLEARANCE && x < c.max.x + SCATTER_CLEARANCE &&
      z > c.min.z - SCATTER_CLEARANCE && z < c.max.z + SCATTER_CLEARANCE);
    if (blocked) return false;
    for (const o of taken) if (Math.hypot(o.x - x, o.z - z) < SCATTER_SPACING) return false;
    for (const p of this.pickups.values()) if (Math.hypot(p.record.x - x, p.record.z - z) < SCATTER_SPACING) return false;
    return true;
  }

  dispose(): void {
    for (const id of [...this.pickups.keys()]) this.remove(id);
    this.pedestal?.dispose();
  }
}
