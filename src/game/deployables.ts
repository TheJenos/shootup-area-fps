import * as THREE from 'three';
import { boxTexture } from './textures';
import { canvas2d } from './canvas';

/*
 * Things abilities leave in the world for a while: smoke clouds and deployable cover.
 * Every client runs the same simulation from the event it receives, so they all agree.
 */

export const SMOKE_RADIUS = 3.6;
export const SMOKE_DURATION = 12;
/** Smoke grows to full size over this long (s), and thins out over the last stretch */
const SMOKE_BLOOM = 1.2;
const SMOKE_FADE = 2.5;
const PUFFS = 11;

export const WALL_SIZE = { w: 2.6, h: 1.3, d: 0.3 };
export const WALL_DURATION = 20;
/** The wall is placed this far in front of the player */
export const WALL_DISTANCE = 1.8;

interface Smoke {
  group: THREE.Group;
  puffs: { sprite: THREE.Sprite; offset: THREE.Vector3; size: number; drift: THREE.Vector3; spin: number }[];
  material: THREE.SpriteMaterial;
  startedAt: number;
}

let puffTexture: THREE.CanvasTexture | null = null;
/** A soft round blob: opaque in the middle, fading to nothing at the edge. */
function puffMap(): THREE.CanvasTexture {
  if (puffTexture) return puffTexture;
  const { canvas, g } = canvas2d(128, 128);
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  puffTexture = new THREE.CanvasTexture(canvas);
  return puffTexture;
}

/** Smoke clouds: a cluster of soft billboard puffs that bloom, drift, turn slowly and thin out. Visual only. */
export class SmokeField {
  private readonly scene: THREE.Scene;
  private readonly smokes = new Map<string, Smoke>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawn(id: string, at: THREE.Vector3): void {
    if (this.smokes.has(id)) return;
    const material = new THREE.SpriteMaterial({
      map: puffMap(), color: 0xd4d8de, transparent: true, opacity: 0.9, depthWrite: false, fog: true,
    });
    const group = new THREE.Group();
    group.position.copy(at);
    const seed = id.charCodeAt(0) + id.charCodeAt(1);
    const puffs = Array.from({ length: PUFFS }, (_, i) => {
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 5;
      // One puff in the middle; the rest ring it at different heights and distances.
      const angle = (i / (PUFFS - 1)) * Math.PI * 2 + seed;
      const spread = i === 0 ? 0 : SMOKE_RADIUS * (0.35 + ((i * 5) % 3) * 0.15);
      const offset = new THREE.Vector3(Math.cos(angle) * spread, 0.9 + (i % 3) * 0.7, Math.sin(angle) * spread);
      const size = SMOKE_RADIUS * (i === 0 ? 1.5 : 1 + ((i * 7) % 4) * 0.15);
      const drift = new THREE.Vector3(Math.cos(angle + 1) * 0.07, 0.05, Math.sin(angle + 1) * 0.07);
      group.add(sprite);
      return { sprite, offset, size, drift, spin: (i % 2 ? 1 : -1) * (0.08 + (i % 3) * 0.04) };
    });
    this.scene.add(group);
    this.smokes.set(id, { group, puffs, material, startedAt: performance.now() });
  }

  /** Whether `p` is inside any smoke (used to hide enemies' name tags, etc.) */
  inside(p: THREE.Vector3): boolean {
    for (const s of this.smokes.values()) if (s.group.position.distanceTo(p) < SMOKE_RADIUS) return true;
    return false;
  }

  update(): void {
    const now = performance.now();
    for (const [id, s] of this.smokes) {
      const age = (now - s.startedAt) / 1000;
      if (age >= SMOKE_DURATION) {
        this.remove(id);
        continue;
      }
      const bloom = Math.min(1, age / SMOKE_BLOOM);
      const grow = 1 - (1 - bloom) ** 3;
      const fade = Math.max(0, Math.min(1, (SMOKE_DURATION - age) / SMOKE_FADE));
      s.material.opacity = 0.9 * fade;
      for (const puff of s.puffs) {
        puff.sprite.position.copy(puff.offset).addScaledVector(puff.drift, age);
        const size = puff.size * grow * (1 + age * 0.03);
        puff.sprite.scale.set(size, size, 1);
        puff.sprite.material.rotation = 0;
        puff.sprite.rotation.z = age * puff.spin;
      }
    }
  }

