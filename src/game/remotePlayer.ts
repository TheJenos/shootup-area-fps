import * as THREE from 'three';
import { NameTag } from './nameTag';
import { makeXrayMaterial, makeXrayMeshes } from './xray';
import { GUNS, buildRemoteGun, remoteGunLength } from './guns';
import { reach, setWorldQuaternion } from './ik';
import { Ragdoll, type RagdollBones } from './ragdoll';
import { cloneCharacter, GAITS, type CharacterAsset, type Gait } from './character';
import { TEAMS, TEAM_INFO } from './modes';
import type { GunKind, PlayerState, Stance, Team } from '../types';

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
// The rest of the aim pitch goes to the head.
const HEAD_PITCH = 0.3;

/*
 * Aim pose, layered over the walk/run animation with arm IK: the gun points exactly where the player
 * is looking. Normally it's held at the ready (stock low at the shoulder); aiming down sights brings it
 * up to the eye. Positions are in metres in the aim frame: forward along the look direction, up, right.
 * The rifle-sized guns are placed by the back of the stock; the pistol by its grip, out in front.
 */
const READY_STOCK = { forward: 0.12, up: -0.2, right: 0.0 };
const ADS_STOCK = { forward: 0.06, up: -0.07, right: 0.035 };
const PISTOL_READY = { forward: 0.42, up: -0.28, right: -0.06 };
const PISTOL_ADS = { forward: 0.5, up: -0.08, right: -0.02 };
/** Where the eye is relative to the head bone: up the skull and a bit forward (m) */
const EYE_UP = 0.09;
const EYE_FORWARD = 0.08;
/** After a shot the aim pose holds this long, so a burst fired on the run reads as shooting (ms) */
const SHOOT_HOLD_MS = 700;
/** Blend speeds for the ready pose (on/off) and for raising the sights */
const READY_SPEED = 8;
const ADS_SPEED = 12;

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _gunAt = new THREE.Vector3();
const _handAt = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _support = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _gunQuat = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _tmp = new THREE.Vector3();
/** Lengths of the switch dip and the throw swing (s) */
const SWITCH_LEN = 0.4;
const THROW_LEN = 0.55;
const _handQuat = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const GUN_IN_HAND_INV = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// After we hit someone, trust our own damage estimate over slightly stale server updates for this long.
const HP_PREDICTION_MS = 600;

/*
 * The model has no crouch or slide animation, so they're posed on top of whatever it's
 * playing: thighs forward, knees bent, upper body leaning (radians), then the hips are
 * lowered until the feet are back on the ground. The pose blends in and out.
 */
const CROUCH_POSE = { thigh: 1.1, knee: 1.75, lean: 0.35 };
const SLIDE_POSE = { thigh: 1.65, knee: 0.3, lean: -0.8 };
/** How high the feet sit above the ground when standing (m) */
const FOOT_REST = 0.12;
/** Body hitbox height (scale) and how far a crouch / slide lowers the head tag and chest */
const CROUCH_BODY = 0.68;
const SLIDE_BODY = 0.42;

/*
 * Tinting. In free-for-all each player gets a light wash of their own colour so the uniform's
 * texture still shows. In team modes the whole uniform takes the team colour, with a faint glow
 * so teams stay readable in shadow and at a distance.
 */
const FFA_TINT = 0.45;
const TEAM_TINT = 0.65;
const TEAM_GLOW = 0.1;
const TEAM_VISOR_GLOW = 0.7;

/** The team a colour belongs to (replay stand-ins only know the colour). */
const teamOfColor = (color: string | undefined): Team | undefined =>
  TEAMS.find((t) => TEAM_INFO[t].color.toLowerCase() === color?.toLowerCase());

