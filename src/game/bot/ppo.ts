import { Adam, Mlp, type MlpJson } from './nn';
import { BUTTONS, POLICY_OUT, Policy, ppoGradient, type BotAction, type PolicyJson } from './policy';
import { OBS_SIZE } from './observe';

/*
 * Proximal Policy Optimisation, in plain TypeScript: experience is gathered as batches of
 * (observation, action, old log-probability, advantage, return), and the policy and value
 * networks are nudged toward actions that did better than expected, a clipped step at a time.
 */

export interface PpoConfig {
  gamma: number;
  lambda: number;
  clip: number;
  entCoef: number;
  vfCoef: number;
  lr: number;
  epochs: number;
  minibatch: number;
  /** Stop an update's epochs early once the policy moved this far (approximate KL) */
  targetKl: number;
  maxGradNorm: number;
}

export const DEFAULT_PPO: PpoConfig = {
  gamma: 0.99,
  lambda: 0.95,
  clip: 0.2,
  // Too little and self-play settles into one rigid way of playing that only beats itself (0.005 did);
  // too much and a new stage's unfamiliar inputs leave it drifting toward random play (0.01 did).
  entCoef: 0.0075,
  vfCoef: 0.5,
  lr: 3e-4,
  epochs: 4,
  minibatch: 1024,
  targetKl: 0.03,
  maxGradNorm: 0.5,
};

/** Experience, one row per decision (all flat arrays). */
export interface Batch {
  n: number;
  /** Normalised observations, n × OBS_SIZE */
  obs: Float32Array;
  move: Uint8Array;
  /** n × 4: sprint, jump, crouch, fire */
  buttons: Uint8Array;
  /** n × 2 */
  aimRaw: Float32Array;
  logp: Float32Array;
  adv: Float32Array;
  ret: Float32Array;
  /** 1 where the aim model aimed (the policy's aim outputs are left out of that row) */
  aimMask: Uint8Array;
}

export function emptyBatch(n: number): Batch {
  return {
    n,
    obs: new Float32Array(n * OBS_SIZE),
    move: new Uint8Array(n),
    buttons: new Uint8Array(n * BUTTONS.length),
    aimRaw: new Float32Array(n * 2),
    logp: new Float32Array(n),
    adv: new Float32Array(n),
    ret: new Float32Array(n),
    aimMask: new Uint8Array(n),
  };
}

export function concatBatches(parts: readonly Batch[]): Batch {
  const out = emptyBatch(parts.reduce((s, b) => s + b.n, 0));
  let o = 0;
  for (const b of parts) {
    out.obs.set(b.obs.subarray(0, b.n * OBS_SIZE), o * OBS_SIZE);
    out.move.set(b.move.subarray(0, b.n), o);
    out.buttons.set(b.buttons.subarray(0, b.n * BUTTONS.length), o * BUTTONS.length);
    out.aimRaw.set(b.aimRaw.subarray(0, b.n * 2), o * 2);
    out.logp.set(b.logp.subarray(0, b.n), o);
    out.adv.set(b.adv.subarray(0, b.n), o);
    out.ret.set(b.ret.subarray(0, b.n), o);
    out.aimMask.set(b.aimMask.subarray(0, b.n), o);
    o += b.n;
  }
  return out;
}

/**
 * One agent's run of decisions, kept until it ends (or is cut off) and then turned into batch
 * rows with generalised advantage estimates.
 */
export class Trajectory {
  readonly obs: Float32Array[] = [];
  readonly actions: BotAction[] = [];
  readonly aimRaw: [number, number][] = [];
  readonly logp: number[] = [];
  readonly values: number[] = [];
  readonly rewards: number[] = [];
  readonly aimMasked: boolean[] = [];

  get length(): number {
    return this.rewards.length;
  }

  push(obs: Float32Array, action: BotAction, aimRaw: [number, number], logp: number, value: number, aimMasked = false): void {
    this.aimMasked.push(aimMasked);
    this.obs.push(Float32Array.from(obs));
    this.actions.push(action);
    this.aimRaw.push(aimRaw);
    this.logp.push(logp);
    this.values.push(value);
    this.rewards.push(0);
  }

  /** Reward for the last decision (arrives after it's been acted on) */
  reward(r: number): void {
    if (this.rewards.length) this.rewards[this.rewards.length - 1]! += r;
  }

