/** Distance between footfalls (m); game movement is fast, so strides are long. */
const WALK_STRIDE = 2.3;
const RUN_STRIDE = 2.9;
/** Speeds above this count as sprinting (walk is 6 m/s, sprint 9 m/s) */
export const RUN_FROM = 7.5;
/** Ignore tiny drifts, e.g. interpolation settling */
const MOVING_FROM = 1;
/** Shorter hops than this don't make a landing sound */
const MIN_AIR_TIME = 0.3;

export type StepEvent = { kind: 'step'; running: boolean } | { kind: 'land'; airTime: number };

/** Turns movement into footfalls: one per stride while moving on the ground, plus a thud on landing. */
export class StepTracker {
  private distance = 0;
  private airTime = 0;

  update(dt: number, speed: number, onGround: boolean): StepEvent | null {
    if (!onGround) {
      this.airTime += dt;
      return null;
    }
    const stride = speed > RUN_FROM ? RUN_STRIDE : WALK_STRIDE;
    if (this.airTime > 0) {
      const airTime = this.airTime;
      this.airTime = 0;
      if (airTime >= MIN_AIR_TIME) {
        // The landing counts as a footfall: the next step comes after half a stride.
        this.distance = stride / 2;
        return { kind: 'land', airTime };
      }
    }
    if (speed < MOVING_FROM) {
      // Start the next walk mid-stride, so the first step comes quickly.
      this.distance = stride * 0.6;
      return null;
    }
    this.distance += speed * dt;
    if (this.distance < stride) return null;
    this.distance -= stride;
    return { kind: 'step', running: speed > RUN_FROM };
  }
}
