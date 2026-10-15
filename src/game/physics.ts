import * as THREE from 'three';
import type RAPIER_NS from '#rapier';
import type { Ramp } from './ramps';
import { rapierHeights, type Ground } from './mapgen';

/*
 * Rapier rigid-body physics, shared by ragdolls, loose props, thrown items and the player.
 *
 * The engine (a ~3 MB WebAssembly module) is loaded the first time a game starts, in its own
 * chunk, so the lobby never downloads it. One PhysicsWorld per game holds the map's static
 * geometry (rebuilt for each map) plus whatever moving bodies the systems add.
 *
 * `#rapier` (package.json "imports") is @dimforge/rapier3d in the browser: a real .wasm file the
 * browser compiles while it downloads. Node (bot training, tests) gets the -compat build instead,
 * which embeds the .wasm as base64 and needs init().
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
  loading ??= import('#rapier')
    .then(async (mod) => {
      const R = (mod as unknown as { default?: Rapier }).default ?? (mod as unknown as Rapier);
      // Only the -compat build has init(); the browser build is ready once imported
      const compat = R as Rapier & { init?: () => Promise<void> };
      if (typeof compat.init === 'function') await compat.init();
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
  /** Living players' bodies (ours, others', bots'): characters walk into each other, nothing else hits them */
  BODY: 1 << 5,
  /**
   * What bullets and lines of sight stop at (castRay). Most of the map is WORLD and SHOT; the invisible
   * boundary is WORLD only, and a model's bullet-only box SHOT only (the bot sim's SHOTS_GROUP is this bit).
   */
  SHOT: 1 << 6,
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

/**
 * What bullets stop at, where it isn't what people bump into (see setMap). The game's world.ts says;
 * without it (the bot sim adds its own), every collider stops bullets too.
 */
export interface ShotShapes {
  /** Colliders bullets fly through: the invisible boundary, `blocks: 'move'` boxes, a cylinder's inner boxes */
  passable: ReadonlySet<THREE.Box3>;
  /** Boxes that stop bullets but not people (`blocks: 'shots'`) */
  boxes: readonly THREE.Box3[];
  /** Upright cylinders (barrels, tanks), by their bounds: bullets stop at the round side, not at a corner */
  cylinders: readonly THREE.Box3[];
  /** Half the width of the drawn floor: past its edge, bullets fly on rather than stop at the slab under the map */
  floor: number;
}

/** Where castRay's ray stopped: how far along it, and the addBox key of what it hit (null: the map) */
export interface ShotHit {
  toi: number;
  key: unknown;
}

type Vec = { x: number; y: number; z: number };
const _line: Vec = { x: 0, y: 0, z: 0 };

export class PhysicsWorld {
  readonly R: Rapier;
  readonly world: RapierWorld;
  /** Set once freed: anything still holding bodies must not touch them */
  disposed = false;
  /** The map's fixed geometry: boxes, ramps, the floor and the out-of-bounds walls */
  private mapBody: RapierBody | null = null;
  /** Colliders added and removed while playing (deployable walls, turrets), by owner key */
  private readonly extras = new Map<unknown, RapierCollider>();
  /** The same, by collider handle: what castRay hit */
  private readonly keyOf = new Map<number, unknown>();
  /** Those added since the last step: Rapier's ray queries don't see them until then (see castRay) */
  private fresh: RapierCollider[] = [];
  /** castRay's ray, reused (bullets and lines of sight cast a lot of them) */
  private readonly ray: RAPIER_NS.Ray;
  private accumulator = 0;
  /** Called after every fixed step, with the step length */
  private readonly stepListeners = new Set<(dt: number) => void>();

