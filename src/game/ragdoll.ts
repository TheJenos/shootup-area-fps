import * as THREE from 'three';
import { setWorldQuaternion, swing } from './ik';
import { overRamp, rampHeightAt, type Ramp } from './ramps';

/*
 * A small Verlet ragdoll for dead players: no physics engine. When someone dies we take the
 * world positions of their main joints, then each frame:
 *   1. move every joint by its velocity plus gravity,
 *   2. keep bones their measured length (and the torso rigid) with distance constraints,
 *   3. push joints out of the floor, cover and ramps (with friction so bodies don't skate),
 *   4. turn each bone of the skinned model to point from its joint to the next.
 * The body slumps, falls the way it was moving (or was hit), drapes over crates and settles.
 */

/** Where bodies can land: the map's boxes and ramps (the arrays are refilled in place each map). */
let worldColliders: THREE.Box3[] = [];
/** Scratch list of the colliders near the body being simulated */
const nearby: THREE.Box3[] = [];
let worldRamps: Ramp[] = [];
export function setRagdollWorld(colliders: THREE.Box3[], ramps: Ramp[]): void {
  worldColliders = colliders;
  worldRamps = ramps;
}

export interface RagdollBones {
  hips: THREE.Object3D;
  chest: THREE.Object3D;
  head: THREE.Object3D;
  lArm: THREE.Object3D; lFore: THREE.Object3D; lHand: THREE.Object3D;
  rArm: THREE.Object3D; rFore: THREE.Object3D; rHand: THREE.Object3D;
  lUp: THREE.Object3D; lLeg: THREE.Object3D; lFoot: THREE.Object3D;
  rUp: THREE.Object3D; rLeg: THREE.Object3D; rFoot: THREE.Object3D;
}

// Joint indices
const HIPS = 0, CHEST = 1, HEAD = 2;
const L_SH = 3, L_EL = 4, L_HA = 5, R_SH = 6, R_EL = 7, R_HA = 8;
const L_HIP = 9, L_KN = 10, L_FT = 11, R_HIP = 12, R_KN = 13, R_FT = 14;
const JOINTS: (keyof RagdollBones)[] = [
  'hips', 'chest', 'head', 'lArm', 'lFore', 'lHand', 'rArm', 'rFore', 'rHand', 'lUp', 'lLeg', 'lFoot', 'rUp', 'rLeg', 'rFoot',
];
/** Collision radius of each joint (m): the head and torso are bulkier than wrists and ankles */
const RADIUS = [0.14, 0.14, 0.12, 0.08, 0.06, 0.05, 0.08, 0.06, 0.05, 0.09, 0.07, 0.06, 0.09, 0.07, 0.06];

/** Bones (fixed length); `min` links only push apart, so limbs can't fold flat onto themselves. */
const LINKS: [number, number][] = [
  // torso, held rigid by cross braces
  [HIPS, CHEST], [CHEST, HEAD], [CHEST, L_SH], [CHEST, R_SH], [L_SH, R_SH],
  [HIPS, L_HIP], [HIPS, R_HIP], [L_HIP, R_HIP], [L_SH, L_HIP], [R_SH, R_HIP], [L_SH, R_HIP], [R_SH, L_HIP],
  [HEAD, L_SH], [HEAD, R_SH], [HEAD, HIPS],
  // limbs
  [L_SH, L_EL], [L_EL, L_HA], [R_SH, R_EL], [R_EL, R_HA],
  [L_HIP, L_KN], [L_KN, L_FT], [R_HIP, R_KN], [R_KN, R_FT],
];
const MIN_LINKS: [number, number, number][] = [
  // a straight limb is 1; keep elbows and knees from folding all the way
  [L_SH, L_HA, 0.45], [R_SH, R_HA, 0.45], [L_HIP, L_FT, 0.6], [R_HIP, R_FT, 0.6],
  // limbs stay off the torso a little
  [L_HA, CHEST, 0.15], [R_HA, CHEST, 0.15], [L_KN, R_KN, 0.12], [L_FT, R_FT, 0.1],
];

const GRAVITY = 16;
const STEP = 1 / 120;
const ITERATIONS = 10;
const DAMPING = 0.995;
/** Fraction of sideways motion a joint keeps while it's touching something */
const FRICTION = 0.55;
/** After this long, or once everything is still, the body stops simulating (s) */
const MAX_LIFE = 8;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

function torsoBasis(hips: THREE.Vector3, chest: THREE.Vector3, lHip: THREE.Vector3, rHip: THREE.Vector3, out: THREE.Matrix4) {
  const up = _a.subVectors(chest, hips).normalize();
  const side = _b.subVectors(rHip, lHip);
  side.addScaledVector(up, -side.dot(up)).normalize();
  const fwd = new THREE.Vector3().crossVectors(side, up);
  return out.makeBasis(side, up, fwd);
}

