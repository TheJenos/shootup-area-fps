import * as THREE from 'three';
import { NameTag } from './nameTag';
import { cloneCharacter, GAITS, type CharacterAsset, type Gait } from './character';
import type { PlayerState } from '../types';

/** Attached to hitbox meshes so a raycast hit can be traced back to a player. */
export interface HitboxData {
  playerId: string;
  head: boolean;
}

// Movement speed (m/s) at which the animation switches gait.
const WALK_FROM = 0.5;
const RUN_FROM = 6.8;
const FADE = 0.2;
// The model's skeleton is authored in centimeters (root scale 0.01).
const BONE_SCALE = 100;
// How much of the aim pitch the upper body takes.
const SPINE_PITCH = 0.7;
// After we hit someone, trust our own damage estimate over slightly stale server updates for this long.
const HP_PREDICTION_MS = 600;

// Hitboxes are invisible but still raycastable.
const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
const bodyHitGeo = new THREE.CapsuleGeometry(0.3, 0.9, 2, 8);
const headHitGeo = new THREE.SphereGeometry(0.16, 8, 6);
const gunGeo = new THREE.BoxGeometry(0.06, 0.09, 0.55);
const shieldGeo = new THREE.SphereGeometry(1, 24, 16);
const shieldMat = new THREE.MeshBasicMaterial({
  color: 0x4aa8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
});
const gunMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.5 });

// World forward / up expressed in the right-hand bone's local space, measured in the Idle pose.
// Aligning the rifle with them makes it point ahead instead of along the fingers.
const HAND_FORWARD = new THREE.Vector3(-0.25, 0.29, 0.92).normalize();
const HAND_UP = new THREE.Vector3(0.13, -0.93, 0.33).normalize();
const GUN_IN_HAND = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(HAND_UP, HAND_FORWARD).normalize(),
    HAND_UP,
    HAND_FORWARD,
  ),
);
// Grip in the palm (bone units are cm), with most of the rifle in front of the hand.
const GUN_OFFSET = new THREE.Vector3(0, 9, 0).addScaledVector(HAND_FORWARD, 14);

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function bone(root: THREE.Object3D, name: string): THREE.Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`Character model is missing bone ${name}`);
  return found;
}

export class RemotePlayer {
  readonly id: string;
  readonly name: string;
  readonly target: THREE.Vector3;
  alive: boolean;

  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly model: THREE.Object3D;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<Gait, THREE.AnimationAction>;
  private readonly spine: THREE.Object3D;
  private readonly bodyHit: THREE.Mesh;
  private readonly headHit: THREE.Mesh;
  private readonly tag: NameTag;
  private readonly shield: THREE.Mesh;
  private readonly lastPos = new THREE.Vector3();
  private gait: Gait = 'Idle';
  private speed = 0;
  private targetYaw: number;
  private targetPitch: number;
  private pitch: number;
  private fall: number;
  /** Health as last reported by the server */
  private hp: number;
  /** Health shown on our tag: drops instantly on our hits, then follows the server */
  private shownHp: number;
  private lastHitAt = 0;

