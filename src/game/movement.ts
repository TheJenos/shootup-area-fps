import * as THREE from 'three';
import { GROUP, groups, type PhysicsWorld, type RapierCollider, type RapierBody } from './physics';
import type { CharacterCollision, KinematicCharacterController, Capsule } from '@dimforge/rapier3d-compat';
import type { Stance } from '../types';
import { EYE_HEIGHT, HEIGHT, MAX_SLOPE, RADIUS, STEP_UP } from './playerDims';

/*
 * Character movement without input devices or a camera: the local player drives it from the
 * keyboard / touch controls, bots and the training simulator drive it from a policy. Same body,
 * same numbers, so a bot moves exactly like a person.
 */

const GRAVITY = 22;
const JUMP_SPEED = 7.6;
const WALK_SPEED = 6;
const SPRINT_SPEED = 9;
const CROUCH_SPEED = 3.2;
const AIM_SPEED = 3.8;
/** Body height while crouching or sliding */
export const CROUCH_HEIGHT = 1.15;
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
/** Walking downhill sticks to the ramp instead of bouncing off it, up to this gap */
const STICK_DOWN = 0.35;
/** Gap the character controller keeps between the body and the world (m) */
export const SKIN = 0.02;
/** What a character's movement runs into: the map and other bodies */
const MOVE_FILTER = groups(GROUP.PLAYER, GROUP.WORLD | GROUP.BODY);
/** A body: something other characters' movement collides with */
export const BODY_GROUPS = groups(GROUP.BODY, GROUP.PLAYER);

/** One step's intent. `forward`/`strafe` are -1..1; with `analog` a smaller push walks slower. */
export interface MoveInput {
  forward: number;
  strafe: number;
  /** A stick (speed follows how far it's pushed) rather than keys (always full speed) */
  analog: boolean;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
}

export const NO_INPUT: MoveInput = { forward: 0, strafe: 0, analog: false, sprint: false, crouch: false, jump: false };

/**
 * Collision is Rapier's kinematic character controller: a capsule that slides along walls, steps
 * up ledges, walks ramps and sticks to the ground going downhill. It collides with the map (and
 * deployed walls) and with other living players' bodies; a second, kinematic capsule follows it to
 * shove loose props around.
 *
 * The capsule the controller moves is also this player's body for everyone else: it's in the BODY
 * group, which other characters' movement collides with (the controller never collides with the
 * collider it's moving).
 */
interface Body {
  physics: PhysicsWorld;
  controller: KinematicCharacterController;
  /** The shape the controller moves (not simulated: it touches nothing by itself) */
  collider: RapierCollider;
  /** Follows the player so loose props get pushed */
  /** Only when it pushes props (the local player): others don't need one */
  pusher: RapierBody | null;
  pusherCollider: RapierCollider | null;
  /** A standing body, for testing whether there's room to stand up */
  standShape: Capsule;
  /** Scratch space for the controller's collision reports */
  hit: CharacterCollision;
}

/** A body that walks, sprints, crouches, slides and jumps through the map (Rapier). */
export class Mover {
  /** Feet position */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  onGround = false;
  stance: Stance = 'stand';
  /** Scales walk/sprint speed (Speed Boost ability) */
  speedMultiplier = 1;
  /** The mode's movement speed and gravity (custom mode rules) */
  speedScale = 1;
  gravityScale = 1;
  /** Set for one step when a slide starts (for the sound) */
  slideStarted = false;
  /** Aiming down sights: slower, no sprinting or sliding */
  aiming = false;
  /** Eye height above the feet, eased between stances */
  eyeHeight = EYE_HEIGHT;
  /** Camera roll (sliding) */
  tilt = 0;

  private body: Body | null = null;
  /** Whether others bump into us (living players); the dead and spectators are walked through */
  private solid = true;
  /** Height of the map's ground at (x, z), for the safety net under it */
  private terrainAt: (x: number, z: number) => number = () => 0;
  private slideLeft = 0;
  private slideCooldown = 0;
  private crouchWasHeld = false;

  /** The map changed: its ground, for the safety net under it. */
  setTerrain(terrainAt: (x: number, z: number) => number): void {
    this.terrainAt = terrainAt;
  }