export class Ragdoll {
  private readonly bones: RagdollBones;
  private readonly pos: THREE.Vector3[];
  private readonly prev: THREE.Vector3[];
  private readonly lengths: number[];
  private readonly minLengths: number[];
  /** Hips orientation at death, and the torso frame it belonged to */
  private readonly hipsQuat0 = new THREE.Quaternion();
  private readonly basis0Inv = new THREE.Matrix4();
  private readonly touching: boolean[];
  private acc = 0;
  private age = 0;
  private asleep = false;

  /** @param velocity how the body was moving when it died (m/s) */
  constructor(bones: RagdollBones, velocity: THREE.Vector3) {
    this.bones = bones;
    bones.hips.updateWorldMatrix(true, true);
    this.pos = JOINTS.map((j) => bones[j].getWorldPosition(new THREE.Vector3()));
    // Verlet: velocity is the gap between this and the previous position.
    this.prev = this.pos.map((p) => p.clone().addScaledVector(velocity, -STEP));
    this.touching = this.pos.map(() => false);
    this.lengths = LINKS.map(([a, b]) => this.pos[a]!.distanceTo(this.pos[b]!));
    // Minimums are fractions of the limb's full length (shoulder–elbow–hand, hip–knee–foot), or of
    // the gap at death for the "keep apart" pairs.
    const limb = (a: number, mid: number, b: number) => this.pos[a]!.distanceTo(this.pos[mid]!) + this.pos[mid]!.distanceTo(this.pos[b]!);
    const full: Record<string, number> = {
      [`${L_SH}-${L_HA}`]: limb(L_SH, L_EL, L_HA), [`${R_SH}-${R_HA}`]: limb(R_SH, R_EL, R_HA),
      [`${L_HIP}-${L_FT}`]: limb(L_HIP, L_KN, L_FT), [`${R_HIP}-${R_FT}`]: limb(R_HIP, R_KN, R_FT),
    };
    this.minLengths = MIN_LINKS.map(([a, b, k]) => (full[`${a}-${b}`] ?? this.pos[a]!.distanceTo(this.pos[b]!)) * k);
    bones.hips.getWorldQuaternion(this.hipsQuat0);
    torsoBasis(this.pos[HIPS]!, this.pos[CHEST]!, this.pos[L_HIP]!, this.pos[R_HIP]!, this.basis0Inv).invert();
    // Knees and elbows buckle first: a small nudge so the body crumples rather than toppling like a plank.
    for (const j of [L_KN, R_KN]) this.prev[j]!.add(new THREE.Vector3((Math.random() - 0.5) * 0.01, 0, 0.004));
    this.prev[HEAD]!.add(new THREE.Vector3((Math.random() - 0.5) * 0.006, 0, (Math.random() - 0.5) * 0.006));
  }

  /** A shove (the killing hit): `dir` from the killer toward the body; headshots snap the head. */
  impulse(dir: THREE.Vector3, strength: number, head: boolean): void {
    const push = dir.clone().setY(0).normalize().multiplyScalar(strength * STEP);
    push.y = strength * STEP * 0.25;
    const weights = new Array<number>(JOINTS.length).fill(0.35);
    weights[CHEST] = 1; weights[L_SH] = 0.9; weights[R_SH] = 0.9; weights[HEAD] = head ? 1.6 : 0.9; weights[HIPS] = 0.6;
    weights.forEach((w, i) => this.prev[i]!.addScaledVector(push, -w));
    this.asleep = false;
  }

  /** A blast lifts the whole body. */
  blast(from: THREE.Vector3, strength: number): void {
    for (let i = 0; i < this.pos.length; i++) {
      const d = this.pos[i]!.clone().sub(from);
      const k = strength / (1 + d.length());
      d.setY(Math.max(d.y, 0) + 0.8).normalize();
      this.prev[i]!.addScaledVector(d, -k * STEP);
    }
    this.asleep = false;
  }

