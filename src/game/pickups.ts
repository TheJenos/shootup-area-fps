import * as THREE from 'three';
import { ABILITIES } from './abilities';
import { ARENA_HALF } from './world';
import { boxTexture } from './textures';
import type { AbilityType, PickupRecord } from '../types';

export const MAX_PICKUPS = 6;
const PICKUP_RADIUS = 1.1;
/** Keep pickups this far from walls/crates and from each other */
const CLEARANCE = 1;
const SPACING = 4;

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

  add(id: string, record: PickupRecord): void {
    if (this.pickups.has(id) || !ABILITIES[record.type]) return;
    const color = ABILITIES[record.type].color;
    const iconMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 });
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const group = new THREE.Group();
    group.position.set(record.x, 0, record.z);
    const icon = iconMesh(record.type, iconMat);
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

  dispose(): void {
    for (const id of [...this.pickups.keys()]) this.remove(id);
    this.pedestal?.dispose();
  }
}
