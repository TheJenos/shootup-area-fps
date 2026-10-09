import { describe, expect, it } from 'vitest';
import { Adam, Mlp, decodeFloats, encodeFloats } from '../nn';
import { Policy, ppoGradient, POLICY_OUT, type BotAction } from '../policy';
import { OBS_SIZE } from '../observe';

/** A seeded random source, so the checks are the same every run */
function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the MLP', () => {
  it('has gradients that match finite differences', () => {
    const rand = lcg(3);
    const net = new Mlp([5, 7, 3], undefined, rand);
    net.scaleOutput(100);
    const n = 4;
    const x = Float32Array.from({ length: n * 5 }, () => rand() * 2 - 1);
    const target = Float32Array.from({ length: n * 3 }, () => rand());
    const loss = () => {
      const y = net.forward(x, n);
      let l = 0;
      for (let i = 0; i < y.length; i++) l += 0.5 * (y[i]! - target[i]!) ** 2;
      return l;
    };
    const y = net.forward(x, n);
    const g = Float32Array.from(y, (v, i) => v - target[i]!);
    net.zeroGrad();
    net.backward(g);
    const eps = 1e-2;
    for (const i of [0, 3, 17, 40, net.params.length - 1]) {
      const keep = net.params[i]!;
      net.params[i] = keep + eps;
      const up = loss();
      net.params[i] = keep - eps;
      const down = loss();
      net.params[i] = keep;
      expect(net.grad[i]!).toBeCloseTo((up - down) / (2 * eps), 2);
    }
  });

  it('learns a small regression with Adam', () => {
    const rand = lcg(7);
    const net = new Mlp([2, 16, 1], undefined, rand);
    const adam = new Adam(net.params.length);
    const n = 64;
    const x = Float32Array.from({ length: n * 2 }, () => rand() * 2 - 1);
    const t = Float32Array.from({ length: n }, (_, i) => Math.sin(x[i * 2]! * 2) * 0.5 + x[i * 2 + 1]! * 0.3);
    let first = 0;
    let last = 0;
    for (let it = 0; it < 600; it++) {
      const y = net.forward(x, n);
      let l = 0;
      const g = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        g[i] = (y[i]! - t[i]!) / n;
        l += (y[i]! - t[i]!) ** 2 / n;
      }
      if (it === 0) first = l;
      last = l;
      net.zeroGrad();
      net.backward(g);
      adam.step(net.params, net.grad, 0.01);
    }
    expect(last).toBeLessThan(first * 0.1);
  });

  it('round-trips weights through text', () => {
    const net = new Mlp([3, 4, 2], undefined, lcg(5));
    const back = Mlp.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect([...back.params]).toEqual([...net.params]);
    const odd = Float32Array.from([1.5, -2.25, 3e-8]);
    expect([...decodeFloats(encodeFloats(odd))]).toEqual([...odd]);
  });
});

describe('the policy', () => {
  it('has a PPO gradient that matches finite differences of the loss', () => {
    const rand = lcg(11);
    const policy = new Policy();
    const out = Float32Array.from({ length: POLICY_OUT }, () => rand() * 2 - 1);
    const action: BotAction = { move: 3, sprint: true, jump: false, crouch: true, fire: true, aimYaw: 0.2, aimPitch: -0.1 };
    const aimRaw = [0.25, -0.1];
    const oldLogp = policy.logProb(out, 0, action, aimRaw) - 0.05;
    const loss = () => {
      const g = new Float32Array(POLICY_OUT);
      const gs = new Float32Array(2);
      const [l, h] = ppoGradient(policy, out, 0, action, aimRaw, oldLogp, 0.7, 0.2, 0.01, g, gs, 1);
      return l - 0.01 * h;
    };
    const g = new Float32Array(POLICY_OUT);
    const gs = new Float32Array(2);
    ppoGradient(policy, out, 0, action, aimRaw, oldLogp, 0.7, 0.2, 0.01, g, gs, 1);
    const eps = 1e-3;
    for (let i = 0; i < POLICY_OUT; i++) {
      const keep = out[i]!;
      out[i] = keep + eps;
      const up = loss();
      out[i] = keep - eps;
      const down = loss();
      out[i] = keep;
      expect(g[i]!).toBeCloseTo((up - down) / (2 * eps), 3);
    }
    for (let d = 0; d < 2; d++) {
      const keep = policy.logStd[d]!;
      policy.logStd[d] = keep + eps;
      const up = loss();
      policy.logStd[d] = keep - eps;
      const down = loss();
      policy.logStd[d] = keep;
      expect(gs[d]!).toBeCloseTo((up - down) / (2 * eps), 3);
    }
  });

  it('samples valid actions and survives a save and load', () => {
    const policy = new Policy();
    const obs = new Float32Array(OBS_SIZE).fill(0.3);
    const { action, logp } = policy.sample(policy.normalize(obs));
    expect(action.move).toBeGreaterThanOrEqual(0);
    expect(action.move).toBeLessThan(9);
    expect(Number.isFinite(logp)).toBe(true);
    const back = Policy.fromJSON(JSON.parse(JSON.stringify(policy.toJSON())));
    const a = policy.sample(policy.normalize(obs), { greedy: true });
    const b = back.sample(back.normalize(obs), { greedy: true });
    expect(b.action).toEqual(a.action);
  });
});

describe('the observation normaliser', () => {
  it("doesn't blow up an input that never changed before, and follows a new distribution", async () => {
    const { ObsNorm } = await import('../policy');
    const norm = new ObsNorm(2);
    // A long history where input 1 is always 0.
    norm.merge(5_000_000, [0.5, 0], [5_000_000 * 0.04, 0]);
    const out = new Float32Array(2);
    norm.normalize([0.5, 0.3], out);
    expect(Math.abs(out[1]!)).toBeLessThanOrEqual(3 + 1e-6);
    // A new stage where it's often 0.3: within a couple of million observations it's centred again.
    for (let i = 0; i < 4; i++) norm.merge(500_000, [0.5, 0.3], [500_000 * 0.04, 500_000 * 0.01]);
    norm.normalize([0.5, 0.3], out);
    expect(Math.abs(out[1]!)).toBeLessThan(1);
  });
});

describe('aim masking', () => {
  it('leaves the aim outputs and their spread alone when the aim model aimed', () => {
    const policy = new Policy();
    const out = Float32Array.from({ length: POLICY_OUT }, (_, i) => Math.sin(i));
    const action: BotAction = { move: 2, sprint: false, jump: true, crouch: false, fire: true, aimYaw: 0.3, aimPitch: 0 };
    const aimRaw = [0.3, 0];
    const g = new Float32Array(POLICY_OUT);
    const gs = new Float32Array(2);
    const oldLogp = policy.logProb(out, 0, action, aimRaw, true) - 0.02;
    ppoGradient(policy, out, 0, action, aimRaw, oldLogp, 1, 0.2, 0.01, g, gs, 1, true);
    expect([...g.slice(POLICY_OUT - 2)]).toEqual([0, 0]);
    expect([...gs]).toEqual([0, 0]);
    // The rest still learns.
    expect(g.slice(0, POLICY_OUT - 2).some((v) => v !== 0)).toBe(true);
  });
});