  update(dt: number): void {
    if (this.asleep) {
      this.apply();
      return;
    }
    this.age += dt;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step();
    }
    if (this.age > MAX_LIFE || (this.age > 1.5 && this.stillness() < 0.0004)) this.asleep = true;
    this.apply();
  }

  private stillness(): number {
    let max = 0;
    for (let i = 0; i < this.pos.length; i++) max = Math.max(max, this.pos[i]!.distanceToSquared(this.prev[i]!));
    return max;
  }

  private step(): void {
    const { pos, prev } = this;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]!;
      const q = prev[i]!;
      const vx = (p.x - q.x) * DAMPING * (this.touching[i] ? FRICTION : 1);
      const vy = (p.y - q.y) * DAMPING;
      const vz = (p.z - q.z) * DAMPING * (this.touching[i] ? FRICTION : 1);
      q.copy(p);
      p.x += vx;
      p.y += vy - GRAVITY * STEP * STEP;
      p.z += vz;
    }
    for (let it = 0; it < ITERATIONS; it++) {
      LINKS.forEach(([a, b], i) => this.solve(a, b, this.lengths[i]!, false));
      MIN_LINKS.forEach(([a, b], i) => this.solve(a, b, this.minLengths[i]!, true));
      this.collide();
    }
  }

  /** Move two joints toward (or, for minimums, only apart to) `length`. */
  private solve(a: number, b: number, length: number, onlyApart: boolean): void {
    const pa = this.pos[a]!;
    const pb = this.pos[b]!;
    const d = _a.subVectors(pb, pa);
    const dist = d.length() || 1e-6;
    if (onlyApart && dist >= length) return;
    d.multiplyScalar((dist - length) / dist / 2);
    pa.add(d);
    pb.sub(d);
  }

  private collide(): void {
    // Only the boxes near the body: maps have hundreds, a body touches a handful.
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of this.pos) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const near = nearby;
    near.length = 0;
    for (const c of worldColliders) {
      if (c.max.x < minX - 1 || c.min.x > maxX + 1 || c.max.y < minY - 1 || c.min.y > maxY + 1 || c.max.z < minZ - 1 || c.min.z > maxZ + 1) continue;
      near.push(c);
    }
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i]!;
      const r = RADIUS[i]!;
      let touching = false;
      if (p.y < r) {
        p.y = r;
        touching = true;
      }
      for (const ramp of worldRamps) {
        if (!overRamp(ramp, p.x, p.z)) continue;
        const h = rampHeightAt(ramp, p.x, p.z) + r;
        if (p.y < h && p.y > h - 0.6) {
          p.y = h;
          touching = true;
        }
      }
      for (const c of near) {
        if (p.x < c.min.x - r || p.x > c.max.x + r || p.y < c.min.y - r || p.y > c.max.y + r || p.z < c.min.z - r || p.z > c.max.z + r) continue;
        // Out along the shallowest side.
        const pushes: [number, 'x' | 'y' | 'z', number][] = [
          [p.x - (c.min.x - r), 'x', c.min.x - r], [c.max.x + r - p.x, 'x', c.max.x + r],
          [p.y - (c.min.y - r), 'y', c.min.y - r], [c.max.y + r - p.y, 'y', c.max.y + r],
          [p.z - (c.min.z - r), 'z', c.min.z - r], [c.max.z + r - p.z, 'z', c.max.z + r],
        ];
        pushes.sort((u, v) => u[0] - v[0]);
        const [, axis, to] = pushes[0]!;
        p[axis] = to;
        touching = true;
      }
      this.touching[i] = touching;
    }
  }

  /** Pose the skinned model from the joints. */
  private apply(): void {
    const b = this.bones;
    const p = this.pos;
    // Hips: placed at their joint, turned with the torso frame since death.
    if (b.hips.parent) {
      b.hips.parent.updateWorldMatrix(true, false);
      b.hips.position.copy(b.hips.parent.worldToLocal(p[HIPS]!.clone()));
    }
    torsoBasis(p[HIPS]!, p[CHEST]!, p[L_HIP]!, p[R_HIP]!, _m).multiply(this.basis0Inv);
    _q.setFromRotationMatrix(_m).multiply(this.hipsQuat0);
    setWorldQuaternion(b.hips, _q);
    // Then each bone points from its joint to the next one down the chain.
    const aim = (bone: THREE.Object3D, child: THREE.Object3D, from: number, to: number) => {
      bone.getWorldPosition(_a);
      child.getWorldPosition(_b);
      swing(bone, _from.subVectors(_b, _a), _to.subVectors(p[to]!, p[from]!));
    };
    aim(b.chest, b.head, CHEST, HEAD);
    aim(b.lArm, b.lFore, L_SH, L_EL);
    aim(b.lFore, b.lHand, L_EL, L_HA);
    aim(b.rArm, b.rFore, R_SH, R_EL);
    aim(b.rFore, b.rHand, R_EL, R_HA);
    aim(b.lUp, b.lLeg, L_HIP, L_KN);
    aim(b.lLeg, b.lFoot, L_KN, L_FT);
    aim(b.rUp, b.rLeg, R_HIP, R_KN);
    aim(b.rLeg, b.rFoot, R_KN, R_FT);
  }
}
