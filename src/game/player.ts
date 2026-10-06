import * as THREE from 'three';
import { keyFor, settings } from './settings';
import { GROUP, groups, type PhysicsWorld, type RapierCollider, type RapierBody } from './physics';
import type { CharacterCollision, KinematicCharacterController, Capsule } from '@dimforge/rapier3d-compat';
import type { Stance } from '../types';
import { EYE_HEIGHT, HEIGHT, MAX_SLOPE, RADIUS, STEP_UP } from './playerDims';

export { EYE_HEIGHT };

const GRAVITY = 22;
const JUMP_SPEED = 7.6;
const WALK_SPEED = 6;
const SPRINT_SPEED = 9;
const CROUCH_SPEED = 3.2;
const AIM_SPEED = 3.8;
const CROUCH_HEIGHT = 1.15;
const CROUCH_EYE = 1.05;
const SLIDE_EYE = 0.85;
/** Slide: a burst of speed that bleeds off, then you're crouching */
const SLIDE_SPEED = 13;
const SLIDE_TIME = 0.85;
const SLIDE_FRICTION = 1.6;
const SLIDE_COOLDOWN = 1.2;
/** You must be moving at least this fast (sprinting) to slide */
const SLIDE_FROM_SPEED = 7.5;
/** Camera roll while sliding (radians) */
const SLIDE_TILT = 0.07;
/** Radians per pixel at sensitivity 1 */
const MOUSE_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;
/** Walking downhill sticks to the ramp instead of bouncing off it, up to this gap */
const STICK_DOWN = 0.35;
/** Gap the character controller keeps between the body and the world (m) */
const SKIN = 0.02;

/**
 * Collision is Rapier's kinematic character controller: a capsule that slides along walls, steps
 * up ledges, walks ramps and sticks to the ground going downhill. It only collides with the map
 * (and deployed walls); a second, kinematic capsule follows it to shove loose props around.
 */
interface Body {
  physics: PhysicsWorld;
  controller: KinematicCharacterController;
  /** The shape the controller moves (not simulated: it touches nothing by itself) */
  collider: RapierCollider;
  /** Follows the player so loose props get pushed */
  pusher: RapierBody;
  pusherCollider: RapierCollider;
  /** A standing body, for testing whether there's room to stand up */
  standShape: Capsule;
  /** Scratch space for the controller's collision reports */
  hit: CharacterCollision;
}

/** First-person controller: WASD + mouse look, gravity, jumping and collisions (Rapier). */
export class LocalPlayer {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  onGround = false;
  enabled = false;
  /** Scales walk/sprint speed (Speed Boost ability) */
  speedMultiplier = 1;
  /** The mode's movement speed and gravity (custom mode rules) */
  speedScale = 1;
  gravityScale = 1;
  stance: Stance = 'stand';
  /** Set for one update when a slide starts (for the sound) */
  slideStarted = false;
  /** Aiming down sights: slower, no sprinting or sliding */
  aiming = false;
  /** Scales mouse look (lower while zoomed in) */
  lookScale = 1;
  /** Touch controls: analog stick (x = right, y = forward, each -1..1), and held buttons */
  touchMove: { x: number; y: number } | null = null;
  touchSprint = false;
  touchCrouch = false;
  touchJump = false;

  private readonly camera: THREE.PerspectiveCamera;
  private body: Body | null = null;
  private eyeHeight = EYE_HEIGHT;
  /** Height of the map's ground at (x, z), for the safety net under it */
  private terrainAt: (x: number, z: number) => number = () => 0;
  private tilt = 0;
  private slideLeft = 0;
  private slideCooldown = 0;
  private crouchWasHeld = false;

