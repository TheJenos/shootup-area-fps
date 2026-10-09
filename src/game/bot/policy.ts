import { Mlp, decodeFloats, encodeFloats, type MlpJson } from './nn';
import { OBS_SIZE, OBS_VERSION } from './observe';

/*
 * The bot's brain: observation → action distribution (the policy) and observation → expected
 * return (the value, only needed while training). Decisions are made 10 times a second.
 *
 * Actions:
 *   move    categorical over 9: stand still, or one of 8 directions relative to where it faces
 *   buttons independent Bernoullis: sprint, jump, crouch, fire
 *   aim     2 Gaussians: turn (yaw) and look up/down (pitch), as a fraction of the most per decision
 */

export const MOVE_DIRS = 9;
export const BUTTONS = ['sprint', 'jump', 'crouch', 'fire'] as const;
export const AIM_DIMS = 2;
/** Policy outputs: move logits, button logits, aim means */
export const POLICY_OUT = MOVE_DIRS + BUTTONS.length + AIM_DIMS;
const AIM_OFFSET = MOVE_DIRS + BUTTONS.length;
/** Most turn per decision (radians) at |aim| = 1 */
export const MAX_TURN = { yaw: 0.6, pitch: 0.3 } as const;
/** Seconds between decisions */
export const DECISION_DT = 0.1;
const HIDDEN = [128, 128];
/** Observations the normaliser's statistics remember (older ones fade out) */
const NORM_MEMORY = 1_000_000;
/** Smallest spread an input is scaled by */
const MIN_STD = 0.1;
const LOG_2PI = Math.log(2 * Math.PI);

export interface BotAction {
  /** 0 = none, 1..8 = forward, forward-right, right, back-right, back, back-left, left, forward-left */
  move: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  fire: boolean;
  /** -1..1 (clipped) fractions of MAX_TURN */
  aimYaw: number;
  aimPitch: number;
}

/** Forward / strafe for each move index */
export const MOVE_TABLE: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** A sampled action plus what PPO needs to remember about it */
export interface Sample {
  action: BotAction;
  /** Raw (unclipped) aim samples */
  aimRaw: [number, number];
  logp: number;
}

/** Running mean and variance of observations, so every input arrives at about unit scale. */
export class ObsNorm {
  mean: Float64Array;
  m2: Float64Array;
  count: number;

  constructor(size = OBS_SIZE) {
    this.mean = new Float64Array(size);
    this.m2 = new Float64Array(size).fill(1);
    this.count = 1;
  }

  /**
   * Merge a batch's moments in (Chan et al.); `batchM2` is the sum of squared deviations. The history is
   * capped at NORM_MEMORY observations, so the scale follows what the bot sees now (a new curriculum stage
   * brings inputs it never saw before) instead of being frozen by everything before.
   */
  merge(count: number, batchMean: ArrayLike<number>, batchM2: ArrayLike<number>): void {
    if (count <= 0) return;
    if (this.count > NORM_MEMORY) {
      const keep = NORM_MEMORY / this.count;
      for (let i = 0; i < this.m2.length; i++) this.m2[i]! *= keep;
      this.count = NORM_MEMORY;
    }
    const total = this.count + count;
    for (let i = 0; i < this.mean.length; i++) {
      const delta = batchMean[i]! - this.mean[i]!;
      this.mean[i]! += (delta * count) / total;
      this.m2[i]! += batchM2[i]! + (delta * delta * this.count * count) / total;
    }
    this.count = total;
  }

  normalize(raw: ArrayLike<number>, out: Float32Array, offset = 0): void {
    for (let i = 0; i < this.mean.length; i++) {
      // A floor on the spread: an input that never changed (a teammate, in free-for-all) mustn't blow up
      // to the clip the first time it does.
      const std = Math.max(MIN_STD, Math.sqrt(this.m2[i]! / this.count));
      out[offset + i] = Math.max(-5, Math.min(5, (raw[i]! - this.mean[i]!) / std));
    }
  }

  toJSON(): { count: number; mean: string; m2: string } {
    return { count: this.count, mean: encodeFloats(Float32Array.from(this.mean)), m2: encodeFloats(Float32Array.from(this.m2)) };
  }

  static fromJSON(j: { count: number; mean: string; m2: string }): ObsNorm {
    const n = new ObsNorm();
    n.count = j.count;
    n.mean = Float64Array.from(decodeFloats(j.mean));
    n.m2 = Float64Array.from(decodeFloats(j.m2));
    return n;
  }
}

