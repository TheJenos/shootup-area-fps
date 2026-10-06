import * as THREE from 'three';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { GROUP, groups, toQuat, toVec3, type PhysicsWorld } from './physics';
import { propParts, whenPropsReady } from './props';
import type { MapProp } from './levelgen/types';

/*
 * Loose things that physics throws around: small map props (traffic cones) that players shove, shots
 * knock over and blasts scatter, plus chunks of rubble flung out by explosions. All of it is local
 * eye candy: each client simulates its own, so a cone may end up in a slightly different spot for
 * different players. Nothing here blocks movement, bullets or line of sight.
 */

/** Map props simulated as loose bodies instead of drawn as part of the map */
export const LOOSE_PROPS: ReadonlySet<string> = new Set(['cone']);

/** How hard a bullet knocks a loose prop (m/s of velocity change at the point hit, for a ~2 kg prop) */
const SHOT_PUSH = 4;
/** Rubble pieces flung out per explosion */
const CHUNKS_PER_BLAST = 10;
/** At most this many pieces of rubble at once; the oldest go first */
const MAX_CHUNKS = 40;
/** Rubble lies around this long, then shrinks away (s) */
const CHUNK_LIFE = 5;
const CHUNK_SHRINK = 0.6;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

interface Loose {
  body: RigidBody;
  scale: number;
  /** The instance slot in each of its model's meshes */
  index: number;
  meshes: THREE.InstancedMesh[];
}

interface Chunk {
  body: RigidBody;
  size: number;
  bornAt: number;
}

