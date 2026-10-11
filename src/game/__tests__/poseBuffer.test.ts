import { describe, expect, it } from 'vitest';
import { EXTRAPOLATE_MAX, PoseBuffer, lerpPose, yawDelta, type PoseSnap } from '../poseBuffer';

const snap = (t: number, x: number, yaw = 0): PoseSnap => ({ t, x, y: 0, z: 0, yaw, pitch: 0 });
const out = (): PoseSnap => snap(0, 0);

describe('pose buffer', () => {
  it('is empty until something arrives, then holds the oldest pose for times before it', () => {
    const b = new PoseBuffer();
    const o = out();
    expect(b.sample(100, o)).toBe('empty');
    b.push(snap(1000, 5));
    expect(b.sample(900, o)).toBe('hold');
    expect(o.x).toBe(5);
  });

  it('moves along the line between the snapshots around the render time', () => {
    const b = new PoseBuffer();
    b.push(snap(1000, 0));
    b.push(snap(1100, 10));
    const o = out();
    expect(b.sample(1025, o)).toBe('interp');
    expect(o.x).toBeCloseTo(2.5);
    expect(b.sample(1100, o)).toBe('hold'); // exactly at the newest, nothing further to carry on from... yet
    expect(o.x).toBe(10);
  });

  it('carries the pose on at its last speed for a short while past the newest snapshot, then holds', () => {
    const b = new PoseBuffer();
    b.push(snap(1000, 0));
    b.push(snap(1100, 10)); // 0.1 m/ms
    const o = out();
    expect(b.sample(1150, o)).toBe('extrap');
    expect(o.x).toBeCloseTo(15);
    expect(b.sample(1100 + EXTRAPOLATE_MAX + 500, o)).toBe('hold');
    expect(o.x).toBeCloseTo(10 + EXTRAPOLATE_MAX * 0.1);
  });

  it('keeps only the newest few, replaces a repeated time and slots late ones into order', () => {
    const b = new PoseBuffer();
    for (let i = 0; i < 10; i++) b.push(snap(1000 + i * 100, i));
    expect(b.size).toBe(4);
    expect(b.latest()?.t).toBe(1900);
    b.push(snap(1900, 99));
    expect(b.size).toBe(4);
    expect(b.latest()?.x).toBe(99);
    b.push(snap(1750, 7.5));
    const o = out();
    expect(b.sample(1750, o)).toBe('interp');
    expect(o.x).toBeCloseTo(7.5);
  });

  it('forgets everything on reset', () => {
    const b = new PoseBuffer();
    b.push(snap(1000, 0));
    b.reset();
    expect(b.sample(1000, out())).toBe('empty');
  });

  it('turns the short way round between yaws', () => {
    expect(yawDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2);
    const o = lerpPose(snap(0, 0, 0.1), snap(100, 0, Math.PI * 2 - 0.1), 0.5, out());
    expect(o.yaw).toBeCloseTo(0);
  });
});
