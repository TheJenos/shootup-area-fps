/*
 * Dynamic resolution for phones: when frames come too slowly for a while, draw fewer pixels (the
 * renderer's pixel ratio, a tenth at a time, down to a floor); when they come quickly again for a
 * while, step back up toward what the quality setting asks for.
 *
 * "Quickly" is under 12 ms, or at the screen's own rate: a 60 Hz phone never delivers frames faster
 * than 16.7 ms, and would otherwise never get its pixels back. That's also how it could see-saw (a
 * step up that's too much for the GPU is stepped back down a few seconds later, and up again), so a
 * step up that fails puts that level off limits for a while, twice as long each time it fails again.
 *
 * Pure: fed frame times, it says when to change the ratio. game.ts applies it.
 */

export interface DynamicResolutionOptions {
  /** The quality setting's pixel ratio: never above it */
  max: number;
  /** Never below this (or `max`, if that's lower) */
  min?: number;
  step?: number;
  /** Smoothed frame time (ms) that counts as slow, and as fast */
  slowMs?: number;
  fastMs?: number;
  /** How long (s) frames must stay slow before a step down, and fast before a step up */
  downAfter?: number;
  upAfter?: number;
  /** After a change, measuring waits this long (s): resizing the canvas costs a frame or two */
  settle?: number;
  /** A step up followed this soon (s) by a step down failed */
  failWindow?: number;
  /** How long (s) a failed level is off limits the first time, and at most */
  ban?: number;
  maxBan?: number;
}

/** Longer frames than this (ms) are a pause (a hidden tab, a hitch), not the steady rate: ignored */
const PAUSE_MS = 250;
/** Weight of each new frame in the smoothed frame time */
const SMOOTH = 0.1;
/** Within this factor of the screen's own frame time counts as fast */
const REFRESH_SLACK = 1.15;

const round = (x: number) => Math.round(x * 100) / 100;

export class DynamicResolution {
  /** The pixel ratio to draw at now */
  ratio: number;
  private readonly max: number;
  private readonly min: number;
  private readonly step: number;
  private readonly slowMs: number;
  private readonly fastMs: number;
  private readonly downAfter: number;
  private readonly upAfter: number;
  private readonly settle: number;
  private readonly failWindow: number;
  private readonly ban: number;
  private readonly maxBan: number;

  /** Seconds of (unpaused) frames seen */
  private clock = 0;
  /** Smoothed frame time (ms); 0 before the first frame */
  private avg = 0;
  /** The screen's frame time (ms), as the best the smoothed frame time has been */
  private refresh = Infinity;
  private slowFor = 0;
  private fastFor = 0;
  private settleFor = 0;
  /** When the last step up happened (clock s), while it could still turn out to be too much */
  private upAt: number | null = null;
  /** Ratios above this are off limits until `bannedUntil` */
  private bannedAbove = Infinity;
  private bannedUntil = 0;
  private banLength: number;

  constructor(opts: DynamicResolutionOptions) {
    this.max = opts.max;
    this.min = Math.min(opts.min ?? 0.6, opts.max);
    this.step = opts.step ?? 0.1;
    this.slowMs = opts.slowMs ?? 20;
    this.fastMs = opts.fastMs ?? 12;
    this.downAfter = opts.downAfter ?? 2;
    this.upAfter = opts.upAfter ?? 3;
    this.settle = opts.settle ?? 1;
    this.failWindow = opts.failWindow ?? 10;
    this.ban = opts.ban ?? 20;
    this.maxBan = opts.maxBan ?? 160;
    this.banLength = this.ban;
    this.ratio = opts.max;
  }

  /** One frame took `frameMs` (from the last one's start to this one's). Returns the new ratio when it changes, else null. */
  update(frameMs: number): number | null {
    if (!(frameMs > 0) || frameMs > PAUSE_MS) return null;
    const s = frameMs / 1000;
    this.clock += s;
    this.avg = this.avg ? this.avg + (frameMs - this.avg) * SMOOTH : frameMs;
    this.refresh = Math.min(this.refresh, this.avg);
    // A step up that has held long enough worked: the next failure starts the ban over from the shortest.
    if (this.upAt !== null && this.clock - this.upAt > this.failWindow) {
      this.upAt = null;
      this.banLength = this.ban;
    }
    if (this.settleFor > 0) {
      this.settleFor -= s;
      return null;
    }
    const fast = Math.max(this.fastMs, Math.min(this.refresh * REFRESH_SLACK, this.slowMs * 0.9));
    this.slowFor = this.avg > this.slowMs ? this.slowFor + s : 0;
    this.fastFor = this.avg < fast ? this.fastFor + s : 0;

    if (this.slowFor >= this.downAfter && this.ratio > this.min) {
      if (this.upAt !== null) {
        // Straight back down after going up: that level is too much, for now.
        this.bannedAbove = round(this.ratio - this.step);
        this.bannedUntil = this.clock + this.banLength;
        this.banLength = Math.min(this.maxBan, this.banLength * 2);
        this.upAt = null;
      }
      return this.change(Math.max(this.min, round(this.ratio - this.step)));
    }
    if (this.fastFor >= this.upAfter && this.ratio < this.max) {
      const next = Math.min(this.max, round(this.ratio + this.step));
      if (next > this.bannedAbove && this.clock < this.bannedUntil) return null;
      this.upAt = this.clock;
      return this.change(next);
    }
    return null;
  }

  private change(ratio: number): number {
    this.ratio = ratio;
    this.slowFor = 0;
    this.fastFor = 0;
    this.settleFor = this.settle;
    return ratio;
  }
}
