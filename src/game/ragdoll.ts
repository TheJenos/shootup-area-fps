import * as THREE from 'three';
import type { ImpulseJoint, RevoluteImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import { setWorldQuaternion } from './ik';
import { GRAVITY as WORLD_GRAVITY, GROUP, activePhysics, groups, toQuat, toVec3, type PhysicsWorld } from './physics';

/*
 * Ragdolls for dead players, as Rapier rigid bodies. When someone dies we take the world positions
 * of their main joints and build a body from capsules: torso, head, upper arms, forearms, thighs and
 * shins, held together by joints. Knees and elbows are hinges that only bend the natural way; the
 * neck, shoulders and hips are ball joints, damped so limbs don't flail. The physics
 * world steps it with everything else; each frame we turn the skinned model's bones to match.
 *
 * Every body starts unrotated, so a bone's world orientation is simply its body's rotation applied
 * to how the bone was turned at death.
 */

export interface RagdollBones {
  hips: THREE.Object3D;
  chest: THREE.Object3D;
  head: THREE.Object3D;
  lArm: THREE.Object3D; lFore: THREE.Object3D; lHand: THREE.Object3D;
  rArm: THREE.Object3D; rFore: THREE.Object3D; rHand: THREE.Object3D;
  lUp: THREE.Object3D; lLeg: THREE.Object3D; lFoot: THREE.Object3D;
  rUp: THREE.Object3D; rLeg: THREE.Object3D; rFoot: THREE.Object3D;
}

/** Bodies, in the order their bones are posed (parents before children) */
type Part = 'torso' | 'head' | 'lUpper' | 'lLower' | 'rUpper' | 'rLower' | 'lThigh' | 'lShin' | 'rThigh' | 'rShin';
/** Which body turns each bone */
const BONE_PART: [keyof RagdollBones, Part][] = [
  ['hips', 'torso'], ['chest', 'torso'], ['head', 'head'],
  ['lArm', 'lUpper'], ['lFore', 'lLower'], ['lHand', 'lLower'],
  ['rArm', 'rUpper'], ['rFore', 'rLower'], ['rHand', 'rLower'],
  ['lUp', 'lThigh'], ['lLeg', 'lShin'], ['lFoot', 'lShin'],
  ['rUp', 'rThigh'], ['rLeg', 'rShin'], ['rFoot', 'rShin'],
];

/** The old Verlet bodies fell a little slower than players; keep that floaty slump */
const GRAVITY = 16;
/** Bodies weigh what water does: realistic mass ratios keep the joints stable */
const DENSITY = 1000;
/** Most a knee or elbow bends (rad) */
const MAX_BEND = 2.4;
/**
 * How quickly the parts stop spinning. This stands in for friction in the ball joints (neck,
 * shoulders, hips), which Rapier's JS bindings can't motorise: higher is stiffer.
 */
const ANGULAR_DAMPING = 2;
/** After this long the body is put to sleep even if it's still twitching (s) */
const MAX_LIFE = 8;
/** How much of the killing shot each part takes (the old ragdoll's joint weights) */
const SHOVE = { torso: 0.9, head: 0.9, headshot: 1.6, limb: 0.35 };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

interface Body {
  body: RigidBody;
  /** Where the body's centre was at death */
  center0: THREE.Vector3;
}

export class Ragdoll {
  private readonly bones: RagdollBones;
  private readonly world: PhysicsWorld | null;
  private readonly parts = new Map<Part, Body>();
  private readonly joints: ImpulseJoint[] = [];
  /** Each bone's world orientation at death */
  private readonly boneQuat0 = new Map<keyof RagdollBones, THREE.Quaternion>();
  /** Where the hips bone was at death (world space) */
  private readonly hips0 = new THREE.Vector3();
  private age = 0;
  private disposed = false;

  /** @param velocity how the body was moving when it died (m/s) */
  constructor(bones: RagdollBones, velocity: THREE.Vector3) {
    this.bones = bones;
    // No engine yet (or the game ended): the body just stays as it fell.
    this.world = activePhysics();
    bones.hips.updateWorldMatrix(true, true);
    for (const [bone] of BONE_PART) this.boneQuat0.set(bone, bones[bone].getWorldQuaternion(new THREE.Quaternion()));
    bones.hips.getWorldPosition(this.hips0);
    if (this.world) this.build(this.world, velocity);
  }

  private build(pw: PhysicsWorld, velocity: THREE.Vector3): void {
    const { R, world } = pw;
    const at = (bone: keyof RagdollBones) => this.bones[bone].getWorldPosition(new THREE.Vector3());
    const hips = at('hips'); const chest = at('chest'); const head = at('head');
    const lSh = at('lArm'); const lEl = at('lFore'); const lHa = at('lHand');
    const rSh = at('rArm'); const rEl = at('rFore'); const rHa = at('rHand');
    const lHip = at('lUp'); const lKn = at('lLeg'); const lFt = at('lFoot');
    const rHip = at('rUp'); const rKn = at('rLeg'); const rFt = at('rFoot');

    // The body's own frame: up the spine, and toward its left (the hinge axis for knees).
    const up = new THREE.Vector3().subVectors(chest, hips).normalize();
    const left = new THREE.Vector3().subVectors(lHip, rHip);
    left.addScaledVector(up, -left.dot(up)).normalize();

    const filter = groups(GROUP.RAGDOLL, GROUP.WORLD | GROUP.DEBRIS);
    const capsule = (part: Part, from: THREE.Vector3, to: THREE.Vector3, radius: number, extend = 0) => {
      const dir = _a.subVectors(to, from);
      const length = dir.length() + extend;
      dir.normalize();
      const center = from.clone().addScaledVector(dir, length / 2);
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(center.x, center.y, center.z)
          .setLinvel(velocity.x, velocity.y, velocity.z)
          .setLinearDamping(0.05)
          .setAngularDamping(ANGULAR_DAMPING)
          .setGravityScale(GRAVITY / WORLD_GRAVITY),
      );
      _q.setFromUnitVectors(_up, dir);
      world.createCollider(
        R.ColliderDesc.capsule(Math.max(0.01, length / 2 - radius), radius)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
          .setDensity(DENSITY)
          .setFriction(0.8)
          .setCollisionGroups(filter),
        body,
      );
      this.parts.set(part, { body, center0: center });
      return body;
    };
    const torso = capsule('torso', hips, chest, 0.15);
    torso.enableCcd(true);
    const neckUp = head.clone().addScaledVector(up, 0.2);
    const headBody = capsule('head', head, neckUp, 0.11);
    headBody.enableCcd(true);
    capsule('lUpper', lSh, lEl, 0.06);
    capsule('lLower', lEl, lHa, 0.05, 0.08);
    capsule('rUpper', rSh, rEl, 0.06);
    capsule('rLower', rEl, rHa, 0.05, 0.08);
    const lThigh = capsule('lThigh', lHip, lKn, 0.08);
    capsule('lShin', lKn, lFt, 0.06);
    const rThigh = capsule('rThigh', rHip, rKn, 0.08);
    capsule('rShin', rKn, rFt, 0.06);

    // Anchors are in each body's local space, which (unrotated) is just the offset from its centre.
    const local = (part: Part, p: THREE.Vector3) => {
      const o = _b.subVectors(p, this.parts.get(part)!.center0);
      return { x: o.x, y: o.y, z: o.z };
    };
    const ball = (a: Part, b: Part, p: THREE.Vector3) => {
      this.joints.push(world.createImpulseJoint(
        R.JointData.spherical(local(a, p), local(b, p)), this.parts.get(a)!.body, this.parts.get(b)!.body, true,
      ));
    };
    /**
     * A hinge about `axis` (world space, which both bodies share at creation). Bending is positive;
     * the limits are measured from however bent the limb already was.
     */
    const hinge = (a: Part, b: Part, p: THREE.Vector3, axis: THREE.Vector3, upper: THREE.Vector3, lower: THREE.Vector3) => {
      const u = _a.copy(upper).normalize();
      const l = _c.copy(lower).normalize();
      const bent = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(u, l)), u.dot(l));
      const data = R.JointData.revolute(local(a, p), local(b, p), { x: axis.x, y: axis.y, z: axis.z });
      const joint = world.createImpulseJoint(data, this.parts.get(a)!.body, this.parts.get(b)!.body, true) as RevoluteImpulseJoint;
      // (Limits must be set on the joint: the descriptor's are ignored for hinges.)
      joint.setLimits(Math.min(-bent, 0) - 0.02, Math.max(MAX_BEND - bent, 0.02));
      this.joints.push(joint);
    };
    const right = left.clone().negate();
    ball('torso', 'head', head);
    ball('torso', 'lUpper', lSh);
    ball('torso', 'rUpper', rSh);
    ball('torso', 'lThigh', lHip);
    ball('torso', 'rThigh', rHip);
    // Knees bend the foot backwards (about the body's left); elbows bring the hand forwards (about its right).
    hinge('lThigh', 'lShin', lKn, left, _a.subVectors(lKn, lHip).clone(), _b.subVectors(lFt, lKn).clone());
    hinge('rThigh', 'rShin', rKn, left, _a.subVectors(rKn, rHip).clone(), _b.subVectors(rFt, rKn).clone());
    hinge('lUpper', 'lLower', lEl, right, _a.subVectors(lEl, lSh).clone(), _b.subVectors(lHa, lEl).clone());
    hinge('rUpper', 'rLower', rEl, right, _a.subVectors(rEl, rSh).clone(), _b.subVectors(rHa, rEl).clone());

    // Knees buckle first: a little spin so the body crumples rather than toppling like a plank.
    for (const thigh of [lThigh, rThigh]) thigh.setAngvel(left.clone().multiplyScalar(-1.5 - Math.random()), true);
    headBody.setAngvel({ x: (Math.random() - 0.5) * 2, y: 0, z: (Math.random() - 0.5) * 2 }, true);
  }

  /** A shove (the killing hit): `dir` from the killer toward the body; headshots snap the head. */
  impulse(dir: THREE.Vector3, strength: number, head: boolean): void {
    const push = _a.copy(dir).setY(0).normalize().multiplyScalar(strength);
    push.y = strength * 0.25;
    for (const [part, { body }] of this.live()) {
      const w = part === 'torso' ? SHOVE.torso : part === 'head' ? (head ? SHOVE.headshot : SHOVE.head) : SHOVE.limb;
      const m = body.mass() * w;
      if (part === 'torso') {
        // High on the chest, so the body spins as it goes over.
        const top = body.translation();
        body.applyImpulseAtPoint({ x: push.x * m, y: push.y * m, z: push.z * m }, { x: top.x, y: top.y + 0.2, z: top.z }, true);
      } else {
        body.applyImpulse({ x: push.x * m, y: push.y * m, z: push.z * m }, true);
      }
    }
  }

  /** A blast throws every part away from it, and up. */
  blast(from: THREE.Vector3, strength: number): void {
    for (const [, { body }] of this.live()) {
      const d = toVec3(body.translation(), _a).sub(from);
      const k = (strength / (1 + d.length())) * body.mass();
      d.setY(Math.max(d.y, 0) + 0.8).normalize().multiplyScalar(k);
      body.applyImpulse({ x: d.x, y: d.y, z: d.z }, true);
    }
  }

  update(dt: number): void {
    if (!this.world || this.disposed) return;
    this.age += dt;
    if (this.age > MAX_LIFE) {
      for (const { body } of this.parts.values()) if (!body.isSleeping()) body.sleep();
    }
    this.apply();
  }

  /** Free the bodies (respawned, left, or the game ended). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pw = this.world;
    if (!pw || pw.disposed) return;
    // Removing a body removes its joints and colliders with it.
    for (const { body } of this.parts.values()) pw.world.removeRigidBody(body);
    this.parts.clear();
    this.joints.length = 0;
  }

  private live(): [Part, Body][] {
    return this.world && !this.world.disposed && !this.disposed ? [...this.parts] : [];
  }

  /** Pose the skinned model from the bodies. */
  private apply(): void {
    if (this.world?.disposed) return;
    const b = this.bones;
    const torso = this.parts.get('torso');
    if (!torso) return;
    // Hips: carried along with the torso since death.
    if (b.hips.parent) {
      b.hips.parent.updateWorldMatrix(true, false);
      const q = toQuat(torso.body.rotation(), _q);
      const p = _a.subVectors(this.hips0, torso.center0).applyQuaternion(q).add(toVec3(torso.body.translation(), _c));
      b.hips.position.copy(b.hips.parent.worldToLocal(p));
    }
    for (const [bone, part] of BONE_PART) {
      const body = this.parts.get(part);
      const q0 = this.boneQuat0.get(bone);
      if (!body || !q0) continue;
      setWorldQuaternion(b[bone], toQuat(body.body.rotation(), _q).multiply(q0));
    }
  }
}