  constructor(camera: THREE.PerspectiveCamera, signal: AbortSignal) {
    this.camera = camera;
    camera.rotation.order = 'YXZ';

    window.addEventListener('keydown', (e) => this.keys.add(e.code), { signal });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), { signal });
    window.addEventListener('blur', () => this.keys.clear(), { signal });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const { sensitivity, invertY } = settings.get();
      const scale = MOUSE_SENSITIVITY * sensitivity * this.lookScale;
      this.look(-e.movementX * scale, -e.movementY * scale * (invertY ? -1 : 1));
    }, { signal });
  }

  /** Give the player a body in the physics world (once it has loaded). Until then it can't move. */
  /** The map changed: its ground, for the safety net under it. */
  setTerrain(terrainAt: (x: number, z: number) => number): void {
    this.terrainAt = terrainAt;
  }

  attachPhysics(physics: PhysicsWorld): void {
    this.detachPhysics();
    const { R, world } = physics;
    const controller = world.createCharacterController(SKIN);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.enableAutostep(STEP_UP, 0.15, false);
    controller.setMaxSlopeClimbAngle(MAX_SLOPE);
    controller.setMinSlopeSlideAngle(MAX_SLOPE + 0.1);
    controller.enableSnapToGround(STICK_DOWN);
    controller.setApplyImpulsesToDynamicBodies(false);
    const half = capsuleHalf(HEIGHT);
    const collider = world.createCollider(R.ColliderDesc.capsule(half, RADIUS).setCollisionGroups(groups(0, 0)));
    const pusher = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    const pusherCollider = world.createCollider(
      R.ColliderDesc.capsule(half, RADIUS).setCollisionGroups(groups(GROUP.PLAYER, GROUP.DEBRIS)),
      pusher,
    );
    this.body = { physics, controller, collider, pusher, pusherCollider, standShape: new R.Capsule(half, RADIUS - 0.02), hit: new R.CharacterCollision() };
    this.placeBody(true);
  }

  detachPhysics(): void {
    const b = this.body;
    if (!b) return;
    this.body = null;
    if (b.physics.disposed) return;
    b.physics.world.removeCharacterController(b.controller);
    b.physics.world.removeCollider(b.collider, false);
    b.physics.world.removeRigidBody(b.pusher);
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.touchMove = null;
      this.touchSprint = this.touchCrouch = this.touchJump = false;
    }
  }

  teleport(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.stance = 'stand';
    this.slideLeft = 0;
    this.eyeHeight = EYE_HEIGHT;
    this.tilt = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.placeBody(true);
    this.syncCamera();
  }

  /** Launch horizontally in the look direction with a small hop, so air control carries it further. */
  dash(speed: number): void {
    this.velocity.x = -Math.sin(this.yaw) * speed;
    this.velocity.z = -Math.cos(this.yaw) * speed;
    this.velocity.y = Math.max(this.velocity.y, 3.5);
    this.onGround = false;
  }

  get sprintHeld(): boolean {
    return !this.aiming && (this.touchSprint || this.keys.has(keyFor('sprint')));
  }

  get crouching(): boolean {
    return this.stance !== 'stand';
  }

  private get height(): number {
    return this.stance === 'stand' ? HEIGHT : CROUCH_HEIGHT;
  }

  /** Whether there's room above us to stand up (e.g. not under the top of a stack). */
  private canStand(): boolean {
    const b = this.body;
    if (!b) return true;
    const p = this.position;
    // A slightly slimmer standing body, lifted off the floor: only something overhead stops us.
    const hit = b.physics.world.intersectionWithShape(
      { x: p.x, y: p.y + SKIN + 0.05 + HEIGHT / 2, z: p.z }, IDENTITY, b.standShape,
      undefined, groups(GROUP.PLAYER, GROUP.WORLD), b.collider,
    );
    return hit === null;
  }

  /** Put the capsule's feet at `position`, sized for the stance. */
  private placeBody(teleport = false): void {
    const b = this.body;
    if (!b) return;
    const h = this.height;
    const half = capsuleHalf(h);
    if (b.collider.halfHeight() !== half) {
      b.collider.setHalfHeight(half);
      b.pusherCollider.setHalfHeight(half);
    }
    const p = this.position;
    const center = { x: p.x, y: p.y + SKIN + h / 2, z: p.z };
    b.collider.setTranslation(center);
    if (teleport) b.pusher.setTranslation(center, true);
    else b.pusher.setNextKinematicTranslation(center);
  }

  /**
   * Holding crouch crouches. Pressing it while sprinting on the ground slides instead:
   * a burst of speed in the direction you're moving that bleeds off into a crouch.
   */
  private updateStance(dt: number, move: boolean): void {
    this.slideStarted = false;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    const held = move && (this.touchCrouch || this.keys.has(keyFor('crouch')));
    const pressed = held && !this.crouchWasHeld;
    this.crouchWasHeld = held;

    if (this.stance === 'slide') {
      this.slideLeft -= dt;
      const slow = this.horizontalSpeed < CROUCH_SPEED + 0.5;
      if (this.slideLeft <= 0 || slow) this.stance = 'crouch';
    } else if (
      pressed && this.onGround && this.sprintHeld && this.slideCooldown <= 0
      && this.horizontalSpeed >= SLIDE_FROM_SPEED
    ) {
      // Launch along the way we're already going, so it follows the sprint.
      const dir = new THREE.Vector3(this.velocity.x, 0, this.velocity.z).normalize();
      const speed = Math.max(SLIDE_SPEED * this.speedMultiplier * this.speedScale, this.horizontalSpeed);
      this.velocity.x = dir.x * speed;
      this.velocity.z = dir.z * speed;
      this.stance = 'slide';
      this.slideLeft = SLIDE_TIME;
      this.slideCooldown = SLIDE_COOLDOWN;
      this.slideStarted = true;
    } else if (held) {
      this.stance = 'crouch';
    }

    if (this.stance === 'crouch' && !held && this.canStand()) this.stance = 'stand';
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  update(dt: number, canMove: boolean): void {
    const k = this.keys;
    const move = canMove && this.enabled;
    const held = (action: Parameters<typeof keyFor>[0]) => (k.has(keyFor(action)) ? 1 : 0);
    this.updateStance(dt, move);
    const stick = move ? this.touchMove : null;
    const forward = stick ? stick.y : move ? held('forward') - held('back') : 0;
    const strafe = stick ? stick.x : move ? held('right') - held('left') : 0;
    // Keys are full speed in any direction; the stick moves slower when pushed less.
    const amount = stick ? Math.min(1, Math.hypot(stick.x, stick.y)) : 1;
    const base = this.crouching
      ? CROUCH_SPEED
      : this.aiming ? AIM_SPEED : move && this.sprintHeld && forward > 0 ? SPRINT_SPEED : WALK_SPEED;
    const speed = base * this.speedMultiplier * this.speedScale;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wish = new THREE.Vector3(
      -sin * forward + cos * strafe,
      0,
      -cos * forward - sin * strafe,
    );
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * amount);

    if (this.stance === 'slide') {
      // No steering while sliding: just friction bleeding off the speed.
      const keep = Math.exp(-SLIDE_FRICTION * dt);
      this.velocity.x *= keep;
      this.velocity.z *= keep;
    } else {
      const accel = this.onGround ? 14 : 2.5;
      const t = 1 - Math.exp(-accel * dt);
      this.velocity.x += (wish.x - this.velocity.x) * t;
      this.velocity.z += (wish.z - this.velocity.z) * t;
    }

    if (move && this.onGround && (held('jump') || this.touchJump) && (this.stance === 'slide' || this.canStand())) {
      // Jumping out of a slide keeps its momentum.
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
      this.stance = 'stand';
    }
    this.velocity.y -= GRAVITY * this.gravityScale * dt;
    this.collide(dt);

    // A safety net under the map: never sink through the ground (the physics keeps us on it).
    const floor = this.terrainAt(this.position.x, this.position.z);
    if (this.position.y < floor - 0.3) {
      this.position.y = floor;
      this.velocity.y = 0;
      this.onGround = true;
    }

    // Ease the eyes down and back up rather than snapping.
    const eye = this.stance === 'slide' ? SLIDE_EYE : this.stance === 'crouch' ? CROUCH_EYE : EYE_HEIGHT;
    const ease = 1 - Math.exp(-14 * dt);
    this.eyeHeight += (eye - this.eyeHeight) * ease;
    this.tilt += ((this.stance === 'slide' ? SLIDE_TILT : 0) - this.tilt) * ease;
    this.syncCamera();
  }

  private syncCamera(): void {
    this.camera.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, this.tilt);
  }

  /**
   * Move by this frame's velocity, letting the character controller slide us along walls, up
   * steps and ramps. Velocity loses whatever the world blocked, as before: a wall stops you,
   * a ceiling ends a jump, the floor stops the fall.
   */
  private collide(dt: number): void {
    const b = this.body;
    const v = this.velocity;
    if (!b) {
      this.position.addScaledVector(v, dt);
      this.onGround = false;
      return;
    }
    this.placeBody();
    const want = { x: v.x * dt, y: v.y * dt, z: v.z * dt };
    b.controller.computeColliderMovement(b.collider, want, undefined, groups(GROUP.PLAYER, GROUP.WORLD));
    const moved = b.controller.computedMovement();
    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.onGround = b.controller.computedGrounded();

    // Lose the velocity going into what we hit: a wall stops that direction (we slide along it),
    // a ceiling ends the jump. Floors, slopes and step edges cost nothing; the controller climbs them.
    // (Stepping up onto a ledge touches its face too: a frame that lifted us isn't a wall.)
    const steppedUp = moved.y > want.y + 1e-3;
    for (let i = 0, n = b.controller.numComputedCollisions(); i < n; i++) {
      const hit = b.controller.computedCollision(i, b.hit);
      if (!hit) continue;
      const { x, y, z } = hit.normal1;
      if (y < -0.7) {
        if (v.y > 0) v.y = 0;
      } else if (Math.abs(y) < 0.3 && !steppedUp) {
        // Only if it actually held us back: stepping up onto a ledge touches its face too.
        const wanted = want.x * x + want.z * z;
        const got = moved.x * x + moved.z * z;
        const into = v.x * x + v.z * z;
        if (into < 0 && got > wanted * 0.5) {
          v.x -= x * into;
          v.z -= z * into;
        }
      }
    }
    if (this.onGround && v.y < 0) v.y = 0;
    this.placeBody();
  }
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** Half the straight middle of a capsule `height` tall (Rapier capsules are measured that way). */
function capsuleHalf(height: number): number {
  return Math.max(0.01, height / 2 - RADIUS);
}
