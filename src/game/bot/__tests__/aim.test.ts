import { describe, expect, it } from 'vitest';
import { AIM_SKILLS, AimController, BOT_SKILLS, type AimCandidate, type AimSelf } from '../aim';
import { aimAngles, wrapAngle, CHEST_Y } from '../hitscan';

function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const self = (yaw = 0, pitch = 0): AimSelf => ({ x: 0, y: 1.6, z: 0, yaw, pitch, speed: 0, gun: 'rifle', shaky: 0 });

/** Aim at a target for `seconds`; returns the error (radians) to its chest at each step and whether on target */
function track(skill: keyof typeof AIM_SKILLS, target: (t: number) => AimCandidate, seconds: number, seed = 3) {
  const aim = new AimController(AIM_SKILLS[skill], lcg(seed));
  const s = self(1.2, 0.2);
  const errors: number[] = [];
  const on: boolean[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const c = target(t);
    const r = aim.update(1 / 60, t, s, [c]);
    s.yaw = r.yaw;
    s.pitch = r.pitch;
    const [ty, tp] = aimAngles(s.x, s.y, s.z, c.x, c.y + CHEST_Y.stand, c.z);
    errors.push(Math.hypot(wrapAngle(ty - s.yaw), tp - s.pitch));
    on.push(aim.onTarget);
  }
  return { errors, on, aim };
}

const still: AimCandidate = { id: 'e', x: 0, y: 0, z: -15, stance: 'stand' };

describe('the aim model', () => {
  it('does nothing while reacting, then settles onto the target', () => {
    const { errors, on } = track('normal', () => still, 2);
    const reactFrames = Math.floor(AIM_SKILLS.normal.reaction * 60) - 1;
    // Still pointing where it was during the reaction time.
    expect(errors[reactFrames]).toBeCloseTo(errors[0]!, 5);
    expect(on.slice(0, reactFrames).some(Boolean)).toBe(false);
    // Settled by the end: on target.
    expect(errors[errors.length - 1]!).toBeLessThan(0.08);
    expect(on.slice(-30).filter(Boolean).length).toBeGreaterThan(20);
  });

  it('gets there faster and closer on harder tiers', () => {
    const settleTime = (skill: keyof typeof AIM_SKILLS) => {
      const { on } = track(skill, () => still, 3, 7);
      return on.indexOf(true) / 60;
    };
    const times = BOT_SKILLS.map(settleTime);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeLessThan(times[i - 1]!);
  });

  it('lags behind someone strafing across its view', () => {
    const strafe = (t: number): AimCandidate => ({ id: 'e', x: -6 + ((t * 7) % 12), y: 0, z: -10, stance: 'stand' });
    const moving = track('hard', strafe, 3).errors.slice(-60);
    const standing = track('hard', () => still, 3).errors.slice(-60);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(moving)).toBeGreaterThan(mean(standing) * 2);
  });

  it('turns no faster than its tier allows', () => {
    const aim = new AimController(AIM_SKILLS.easy, lcg(1));
    const s = self(Math.PI, 0);
    for (let t = 0; t < 1; t += 1 / 60) {
      const before = s.yaw;
      const r = aim.update(1 / 60, t, s, [still]);
      expect(Math.abs(wrapAngle(r.yaw - before))).toBeLessThanOrEqual(AIM_SKILLS.easy.maxTurn / 60 + 1e-9);
      s.yaw = r.yaw;
      s.pitch = r.pitch;
    }
  });

  it('goes for whoever is shooting at it, and for a flag carrier above all', () => {
    const a: AimCandidate = { id: 'a', x: 0, y: 0, z: -5, stance: 'stand' };
    const b: AimCandidate = { id: 'b', x: 5, y: 0, z: -20, stance: 'stand' };
    const aim = new AimController(AIM_SKILLS.hard, lcg(2));
    aim.update(1 / 60, 0, self(), [a, b]);
    expect(aim.target).toBe('a');
    aim.update(1 / 60, 0.1, self(), [a, b], 'b');
    expect(aim.target).toBe('b');
    aim.update(1 / 60, 0.2, self(), [a, { ...b, id: 'c', carrying: true }], null);
    expect(aim.target).toBe('c');
  });

  it('lets go of a target that has been out of sight for a moment', () => {
    const aim = new AimController(AIM_SKILLS.hard, lcg(2));
    aim.update(1 / 60, 0, self(), [still]);
    aim.update(1 / 60, 0.3, self(), []);
    expect(aim.engaged).toBe(true);
    aim.update(1 / 60, 1, self(), []);
    expect(aim.engaged).toBe(false);
  });
});
