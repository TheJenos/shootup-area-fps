import * as THREE from 'three';
import { keyFor, settings } from './settings';
import type { PhysicsWorld } from './physics';
import type { Stance } from '../types';
import { EYE_HEIGHT } from './playerDims';
import { Mover, type MoveInput } from './movement';

export { EYE_HEIGHT };

/** Radians per pixel at sensitivity 1 */
const MOUSE_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

/** First-person controller: WASD + mouse look driving a Mover (movement.ts), and the camera. */
export class LocalPlayer {
  readonly keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  enabled = false;
  /** Scales mouse look (lower while zoomed in) */
  lookScale = 1;
  /** Touch controls: analog stick (x = right, y = forward, each -1..1), and held buttons */
  touchMove: { x: number; y: number } | null = null;
  touchSprint = false;
  touchCrouch = false;
  touchJump = false;

  readonly mover = new Mover();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input: MoveInput = { forward: 0, strafe: 0, analog: false, sprint: false, crouch: false, jump: false };

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

  get position(): THREE.Vector3 { return this.mover.position; }
  get velocity(): THREE.Vector3 { return this.mover.velocity; }
  get onGround(): boolean { return this.mover.onGround; }
  set onGround(v: boolean) { this.mover.onGround = v; }
  get stance(): Stance { return this.mover.stance; }
  set stance(v: Stance) { this.mover.stance = v; }
  get speedMultiplier(): number { return this.mover.speedMultiplier; }
  set speedMultiplier(v: number) { this.mover.speedMultiplier = v; }
  get speedScale(): number { return this.mover.speedScale; }
  set speedScale(v: number) { this.mover.speedScale = v; }
  get gravityScale(): number { return this.mover.gravityScale; }
  set gravityScale(v: number) { this.mover.gravityScale = v; }
  get slideStarted(): boolean { return this.mover.slideStarted; }
  get aiming(): boolean { return this.mover.aiming; }
  set aiming(v: boolean) { this.mover.aiming = v; }
  get crouching(): boolean { return this.mover.crouching; }
  get horizontalSpeed(): number { return this.mover.horizontalSpeed; }

  /** The map changed: its ground, for the safety net under it. */
  setTerrain(terrainAt: (x: number, z: number) => number): void {
    this.mover.setTerrain(terrainAt);
  }

  /** Give the player a body in the physics world (once it has loaded). Until then it can't collide. */
  attachPhysics(physics: PhysicsWorld): void {
    this.mover.attachPhysics(physics);
  }

  detachPhysics(): void {
    this.mover.detachPhysics();
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
    this.mover.teleport(pos);
    this.yaw = yaw;
    this.pitch = 0;
    this.syncCamera();
  }

  /** Launch horizontally in the look direction with a small hop, so air control carries it further. */
  dash(speed: number): void {
    this.mover.dash(this.yaw, speed);
  }

  get sprintHeld(): boolean {
    return !this.aiming && (this.touchSprint || this.keys.has(keyFor('sprint')));
  }

  update(dt: number, canMove: boolean): void {
    const move = canMove && this.enabled;
    const k = this.keys;
    const held = (action: Parameters<typeof keyFor>[0]) => (k.has(keyFor(action)) ? 1 : 0);
    const stick = this.touchMove;
    const input = this.input;
    input.analog = !!stick;
    input.forward = stick ? stick.y : held('forward') - held('back');
    input.strafe = stick ? stick.x : held('right') - held('left');
    input.sprint = this.touchSprint || !!held('sprint');
    input.crouch = this.touchCrouch || !!held('crouch');
    input.jump = this.touchJump || !!held('jump');
    this.mover.step(dt, this.yaw, move ? input : null);
    this.syncCamera();
  }

  private syncCamera(): void {
    const m = this.mover;
    this.camera.position.set(m.position.x, m.position.y + m.eyeHeight, m.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, m.tilt);
  }
}