  /**
   * Write the rows into `batch` at `at` and clear. `bootstrap`: the value of the state after the
   * last decision (0 if the episode ended there).
   */
  flush(batch: Batch, at: number, bootstrap: number, cfg: Pick<PpoConfig, 'gamma' | 'lambda'>): number {
    const n = this.length;
    let next = bootstrap;
    let gae = 0;
    for (let i = n - 1; i >= 0; i--) {
      const delta = this.rewards[i]! + cfg.gamma * next - this.values[i]!;
      gae = delta + cfg.gamma * cfg.lambda * gae;
      batch.adv[at + i] = gae;
      batch.ret[at + i] = gae + this.values[i]!;
      next = this.values[i]!;
    }
    for (let i = 0; i < n; i++) {
      const row = at + i;
      const a = this.actions[i]!;
      batch.obs.set(this.obs[i]!, row * OBS_SIZE);
      batch.move[row] = a.move;
      batch.buttons[row * 4] = a.sprint ? 1 : 0;
      batch.buttons[row * 4 + 1] = a.jump ? 1 : 0;
      batch.buttons[row * 4 + 2] = a.crouch ? 1 : 0;
      batch.buttons[row * 4 + 3] = a.fire ? 1 : 0;
      batch.aimRaw[row * 2] = this.aimRaw[i]![0];
      batch.aimRaw[row * 2 + 1] = this.aimRaw[i]![1];
      batch.logp[row] = this.logp[i]!;
      batch.aimMask[row] = this.aimMasked[i] ? 1 : 0;
    }
    this.obs.length = this.actions.length = this.aimRaw.length = this.logp.length = this.values.length = this.rewards.length = 0;
    this.aimMasked.length = 0;
    return n;
  }
}

export interface UpdateStats {
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  approxKl: number;
  clipFrac: number;
  epochs: number;
}

/** Summed gradients (already divided by the minibatch size) and loss totals over some rows */
export interface Gradients {
  policy: Float32Array;
  logStd: Float32Array;
  value: Float32Array;
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  clipped: number;
  /** Sum of (old log-prob - new log-prob) */
  kl: number;
  rows: number;
}

/**
 * Gradients of the PPO loss over `rows` of the batch, each weighted 1 / `minibatch` (so shards of
 * one minibatch, computed anywhere, add up to its mean). `adv` is the normalised advantage.
 */
export function computeGradients(
  policy: Policy, value: Mlp, batch: Batch, adv: Float32Array, rows: ArrayLike<number>, minibatch: number,
  cfg: Pick<PpoConfig, 'clip' | 'entCoef' | 'vfCoef'>,
): Gradients {
  const n = rows.length;
  const obs = new Float32Array(n * OBS_SIZE);
  for (let j = 0; j < n; j++) obs.set(batch.obs.subarray(rows[j]! * OBS_SIZE, (rows[j]! + 1) * OBS_SIZE), j * OBS_SIZE);
  const scale = 1 / minibatch;
  const g: Gradients = {
    policy: policy.net.grad, logStd: new Float32Array(policy.logStd.length), value: value.grad,
    policyLoss: 0, valueLoss: 0, entropy: 0, clipped: 0, kl: 0, rows: n,
  };

  const out = policy.net.forward(obs, n);
  const gOut = new Float32Array(n * POLICY_OUT);
  const action: BotAction = { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 };
  const aim = [0, 0];
  for (let j = 0; j < n; j++) {
    const row = rows[j]!;
    action.move = batch.move[row]!;
    action.sprint = batch.buttons[row * 4] === 1;
    action.jump = batch.buttons[row * 4 + 1] === 1;
    action.crouch = batch.buttons[row * 4 + 2] === 1;
    action.fire = batch.buttons[row * 4 + 3] === 1;
    aim[0] = batch.aimRaw[row * 2]!;
    aim[1] = batch.aimRaw[row * 2 + 1]!;
    const masked = batch.aimMask[row] === 1;
    g.kl += batch.logp[row]! - policy.logProb(out, j * POLICY_OUT, action, aim, masked);
    const [l, h, c] = ppoGradient(policy, out, j * POLICY_OUT, action, aim, batch.logp[row]!, adv[row]!, cfg.clip, cfg.entCoef, gOut, g.logStd, scale, masked);
    g.policyLoss += l;
    g.entropy += h;
    if (c) g.clipped++;
  }
  policy.net.zeroGrad();
  policy.net.backward(gOut);

  const v = value.forward(obs, n);
  const gValue = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const err = v[j]! - batch.ret[rows[j]!]!;
    g.valueLoss += 0.5 * err * err;
    gValue[j] = cfg.vfCoef * err * scale;
  }
  value.zeroGrad();
  value.backward(gValue);
  return g;
}