  /**
   * Give the body a collider in the physics world (once it has loaded). Until then it can't collide.
   * `pushProps`: also shove loose props around (the local player; bots don't bother).
   */
  attachPhysics(physics: PhysicsWorld, pushProps = true): void {
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
    const collider = world.createCollider(R.ColliderDesc.capsule(half, RADIUS).setCollisionGroups(BODY_GROUPS));
    collider.setEnabled(this.solid);
    const pusher = pushProps ? world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased()) : null;
    const pusherCollider = pusher
      ? world.createCollider(R.ColliderDesc.capsule(half, RADIUS).setCollisionGroups(groups(GROUP.PLAYER, GROUP.DEBRIS)), pusher)
      : null;
    this.body = { physics, controller, collider, pusher, pusherCollider, standShape: new R.Capsule(half, RADIUS - 0.02), hit: new R.CharacterCollision() };
    this.placeBody(true);
  }

  /** Living players are solid to others; the dead and spectators aren't. */
  setSolid(solid: boolean): void {
    if (solid === this.solid) return;
    this.solid = solid;
    const b = this.body;
    if (b && !b.physics.disposed) b.collider.setEnabled(solid);
  }

  detachPhysics(): void {
    const b = this.body;
    if (!b) return;
    this.body = null;
    if (b.physics.disposed) return;
    b.physics.world.removeCharacterController(b.controller);
    b.physics.world.removeCollider(b.collider, false);
    if (b.pusher) b.physics.world.removeRigidBody(b.pusher);
  }

  teleport(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.stance = 'stand';
    this.slideLeft = 0;
    this.eyeHeight = EYE_HEIGHT;
    this.tilt = 0;
    this.placeBody(true);
  }

  /** Launch horizontally toward `yaw` with a small hop, so air control carries it further. */
  dash(yaw: number, speed: number): void {
    this.velocity.x = -Math.sin(yaw) * speed;
    this.velocity.z = -Math.cos(yaw) * speed;
    this.velocity.y = Math.max(this.velocity.y, 3.5);
    this.onGround = false;
  }

  get crouching(): boolean {
    return this.stance !== 'stand';
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
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
      b.pusherCollider?.setHalfHeight(half);
    }
    const p = this.position;
    const center = { x: p.x, y: p.y + SKIN + h / 2, z: p.z };
    b.collider.setTranslation(center);
    if (teleport) b.pusher?.setTranslation(center, true);
    else b.pusher?.setNextKinematicTranslation(center);
  }

  /**
   * Holding crouch crouches. Pressing it while sprinting on the ground slides instead:
   * a burst of speed in the direction you're moving that bleeds off into a crouch.
   */
  private updateStance(dt: number, held: boolean, sprintHeld: boolean): void {
    this.slideStarted = false;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    const pressed = held && !this.crouchWasHeld;
    this.crouchWasHeld = held;

    if (this.stance === 'slide') {
      this.slideLeft -= dt;
      const slow = this.horizontalSpeed < CROUCH_SPEED + 0.5;
      if (this.slideLeft <= 0 || slow) this.stance = 'crouch';
    } else if (
      pressed && this.onGround && sprintHeld && this.slideCooldown <= 0
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

  /** Advance `dt` seconds facing `yaw`. `input` null: no control (still falls and collides). */
  step(dt: number, yaw: number, input: MoveInput | null): void {
    const move = input !== null;
    const sprintHeld = move && !this.aiming && input.sprint;
    this.updateStance(dt, move && input.crouch, sprintHeld);
    const forward = move ? input.forward : 0;
    const strafe = move ? input.strafe : 0;
    // Keys are full speed in any direction; the stick moves slower when pushed less.
    const amount = move && input.analog ? Math.min(1, Math.hypot(strafe, forward)) : 1;
    const base = this.crouching
      ? CROUCH_SPEED
      : this.aiming ? AIM_SPEED : sprintHeld && forward > 0 ? SPRINT_SPEED : WALK_SPEED;
    const speed = base * this.speedMultiplier * this.speedScale;

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
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

    if (move && this.onGround && input.jump && (this.stance === 'slide' || this.canStand())) {
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
  }

  /**
   * Move by this step's velocity, letting the character controller slide us along walls, up
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
    b.controller.computeColliderMovement(b.collider, want, undefined, MOVE_FILTER);
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
export function capsuleHalf(height: number): number {
  return Math.max(0.01, height / 2 - RADIUS);
}