  private remove(id: string): void {
    const s = this.smokes.get(id);
    if (!s) return;
    this.scene.remove(s.group);
    s.material.dispose();
    this.smokes.delete(id);
  }

  dispose(): void {
    for (const id of [...this.smokes.keys()]) this.remove(id);
  }
}

export type WallAxis = 'x' | 'z';

interface Wall {
  mesh: THREE.Mesh;
  box: THREE.Box3;
  /** Server ms when it disappears */
  until: number;
  material: THREE.MeshStandardMaterial;
}

/**
 * Deployable cover: a short wall that blocks movement and bullets for a while. Axis-aligned so
 * the player's box collisions work on it. Walls go into the shared collider / solid lists
 * while they stand.
 */
export class WallField {
  private readonly scene: THREE.Scene;
  private readonly colliders: THREE.Box3[];
  private readonly solids: THREE.Mesh[];
  private readonly walls = new Map<string, Wall>();
  private material: THREE.MeshStandardMaterial | null = null;

  constructor(scene: THREE.Scene, colliders: THREE.Box3[], solids: THREE.Mesh[]) {
    this.scene = scene;
    this.colliders = colliders;
    this.solids = solids;
  }

  /** The box a wall at (x, y, z) facing along `axis` would occupy. */
  static boxFor(x: number, y: number, z: number, axis: WallAxis): THREE.Box3 {
    const { w, h, d } = WALL_SIZE;
    const half = axis === 'x' ? new THREE.Vector3(w / 2, h / 2, d / 2) : new THREE.Vector3(d / 2, h / 2, w / 2);
    const center = new THREE.Vector3(x, y + h / 2, z);
    return new THREE.Box3(center.clone().sub(half), center.clone().add(half));
  }

  place(id: string, x: number, y: number, z: number, axis: WallAxis, until: number, color: number): void {
    if (this.walls.has(id)) return;
    const box = WallField.boxFor(x, y, z, axis);
    const size = box.getSize(new THREE.Vector3());
    const map = boxTexture('metal');
    const material = new THREE.MeshStandardMaterial({
      color, map, bumpMap: map, bumpScale: 0.6, roughness: 0.45, metalness: 0.5,
      emissive: color, emissiveIntensity: 0.12, transparent: true,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    box.getCenter(mesh.position);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.updateMatrixWorld();
    this.scene.add(mesh);
    this.colliders.push(box);
    this.solids.push(mesh);
    this.walls.set(id, { mesh, box, until, material });
  }

  /** @param serverNow the shared clock, so walls fall at the same moment for everyone */
  update(serverNow: number): void {
    for (const [id, w] of this.walls) {
      const left = (w.until - serverNow) / 1000;
      if (left <= 0) {
        this.remove(id);
        continue;
      }
      // Rises out of the floor, then flickers for the last two seconds.
      const age = WALL_DURATION - left;
      const rise = Math.min(1, age / 0.35);
      w.mesh.scale.y = rise;
      w.mesh.position.y = w.box.min.y + (w.box.max.y - w.box.min.y) * rise / 2;
      w.material.opacity = left < 2 ? 0.55 + 0.45 * Math.abs(Math.sin(left * 9)) : 1;
    }
  }

  private remove(id: string): void {
    const w = this.walls.get(id);
    if (!w) return;
    this.scene.remove(w.mesh);
    w.mesh.geometry.dispose();
    w.material.dispose();
    const c = this.colliders.indexOf(w.box);
    if (c >= 0) this.colliders.splice(c, 1);
    const s = this.solids.indexOf(w.mesh);
    if (s >= 0) this.solids.splice(s, 1);
    this.walls.delete(id);
  }

  /** New map: the old walls go with it. */
  clear(): void {
    for (const id of [...this.walls.keys()]) this.remove(id);
  }

  dispose(): void {
    this.clear();
    this.material?.dispose();
  }
}
