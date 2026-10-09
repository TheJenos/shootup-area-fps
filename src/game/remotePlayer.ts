import * as THREE from 'three';
import { NameTag } from './nameTag';
import { makeXrayMaterial, makeXrayMeshes } from './xray';
import { GUNS, buildRemoteGun, remoteGunLength } from './guns';
import { buildKnifeModel } from './weapon';
import { reach, setWorldQuaternion } from './ik';
import { Ragdoll, type RagdollBones } from './ragdoll';
import { BONES, cloneCharacter, GAITS, type CharacterAsset, type Gait } from './character';
import { CARRIED_LEAN } from './flags';
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
const READY_STOCK = { forward: 0.02, up: -0.18, right: -0.03 };
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
const _color = new THREE.Color();
/** Lengths of the switch dip and the throw swing (s) */
const SWITCH_LEN = 0.4;
/** A knife slash with the free hand (s) */
const KNIFE_LEN = 0.42;
const _bladeDir = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);
const THROW_LEN = 0.55;
/** A carried flag's swing: tipped back this far over the shoulder, then through this far forward (radians) */
const FLAG_WIND = 0.9;
const FLAG_STRIKE = 1.7;
/** Where a carried flag's pole is gripped, from the shoulder (m): out in front, elbow bent */
const FLAG_CARRY = { forward: 0.24, up: -0.3, right: 0.04 };
const _fwd = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _handQuat = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const GUN_IN_HAND_INV = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// After we hit someone, trust our own damage estimate over slightly stale server updates for this long.
const HP_PREDICTION_MS = 600;

/*
 * The model has no crouch or slide animation, so they're posed on top of whatever it's
 * playing: thighs forward, knees bent, upper body leaning (radians), then the body is
 * lowered until the feet are back on the ground. The pose blends in and out.
 */
const CROUCH_POSE = { thigh: 1.1, knee: 1.75, lean: 0.35 };
const SLIDE_POSE = { thigh: 1.65, knee: 0.3, lean: -0.8 };
/** How high the foot bones sit above the ground when standing (m) */
const FOOT_REST = 0.02;
/** Body hitbox height (scale) and how far a crouch / slide lowers the head tag and chest */
const CROUCH_BODY = 0.68;
const SLIDE_BODY = 0.42;

/*
 * Tinting. Only the uniform takes the player's colour (the gear stays black, the skin skin-toned).
 * In free-for-all it's a wash of their own colour; in team modes the uniform takes the team
 * colour, with a faint glow so teams stay readable in shadow and at a distance.
 */
const FFA_TINT = 0.45;
const TEAM_TINT = 0.65;
const TEAM_GLOW = 0.1;
const TEAM_VISOR_GLOW = 0.7;
/** What a cloaked enemy fades to instead of their colour: a pale glassy grey */
const CLOAK_COLOR = new THREE.Color(0xd8dee4);

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
const HAND_FORWARD = new THREE.Vector3(-0.89, 0.32, 0.31).normalize();
const HAND_UP = new THREE.Vector3(-0.3, -0.95, 0.11).normalize();
const GUN_IN_HAND = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(HAND_UP, HAND_FORWARD).normalize(),
    HAND_UP,
    HAND_FORWARD,
  ),
);
/** The middle of the fist from the hand bone (m, in its axes): what's held (gun, flag pole) runs through it */
const PALM = new THREE.Vector3(0, 0.1, -0.03);
/*
 * The model's fingers are straight, so a hand that holds something is curled into a fist: each joint
 * turns about the knuckle line (the hand bone's X, both hands; the palms face its -Z) by these angles
 * (rad), knuckle to tip. The thumb closes a little.
 */