  constructor(id: string, data: PlayerState, scene: THREE.Scene, asset: CharacterAsset) {
    this.id = id;
    this.scene = scene;
    this.name = data.name;
    this.alive = data.alive !== false;
    this.target = new THREE.Vector3(data.x || 0, data.y || 0, data.z || 0);
    this.targetYaw = data.yaw || 0;
    this.targetPitch = this.pitch = data.pitch || 0;
    this.fall = this.alive ? 0 : 1;
    this.hp = this.shownHp = data.hp ?? 100;
    this.group.rotation.order = 'YXZ';

    // The model already faces -Z, the same way players look at yaw 0.
    this.model = cloneCharacter(asset);
    this.model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.castShadow = true;
      // Animated bounds don't match the bind pose, so never cull.
      mesh.frustumCulled = false;
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      mesh.material = mat;
      this.materials.push(mat);
    });
    this.setColor(data.color);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = Object.fromEntries(
      GAITS.map((g) => [g, this.mixer.clipAction(asset.clips[g])]),
    ) as Record<Gait, THREE.AnimationAction>;
    this.actions.Idle.play();

    this.spine = bone(this.model, 'mixamorigSpine2');

    const gun = new THREE.Mesh(gunGeo, gunMat);
    gun.castShadow = true;
    gun.scale.setScalar(BONE_SCALE);
    gun.position.copy(GUN_OFFSET);
    gun.quaternion.copy(GUN_IN_HAND);
    bone(this.model, 'mixamorigRightHand').add(gun);

    this.bodyHit = new THREE.Mesh(bodyHitGeo, hitboxMat);
    this.bodyHit.position.y = 0.75;
    this.bodyHit.userData = { playerId: id, head: false } satisfies HitboxData;

    // The head hitbox rides on the head bone so it follows the animation.
    this.headHit = new THREE.Mesh(headHitGeo, hitboxMat);
    this.headHit.scale.setScalar(BONE_SCALE);
    this.headHit.position.set(0, 18, 2);
    this.headHit.userData = { playerId: id, head: true } satisfies HitboxData;
    bone(this.model, 'mixamorigHead').add(this.headHit);

    this.tag = new NameTag(data.name || '???');
    this.tag.sprite.position.y = 2.15;

    this.shield = new THREE.Mesh(shieldGeo, shieldMat);
    this.shield.scale.set(0.75, 1.05, 0.75);
    this.shield.position.y = 0.95;
    this.shield.visible = !!data.shield;

    this.group.add(this.model, this.bodyHit, this.tag.sprite, this.shield);
    this.group.position.copy(this.target);
    this.group.rotation.y = this.targetYaw;
    this.lastPos.copy(this.target);
    scene.add(this.group);
  }

  setData(data: Partial<PlayerState>): void {
    const next = new THREE.Vector3(data.x ?? this.target.x, data.y ?? this.target.y, data.z ?? this.target.z);
    const wasAlive = this.alive;
    this.alive = data.alive !== false;
    // Snap on respawn / big jumps instead of sliding across the map.
    const respawned = !wasAlive && this.alive;
    if (respawned || next.distanceTo(this.target) > 6) {
      this.group.position.copy(next);
      this.lastPos.copy(next);
      this.fall = 0;
    }
    this.target.copy(next);
    this.targetYaw = data.yaw ?? this.targetYaw;
    this.targetPitch = data.pitch ?? this.targetPitch;
    if (data.color) this.setColor(data.color);
    if (data.name) this.tag.setName(data.name);
    this.shield.visible = !!data.shield && this.alive;
    if (data.hp !== undefined) {
      this.hp = data.hp;
      const predicting = performance.now() - this.lastHitAt < HP_PREDICTION_MS;
      if (!predicting || this.hp < this.shownHp || respawned) this.shownHp = this.hp;
      this.tag.setHp(this.shownHp);
    }
    if (!this.alive) this.tag.hide();
  }

  /** We just shot this player: show their name and (predicted) health to us. */
  reveal(damage: number): void {
    if (!this.alive) return;
    this.lastHitAt = performance.now();
    this.shownHp = Math.max(0, Math.min(this.shownHp, this.hp) - damage);
    this.tag.reveal(this.shownHp);
  }

  /** Our best guess of their health right now (server value, minus our unconfirmed hits). */
  get displayedHp(): number {
    return Math.min(this.shownHp, this.hp);
  }

  /** How fast the avatar is moving across the ground (m/s, smoothed). */
  get moveSpeed(): number {
    return this.speed;
  }

  /** Where the avatar is drawn right now (interpolated). */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  get yaw(): number {
    return this.group.rotation.y;
  }

  /** Teammates always show their name and health. */
  setAlly(ally: boolean): void {
    this.tag.setPinned(ally);
  }

  get hitboxes(): THREE.Mesh[] {
    return this.alive ? [this.bodyHit, this.headHit] : [];
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-14 * dt);
    this.group.position.lerp(this.target, t);
    this.group.rotation.y = angleLerp(this.group.rotation.y, this.targetYaw, t);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, t);

    this.updateGait(dt);
    // Freeze the pose while falling over, so the body drops stiffly.
    this.mixer.timeScale = this.alive ? 1 : 0;
    this.mixer.update(dt);
    // Lean the upper body to match where they're aiming (applied after the animation).
    this.spine.rotateX(-this.pitch * SPINE_PITCH);

    this.fall = THREE.MathUtils.clamp(this.fall + (this.alive ? -dt * 4 : dt * 2.5), 0, 1);
    this.group.rotation.x = (-Math.PI / 2) * this.fall * this.fall;
    this.tag.update(this.alive);
  }

  /** Pick Idle / Walk / Run from how fast the avatar is actually moving. */
  private updateGait(dt: number): void {
    const moved = this.group.position.clone().sub(this.lastPos);
    this.lastPos.copy(this.group.position);
    moved.y = 0;
    const instant = dt > 0 ? moved.length() / dt : 0;
    this.speed += (instant - this.speed) * (1 - Math.exp(-10 * dt));

    const next: Gait = this.speed < WALK_FROM ? 'Idle' : this.speed < RUN_FROM ? 'Walk' : 'Run';
    if (next !== this.gait) {
      const from = this.actions[this.gait];
      const to = this.actions[next];
      to.reset().play();
      from.crossFadeTo(to, FADE, false);
      this.gait = next;
    }

    // Play walk/run backwards when moving away from where they face.
    const yaw = this.group.rotation.y;
    const forward = -Math.sin(yaw) * moved.x - Math.cos(yaw) * moved.z;
    const direction = forward < -1e-4 ? -1 : 1;
    this.actions.Walk.timeScale = direction;
    this.actions.Run.timeScale = direction;
  }

  private setColor(color: string | undefined): void {
    if (!color) return;
    const tint = new THREE.Color(color);
    for (const mat of this.materials) {
      // Visor in full player color; the uniform only tinted so its texture still shows.
      if (mat.name.includes('Visor')) mat.color.copy(tint);
      else mat.color.setRGB(1, 1, 1).lerp(tint, 0.45);
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.scene.remove(this.group);
    for (const mat of this.materials) mat.dispose();
    this.tag.dispose();
  }
}
