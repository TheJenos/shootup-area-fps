import * as THREE from 'three';
import { grenadeTexture } from './textures';

const GRAVITY = 18;
const STEP = 1 / 120;
const FUSE = 2.5;
const RADIUS = 0.12;
export const THROW_SPEED = 17;
export const THROW_LIFT = 4;

export interface Trajectory {
  /** Sampled positions, one per STEP seconds */
  points: THREE.Vector3[];
  /** Where it explodes */
  end: THREE.Vector3;
  /** Seconds from throw to explosion */
  duration: number;
}

/**
 * Integrates a grenade arc with a fixed step, so every client that receives the same
 * origin and velocity draws exactly the same flight. It explodes on first contact
 * with the floor or any cover, or when the fuse runs out.
 */
export function simulateGrenade(origin: THREE.Vector3, velocity: THREE.Vector3, colliders: THREE.Box3[]): Trajectory {
  const p = origin.clone();
  const v = velocity.clone();
  const points = [p.clone()];
  let t = 0;
  while (t < FUSE) {
    v.y -= GRAVITY * STEP;
    p.addScaledVector(v, STEP);
    t += STEP;
    points.push(p.clone());
    if (p.y <= RADIUS) {
      p.y = RADIUS;
      break;
    }
    const hit = colliders.some((c) =>
      p.x > c.min.x - RADIUS && p.x < c.max.x + RADIUS &&
      p.y > c.min.y - RADIUS && p.y < c.max.y + RADIUS &&
      p.z > c.min.z - RADIUS && p.z < c.max.z + RADIUS);
    if (hit) break;
  }
  return { points, end: p.clone(), duration: t };
}

const grenadeGeo = new THREE.SphereGeometry(RADIUS, 12, 8);
let grenadeMat: THREE.MeshStandardMaterial | null = null;
function grenadeMaterial(): THREE.MeshStandardMaterial {
  grenadeMat ??= new THREE.MeshStandardMaterial({
    map: grenadeTexture(), roughness: 0.6, emissive: 0xff4a1a, emissiveIntensity: 0.25,
  });
  return grenadeMat;
}
const blastGeo = new THREE.SphereGeometry(1, 24, 16);

interface Flight {
  mesh: THREE.Mesh;
  trajectory: Trajectory;
  startedAt: number;
}

interface Blast {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  light: THREE.PointLight;
  startedAt: number;
  radius: number;
}

const BLAST_LIFE = 450;

/** Flying grenades and explosion effects, for our own grenades and everyone else's. */
export class GrenadeFx {
  private readonly scene: THREE.Scene;
  private readonly flights = new Map<string, Flight>();
  private blasts: Blast[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  launch(id: string, trajectory: Trajectory): void {
    const mesh = new THREE.Mesh(grenadeGeo, grenadeMaterial());
    mesh.castShadow = true;
    mesh.position.copy(trajectory.points[0] ?? trajectory.end);
    this.scene.add(mesh);
    this.flights.set(id, { mesh, trajectory, startedAt: performance.now() });
  }

  /** The projectile landed without a blast (smoke canisters). */
  land(id: string): void {
    const flight = this.flights.get(id);
    if (!flight) return;
    this.scene.remove(flight.mesh);
    this.flights.delete(id);
  }

  explode(id: string, at: THREE.Vector3, radius: number): void {
    const flight = this.flights.get(id);
    if (flight) {
      this.scene.remove(flight.mesh);
      this.flights.delete(id);
    }
    const mesh = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({
      color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    mesh.position.copy(at);
    const light = new THREE.PointLight(0xff8a3a, 0, radius * 4);
    light.position.copy(at).y += 0.5;
    this.scene.add(mesh, light);
    this.blasts.push({ mesh, light, startedAt: performance.now(), radius });
  }

  update(): void {
    const now = performance.now();
    for (const [id, f] of this.flights) {
      const i = Math.min(Math.floor((now - f.startedAt) / 1000 / STEP), f.trajectory.points.length - 1);
      const point = f.trajectory.points[i];
      if (point) f.mesh.position.copy(point);
      // Safety net in case the blast event never arrives
      if (now - f.startedAt > (f.trajectory.duration + 2) * 1000) {
        this.scene.remove(f.mesh);
        this.flights.delete(id);
      }
    }
    this.blasts = this.blasts.filter((b) => {
      const k = (now - b.startedAt) / BLAST_LIFE;
      if (k >= 1) {
        this.scene.remove(b.mesh, b.light);
        b.mesh.material.dispose();
        b.light.dispose();
        return false;
      }
      b.mesh.scale.setScalar(b.radius * (0.3 + 0.7 * Math.sqrt(k)));
      b.mesh.material.opacity = 0.85 * (1 - k);
      b.light.intensity = 40 * (1 - k);
      return true;
    });
  }

  dispose(): void {
    for (const f of this.flights.values()) this.scene.remove(f.mesh);
    this.flights.clear();
    for (const b of this.blasts) {
      this.scene.remove(b.mesh, b.light);
      b.mesh.material.dispose();
    }
    this.blasts = [];
  }
}