/** Computes one minibatch's gradients, possibly split over threads. */
export type GradientFn = (rows: Int32Array, minibatch: number) => Promise<Gradients>;

export interface TrainerJson {
  policy: PolicyJson;
  value: MlpJson;
}

/** The policy and value networks with their optimisers. */
export class PpoTrainer {
  readonly policy: Policy;
  readonly value: Mlp;
  private readonly adamPolicy: Adam;
  private readonly adamStd: Adam;
  private readonly adamValue: Adam;

  constructor(policy?: Policy, value?: Mlp, readonly cfg: PpoConfig = DEFAULT_PPO) {
    this.policy = policy ?? new Policy();
    if (value) {
      this.value = value;
    } else {
      this.value = new Mlp([OBS_SIZE, 128, 128, 1]);
      this.value.scaleOutput(100);
    }
    this.adamPolicy = new Adam(this.policy.net.params.length);
    this.adamStd = new Adam(this.policy.logStd.length);
    this.adamValue = new Adam(this.value.params.length);
  }

  /** Expected return from an already-normalised observation */
  valueOf(obs: Float32Array): number {
    return this.value.run(obs)[0]!;
  }

  /** Advantages normalised to zero mean and unit spread */
  static normalizedAdvantages(batch: Batch): Float32Array {
    const n = batch.n;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += batch.adv[i]!;
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (batch.adv[i]! - mean) ** 2;
    const std = Math.sqrt(variance / n) + 1e-8;
    return Float32Array.from(batch.adv.subarray(0, n), (a) => (a - mean) / std);
  }

  /**
   * Train on a batch: a few epochs of shuffled minibatches. `gradients` computes a minibatch's
   * gradients for the current weights (by default right here, on this thread).
   */
  async update(batch: Batch, lr = this.cfg.lr, rand: () => number = Math.random, gradients?: GradientFn): Promise<UpdateStats> {
    const { cfg, policy } = this;
    const n = batch.n;
    const adv = PpoTrainer.normalizedAdvantages(batch);
    const compute: GradientFn = gradients ?? (async (rows, mb) => computeGradients(policy, this.value, batch, adv, rows, mb, cfg));
    const order = Int32Array.from({ length: n }, (_, i) => i);
    const mb = Math.min(cfg.minibatch, n);
    const stats: UpdateStats = { policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipFrac: 0, epochs: 0 };
    let counted = 0;

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
      shuffle(order, rand);
      let kl = 0;
      let klRows = 0;
      for (let start = 0; start + mb <= n; start += mb) {
        const g = await compute(order.subarray(start, start + mb), mb);
        this.adamPolicy.step(policy.net.params, g.policy, lr, cfg.maxGradNorm);
        this.adamStd.step(policy.logStd, g.logStd, lr);
        for (let d = 0; d < policy.logStd.length; d++) policy.logStd[d] = Math.max(-3, Math.min(0.5, policy.logStd[d]!));
        this.adamValue.step(this.value.params, g.value, lr, cfg.maxGradNorm);
        stats.policyLoss += g.policyLoss / g.rows;
        stats.valueLoss += g.valueLoss / g.rows;
        stats.entropy += g.entropy / g.rows;
        stats.clipFrac += g.clipped / g.rows;
        kl += g.kl;
        klRows += g.rows;
        counted++;
      }
      stats.epochs = epoch + 1;
      stats.approxKl = klRows ? kl / klRows : 0;
      if (stats.approxKl > cfg.targetKl) break;
    }
    if (counted) {
      stats.policyLoss /= counted;
      stats.valueLoss /= counted;
      stats.entropy /= counted;
      stats.clipFrac /= counted;
    }
    return stats;
  }

  toJSON(): TrainerJson {
    return { policy: this.policy.toJSON(), value: this.value.toJSON() };
  }

  static fromJSON(j: TrainerJson, cfg: PpoConfig = DEFAULT_PPO): PpoTrainer {
    return new PpoTrainer(Policy.fromJSON(j.policy), Mlp.fromJSON(j.value), cfg);
  }
}

function shuffle(a: Int32Array, rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
}