export interface PolicyJson {
  version: number;
  obsSize: number;
  net: MlpJson;
  logStd: number[];
  norm: ReturnType<ObsNorm['toJSON']>;
}

export interface ActOptions {
  /** Take the most likely action instead of sampling */
  greedy?: boolean;
  /** < 1 sharpens the move and button choices, > 1 makes them more random */
  temperature?: number;
  /** The aim model aims this decision: the aim outputs don't count toward the action's probability */
  maskAim?: boolean;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** log σ(x), stable for large |x| */
const logSigmoid = (x: number) => (x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x)));

export class Policy {
  readonly net: Mlp;
  /** State-independent log standard deviation of the aim Gaussians */
  readonly logStd: Float32Array;
  norm: ObsNorm;
  private readonly normed = new Float32Array(OBS_SIZE);

  constructor(net?: Mlp, logStd?: Float32Array, norm?: ObsNorm) {
    this.net = net ?? new Mlp([OBS_SIZE, ...HIDDEN, POLICY_OUT]);
    this.logStd = logStd ?? new Float32Array(AIM_DIMS).fill(-1.2);
    this.norm = norm ?? new ObsNorm();
  }

  /** Normalise a raw observation (into a scratch array that the next call reuses). */
  normalize(raw: ArrayLike<number>): Float32Array {
    this.norm.normalize(raw, this.normed);
    return this.normed;
  }

  /** Pick an action for an already-normalised observation. */
  sample(obs: Float32Array, opts: ActOptions = {}, rand: () => number = Math.random): Sample {
    const out = this.net.run(obs);
    const temp = opts.temperature ?? 1;
    // Move: softmax over 9.
    let max = -Infinity;
    for (let i = 0; i < MOVE_DIRS; i++) max = Math.max(max, out[i]!);
    const probs = new Array<number>(MOVE_DIRS);
    let sum = 0;
    for (let i = 0; i < MOVE_DIRS; i++) {
      probs[i] = Math.exp((out[i]! - max) / temp);
      sum += probs[i]!;
    }
    let move = 0;
    if (opts.greedy) {
      for (let i = 1; i < MOVE_DIRS; i++) if (probs[i]! > probs[move]!) move = i;
    } else {
      let r = rand() * sum;
      for (move = 0; move < MOVE_DIRS - 1; move++) {
        r -= probs[move]!;
        if (r <= 0) break;
      }
    }
    const buttons = BUTTONS.map((_, b) => {
      const p = sigmoid(out[MOVE_DIRS + b]! / temp);
      return opts.greedy ? p > 0.5 : rand() < p;
    });
    const aimRaw: [number, number] = [0, 0];
    for (let d = 0; d < AIM_DIMS; d++) {
      const mean = out[AIM_OFFSET + d]!;
      aimRaw[d] = opts.greedy ? mean : mean + Math.exp(this.logStd[d]!) * gaussian(rand);
    }
    const action: BotAction = {
      move,
      sprint: buttons[0]!, jump: buttons[1]!, crouch: buttons[2]!, fire: buttons[3]!,
      aimYaw: clip1(aimRaw[0]), aimPitch: clip1(aimRaw[1]),
    };
    return { action, aimRaw, logp: this.logProb(out, 0, action, aimRaw, opts.maskAim) };
  }

  /** Log-probability of an action under the outputs `out` (at `o`); `maskAim`: without the aim part */
  logProb(out: Float32Array, o: number, a: BotAction, aimRaw: readonly number[], maskAim = false): number {
    let max = -Infinity;
    for (let i = 0; i < MOVE_DIRS; i++) max = Math.max(max, out[o + i]!);
    let sum = 0;
    for (let i = 0; i < MOVE_DIRS; i++) sum += Math.exp(out[o + i]! - max);
    let logp = out[o + a.move]! - max - Math.log(sum);
    const pressed = [a.sprint, a.jump, a.crouch, a.fire];
    for (let b = 0; b < BUTTONS.length; b++) {
      const l = out[o + MOVE_DIRS + b]!;
      logp += pressed[b] ? logSigmoid(l) : logSigmoid(-l);
    }
    if (maskAim) return logp;
    for (let d = 0; d < AIM_DIMS; d++) {
      const std = Math.exp(this.logStd[d]!);
      const z = (aimRaw[d]! - out[o + AIM_OFFSET + d]!) / std;
      logp += -0.5 * z * z - this.logStd[d]! - 0.5 * LOG_2PI;
    }
    return logp;
  }

