import * as THREE from 'three';
import { ABILITIES } from './abilities';
import { ARENA_HALF } from './world';
import { boxTexture } from './textures';
import { GUNS, buildGunModel, isPickupGun } from './guns';
import type { AbilityType, PickupRecord } from '../types';

/** Abilities and guns are stocked separately, so guns don't crowd out abilities */
export const MAX_PICKUPS = 6;
export const MAX_GUN_PICKUPS = 3;
const PICKUP_RADIUS = 1.1;
/** Keep pickups this far from walls/crates and from each other */
const CLEARANCE = 1;
const SPACING = 4;
/** Items dropped by a dead player: rings around the body, kept apart so they don't stack */
const SCATTER_RADII = [1.3, 2, 2.8, 3.6];
const SCATTER_SPACING = 1.5;
const SCATTER_CLEARANCE = 0.5;

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
  }
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
  private readonly colliders: THREE.Box3[];
  private readonly pickups = new Map<string, PickupView>();

  private pedestal: THREE.MeshStandardMaterial | null = null;

  constructor(scene: THREE.Scene, colliders: THREE.Box3[]) {
    this.scene = scene;
    this.colliders = colliders;
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

  /** How many guns / abilities are lying around */
  countOf(kind: 'gun' | 'ability'): number {
    let n = 0;
    for (const p of this.pickups.values()) if (isPickupGun(p.record.type) === (kind === 'gun')) n++;
    return n;
  }

  add(id: string, record: PickupRecord): void {
    const type = record.type;
    const gun = isPickupGun(type);
    if (this.pickups.has(id) || (!gun && !ABILITIES[type])) return;
    const color = gun ? GUNS[type].color : ABILITIES[type].color;
    const iconMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 });
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const group = new THREE.Group();
    group.position.set(record.x, 0, record.z);
    let icon: THREE.Object3D;
    if (gun) {
      // A full-size copy of the gun itself, spinning on its side.
      const model = buildGunModel(type).group;
      model.scale.setScalar(1.6);
      model.rotation.z = Math.PI / 2;
      icon = new THREE.Group().add(model);
    } else {
      icon = iconMesh(type, iconMat);
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
    // Icon geometries are per pickup; the ring and beam are shared.
    p.icon.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.pickups.delete(id);
  }

  update(time: number): void {
    for (const p of this.pickups.values()) {
      p.icon.rotation.y = time * 1.5 + p.phase;
      p.icon.position.y = 0.9 + Math.sin(time * 2 + p.phase) * 0.12;
    }
  }

  /** The pickup the player is standing on, if any. */
  touching(pos: THREE.Vector3): string | null {
    for (const [id, p] of this.pickups) {
      const dx = p.record.x - pos.x;
      const dz = p.record.z - pos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && pos.y < 1.5) return id;
    }
    return null;
  }

  /** A random spot on open floor, away from cover and other pickups. */
  randomSpot(): { x: number; z: number } | null {
    const limit = ARENA_HALF - 2;
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
    const limit = ARENA_HALF - 1;
    const spots: { x: number; z: number }[] = [];
    const free = (sx: number, sz: number) =>
      Math.abs(sx) < limit && Math.abs(sz) < limit &&
      !this.colliders.some((c) =>
        sx > c.min.x - SCATTER_CLEARANCE && sx < c.max.x + SCATTER_CLEARANCE &&
        sz > c.min.z - SCATTER_CLEARANCE && sz < c.max.z + SCATTER_CLEARANCE) &&
      ![...spots, ...[...this.pickups.values()].map((p) => p.record)]
        .some((o) => Math.hypot(o.x - sx, o.z - sz) < SCATTER_SPACING);
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

  dispose(): void {
    for (const id of [...this.pickups.keys()]) this.remove(id);
    this.pedestal?.dispose();
  }
}