const CURL_AXIS = new THREE.Vector3(-1, 0, 0);
const FIST = [1.3, 1.4, 1.0];
const THUMB_CURL = [0.3, 0.5];
// Grip in the palm, with most of the rifle in front of the hand.
const GUN_OFFSET = PALM.clone().addScaledVector(HAND_FORWARD, 0.14);
/** The head hitbox's centre from the head bone (m, in its axes): up the skull and a touch forward */
const HEAD_HIT_OFFSET = new THREE.Vector3(0, 0.18, 0.02);
/** The body's left in the model's space (it faces -Z): the axis legs, spine and head bend about */
const MODEL_LEFT = new THREE.Vector3(-1, 0, 0);
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
  /** Knife slash: seconds since it started, or -1; the knife in their free hand (made on first slash) */
  private knifeTime = -1;
  private knifeMesh: THREE.Group | null = null;
  /** A slash not yet shown in the first-person view of this player */
  private knifeFlash = false;
  private flagSwingNow = 0;
  /** 0..1 blend from carrying the flag to swinging it, so the arm eases back after a strike */
  private swingAmount = 0;
  /** PALM in the hand bone's units */
  private readonly palm = new THREE.Vector3();
  /** Finger joints of each hand (right, left): bind-pose rotation, CURL_AXIS in the joint's space, full-fist angle */
  private readonly fists: { bone: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3; angle: number }[][];
  private throwsSeen: number | undefined;
  /** Gun switch: the gun dips for a moment */
  private switchTime = -1;
  /** Death: a sideways tilt chosen per fall so bodies don't all drop the same way */
  private fallRoll = 0;
  /** Carrying the enemy flag: no gun in hand, arms swing free except when they strike */
  private carrying = false;
  /** Cloak ability on (as last reported), and how far the fade has got (0..1) */
  private cloak = false;
  private cloakAmount = 0;
  private lastCloakLook = -1;
  /** Cloaked enough that an enemy loses the gun and name tag */
  private cloakHidden = false;
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
  /** Red outline from our scan pulse */
  private scanned = false;
  private scanXray: THREE.Mesh[] = [];
  private scanMaterial: THREE.ShaderMaterial | null = null;
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
      // Always on the transparent path (drawn solid at opacity 1): three.js compiles opaque
      // materials to ignore opacity, so switching for the cloak would need a shader recompile.
      mat.transparent = true;
      mat.userData.baseColor = mat.color.clone();
      mesh.material = mat;
      this.materials.push(mat);
    });
    this.setColor(data.color, data.team);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = Object.fromEntries(
      GAITS.map((g) => [g, this.mixer.clipAction(asset.clips[g])]),
    ) as Record<Gait, THREE.AnimationAction>;
    this.actions.Idle.play();

    const bones = (names: readonly string[]) => names.map((n) => bone(this.model, n));
    this.spine = bone(this.model, BONES.chest);
    this.hips = bone(this.model, BONES.body);
    this.thighs = bones(BONES.thighs);
    this.shins = bones(BONES.shins);
    this.feet = bones(BONES.feet);
    this.head = bone(this.model, BONES.head);
    this.rightArm = bones(BONES.rightArm) as [THREE.Object3D, THREE.Object3D, THREE.Object3D];
    this.leftArm = bones(BONES.leftArm) as [THREE.Object3D, THREE.Object3D, THREE.Object3D];
    this.ragdollBones = {
      hips: this.hips, chest: this.spine, head: this.head,
      lArm: this.leftArm[0], lFore: this.leftArm[1], lHand: this.leftArm[2],
      rArm: this.rightArm[0], rFore: this.rightArm[1], rHand: this.rightArm[2],
      lUp: this.thighs[0]!, lLeg: this.shins[0]!, lFoot: this.feet[0]!,
      rUp: this.thighs[1]!, rLeg: this.shins[1]!, rFoot: this.feet[1]!,
    };
    this.aiming = !!data.aim;
    this.stanceNow = data.stance ?? 'stand';

    // Things riding on bones are sized in metres: undo the skeleton's scale.
    const boneScale = (b: THREE.Object3D) => b.getWorldScale(_scale).x / this.model.getWorldScale(_tmp).x;
    const gun = this.gunHolder;
    this.setGun(data.gun ?? 'rifle');
    const handScale = boneScale(this.rightArm[2]);
    gun.scale.setScalar(1 / handScale);
    gun.position.copy(GUN_OFFSET).divideScalar(handScale);
    this.palm.copy(PALM).divideScalar(handScale);
    this.fists = [BONES.rightFingers, BONES.leftFingers].map((hand) => hand.flatMap((chain, f) => {
      const thumb = f === hand.length - 1;
      // The axis is the same line all along a finger, so in each joint's space it's the parent's, undone by the joint's rest turn.
      // (Each chain starts at the knuckle, under the finger's palm bone.)
      const palmBone = bone(this.model, chain[0]!).parent!;
      const axis = CURL_AXIS.clone().applyQuaternion(_q.copy(palmBone.quaternion).invert());
      return chain.map((name, j) => {
        const b = bone(this.model, name);
        axis.applyQuaternion(_q.copy(b.quaternion).invert());
        return { bone: b, rest: b.quaternion.clone(), axis: axis.clone(), angle: (thumb ? THUMB_CURL : FIST)[j]! };
      });
    }));
    gun.quaternion.copy(GUN_IN_HAND);
    this.rightArm[2].add(gun);

    this.bodyHit = new THREE.Mesh(bodyHitGeo, hitboxMat);
    this.bodyHit.position.y = 0.75;
    this.bodyHit.userData = { playerId: id, head: false } satisfies HitboxData;

    // The head hitbox rides on the head bone so it follows the animation.
    this.headHit = new THREE.Mesh(headHitGeo, hitboxMat);
    const headScale = boneScale(this.head);
    this.headHit.scale.setScalar(1 / headScale);
    this.headHit.position.copy(HEAD_HIT_OFFSET).divideScalar(headScale);
    this.headHit.userData = { playerId: id, head: true } satisfies HitboxData;
    this.head.add(this.headHit);

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
    // A colour comes with the whole record, so a missing team then means none (the owner switched to free-for-all).
    if (data.color || data.team) this.setColor(data.color ?? this.colorNow, data.color ? data.team : this.teamNow);
    if (data.name) this.tag.setName(data.name);
    this.shield.visible = !!data.shield && this.alive;
    if (data.cloak !== undefined) this.cloak = data.cloak;
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
      this.ragdoll?.dispose();
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

  /**
   * The gun a shot of theirs says they fired: a shot can arrive just before the state update that
   * says they switched, so trust the shot.
   */
  showGun(kind: GunKind): void {
    if (kind === this.gunNow) return;
    this.setGun(kind);
    if (this.alive) this.switchTime = 0;
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
  /** Shown through walls in red by an enemy's scan pulse (only while it lasts). */
  setScanned(on: boolean): void {
    const show = on && this.alive;
    if (show === this.scanned) return;
    this.scanned = show;
    if (show && !this.scanXray.length) {
      this.scanMaterial = makeXrayMaterial('#ff3b3b');
      this.scanXray = makeXrayMeshes(this.model, this.scanMaterial);
    }
    for (const mesh of this.scanXray) mesh.visible = show;
  }

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

  /** They slashed with the knife: the free hand cuts across, knife in hand. */
  noteKnife(): void {
    if (!this.alive) return;
    this.knifeTime = 0;
    this.knifeFlash = true;
  }

  /** True once per knife slash (to slash in the first-person view of this player too). */
  consumeKnife(): boolean {
    // (Only while it's still going: not one from before we started watching.)
    const slash = this.knifeFlash && this.knifeTime >= 0;
    this.knifeFlash = false;
    return slash;
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

  /** How far a carried flag is tipped by their swing (radians, + forward); 0 when not swinging */
  get flagSwing(): number {
    return this.flagSwingNow;
  }

  /** Where their right fist is (world space): a carried flag's pole runs through it. */
  handPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.rightArm[2].localToWorld(out.copy(this.palm));
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
    this.swingAmount = 0;
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

  /** Cloaked as far as we know (for their footsteps) */
  get cloaked(): boolean {
    return this.cloak && this.alive;
  }

  /**
   * Fade toward a faint shimmer while cloaked: enemies see ~6% of them, teammates a ghost at ~45%.
   * Their gun, name tag and shadow go too (the gun's material is shared, so it's hidden, not faded).
   */
  /** The colours setColor gave each material, which the cloak fades from and back to */
  private readonly baseLook = new Map<THREE.MeshStandardMaterial, { color: THREE.Color; emissive: THREE.Color }>();

  private updateCloak(dt: number): void {
    const on = this.cloaked;
    this.cloakAmount += ((on ? 1 : 0) - this.cloakAmount) * (1 - Math.exp(-8 * dt));
    if (!on && this.cloakAmount < 0.01) this.cloakAmount = 0;
    const amount = Math.round(this.cloakAmount * 50) / 50;
    this.cloakHidden = amount > 0.5 && !this.ally;
    this.gunHolder.visible = !this.carrying && !this.cloakHidden;
    const look = amount + (this.ally ? 10 : 0);
    if (look === this.lastCloakLook) return;
    this.lastCloakLook = look;
    const opacity = 1 - amount * (1 - (this.ally ? 0.45 : 0.06));
    const faded = amount > 0;
    // Enemies lose the team colour and glow too, leaving a faint neutral shimmer; teammates keep it.
    const neutral = this.ally ? 0 : amount;
    for (const mat of this.materials) {
      mat.opacity = opacity;
      mat.depthWrite = !faded;
      const base = this.baseLook.get(mat);
      if (base) {
        mat.color.copy(base.color).lerp(CLOAK_COLOR, neutral);
        mat.emissive.copy(base.emissive).multiplyScalar(1 - neutral);
      }
    }
    this.model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = !faded; });
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-14 * dt);
    this.updateCloak(dt);
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
    this.bend(this.spine, -this.pitch * SPINE_PITCH);
    this.applyStance(dt);
    this.applyAim(dt);
    // The right hand always holds the gun or the flag; the left grips the gun when it's up.
    this.curlFingers(0, 1);
    this.curlFingers(1, this.carrying ? 0 : this.readyAmount);

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
      for (const thigh of this.thighs) this.bend(thigh, -buckle * 0.9);
      for (const shin of this.shins) this.bend(shin, buckle * 1.4);
      this.bend(this.spine, buckle * 0.5);
      this.bend(this.head, buckle * 0.6);
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
    this.tag.update(this.alive && !this.occluded && !this.firstPerson && !this.cloakHidden);
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
      for (const thigh of this.thighs) this.bend(thigh, -(c * CROUCH_POSE.thigh + sl * SLIDE_POSE.thigh));
      for (const shin of this.shins) this.bend(shin, c * CROUCH_POSE.knee + sl * SLIDE_POSE.knee);
      this.bend(this.spine, c * CROUCH_POSE.lean + sl * SLIDE_POSE.lean);
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
      : this.carrying || this.knifeTime >= 0 ? 1
        : this.aiming || shooting || (this.gait !== 'Run' && this.slideAmount < 0.5) ? 1 : 0;
    // Snap up fast for a strike or a shot (the first bullets shouldn't leave from the hip), ease otherwise.
    const speed = this.carrying || shooting ? 16 : READY_SPEED;
    this.readyAmount += (ready - this.readyAmount) * (1 - Math.exp(-speed * dt));
    this.adsAmount += ((this.aiming && this.alive ? 1 : 0) - this.adsAmount) * (1 - Math.exp(-ADS_SPEED * dt));
    this.bend(this.head, -this.pitch * HEAD_PITCH);
    this.flagSwingNow = 0;
    if (this.knifeTime >= 0) this.knifeTime = this.knifeTime + dt > KNIFE_LEN || !this.alive || this.carrying ? -1 : this.knifeTime + dt;
    const w = this.readyAmount;
    if (w < 0.01) {
      this.showKnife(false);
      return;
    }

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

    if (this.carrying) {
      // The flag is in the right hand: that arm holds and swings it, the left keeps its animation.
      this.swingFlag(throwPhase, w, dt);
      this.blendArms(3, w);
      return;
    }

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
    _offset.copy(GUN_OFFSET).applyQuaternion(_handQuat);
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
    const knifePhase = this.knifeTime >= 0 ? this.knifeTime / KNIFE_LEN : -1;
    if (knifePhase >= 0) {
      // The free hand comes up on the left, then cuts across in front and down to the right.
      this.head.getWorldPosition(_tmp);
      const cut = knifePhase < 0.3 ? 0 : Math.min(1, (knifePhase - 0.3) / 0.4);
      const ready = _tmp.clone().addScaledVector(_dir, 0.3).addScaledVector(WORLD_UP, 0.05).addScaledVector(_right, -0.35);
      const through = _tmp.clone().addScaledVector(_dir, 0.6).addScaledVector(WORLD_UP, -0.3).addScaledVector(_right, 0.2);
      const at = ready.lerp(through, 1 - (1 - cut) ** 2);
      // In from the support grip, and back to it at the end.
      const blend = Math.min(1, knifePhase / 0.2, (1 - knifePhase) / 0.15);
      _support.lerp(at, blend);
    }
    _pole.copy(_right).multiplyScalar(-0.6).addScaledVector(WORLD_UP, -1);
    reach(this.leftArm[0], this.leftArm[1], this.leftArm[2], _support, _pole);

    this.blendArms(6, w);
    this.showKnife(knifePhase >= 0);
  }

  /**
   * The knife in the free hand while slashing: out of the fist, pointing forward and the way the cut
   * goes (so it reads from any side, not just end-on). Uses the aim frame applyAim just set.
   */
  private showKnife(on: boolean): void {
    if (!on || this.firstPerson || this.cloakHidden) {
      if (this.knifeMesh) this.knifeMesh.visible = false;
      return;
    }
    if (!this.knifeMesh) {
      this.knifeMesh = buildKnifeModel();
      this.scene.add(this.knifeMesh);
    }
    const knife = this.knifeMesh;
    this.group.updateMatrixWorld(true);
    this.leftArm[2].getWorldPosition(_handAt);
    _bladeDir.copy(_dir).multiplyScalar(0.6).addScaledVector(_right, 0.7).addScaledVector(_up, 0.25).normalize();
    knife.position.copy(_handAt).addScaledVector(_dir, 0.05).addScaledVector(_bladeDir, 0.03);
    knife.quaternion.setFromUnitVectors(UP_Y, _bladeDir);
    knife.visible = true;
  }

  /** Close hand 0 (right) or 1 (left) into a fist, `amount` 0..1 of the way. */
  private curlFingers(hand: number, amount: number): void {
    for (const { bone: b, rest, axis, angle } of this.fists[hand]!) b.quaternion.copy(rest).multiply(_q.setFromAxisAngle(axis, angle * amount));
  }

  /** Blend the first `count` arm bones (right arm, then left) from the animation's pose to the one just set, by `w`. */
  private blendArms(count: number, w: number): void {
    if (w >= 0.999) return;
    const bones = [...this.rightArm, ...this.leftArm];
    for (let i = 0; i < count; i++) {
      const b = bones[i]!;
      // (Not slerpQuaternions(anim, b.quaternion, w): that copies `anim` over b.quaternion before reading it.)
      _q.copy(b.quaternion);
      b.quaternion.copy(this.armAnim[i]!).slerp(_q, w);
    }
  }

  /**
   * The carried flag: held upright out in front, the fist round the pole. A swing winds the hand up
   * over the shoulder (flag tipped back), then chops forward and down (flag swung through to past
   * level), like a club, and eases back to the carry.
   */
  private swingFlag(phase: number, w: number, dt: number): void {
    this.swingAmount += ((phase >= 0 ? 1 : 0) - this.swingAmount) * (1 - Math.exp(-16 * dt));
    const s = this.swingAmount;
    // After the strike (phase < 0) the arm eases back from the follow-through as `s` fades.
    if (phase < 0) phase = 1;
    const wind = Math.min(1, phase / 0.35);
    const release = Math.max(0, (phase - 0.35) / 0.65);
    const strike = 1 - (1 - release) ** 2;
    const tip = (release > 0 ? THREE.MathUtils.lerp(-FLAG_WIND, FLAG_STRIKE, strike) : -FLAG_WIND * wind) * s;
    this.flagSwingNow = tip * w;

    // Level forward (the flag ignores the look pitch), and where the fist goes.
    _fwd.set(_right.z, 0, -_right.x);
    this.rightArm[0].getWorldPosition(_grip)
      .addScaledVector(_fwd, FLAG_CARRY.forward).addScaledVector(WORLD_UP, FLAG_CARRY.up).addScaledVector(_right, FLAG_CARRY.right);
    if (s > 0.001) {
      this.head.getWorldPosition(_tmp);
      const back = _tmp.clone().addScaledVector(_fwd, -0.15).addScaledVector(WORLD_UP, 0.3).addScaledVector(_right, 0.3);
      const fwd = _tmp.clone().addScaledVector(_fwd, 0.65).addScaledVector(WORLD_UP, -0.45).addScaledVector(_right, 0.12);
      const swung = release > 0 ? back.lerp(fwd, strike) : _grip.clone().lerp(back, wind);
      _grip.lerp(swung, s);
    }

    // The fist holds the pole as it would a gun pointing up the pole: along it, leaning forward with the flag.
    const lean = CARRIED_LEAN + this.flagSwingNow;
    _gunAt.copy(WORLD_UP).multiplyScalar(Math.cos(lean)).addScaledVector(_fwd, Math.sin(lean));
    _support.copy(WORLD_UP).multiplyScalar(Math.sin(lean)).addScaledVector(_fwd, -Math.cos(lean));
    _basis.makeBasis(_offset.crossVectors(_support, _gunAt), _support, _gunAt);
    _handQuat.setFromRotationMatrix(_basis).multiply(GUN_IN_HAND_INV);

    const hand = this.rightArm[2];
    _handAt.copy(_grip).sub(_offset.copy(PALM).applyQuaternion(_handQuat));
    _pole.copy(_right).multiplyScalar(0.8).addScaledVector(WORLD_UP, -1);
    reach(this.rightArm[0], this.rightArm[1], hand, _handAt, _pole);
    setWorldQuaternion(hand, _handQuat);
  }

  /**
   * Turn a bone about the body's left-right axis, whatever way the rig's bone axes point:
   * + tips a leg's far end back and the spine and head forward.
   */
  private bend(b: THREE.Object3D, angle: number): void {
    this.model.getWorldQuaternion(_q);
    _tmp.copy(MODEL_LEFT).applyQuaternion(_q);
    b.getWorldQuaternion(_q);
    b.rotateOnAxis(_tmp.applyQuaternion(_q.invert()), angle);
  }

  /** Lower the body so the lowest foot is back at standing height after the legs were bent. */
  private plantFeet(): void {
    const parent = this.hips.parent;
    if (!parent) return;
    this.model.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const lowest = Math.min(...this.feet.map((f) => f.getWorldPosition(v).y)) - this.group.position.y;
    const lift = lowest - FOOT_REST;
    if (lift <= 0) return;
    // World down in the parent's space (the animation sets the position afresh every frame).
    parent.getWorldQuaternion(_q).invert();
    const scale = parent.getWorldScale(v).x;
    this.hips.position.addScaledVector(v.set(0, -1, 0).applyQuaternion(_q), lift / scale);
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
      if (mat.name === 'Visor') {
        // Visor in full colour; in team modes it glows too.
        mat.color.copy(tint);
        mat.emissive.copy(tint).multiplyScalar(onTeam ? TEAM_VISOR_GLOW : 0);
      } else if (mat.name === 'Uniform') {
        mat.color.copy(mat.userData.baseColor as THREE.Color).multiply(_color.setRGB(1, 1, 1).lerp(tint, onTeam ? TEAM_TINT : FFA_TINT));
        mat.emissive.copy(tint).multiplyScalar(onTeam ? TEAM_GLOW : 0);
      }
      this.baseLook.set(mat, { color: mat.color.clone(), emissive: mat.emissive.clone() });
    }
    // Re-apply the cloak over the new colours.
    this.lastCloakLook = -1;
  }

  dispose(): void {
    this.ragdoll?.dispose();
    this.ragdoll = null;
    if (this.knifeMesh) this.scene.remove(this.knifeMesh);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.scene.remove(this.group);
    for (const mat of this.materials) mat.dispose();
    this.xrayMaterial?.dispose();
    this.scanMaterial?.dispose();
    this.tag.dispose();
  }
}