  constructor() {
    this.R = getRapier();
    this.world = new this.R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
    this.ray = new this.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  /**
   * Replace the map geometry. Boxes are axis-aligned; ramps become wedge-shaped hulls; the ground a heightfield.
   * `shots` sorts out what stops bullets (castRay) from what only stops people.
   */
  setMap(colliders: readonly THREE.Box3[], ramps: readonly Ramp[], ground: Ground | null = null, shots: ShotShapes | null = null): void {
    const { R, world } = this;
    if (this.mapBody) world.removeRigidBody(this.mapBody);
    // Deployed walls and turrets hung off the old map body; they went with it.
    this.extras.clear();
    this.keyOf.clear();
    this.fresh = [];
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    this.mapBody = body;
    const solid = groups(GROUP.WORLD | GROUP.SHOT, ALL);
    const moveOnly = groups(GROUP.WORLD, ALL);
    // Only queries for SHOT see these: no body is a member of it, so nothing bumps into them.
    const shotOnly = groups(GROUP.SHOT, GROUP.SHOT);
    // The floor: a thick slab whose top is y = 0 (the ground never dips below it). Bullets stop at
    // the terrain, or on a flat map at the slab's drawn middle.
    world.createCollider(R.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setCollisionGroups(shots ? moveOnly : solid).setFriction(0.9), body);
    if (shots && !ground) world.createCollider(R.ColliderDesc.cuboid(shots.floor, 1, shots.floor).setTranslation(0, -1, 0).setCollisionGroups(shotOnly), body);
    // The terrain on top of it: a heightfield (the same triangles as the drawn floor), with internal
    // edges fixed so nothing snags on the seams between triangles.
    if (ground) {
      const desc = R.ColliderDesc.heightfield(
        ground.n, ground.n, rapierHeights(ground), { x: ground.n * ground.cell, y: 1, z: ground.n * ground.cell },
        R.HeightFieldFlags.FIX_INTERNAL_EDGES,
      );
      world.createCollider(desc.setCollisionGroups(solid).setFriction(0.9), body);
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    for (const box of colliders) {
      if (box.isEmpty()) continue;
      box.getCenter(center);
      box.getSize(size);
      world.createCollider(
        R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setTranslation(center.x, center.y, center.z)
          .setCollisionGroups(shots?.passable.has(box) ? moveOnly : solid)
          .setFriction(0.8),
        body,
      );
    }
    for (const ramp of ramps) {
      const desc = R.ColliderDesc.convexHull(wedgePoints(ramp));
      if (desc) world.createCollider(desc.setCollisionGroups(solid).setFriction(0.8), body);
    }
    for (const box of shots?.boxes ?? []) {
      if (box.isEmpty()) continue;
      box.getCenter(center);
      box.getSize(size);
      world.createCollider(R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(center.x, center.y, center.z).setCollisionGroups(shotOnly), body);
    }
    for (const box of shots?.cylinders ?? []) {
      const desc = cylinderDesc(R, box);
      if (desc) world.createCollider(desc.setCollisionGroups(shotOnly), body);
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
      R.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setTranslation(c.x, c.y, c.z).setCollisionGroups(groups(GROUP.WORLD | GROUP.SHOT, ALL)),
      this.mapBody,
    );
    this.extras.set(key, collider);
    this.keyOf.set(collider.handle, key);
    this.fresh.push(collider);
  }

  removeBox(key: unknown): void {
    const collider = this.extras.get(key);
    if (!collider) return;
    this.extras.delete(key);
    this.keyOf.delete(collider.handle);
    if (this.fresh.length) this.fresh = this.fresh.filter((c) => c !== collider);
    if (collider.isValid()) this.world.removeCollider(collider, true);
  }

  /**
   * The first thing a bullet from `o` along unit `dir` stops at within `max`: the map (its SHOT
   * shapes) or a box added with addBox, except the one keyed `skip`. Started inside a box (a muzzle
   * poking into a wall), it stops at the box's far side, so a gun can't fire through the wall it's in.
   */
  castRay(o: Vec, dir: Vec, max: number, skip?: unknown): ShotHit | null {
    const { origin, dir: d } = this.ray;
    origin.x = o.x;
    origin.y = o.y;
    origin.z = o.z;
    d.x = dir.x;
    d.y = dir.y;
    d.z = dir.z;
    const skipped = skip === undefined ? undefined : this.extras.get(skip);
    const hit = this.world.castRay(this.ray, max, false, undefined, groups(ALL, GROUP.SHOT), skipped);
    let toi = hit ? hit.timeOfImpact : max;
    let found = hit?.collider;
    // A barrier that went up this frame isn't in the query structure until the next step: try those
    // directly, or the first shots at it (at a low frame rate, a few) would go straight through.
    for (const c of this.fresh) {
      if (c === skipped) continue;
      const t = c.castRay(this.ray, toi, false);
      if (t >= 0 && t < toi) {
        toi = t;
        found = c;
      }
    }
    return found ? { toi, key: this.keyOf.get(found.handle) ?? null } : null;
  }

  /** Whether the line from `a` to `b` is clear of anything castRay stops at. */
  clearLine(a: Vec, b: Vec): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    _line.x = dx / len;
    _line.y = dy / len;
    _line.z = dz / len;
    return !this.castRay(a, _line, len);
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
      this.fresh.length = 0;
      for (const fn of this.stepListeners) fn(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
    }
    return this.accumulator / PHYSICS_STEP;
  }

  dispose(): void {
    this.disposed = true;
    this.stepListeners.clear();
    this.extras.clear();
    this.keyOf.clear();
    this.fresh = [];
    this.mapBody = null;
    this.world.free();
  }
}

/**
 * A round thing's shape for bullets: a cylinder, or for one drawn stretched (world.ts scales it), a
 * hull round its oval. Either way the side is round, as drawn, not the box's corners.
 */
function cylinderDesc(R: Rapier, box: THREE.Box3): RAPIER_NS.ColliderDesc | null {
  if (box.isEmpty()) return null;
  const rx = (box.max.x - box.min.x) / 2;
  const rz = (box.max.z - box.min.z) / 2;
  const hy = (box.max.y - box.min.y) / 2;
  const cx = box.min.x + rx;
  const cy = box.min.y + hy;
  const cz = box.min.z + rz;
  if (Math.abs(rx - rz) < 1e-3) return R.ColliderDesc.cylinder(hy, rx).setTranslation(cx, cy, cz);
  const SIDES = 32;
  const pts = new Float32Array(SIDES * 6);
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    pts.set([x, box.min.y, z, x, box.max.y, z], i * 6);
  }
  return R.ColliderDesc.convexHull(pts);
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
