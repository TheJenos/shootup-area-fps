import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Ramp } from './ramps';

/*
 * Rapier rigid-body physics, shared by ragdolls, loose props, thrown items and the player.
 *
 * The engine (a ~4 MB WebAssembly module) is loaded the first time a game starts, in its own
 * chunk, so the lobby never downloads it. One PhysicsWorld per game holds the map's static
 * geometry (rebuilt for each map) plus whatever moving bodies the systems add.
 *
 * Rapier isn't bit-for-bit identical across machines, so anything every player must agree on is
 * simulated by one client and the result is sent; the rest (bodies, debris) is local eye candy.
 */

export type Rapier = typeof RAPIER_NS;
export type RapierWorld = RAPIER_NS.World;
export type RapierBody = RAPIER_NS.RigidBody;
export type RapierCollider = RAPIER_NS.Collider;

let rapier: Rapier | null = null;
let loading: Promise<Rapier> | null = null;

/** Download and start the engine (once). Call early: the game can't start without it. */
export function loadPhysics(): Promise<Rapier> {
  loading ??= import('@dimforge/rapier3d-compat')
    .then(async (mod) => {
      const R = (mod as unknown as { default?: Rapier }).default ?? (mod as unknown as Rapier);
      await R.init();
      rapier = R;
      return R;
    })
    .catch((err: unknown) => {
      loading = null; // allow a retry on the next join
      throw err;
    });
  return loading;
}

/** The engine, once loadPhysics() has resolved. */
export function getRapier(): Rapier {
  if (!rapier) throw new Error('Physics used before loadPhysics() finished');
  return rapier;
}

/** World gravity (m/s²), the same the player and grenades always used */
export const GRAVITY = 22;
/** Fixed simulation step (s): steady results whatever the frame rate */
export const PHYSICS_STEP = 1 / 60;
/** At most this many steps per frame; after a long stall the simulation slows rather than spiral */
const MAX_STEPS = 4;

/**
 * Collision groups (Rapier packs "member of" in the high 16 bits and "collides with" in the low 16).
 * Ragdolls don't hit players or each other's limbs explosively; debris doesn't push the player.
 */
export const GROUP = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  RAGDOLL: 1 << 2,
  DEBRIS: 1 << 3,
  THROWN: 1 << 4,
} as const;
export function groups(member: number, filter: number): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}
const ALL = 0xffff;

let active: PhysicsWorld | null = null;
/** The game's world, for systems that don't own one (ragdolls, grenade arcs). Null outside a game. */
export function setActivePhysics(p: PhysicsWorld | null): void {
  active = p;
}
export function activePhysics(): PhysicsWorld | null {
  return active && !active.disposed ? active : null;
}

export class PhysicsWorld {
  readonly R: Rapier;
  readonly world: RapierWorld;
  /** Set once freed: anything still holding bodies must not touch them */
  disposed = false;
  /** The map's fixed geometry: boxes, ramps, the floor and the out-of-bounds walls */
  private mapBody: RapierBody | null = null;
  /** Colliders added and removed while playing (deployable walls, turrets), by owner key */
  private readonly extras = new Map<unknown, RapierCollider>();
  private accumulator = 0;
  /** Called after every fixed step, with the step length */
  private readonly stepListeners = new Set<(dt: number) => void>();

  constructor() {
    this.R = getRapier();
    this.world = new this.R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
  }

  /** Replace the map geometry. Boxes are axis-aligned; ramps become wedge-shaped hulls. */
  setMap(colliders: readonly THREE.Box3[], ramps: readonly Ramp[]): void {
    const { R, world } = this;
    if (this.mapBody) world.removeRigidBody(this.mapBody);
    // Deployed walls and turrets hung off the old map body; they went with it.
    this.extras.clear();
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    this.mapBody = body;
    const solid = groups(GROUP.WORLD, ALL);
    // The floor: a thick slab whose top is y = 0.
    world.createCollider(R.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setCollisionGroups(solid).setFriction(0.9), body);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    for (const box of colliders) {
      if (box.isEmpty()) continue;
      box.getCenter(center);
      box.getSize(size);
      world.createCollider(
        R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setTranslation(center.x, center.y, center.z)
          .setCollisionGroups(solid)
          .setFriction(0.8),
        body,
      );
    }
    for (const ramp of ramps) {
      const desc = R.ColliderDesc.convexHull(wedgePoints(ramp));
      if (desc) world.createCollider(desc.setCollisionGroups(solid).setFriction(0.8), body);
    }
    // Queries (the player's movement) only see new colliders after a step.
    world.step();
  }

  /** A box that appears mid-round (a deployed wall, a turret); `key` removes it again. */
  addBox(key: unknown, box: THREE.Box3): void {
    this.removeBox(key);
    if (!this.mapBody) return;
    const { R } = this;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const collider = this.world.createCollider(
      R.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setTranslation(c.x, c.y, c.z).setCollisionGroups(groups(GROUP.WORLD, ALL)),
      this.mapBody,
    );
    this.extras.set(key, collider);
  }

  removeBox(key: unknown): void {
    const collider = this.extras.get(key);
    if (!collider) return;
    this.extras.delete(key);
    if (collider.isValid()) this.world.removeCollider(collider, true);
  }

  /** Run `fn` after every fixed step (returns an unsubscribe function). */
  onStep(fn: (dt: number) => void): () => void {
    this.stepListeners.add(fn);
    return () => this.stepListeners.delete(fn);
  }

  /** Advance by a frame's worth of fixed steps. Returns how far into the next step we are (0..1). */
  update(dt: number): number {
    this.accumulator = Math.min(this.accumulator + dt, PHYSICS_STEP * MAX_STEPS);
    while (this.accumulator >= PHYSICS_STEP) {
      this.world.step();
      for (const fn of this.stepListeners) fn(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
    }
    return this.accumulator / PHYSICS_STEP;
  }

  dispose(): void {
    this.disposed = true;
    this.stepListeners.clear();
    this.extras.clear();
    this.mapBody = null;
    this.world.free();
  }
}

/** The 8 corners of a ramp's wedge (the low end's top corners sit on its floor). */
function wedgePoints(r: Ramp): Float32Array {
  const { min, max } = r.box;
  const rising = (x: number, z: number) => {
    const along = r.dir[0] === 'x' ? (x - min.x) / (max.x - min.x) : (z - min.z) / (max.z - min.z);
    return min.y + (max.y - min.y) * (r.dir[1] === '+' ? along : 1 - along);
  };
  const pts: number[] = [];
  for (const [x, z] of [[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z]] as const) {
    pts.push(x, min.y, z, x, Math.max(rising(x, z), min.y + 0.01), z);
  }
  return new Float32Array(pts);
}

/** Copy a Rapier vector or rotation into a three.js one. */
export const toVec3 = (v: { x: number; y: number; z: number }, out: THREE.Vector3): THREE.Vector3 => out.set(v.x, v.y, v.z);
export const toQuat = (q: { x: number; y: number; z: number; w: number }, out: THREE.Quaternion): THREE.Quaternion =>
  out.set(q.x, q.y, q.z, q.w);
