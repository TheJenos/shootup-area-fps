import * as THREE from 'three';
import { keyFor, settings } from './settings';
import { overRamp, rampHeightAt, type Ramp } from './ramps';
import type { Stance } from '../types';

const GRAVITY = 22;
const JUMP_SPEED = 7.6;
const WALK_SPEED = 6;
const SPRINT_SPEED = 9;
const CROUCH_SPEED = 3.2;
const AIM_SPEED = 3.8;
const RADIUS = 0.35;
const HEIGHT = 1.75;
const CROUCH_HEIGHT = 1.15;
export const EYE_HEIGHT = 1.6;
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
/** Highest ledge (or ramp side) you can walk straight onto without jumping */
const STEP_UP = 0.7;
/** Walking downhill sticks to the ramp instead of bouncing off it, up to this gap */
const STICK_DOWN = 0.35;

type Axis = 'x' | 'y' | 'z';

/** First-person controller: WASD + mouse look, gravity, jumping and AABB collisions. */
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
  private readonly colliders: THREE.Box3[];
  private readonly ramps: Ramp[];
  private wasOnGround = false;
  private eyeHeight = EYE_HEIGHT;
  private tilt = 0;
  private slideLeft = 0;
  private slideCooldown = 0;
  private crouchWasHeld = false;

  constructor(camera: THREE.PerspectiveCamera, colliders: THREE.Box3[], ramps: Ramp[], signal: AbortSignal) {
    this.camera = camera;
    this.colliders = colliders;
    this.ramps = ramps;
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

  /** Whether our body would fit with its feet at height `y` (nothing overhead there). */
  private headroomAt(y: number): boolean {
    const p = this.position;
    return !this.colliders.some((c) =>
      p.x + RADIUS > c.min.x && p.x - RADIUS < c.max.x &&
      p.z + RADIUS > c.min.z && p.z - RADIUS < c.max.z &&
      y + this.height > c.min.y && y < c.max.y - 1e-3 && c.max.y > y + 1e-3);
  }

  /** Whether there's room above us to stand up (e.g. not under the top of a stack). */
  private canStand(): boolean {
    const p = this.position;
    return !this.colliders.some((c) =>
      p.x + RADIUS > c.min.x && p.x - RADIUS < c.max.x &&
      p.z + RADIUS > c.min.z && p.z - RADIUS < c.max.z &&
      p.y + HEIGHT > c.min.y && p.y + CROUCH_HEIGHT <= c.min.y + 1e-3);
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
      const speed = Math.max(SLIDE_SPEED * this.speedMultiplier, this.horizontalSpeed);
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
    const speed = base * this.speedMultiplier;

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
    this.velocity.y -= GRAVITY * dt;

    this.wasOnGround = this.onGround;
    this.onGround = false;
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveAxis('y', this.velocity.y * dt);
    this.landOnRamps();

    if (this.position.y < 0) {
      this.position.y = 0;
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
   * Ramps: stand on the slope under us. Coming down a slope sticks to it (so running downhill
   * doesn't skip), and we never sink into it.
   */
  private landOnRamps(): void {
    const p = this.position;
    for (const r of this.ramps) {
      if (!overRamp(r, p.x, p.z)) continue;
      const surface = rampHeightAt(r, p.x, p.z);
      const below = surface - p.y;
      const onIt = (below >= 0 && below < STEP_UP + 0.3) || (below < 0 && -below < STICK_DOWN && this.wasOnGround && this.velocity.y <= 0);
      if (!onIt) continue;
      p.y = surface;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    }
  }

  private moveAxis(axis: Axis, amount: number): void {
    if (amount === 0) return;
    const p = this.position;
    const before = p[axis];
    p[axis] += amount;
    if (axis !== 'y') {
      // A ramp's side (or its high end) is a wall unless we're already most of the way up it.
      for (const r of this.ramps) {
        if (!overRamp(r, p.x, p.z, RADIUS)) continue;
        const surface = rampHeightAt(
          r, THREE.MathUtils.clamp(p.x, r.box.min.x, r.box.max.x), THREE.MathUtils.clamp(p.z, r.box.min.z, r.box.max.z),
        );
        if (surface > p.y + STEP_UP && p.y + this.height > r.box.min.y) {
          p[axis] = before;
          this.velocity[axis] = 0;
        }
      }
    }
    for (const c of this.colliders) {
      if (
        p.x + RADIUS > c.min.x && p.x - RADIUS < c.max.x &&
        p.z + RADIUS > c.min.z && p.z - RADIUS < c.max.z &&
        p.y + this.height > c.min.y && p.y < c.max.y
      ) {
        if (axis === 'y') {
          if (amount < 0) {
            p.y = c.max.y;
            this.onGround = true;
          } else {
            p.y = c.min.y - this.height;
          }
          this.velocity.y = 0;
        } else if (this.wasOnGround && c.max.y - p.y <= STEP_UP && this.headroomAt(c.max.y)) {
          // A low ledge (a step, the top of a ramp): walk up onto it.
          p.y = c.max.y;
          this.onGround = true;
        } else {
          p[axis] = amount > 0 ? c.min[axis] - RADIUS - 1e-4 : c.max[axis] + RADIUS + 1e-4;
          this.velocity[axis] = 0;
        }
      }
    }
  }
}