// Hitboxes are invisible but still raycastable.
const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
const bodyHitGeo = new THREE.CapsuleGeometry(0.3, 0.9, 2, 8);
const headHitGeo = new THREE.SphereGeometry(0.16, 8, 6);
const shieldGeo = new THREE.SphereGeometry(1, 24, 16);
const shieldMat = new THREE.MeshBasicMaterial({
  color: 0x4aa8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
});

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
GUN_IN_HAND_INV.copy(GUN_IN_HAND).invert();

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
  private readonly hips: THREE.Object3D;
  private readonly thighs: THREE.Object3D[];
  private readonly shins: THREE.Object3D[];
  private readonly feet: THREE.Object3D[];
  private readonly head: THREE.Object3D;
  /** Upper arm, forearm, hand: right then left */
  private readonly rightArm: [THREE.Object3D, THREE.Object3D, THREE.Object3D];
  private readonly leftArm: [THREE.Object3D, THREE.Object3D, THREE.Object3D];
  /** Aiming down sights, as last reported */
  private aiming = false;
  /** Reloading, as last reported, and how far through the hand's trip to the magazine we are (s) */
  private reloading = false;
  private reloadTime = 0;
  private reloadStarted = false;
  /** Throw animation: seconds since it started, or -1 */
  private throwTime = -1;
  private throwsSeen: number | undefined;
  /** Gun switch: the gun dips for a moment */
  private switchTime = -1;
  /** Death: a sideways tilt chosen per fall so bodies don't all drop the same way */
  private fallRoll = 0;
  /** Carrying the enemy flag: no gun in hand, arms swing free except when they strike */
  private carrying = false;
  /** When they last fired (performance.now ms): shooting holds the aim pose even at a sprint */
  private firedAt = -Infinity;
  /** A shot not yet shown as a muzzle flash in the first-person view of this player */
  private shotFlash = false;
  /** We're watching through their eyes: their own body is hidden so it doesn't block the view */
  private firstPerson = false;
  /** Their body after death; made on the first frame they're dead so it starts from the last pose */
  private ragdoll: Ragdoll | null = null;
  private ragdollBones: RagdollBones;
  /** The killing hit, if it arrives before the body exists */
  private pendingHit: { dir: THREE.Vector3; strength: number; head: boolean } | null = null;
  /** The mode's full health, so the name tag's bar reads right in 50 / 200 HP modes */
  private maxHp = 100;
  /** Ground velocity, smoothed (m/s), so a body keeps the momentum it died with */
  private readonly velocity = new THREE.Vector3();
  /** 0..1 blend from the animation's arms to the aim pose, and from the ready pose to the sights */
  private readyAmount = 1;
  private adsAmount = 0;
  /** The animation's arm rotations, kept to blend the aim pose over them */
  private readonly armAnim: THREE.Quaternion[] = Array.from({ length: 6 }, () => new THREE.Quaternion());
  private stanceNow: Stance = 'stand';
  private colorNow: string | undefined;
  /** In the right hand: one model per gun they've held, only the current one shown */
  private gunHolder = new THREE.Group();
  private gunModels = new Map<GunKind, THREE.Group>();
  /** X-ray copies of the gun in hand (rebuilt when they switch) */
  private gunXray: THREE.Mesh[] = [];
  private gunNow: GunKind = 'rifle';
  private ally = false;
  /** Flat silhouette drawn over the walls while a teammate is behind cover (made on first need) */
  private xray: THREE.Mesh[] = [];
  private xrayMaterial: THREE.ShaderMaterial | null = null;
  private occluded = false;
  private teamNow: Team | undefined;
  /** 0..1 blend toward the crouch and slide poses */
  private crouchAmount = 0;
  private slideAmount = 0;
  private slideStarted = false;
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
    this.setColor(data.color, data.team);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = Object.fromEntries(
      GAITS.map((g) => [g, this.mixer.clipAction(asset.clips[g])]),
    ) as Record<Gait, THREE.AnimationAction>;
    this.actions.Idle.play();

    this.spine = bone(this.model, 'mixamorigSpine2');
    this.hips = bone(this.model, 'mixamorigHips');
    this.thighs = [bone(this.model, 'mixamorigLeftUpLeg'), bone(this.model, 'mixamorigRightUpLeg')];
    this.shins = [bone(this.model, 'mixamorigLeftLeg'), bone(this.model, 'mixamorigRightLeg')];
    this.feet = [bone(this.model, 'mixamorigLeftFoot'), bone(this.model, 'mixamorigRightFoot')];
    this.head = bone(this.model, 'mixamorigHead');
    this.rightArm = [bone(this.model, 'mixamorigRightArm'), bone(this.model, 'mixamorigRightForeArm'), bone(this.model, 'mixamorigRightHand')];
    this.leftArm = [bone(this.model, 'mixamorigLeftArm'), bone(this.model, 'mixamorigLeftForeArm'), bone(this.model, 'mixamorigLeftHand')];
    this.ragdollBones = {
      hips: this.hips, chest: this.spine, head: this.head,
      lArm: this.leftArm[0], lFore: this.leftArm[1], lHand: this.leftArm[2],
      rArm: this.rightArm[0], rFore: this.rightArm[1], rHand: this.rightArm[2],
      lUp: this.thighs[0]!, lLeg: this.shins[0]!, lFoot: this.feet[0]!,
      rUp: this.thighs[1]!, rLeg: this.shins[1]!, rFoot: this.feet[1]!,
    };
    this.aiming = !!data.aim;
    this.stanceNow = data.stance ?? 'stand';

    const gun = this.gunHolder;
    this.setGun(data.gun ?? 'rifle');
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
    if (data.color || data.team) this.setColor(data.color ?? this.colorNow, data.team ?? this.teamNow);
    if (data.name) this.tag.setName(data.name);
    this.shield.visible = !!data.shield && this.alive;
    if (data.gun && data.gun !== this.gunNow) {
      this.setGun(data.gun);
      if (this.alive) this.switchTime = 0;
    }
    if (data.aim !== undefined) this.aiming = data.aim;
    if (data.rl !== undefined) {
      if (data.rl && !this.reloading) {
        this.reloadTime = 0;
        this.reloadStarted = true;
      }
      this.reloading = data.rl;
    }
    if (data.th !== undefined && data.th !== this.throwsSeen) {
      if (this.throwsSeen !== undefined && this.alive) this.throwTime = 0;
      this.throwsSeen = data.th;
    }
    if (wasAlive && !this.alive) this.fallRoll = (Math.random() - 0.5) * 1.2;
    if (this.alive) {
      this.ragdoll = null;
      this.pendingHit = null;
    }
    if (data.stance) {
      if (data.stance === 'slide' && this.stanceNow !== 'slide') this.slideStarted = true;
      this.stanceNow = data.stance;
    }
    if (data.hp !== undefined) {
      this.hp = data.hp;
      const predicting = performance.now() - this.lastHitAt < HP_PREDICTION_MS;
      if (!predicting || this.hp < this.shownHp || respawned) this.shownHp = this.hp;
      this.tag.setHp(this.hpPercent(this.shownHp));
    }
    if (!this.alive) this.tag.hide();
  }

  /** We just shot this player: show their name and (predicted) health to us. */
  reveal(damage: number): void {
    if (!this.alive) return;
    this.lastHitAt = performance.now();
    this.shownHp = Math.max(0, Math.min(this.shownHp, this.hp) - damage);
    this.tag.reveal(this.hpPercent(this.shownHp));
  }

  setMaxHealth(max: number): void {
    this.maxHp = Math.max(1, max);
  }

  private hpPercent(hp: number): number {
    return (hp / this.maxHp) * 100;
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

  get stance(): Stance {
    return this.stanceNow;
  }

  /** True once after this player starts a slide (for its sound). */
  consumeSlideStart(): boolean {
    const started = this.slideStarted;
    this.slideStarted = false;
    return started;
  }

  /** Height of their chest above their feet, lower when crouching or sliding (for grenade line of sight). */
  get chestHeight(): number {
    return 1 - 0.35 * this.crouchAmount - 0.55 * this.slideAmount;
  }

  /** Show the gun they're holding. */
  private setGun(kind: GunKind): void {
    this.gunNow = kind;
    let model = this.gunModels.get(kind);
    if (!model) {
      model = buildRemoteGun(kind);
      this.gunModels.set(kind, model);
      this.gunHolder.add(model);
    }
    for (const [k, m] of this.gunModels) m.visible = k === kind;
    if (this.xrayMaterial) this.buildGunXray();
  }

  /** X-ray copies of the gun in hand, so it's part of a teammate's silhouette behind walls. */
  private buildGunXray(): void {
    for (const copy of this.gunXray) copy.removeFromParent();
    this.gunXray = [];
    const material = this.xrayMaterial;
    if (!material) return;
    const sources: THREE.Mesh[] = [];
    this.gunModels.get(this.gunNow)?.traverse((o) => { if ((o as THREE.Mesh).isMesh) sources.push(o as THREE.Mesh); });
    for (const mesh of sources) {
      const copy = new THREE.Mesh(mesh.geometry, material);
      copy.renderOrder = 10;
      copy.visible = this.occluded;
      mesh.add(copy);
      this.gunXray.push(copy);
    }
  }

  /** Hide the avatar (e.g. while the MVP replay is on). */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Teammates always show their name and health. */
  setAlly(ally: boolean): void {
    if (ally === this.ally) return;
    this.ally = ally;
    this.tag.setPinned(ally);
    if (!ally) this.setOccluded(false);
  }

  get isAlly(): boolean {
    return this.ally;
  }

  /**
   * A teammate is behind cover: show a flat 2D silhouette of their character in team colour
   * over the walls. Their name tag is hidden meanwhile; it comes back once they're in sight.
   * Only for allies; enemies behind walls stay hidden.
   */
  setOccluded(occluded: boolean): void {
    const show = occluded && this.ally && this.alive;
    if (show === this.occluded) return;
    this.occluded = show;
    if (show && !this.xray.length) {
      this.xrayMaterial = makeXrayMaterial(this.colorNow ?? '#ffffff');
      this.xray = makeXrayMeshes(this.model, this.xrayMaterial);
      // The gun they're holding is part of the silhouette too (rebuilt when they switch).
      this.buildGunXray();
    }
    for (const mesh of this.xray) mesh.visible = show;
    for (const mesh of this.gunXray) mesh.visible = show;
  }

  /** They just fired: bring the gun up (and keep it up for a moment) whatever they're doing. */
  noteShot(): void {
    this.firedAt = performance.now();
    this.shotFlash = true;
  }

  /** True once per shot (for the muzzle flash when watching through their eyes). */
  consumeShotFlash(): boolean {
    const flash = this.shotFlash;
    this.shotFlash = false;
    return flash;
  }

  /** Where their eyes are, following crouches and slides (same heights as our own camera). */
  eyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.group.position).setY(this.group.position.y + 1.6 - 0.55 * this.crouchAmount - 0.75 * this.slideAmount);
  }

  /** Where they're looking up / down (radians, smoothed) */
  get lookPitch(): number {
    return this.pitch;
  }

  /** The gun in their hands, and how far they've raised the sights (0..1) */
  get heldGun(): GunKind {
    return this.gunNow;
  }

  get aimAmount(): number {
    return this.adsAmount;
  }

  get sprinting(): boolean {
    return this.gait === 'Run';
  }

  get carryingFlag(): boolean {
    return this.carrying;
  }

  /** Watching through their eyes: hide their body, name tag and shield bubble from us. */
  setFirstPerson(on: boolean): void {
    if (on === this.firstPerson) return;
    this.firstPerson = on;
    this.model.visible = !on;
    if (on) this.tag.hide();
  }

  /** They're carrying the enemy flag (guns stowed; a "throw" is a swing of the flag). */
  setCarrying(carrying: boolean): void {
    if (carrying === this.carrying) return;
    this.carrying = carrying;
    this.gunHolder.visible = !carrying;
  }

  /**
   * The hit that killed them: `from` is where it came from. Shoves the body away (headshots snap
   * the head back); blasts lift the whole body.
   */
  knockback(from: THREE.Vector3, strength: number, head: boolean, blast = false): void {
    const dir = this.group.position.clone().sub(from);
    if (blast && this.ragdoll) {
      this.ragdoll.blast(from, strength);
      return;
    }
    if (this.ragdoll) this.ragdoll.impulse(dir, strength, head);
    else this.pendingHit = { dir, strength: blast ? strength * 0.8 : strength, head };
  }

  /** True once per reload they start (for the sound). */
  consumeReloadStart(): boolean {
    const started = this.reloadStarted;
    this.reloadStarted = false;
    return started;
  }

  /** Points to test for line of sight: chest and head, in world space. */
  sightPoints(): THREE.Vector3[] {
    const p = this.group.position;
    return [
      new THREE.Vector3(p.x, p.y + this.chestHeight, p.z),
      this.headHit.getWorldPosition(new THREE.Vector3()),
    ];
  }

  get hitboxes(): THREE.Mesh[] {
    return this.alive ? [this.bodyHit, this.headHit] : [];
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-14 * dt);
    this.group.position.lerp(this.target, t);
    this.group.rotation.y = angleLerp(this.group.rotation.y, this.targetYaw, t);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, t);

    // A body doesn't change gait: with the mixer frozen a cross-fade would never finish and
    // both clips would end up at full weight.
    if (this.alive) this.updateGait(dt);
    else this.lastPos.copy(this.group.position);
    if (!this.alive) this.velocity.multiplyScalar(this.ragdoll ? 0 : 1);
    // Freeze the pose while falling over, so the body drops stiffly.
    this.mixer.timeScale = this.alive ? 1 : 0;
    this.mixer.update(dt);
    // Lean the upper body to match where they're aiming (applied after the animation).
    this.spine.rotateX(-this.pitch * SPINE_PITCH);
    this.applyStance(dt);
    this.applyAim(dt);

    // Died while we were watching: the body goes limp as a ragdoll, starting from this pose.
    if (!this.alive && !this.ragdoll && this.fall < 1) {
      this.group.rotation.x = 0;
      this.group.rotation.z = 0;
      this.model.position.y = 0;
      this.group.updateMatrixWorld(true);
      this.ragdoll = new Ragdoll(this.ragdollBones, this.velocity);
      if (this.pendingHit) this.ragdoll.impulse(this.pendingHit.dir, this.pendingHit.strength, this.pendingHit.head);
      this.pendingHit = null;
    }
    if (this.ragdoll) {
      this.fall = 1;
      this.group.updateMatrixWorld(true);
      this.ragdoll.update(dt);
    } else {
    this.fall = THREE.MathUtils.clamp(this.fall + (this.alive ? -dt * 4 : dt * 2.2), 0, 1);
    if (this.fall > 0) {
      // Knees give first, then the body tips over and rolls a little to one side.
      const f = this.fall;
      const buckle = Math.min(1, f * 2.5);
      for (const thigh of this.thighs) thigh.rotateX(-buckle * 0.9);
      for (const shin of this.shins) shin.rotateX(buckle * 1.4);
      this.spine.rotateX(buckle * 0.5);
      this.head.rotateX(buckle * 0.6);
      const tip = Math.max(0, (f - 0.15) / 0.85);
      const eased = 1 - (1 - tip) ** 3;
      this.group.rotation.x = (-Math.PI / 2) * eased;
      this.group.rotation.z = this.fallRoll * eased;
      // Sink a touch so the slumped body meets the floor.
      this.model.position.y = -0.25 * buckle * (1 - eased) - 0.05 * eased;
    } else {
      // Back on their feet (a respawn snaps `fall` straight to 0, so undo the whole tilt here).
      this.group.rotation.x = 0;
      this.group.rotation.z = 0;
      this.model.position.y = 0;
    }
    }
    this.tag.update(this.alive && !this.occluded && !this.firstPerson);
    if (this.firstPerson) this.shield.visible = false;
  }

  /** Blend the crouch / slide pose and shrink the hitbox, name tag and shield to match. */
  private applyStance(dt: number): void {
    const ease = 1 - Math.exp(-12 * dt);
    const crouch = this.alive && this.stanceNow === 'crouch' ? 1 : 0;
    const slide = this.alive && this.stanceNow === 'slide' ? 1 : 0;
    this.crouchAmount += (crouch - this.crouchAmount) * ease;
    this.slideAmount += (slide - this.slideAmount) * ease;
    const c = this.crouchAmount;
    const sl = this.slideAmount;

    if (c > 0.001 || sl > 0.001) {
      for (const thigh of this.thighs) thigh.rotateX(-(c * CROUCH_POSE.thigh + sl * SLIDE_POSE.thigh));
      for (const shin of this.shins) shin.rotateX(c * CROUCH_POSE.knee + sl * SLIDE_POSE.knee);
      this.spine.rotateX(c * CROUCH_POSE.lean + sl * SLIDE_POSE.lean);
      this.plantFeet();
    }

    const body = 1 - (1 - CROUCH_BODY) * c - (1 - SLIDE_BODY) * sl;
    this.bodyHit.scale.y = body;
    this.bodyHit.position.y = 0.75 * body;
    this.tag.sprite.position.y = 2.15 - 0.6 * c - 0.95 * sl;
    this.shield.scale.y = 1.05 * body;
    this.shield.position.y = 0.95 * body;
  }

  /**
   * Point the gun where they're looking: the head takes the rest of the pitch, then both arms are
   * solved with IK, the right hand holding the gun along the look direction and the left hand on
   * its fore-end. Blended over the animation; off while sprinting, sliding or dead.
   */
  private applyAim(dt: number): void {
    const shooting = performance.now() - this.firedAt < SHOOT_HOLD_MS;
    const ready = !this.alive ? 0
      : this.carrying ? (this.throwTime >= 0 ? 1 : 0)
        : this.aiming || shooting || (this.gait !== 'Run' && this.slideAmount < 0.5) ? 1 : 0;
    // Snap up fast for a strike or a shot (the first bullets shouldn't leave from the hip), ease otherwise.
    const speed = this.carrying || shooting ? 16 : READY_SPEED;
    this.readyAmount += (ready - this.readyAmount) * (1 - Math.exp(-speed * dt));
    this.adsAmount += ((this.aiming && this.alive ? 1 : 0) - this.adsAmount) * (1 - Math.exp(-ADS_SPEED * dt));
    this.head.rotateX(-this.pitch * HEAD_PITCH);
    const w = this.readyAmount;
    if (w < 0.01) return;

    const bones = [...this.rightArm, ...this.leftArm];
    bones.forEach((b, i) => this.armAnim[i]!.copy(b.quaternion));
    this.group.updateMatrixWorld(true);

    // Reload: the gun dips and tilts while the support hand drops to the magazine and back.
    if (this.reloading) this.reloadTime += dt;
    const reloadLen = GUNS[this.gunNow].reloadTime;
    const reloadPhase = this.reloading ? Math.min(1, this.reloadTime / reloadLen) : 0;
    const reloadDip = Math.sin(reloadPhase * Math.PI);
    // Switch: a quick dip as the new gun comes up.
    if (this.switchTime >= 0) this.switchTime = this.switchTime + dt > SWITCH_LEN ? -1 : this.switchTime + dt;
    const switchDip = this.switchTime >= 0 ? Math.sin((this.switchTime / SWITCH_LEN) * Math.PI) : 0;
    // Throw: the free hand swings up behind the head and snaps forward.
    if (this.throwTime >= 0) this.throwTime = this.throwTime + dt > THROW_LEN ? -1 : this.throwTime + dt;
    const throwPhase = this.throwTime >= 0 ? this.throwTime / THROW_LEN : -1;

    // Aim frame: where they're looking (the model faces -Z at yaw 0).
    const yaw = this.group.rotation.y;
    const cp = Math.cos(this.pitch);
    _dir.set(-Math.sin(yaw) * cp, Math.sin(this.pitch), -Math.cos(yaw) * cp);
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    _up.crossVectors(_right, _dir).normalize();

    // The gun lies along the look direction, upright (x = up × forward, i.e. to their left).
    _basis.makeBasis(_offset.crossVectors(_up, _dir), _up, _dir);
    _gunQuat.setFromRotationMatrix(_basis);
    _handQuat.copy(_gunQuat).multiply(GUN_IN_HAND_INV);

    const pistol = this.gunNow === 'deagle';
    const length = remoteGunLength(this.gunNow);
    const a = this.adsAmount;
    const low = pistol ? PISTOL_READY : READY_STOCK;
    const high = pistol ? PISTOL_ADS : ADS_STOCK;
    const lerp = THREE.MathUtils.lerp;
    // Anchor: the eye when aiming, the shoulder at the ready.
    this.head.getWorldPosition(_anchor).addScaledVector(WORLD_UP, EYE_UP).addScaledVector(_dir, EYE_FORWARD);
    this.rightArm[0].getWorldPosition(_gunAt);
    _anchor.lerp(_gunAt, 1 - a);
    _gunAt.copy(_anchor)
      .addScaledVector(_dir, lerp(low.forward, high.forward, a) + (pistol ? 0 : length / 2) - 0.08 * reloadDip - 0.1 * switchDip)
      .addScaledVector(_up, lerp(low.up, high.up, a) - 0.12 * reloadDip - 0.25 * switchDip)
      .addScaledVector(_right, lerp(low.right, high.right, a));
    if (reloadDip > 0 || switchDip > 0) {
      // Tilt the gun down and roll it toward the body a little.
      _q.setFromAxisAngle(_right, 0.45 * reloadDip + 0.6 * switchDip).multiply(_gunQuat);
      _gunQuat.copy(_q);
      _q.setFromAxisAngle(_dir, -0.5 * reloadDip);
      _gunQuat.premultiply(_q);
      _handQuat.copy(_gunQuat).multiply(GUN_IN_HAND_INV);
    }

    // The hand sits where the gun's centre minus its offset in the palm puts it.
    const hand = this.rightArm[2];
    hand.getWorldScale(_scale);
    _offset.copy(GUN_OFFSET).multiplyScalar(_scale.x).applyQuaternion(_handQuat);
    _handAt.copy(_gunAt).sub(_offset);

    _pole.copy(_right).multiplyScalar(lerp(0.5, 1, a)).addScaledVector(WORLD_UP, -1);
    reach(this.rightArm[0], this.rightArm[1], hand, _handAt, _pole);
    setWorldQuaternion(hand, _handQuat);

    // Support hand under the fore-end (or wrapped round the pistol grip).
    if (pistol) _support.copy(_handAt).addScaledVector(_right, -0.05).addScaledVector(_up, -0.02);
    else _support.copy(_gunAt).addScaledVector(_dir, length * 0.22).addScaledVector(_up, -0.05);
    if (reloadDip > 0) {
      // Down to the magazine well (just under and behind the grip), then back up.
      _support.lerp(
        _tmp.copy(_handAt).addScaledVector(_up, -0.22).addScaledVector(_dir, pistol ? -0.02 : 0.08).addScaledVector(_right, -0.04),
        reloadDip,
      );
    }
    if (throwPhase >= 0) {
      // Wind up behind the head, then whip forward and down.
      const wind = Math.min(1, throwPhase / 0.4);
      const release = Math.max(0, (throwPhase - 0.4) / 0.6);
      this.head.getWorldPosition(_tmp);
      const back = _tmp.clone().addScaledVector(_dir, -0.25).addScaledVector(WORLD_UP, 0.35).addScaledVector(_right, -0.2);
      const fwd = _tmp.clone().addScaledVector(_dir, 0.7).addScaledVector(WORLD_UP, -0.1).addScaledVector(_right, -0.15);
      const target = release > 0 ? back.lerp(fwd, 1 - (1 - release) ** 2) : _support.clone().lerp(back, wind);
      _support.copy(target);
    }
    _pole.copy(_right).multiplyScalar(-0.6).addScaledVector(WORLD_UP, -1);
    reach(this.leftArm[0], this.leftArm[1], this.leftArm[2], _support, _pole);

    if (w < 0.999) bones.forEach((b, i) => b.quaternion.slerpQuaternions(this.armAnim[i]!, b.quaternion, w));
  }

  /** Lower the hips so the lowest foot is back at standing height after the legs were bent. */
  private plantFeet(): void {
    this.model.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const lowest = Math.min(...this.feet.map((f) => f.getWorldPosition(v).y)) - this.group.position.y;
    const lift = lowest - FOOT_REST;
    if (lift <= 0) return;
    // The rig is Z-up inside the scaled armature, so "down" for the hips is local -Z.
    const scale = this.hips.parent?.getWorldScale(v).z || 1;
    this.hips.position.z -= lift / scale;
  }

  /** Pick Idle / Walk / Run from how fast the avatar is actually moving. */
  private updateGait(dt: number): void {
    const moved = this.group.position.clone().sub(this.lastPos);
    this.lastPos.copy(this.group.position);
    moved.y = 0;
    const instant = dt > 0 ? moved.length() / dt : 0;
    if (dt > 0) this.velocity.lerp(moved.clone().divideScalar(dt), 1 - Math.exp(-10 * dt));
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

  private setColor(color: string | undefined, team?: Team): void {
    if (!color) return;
    if (color === this.colorNow && team === this.teamNow) return;
    this.colorNow = color;
    this.teamNow = team;
    this.xrayMaterial?.uniforms.color?.value.set(color);
    const onTeam = !!(team ?? teamOfColor(color));
    const tint = new THREE.Color(color);
    for (const mat of this.materials) {
      if (mat.name.includes('Visor')) {
        // Visor in full colour; in team modes it glows too.
        mat.color.copy(tint);
        mat.emissive.copy(tint).multiplyScalar(onTeam ? TEAM_VISOR_GLOW : 0);
      } else {
        mat.color.setRGB(1, 1, 1).lerp(tint, onTeam ? TEAM_TINT : FFA_TINT);
        mat.emissive.copy(tint).multiplyScalar(onTeam ? TEAM_GLOW : 0);
      }
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.scene.remove(this.group);
    for (const mat of this.materials) mat.dispose();
    this.xrayMaterial?.dispose();
    this.tag.dispose();
  }
}
