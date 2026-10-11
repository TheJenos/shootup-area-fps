/*
 * Timed snapshots of another player's pose, and the pose to draw between them.
 *
 * Poses arrive about 15 times a second, each stamped with the server time it was taken at (see
 * `t` on PlayerState). Drawing them a little behind that clock (RENDER_DELAY) means there is nearly
 * always a snapshot either side of the moment being drawn, so the avatar moves along the line
 * between them instead of chasing the latest one: a steady walk looks steady, however unevenly the
 * updates come in. Past the newest snapshot the pose is carried on at its last speed for a short
 * while (a late packet), then held still (they stopped, or stopped sending).
 *
 * Pure numbers, no three.js, so it can be tested on its own.
 */

export interface PoseSnap {
  /** Server ms */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** How far behind the server clock remote players are drawn (ms): one send interval plus the usual jitter */
export const RENDER_DELAY = 120;
/** How long a pose is carried on past the newest snapshot before it's held still (ms) */
export const EXTRAPOLATE_MAX = 100;
/** Snapshots kept: enough to have both neighbours of the render time with a couple of late ones */
const KEEP = 4;

export type Sampled = 'interp' | 'extrap' | 'hold' | 'empty';

const TAU = Math.PI * 2;

/** Shortest turn from `a` to `b` (radians, -π..π) */
export function yawDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** `out` = the pose `k` of the way from `a` to `b` (yaw by the shortest turn). `k` may go past 1 to extrapolate. */
export function lerpPose(a: PoseSnap, b: PoseSnap, k: number, out: PoseSnap): PoseSnap {
  out.t = a.t + (b.t - a.t) * k;
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  out.yaw = a.yaw + yawDelta(a.yaw, b.yaw) * k;
  out.pitch = a.pitch + (b.pitch - a.pitch) * k;
  return out;
}

const copy = (from: PoseSnap, to: PoseSnap): PoseSnap => {
  to.t = from.t;
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.yaw = from.yaw;
  to.pitch = from.pitch;
  return to;
};

export class PoseBuffer {
  private readonly snaps: PoseSnap[] = [];

  get size(): number {
    return this.snaps.length;
  }

  latest(): PoseSnap | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  /** Forget everything (a teleport or respawn: nothing to move between any more). */
  reset(): void {
    this.snaps.length = 0;
  }

  /** Add a snapshot; one with a time already held replaces it, late ones slot into order. */
  push(s: PoseSnap): void {
    const snaps = this.snaps;
    let i = snaps.length;
    while (i > 0 && snaps[i - 1]!.t > s.t) i--;
    if (i > 0 && snaps[i - 1]!.t === s.t) copy(s, snaps[i - 1]!);
    else snaps.splice(i, 0, { ...s });
    if (snaps.length > KEEP) snaps.splice(0, snaps.length - KEEP);
  }

  /**
   * The pose at `renderT` (server ms) into `out`: between the two snapshots around it; carried on
   * past the newest one for up to EXTRAPOLATE_MAX, then held there; held at the oldest one when
   * `renderT` is before it (just joined).
   */
  sample(renderT: number, out: PoseSnap): Sampled {
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return 'empty';
    const first = snaps[0]!;
    const last = snaps[n - 1]!;
    if (renderT <= first.t) {
      copy(first, out);
      return 'hold';
    }
    if (renderT >= last.t) {
      const prev = snaps[n - 2];
      const ahead = renderT - last.t;
      if (!prev || ahead === 0 || ahead > EXTRAPOLATE_MAX || last.t === prev.t) {
        copy(last, out);
        // Carried as far as allowed: from here it stands where it was last seen.
        if (prev && ahead > EXTRAPOLATE_MAX && last.t !== prev.t) lerpPose(prev, last, 1 + EXTRAPOLATE_MAX / (last.t - prev.t), out);
        return 'hold';
      }
      lerpPose(prev, last, 1 + ahead / (last.t - prev.t), out);
      return 'extrap';
    }
    let i = 1;
    while (snaps[i]!.t < renderT) i++;
    const a = snaps[i - 1]!;
    const b = snaps[i]!;
    lerpPose(a, b, (renderT - a.t) / (b.t - a.t), out);
    return 'interp';
  }
}