export class DebrisField {
  private readonly scene: THREE.Scene;
  private physics: PhysicsWorld | null = null;
  private readonly root = new THREE.Group();
  private loose: Loose[] = [];
  private chunks: Chunk[] = [];
  private chunkMesh: THREE.InstancedMesh | null = null;
  private unsubscribe: () => void = () => {};

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root.name = 'debris';
    scene.add(this.root);
  }

  setPhysics(physics: PhysicsWorld | null): void {
    this.clear();
    this.physics = physics;
  }

  /** The current map's loose props (replacing the last map's), once their models have loaded. */
  setProps(props: readonly MapProp[]): void {
    this.clearProps();
    if (!props.length) return;
    this.unsubscribe = whenPropsReady(() => this.buildProps(props));
  }

  private buildProps(props: readonly MapProp[]): void {
    const physics = this.physics;
    if (!physics || physics.disposed) return;
    const { R, world } = physics;
    const byId = new Map<string, MapProp[]>();
    for (const p of props) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
    for (const [id, list] of byId) {
      const parts = propParts(id);
      if (!parts) continue;
      const meshes = parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        mesh.castShadow = mesh.receiveShadow = true;
        // The bodies move: the bounds must cover the whole map, not where the props started.
        mesh.frustumCulled = false;
        this.root.add(mesh);
        return mesh;
      });
      const hull = hullPoints(parts.map((p) => p.geometry));
      list.forEach((p, index) => {
        const scale = p.scale ?? 1;
        _q.setFromAxisAngle(_up, (p.rot * Math.PI) / 2);
        const body = world.createRigidBody(
          R.RigidBodyDesc.dynamic()
            .setTranslation(p.x, p.y, p.z)
            .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
            .setLinearDamping(0.2)
            .setAngularDamping(0.6)
            // Start asleep: a map full of cones costs nothing until something touches one.
            .setSleeping(true),
        );
        const scaled = scale === 1 ? hull : hull.map((v) => v * scale);
        const desc = R.ColliderDesc.convexHull(scaled) ?? R.ColliderDesc.ball(0.3 * scale);
        world.createCollider(
          desc.setDensity(150).setFriction(0.7).setRestitution(0.2)
            .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.WORLD | GROUP.PLAYER | GROUP.DEBRIS | GROUP.RAGDOLL)),
          body,
        );
        this.loose.push({ body, scale, index, meshes });
      });
    }
    this.sync(true);
  }

  /** A bullet from `from` stopped at `to`: knock any loose prop it passed through. */
  shot(from: THREE.Vector3, to: THREE.Vector3): void {
    const physics = this.live();
    if (!physics || !this.loose.length) return;
    const { R, world } = physics;
    const dir = _p.subVectors(to, from);
    const length = dir.length();
    if (length < 1e-3) return;
    dir.divideScalar(length);
    const ray = new R.Ray(from, dir);
    const hit = world.castRay(ray, length + 0.2, true, undefined, groups(GROUP.DEBRIS, GROUP.DEBRIS));
    const body = hit?.collider.parent();
    if (!hit || !body) return;
    const at = ray.pointAt(hit.timeOfImpact);
    const k = SHOT_PUSH * body.mass();
    body.applyImpulseAtPoint({ x: dir.x * k, y: dir.y * k + k * 0.3, z: dir.z * k }, at, true);
  }

  /** An explosion at `at`: shove loose props away and fling rubble. */
  blast(at: THREE.Vector3, radius: number, strength = 9): void {
    const physics = this.live();
    if (!physics) return;
    for (const l of this.loose) {
      const d = toVec3(l.body.translation(), _p).sub(at);
      const dist = d.length();
      if (dist > radius * 1.5) continue;
      const k = (strength * l.body.mass()) / (1 + dist);
      d.setY(Math.max(d.y, 0) + 0.8).normalize().multiplyScalar(k);
      l.body.applyImpulse(d, true);
      l.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k * 0.1, y: 0, z: (Math.random() - 0.5) * k * 0.1 }, true);
    }
    this.fling(physics, at, strength);
  }

  private fling(physics: PhysicsWorld, at: THREE.Vector3, strength: number): void {
    const { R, world } = physics;
    this.chunkMesh ??= this.makeChunkMesh();
    const now = performance.now();
    for (let i = 0; i < CHUNKS_PER_BLAST; i++) {
      if (this.chunks.length >= MAX_CHUNKS) this.removeChunk(0);
      const size = 0.06 + Math.random() * 0.1;
      const a = Math.random() * Math.PI * 2;
      const out = 0.4 + Math.random() * 0.8;
      const speed = strength * (0.5 + Math.random() * 0.7);
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(at.x + Math.cos(a) * 0.2, Math.max(at.y, size) + 0.1, at.z + Math.sin(a) * 0.2)
          .setLinvel(Math.cos(a) * out * speed, (0.6 + Math.random() * 0.6) * speed, Math.sin(a) * out * speed)
          .setAngvel({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 })
          .setCcdEnabled(true),
      );
      world.createCollider(
        R.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setDensity(1500).setFriction(0.8).setRestitution(0.25)
          // Rubble bounces off the map only: never pushes props or bodies around.
          .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.WORLD)),
        body,
      );
      this.chunks.push({ body, size, bornAt: now });
    }
  }

  private makeChunkMesh(): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x5a524a, roughness: 0.95 }),
      MAX_CHUNKS,
    );
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }

  private removeChunk(i: number): void {
    const [chunk] = this.chunks.splice(i, 1);
    const physics = this.live();
    if (chunk && physics) physics.world.removeRigidBody(chunk.body);
  }

  /** Copy the simulation into the meshes (after the physics world has stepped). */
  update(): void {
    if (!this.live()) return;
    this.sync(false);
    const mesh = this.chunkMesh;
    if (!mesh) return;
    const now = performance.now();
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      if ((now - this.chunks[i]!.bornAt) / 1000 > CHUNK_LIFE + CHUNK_SHRINK) this.removeChunk(i);
    }
    this.chunks.forEach((c, i) => {
      const age = (now - c.bornAt) / 1000;
      const shrink = age > CHUNK_LIFE ? Math.max(0.001, 1 - (age - CHUNK_LIFE) / CHUNK_SHRINK) : 1;
      _m.compose(toVec3(c.body.translation(), _p), toQuat(c.body.rotation(), _q), _s.setScalar(c.size * shrink));
      mesh.setMatrixAt(i, _m);
    });
    mesh.count = this.chunks.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Loose props: only the ones that moved (most of a map's cones sleep all round). */
  private sync(all: boolean): void {
    const dirty = new Set<THREE.InstancedMesh>();
    for (const l of this.loose) {
      if (!all && l.body.isSleeping()) continue;
      _m.compose(toVec3(l.body.translation(), _p), toQuat(l.body.rotation(), _q), _s.setScalar(l.scale));
      for (const mesh of l.meshes) {
        mesh.setMatrixAt(l.index, _m);
        dirty.add(mesh);
      }
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  private live(): PhysicsWorld | null {
    return this.physics && !this.physics.disposed ? this.physics : null;
  }

  private clearProps(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
    const physics = this.live();
    for (const l of this.loose) if (physics) physics.world.removeRigidBody(l.body);
    this.loose = [];
    for (const child of [...this.root.children]) {
      if (child === this.chunkMesh) continue;
      // The model's geometry and material belong to props.ts; free only the instance data.
      (child as THREE.InstancedMesh).dispose();
      this.root.remove(child);
    }
  }

  /** Remove everything (new map, or the game ended). */
  clear(): void {
    this.clearProps();
    while (this.chunks.length) this.removeChunk(this.chunks.length - 1);
    if (this.chunkMesh) this.chunkMesh.count = 0;
  }

  dispose(): void {
    this.clear();
    if (this.chunkMesh) {
      this.chunkMesh.geometry.dispose();
      (this.chunkMesh.material as THREE.Material).dispose();
      this.chunkMesh.dispose();
    }
    this.scene.remove(this.root);
  }
}

/** Every vertex of a prop's parts, flattened, for its convex collision hull (at most ~300 points). */
function hullPoints(geometries: THREE.BufferGeometry[]): Float32Array {
  const points: number[] = [];
  for (const geo of geometries) {
    const pos = geo.getAttribute('position');
    const stride = Math.max(1, Math.floor(pos.count / 300));
    for (let i = 0; i < pos.count; i += stride) points.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  return new Float32Array(points);
}
