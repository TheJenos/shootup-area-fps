import * as THREE from 'three';
import { grenadeTexture } from './textures';
import { GROUP, activePhysics, groups, type PhysicsWorld } from './physics';

const GRAVITY = 18;
const STEP = 1 / 120;
const FUSE = 2.5;
/** A bouncing grenade goes off this long after the throw, wherever it has rolled to (s) */
const GRENADE_FUSE = 1.8;
const RADIUS = 0.12;
/** Share of the speed into a surface that comes back out of it */
const RESTITUTION = 0.4;
/** Hits slower than this (m/s, into the surface) don't bounce: the canister settles and rolls */
const BOUNCE_FROM = 1.5;
/** Share of the sliding speed kept by each bounce */
const IMPACT_GRIP = 0.7;
/** How fast rolling on the ground bleeds speed (1/s) */
const ROLL_FRICTION = 3.5;
/** Below this speed (m/s) on the ground, it has come to rest */
const REST_SPEED = 0.3;
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
 * How a thrown thing behaves: `impact` goes off on first contact (molotov, flashbang); `grenade`
 * bounces and rolls until its fuse runs out; `smoke` bounces and goes off once it comes to rest.
 */
export type FlightKind = 'impact' | 'grenade' | 'smoke';

/**
 * Integrates a thrown arc with a fixed step, so every client that receives the same origin and
 * velocity draws exactly the same flight. With the physics engine loaded, it sweeps a ball through
 * the map (boxes, ramps, deployed walls) and bounces off what it hits; that's a geometric query,
 * not a simulation, so it comes out the same everywhere. Without it, it stops at the first box.
 */
export function simulateGrenade(
  origin: THREE.Vector3, velocity: THREE.Vector3, colliders: THREE.Box3[], kind: FlightKind = 'impact',
): Trajectory {
  const physics = activePhysics();
  if (physics) return sweptFlight(physics, origin, velocity, kind);
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

const _n = new THREE.Vector3();
const _tan = new THREE.Vector3();

function sweptFlight(physics: PhysicsWorld, origin: THREE.Vector3, velocity: THREE.Vector3, kind: FlightKind): Trajectory {
  const { R, world } = physics;
  const ball = new R.Ball(RADIUS);
  const flags = R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC;
  const filter = groups(GROUP.THROWN, GROUP.WORLD);
  const fuse = kind === 'grenade' ? GRENADE_FUSE : FUSE;
  const p = origin.clone();
  const v = velocity.clone();
  const points = [p.clone()];
  let t = 0;
  flight: while (t < fuse) {
    v.y -= GRAVITY * STEP;
    let left = STEP;
    let grounded = false;
    // A step can hit more than one surface (into a corner): a few sweeps at most.
    for (let i = 0; i < 3 && left > 1e-7; i++) {
      const hit = world.castShape(p, IDENTITY, v, ball, 0, left, false, flags, filter);
      if (!hit) {
        p.addScaledVector(v, left);
        break;
      }
      const toi = hit.time_of_impact;
      p.addScaledVector(v, toi);
      left -= toi;
      if (kind === 'impact') {
        t += STEP - left;
        points.push(p.clone());
        break flight;
      }
      // The surface normal faces out of what we hit: the ball's own contact normal, reversed.
      _n.set(-hit.normal2.x, -hit.normal2.y, -hit.normal2.z).normalize();
      const into = v.dot(_n);
      if (into < 0) {
        const bounce = -into > BOUNCE_FROM ? RESTITUTION : 0;
        _tan.copy(v).addScaledVector(_n, -into);
        // A real bounce scrubs some sliding speed; settling onto a surface keeps it (rolling friction below).
        if (bounce > 0) _tan.multiplyScalar(IMPACT_GRIP);
        v.copy(_tan).addScaledVector(_n, -into * bounce);
      }
      // Back off the surface a hair so the next sweep doesn't start touching it.
      p.addScaledVector(_n, 1e-3);
    }
    // Resting on something? (A short probe down: sweeps along the ground don't always touch it.)
    const below = world.castShape(p, IDENTITY, DOWN, ball, 0, 0.01, false, flags, filter);
    if (below && -below.normal2.y > 0.6) grounded = true;
    if (grounded) {
      const keep = Math.exp(-ROLL_FRICTION * STEP);
      v.x *= keep;
      v.z *= keep;
    }
    if (p.y < RADIUS) {
      // Never below the floor, whatever happened.
      p.y = RADIUS;
      if (v.y < 0) v.y = 0;
    }
    t += STEP;
    points.push(p.clone());
    if (grounded && v.lengthSq() < REST_SPEED * REST_SPEED) {
      if (kind === 'smoke') break;
      v.set(0, 0, 0);
    }
  }
  return { points, end: p.clone(), duration: t };
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const DOWN = { x: 0, y: -1, z: 0 };

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
/**
 * Explosion lights are created once and stay in the scene (dark until used): adding or removing a
 * light changes the scene's light count, which makes every lit material recompile its shader — a
 * visible hitch on every explosion. With a fixed pool, the count never changes.
 */
const LIGHT_POOL = 1;

/** Flying grenades and explosion effects, for our own grenades and everyone else's. */
export class GrenadeFx {
  private readonly scene: THREE.Scene;
  private readonly flights = new Map<string, Flight>();
  private blasts: Blast[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private nextLight = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xff8a3a, 0, 20);
      light.visible = true;
      this.lights.push(light);
      scene.add(light);
    }
    // Compile the blast material's shader now, not on the first explosion: an invisible, tiny blast.
    const warm = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({
      color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    warm.scale.setScalar(0.001);
    warm.position.set(0, -50, 0);
    warm.frustumCulled = false;
    warm.onAfterRender = () => {
      scene.remove(warm);
      warm.material.dispose();
    };
    scene.add(warm);
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

  /** @param color the fireball (white for a flashbang) */
  explode(id: string, at: THREE.Vector3, radius: number, color = 0xffa040): void {
    const flight = this.flights.get(id);
    if (flight) {
      this.scene.remove(flight.mesh);
      this.flights.delete(id);
    }
    const mesh = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    mesh.position.copy(at);
    // Reuse the oldest light in the pool.
    const light = this.lights[this.nextLight++ % this.lights.length]!;
    light.distance = radius * 4;
    light.color.set(color === 0xffa040 ? 0xff8a3a : color);
    light.position.copy(at).y += 0.5;
    this.scene.add(mesh);
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
        this.scene.remove(b.mesh);
        b.mesh.material.dispose();
        // The light goes dark but stays in the scene (see LIGHT_POOL); unless a newer blast took it.
        if (!this.blasts.some((o) => o !== b && o.light === b.light && o.startedAt > b.startedAt)) b.light.intensity = 0;
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
      this.scene.remove(b.mesh);
      b.mesh.material.dispose();
    }
    this.blasts = [];
    for (const l of this.lights) {
      this.scene.remove(l);
      l.dispose();
    }
  }
}
