import * as THREE from 'three';
import { keyFor, settings } from './settings';

const GRAVITY = 22;
const JUMP_SPEED = 7.6;
const WALK_SPEED = 6;
const SPRINT_SPEED = 9;
const RADIUS = 0.35;
const HEIGHT = 1.75;
export const EYE_HEIGHT = 1.6;
/** Radians per pixel at sensitivity 1 */
const MOUSE_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

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

  private readonly camera: THREE.PerspectiveCamera;
  private readonly colliders: THREE.Box3[];

  constructor(camera: THREE.PerspectiveCamera, colliders: THREE.Box3[], signal: AbortSignal) {
    this.camera = camera;
    this.colliders = colliders;
    camera.rotation.order = 'YXZ';

    window.addEventListener('keydown', (e) => this.keys.add(e.code), { signal });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), { signal });
    window.addEventListener('blur', () => this.keys.clear(), { signal });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const { sensitivity, invertY } = settings.get();
      const scale = MOUSE_SENSITIVITY * sensitivity;
      this.look(-e.movementX * scale, -e.movementY * scale * (invertY ? -1 : 1));
    }, { signal });
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keys.clear();
  }

  teleport(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
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
    return this.keys.has(keyFor('sprint'));
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  update(dt: number, canMove: boolean): void {
    const k = this.keys;
    const move = canMove && this.enabled;
    const held = (action: Parameters<typeof keyFor>[0]) => (k.has(keyFor(action)) ? 1 : 0);
    const forward = move ? held('forward') - held('back') : 0;
    const strafe = move ? held('right') - held('left') : 0;
    const speed = (move && this.sprintHeld && forward > 0 ? SPRINT_SPEED : WALK_SPEED) * this.speedMultiplier;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wish = new THREE.Vector3(
      -sin * forward + cos * strafe,
      0,
      -cos * forward - sin * strafe,
    );
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    const accel = this.onGround ? 14 : 2.5;
    const t = 1 - Math.exp(-accel * dt);
    this.velocity.x += (wish.x - this.velocity.x) * t;
    this.velocity.z += (wish.z - this.velocity.z) * t;

    if (move && this.onGround && held('jump')) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;

    this.onGround = false;
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveAxis('y', this.velocity.y * dt);

    if (this.position.y < 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.onGround = true;
    }

    this.syncCamera();
  }

  private syncCamera(): void {
    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private moveAxis(axis: Axis, amount: number): void {
    if (amount === 0) return;
    const p = this.position;
    p[axis] += amount;
    for (const c of this.colliders) {
      if (
        p.x + RADIUS > c.min.x && p.x - RADIUS < c.max.x &&
        p.z + RADIUS > c.min.z && p.z - RADIUS < c.max.z &&
        p.y + HEIGHT > c.min.y && p.y < c.max.y
      ) {
        if (axis === 'y') {
          if (amount < 0) {
            p.y = c.max.y;
            this.onGround = true;
          } else {
            p.y = c.min.y - HEIGHT;
          }
          this.velocity.y = 0;
        } else {
          p[axis] = amount > 0 ? c.min[axis] - RADIUS - 1e-4 : c.max[axis] + RADIUS + 1e-4;
          this.velocity[axis] = 0;
        }
      }
    }
  }
}