  toJSON(): PolicyJson {
    return { version: OBS_VERSION, obsSize: OBS_SIZE, net: this.net.toJSON(), logStd: [...this.logStd], norm: this.norm.toJSON() };
  }

  static fromJSON(j: PolicyJson): Policy {
    if (j.version !== OBS_VERSION || j.obsSize !== OBS_SIZE) {
      throw new Error(`Policy was trained for observation v${j.version} (${j.obsSize}); this build uses v${OBS_VERSION} (${OBS_SIZE})`);
    }
    return new Policy(Mlp.fromJSON(j.net), Float32Array.from(j.logStd), ObsNorm.fromJSON(j.norm));
  }
}

/**
 * The PPO loss for one sample, and its gradient with respect to the policy outputs (written into
 * `gOut` at `o`) and the aim log-stds (added to `gLogStd`). Returns [loss, entropy, clipped?].
 *
 * loss = -min(r·A, clip(r, 1±ε)·A) - entCoef · entropy, with r = exp(logp - oldLogp)
 */
export function ppoGradient(
  policy: Policy, out: Float32Array, o: number, a: BotAction, aimRaw: readonly number[],
  oldLogp: number, adv: number, clip: number, entCoef: number,
  gOut: Float32Array, gLogStd: Float32Array, scale: number, maskAim = false,
): [loss: number, entropy: number, clipped: boolean] {
  const logp = policy.logProb(out, o, a, aimRaw, maskAim);
  const ratio = Math.exp(logp - oldLogp);
  const unclipped = ratio * adv;
  const clippedObj = Math.max(1 - clip, Math.min(1 + clip, ratio)) * adv;
  const clipped = clippedObj < unclipped;
  const loss = -Math.min(unclipped, clippedObj);
  // dLoss/dlogp: zero where the clipped objective is the smaller one (its ratio is constant there).
  const dLogp = clipped ? 0 : -adv * ratio;

  let entropy = 0;
  // Move head
  let max = -Infinity;
  for (let i = 0; i < MOVE_DIRS; i++) max = Math.max(max, out[o + i]!);
  let sum = 0;
  for (let i = 0; i < MOVE_DIRS; i++) sum += Math.exp(out[o + i]! - max);
  const logZ = max + Math.log(sum);
  let hMove = 0;
  const p = new Array<number>(MOVE_DIRS);
  for (let i = 0; i < MOVE_DIRS; i++) {
    const lp = out[o + i]! - logZ;
    p[i] = Math.exp(lp);
    hMove -= p[i]! * lp;
  }
  entropy += hMove;
  for (let i = 0; i < MOVE_DIRS; i++) {
    const lp = out[o + i]! - logZ;
    // d logp(a)/dz_i = [i = a] - p_i ; d H/dz_i = -p_i (log p_i + H)
    const dlogp = (i === a.move ? 1 : 0) - p[i]!;
    const dH = -p[i]! * (lp + hMove);
    gOut[o + i]! += scale * (dLogp * dlogp - entCoef * dH);
  }
  // Buttons
  const pressed = [a.sprint, a.jump, a.crouch, a.fire];
  for (let b = 0; b < BUTTONS.length; b++) {
    const l = out[o + MOVE_DIRS + b]!;
    const q = sigmoid(l);
    const h = -(q * logSigmoid(l) + (1 - q) * logSigmoid(-l));
    entropy += h;
    const dlogp = (pressed[b] ? 1 : 0) - q;
    const dH = -l * q * (1 - q);
    gOut[o + MOVE_DIRS + b]! += scale * (dLogp * dlogp - entCoef * dH);
  }
  // Aim (not when the aim model aimed: these outputs weren't used)
  for (let d = 0; d < (maskAim ? 0 : AIM_DIMS); d++) {
    const ls = policy.logStd[d]!;
    const std = Math.exp(ls);
    const z = (aimRaw[d]! - out[o + AIM_OFFSET + d]!) / std;
    entropy += ls + 0.5 * (1 + LOG_2PI);
    gOut[o + AIM_OFFSET + d]! += scale * dLogp * (z / std);
    // d logp/d logStd = z² - 1 ; d H/d logStd = 1
    gLogStd[d]! += scale * (dLogp * (z * z - 1) - entCoef);
  }
  return [loss, entropy, clipped];
}

/** A standard normal sample (Box–Muller). */
export function gaussian(rand: () => number = Math.random): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const clip1 = (x: number) => Math.max(-1, Math.min(1, x));
