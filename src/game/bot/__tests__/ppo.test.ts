import { describe, expect, it } from 'vitest';
import { PpoTrainer, Trajectory, emptyBatch, concatBatches, DEFAULT_PPO } from '../ppo';
import { AIM_LOG_STD, MAX_TURN, Policy } from '../policy';
import { OBS_LAYOUT, OBS_SIZE } from '../observe';

function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * A toy task using every action head: turn to face a target (aim), walk the way a signal says
 * (move), and fire only when lined up (buttons).
 */
class AimTask {
  err = 0;
  side = 1;
  t = 0;
  constructor(private readonly rand: () => number) { this.reset(); }
  reset(): void {
    this.err = (this.rand() - 0.5) * 2;
    this.side = this.rand() < 0.5 ? 1 : -1;
    this.t = 0;
  }
  observe(out: Float32Array): Float32Array {
    out.fill(0);
    out[0] = this.side;
    out[OBS_LAYOUT.enemies] = 1;
    out[OBS_LAYOUT.enemies + 5] = this.err / Math.PI;
    return out;
  }
  step(a: { move: number; fire: boolean; aimYaw: number }): [reward: number, done: boolean] {
    const before = Math.abs(this.err);
    this.err -= a.aimYaw * MAX_TURN.yaw;
    let r = (before - Math.abs(this.err)) * 2;
    r += a.move === (this.side > 0 ? 1 : 5) ? 0.2 : 0;
    if (a.fire) r += Math.abs(this.err) < 0.1 ? 0.3 : -0.3;
    this.t++;
    if (this.t % 5 === 0) this.err += (this.rand() - 0.5) * 0.8;
    return [r, this.t >= 30];
  }
}

describe('PPO', () => {
  it('learns to aim, move and fire on a toy task', async () => {
    const rand = lcg(9);
    const trainer = new PpoTrainer(undefined, undefined, { ...DEFAULT_PPO, minibatch: 256, lr: 1e-3, entCoef: 0.001 });
    const task = new AimTask(rand);
    const raw = new Float32Array(OBS_SIZE);
    const evaluate = () => {
      let total = 0;
      const t = new AimTask(lcg(123));
      for (let ep = 0; ep < 10; ep++) {
        t.reset();
        for (let done = false; !done;) {
          const { action } = trainer.policy.sample(trainer.policy.normalize(t.observe(raw)), { greedy: true });
          const [r, d] = t.step(action);
          total += r;
          done = d;
        }
      }
      return total / 10;
    };
    const before = evaluate();
    for (let iter = 0; iter < 20; iter++) {
      const traj = new Trajectory();
      const parts = [];
      for (let ep = 0; ep < 34; ep++) {
        task.reset();
        for (let done = false; !done;) {
          const obs = trainer.policy.normalize(task.observe(raw));
          const s = trainer.policy.sample(obs, {}, rand);
          traj.push(obs, s.action, s.aimRaw, s.logp, trainer.valueOf(obs));
          const [r, d] = task.step(s.action);
          traj.reward(r);
          done = d;
        }
        const b = emptyBatch(traj.length);
        traj.flush(b, 0, 0, trainer.cfg);
        parts.push(b);
      }
      await trainer.update(concatBatches(parts), undefined, rand);
    }
    const after = evaluate();
    expect(after).toBeGreaterThan(before + 5);
    // (Seeded, so it never flakes on the result, but it's CPU-heavy: slow when the whole suite runs at once.)
  }, 120_000);

  it('leaves the aim noise alone when the aim earns nothing (no entropy bonus there)', async () => {
    const rand = lcg(4);
    const trainer = new PpoTrainer(undefined, undefined, { ...DEFAULT_PPO, minibatch: 256 });
    const start = Float32Array.from(trainer.policy.logStd);
    const raw = new Float32Array(OBS_SIZE);
    for (let iter = 0; iter < 6; iter++) {
      const traj = new Trajectory();
      for (let i = 0; i < 1024; i++) {
        raw.fill(0);
        raw[0] = rand() - 0.5;
        const obs = trainer.policy.normalize(raw);
        const s = trainer.policy.sample(obs, {}, rand);
        traj.push(obs, s.action, s.aimRaw, s.logp, trainer.valueOf(obs));
        traj.reward(0);
      }
      const b = emptyBatch(traj.length);
      traj.flush(b, 0, 0, trainer.cfg);
      await trainer.update(b, undefined, rand);
    }
    // With the bonus, every update pushed it up (it drifted to the cap in training).
    for (let d = 0; d < start.length; d++) expect(trainer.policy.logStd[d]).toBeLessThan(start[d]! + 0.05);
  }, 60_000);

  it('caps the aim noise of policies saved before the cap', () => {
    const json = new Policy().toJSON();
    json.logStd = [0.03, 0.5];
    for (const v of Policy.fromJSON(json).logStd) expect(v).toBeCloseTo(AIM_LOG_STD.max, 5);
  });
});
