import { describe, expect, it } from 'vitest';
import { DynamicResolution } from '../dynamicResolution';

/** Run `seconds` of frames, each taking `ms(ratio)`; returns every ratio it switched to, with when (s). */
function run(d: DynamicResolution, seconds: number, ms: number | ((ratio: number) => number), from = 0) {
  const changes: { at: number; ratio: number }[] = [];
  let t = from;
  while (t < from + seconds) {
    const frame = typeof ms === 'number' ? ms : ms(d.ratio);
    t += frame / 1000;
    const r = d.update(frame);
    if (r !== null) changes.push({ at: t, ratio: r });
  }
  return changes;
}

describe('dynamic resolution', () => {
  it('leaves the resolution alone while frames keep up', () => {
    const d = new DynamicResolution({ max: 1.5 });
    expect(run(d, 30, 16.7)).toEqual([]);
    expect(d.ratio).toBe(1.5);
  });

  it('steps down a tenth once frames have been slow for 2 s, and again while they stay slow, down to the floor', () => {
    const d = new DynamicResolution({ max: 1.5, min: 0.6 });
    const first = run(d, 1.8, 30);
    expect(first).toEqual([]);
    const changes = run(d, 60, 30, 1.8);
    expect(changes[0]!.ratio).toBe(1.4);
    expect(changes[0]!.at).toBeLessThan(2.6);
    // Each further step waits for the canvas to settle and for 2 s more of slow frames.
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(3);
    expect(changes.map((c) => c.ratio)).toEqual([1.4, 1.3, 1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6]);
    expect(d.ratio).toBe(0.6);
  });

  it('never goes below the quality setting (a ratio already under the floor stays put)', () => {
    const d = new DynamicResolution({ max: 0.5, min: 0.6 });
    expect(run(d, 30, 40)).toEqual([]);
    expect(d.ratio).toBe(0.5);
  });

  it('steps back up when frames are fast again, up to the quality setting and no further', () => {
    const d = new DynamicResolution({ max: 1.2 });
    run(d, 12, 30);
    expect(d.ratio).toBeLessThan(1.2);
    const changes = run(d, 60, 10, 12);
    expect(changes.every((c, i) => i === 0 || c.ratio > changes[i - 1]!.ratio)).toBe(true);
    expect(d.ratio).toBe(1.2);
  });

  it('counts the screen\'s own rate as fast: a 60 Hz phone gets its pixels back', () => {
    const d = new DynamicResolution({ max: 1.5 });
    run(d, 5, 16.7); // learns the screen's rate
    run(d, 6, 30, 5);
    const down = d.ratio;
    expect(down).toBeLessThan(1.5);
    run(d, 30, 16.7, 11);
    expect(d.ratio).toBe(1.5);
  });

  it('ignores single slow frames and pauses (a hidden tab, a hitch)', () => {
    const d = new DynamicResolution({ max: 1.5 });
    let n = 0;
    expect(run(d, 30, () => (++n % 20 === 0 ? 60 : 16.7))).toEqual([]);
    expect(d.update(5000)).toBeNull();
    expect(d.update(0)).toBeNull();
    expect(run(d, 5, 16.7)).toEqual([]);
    expect(d.ratio).toBe(1.5);
  });

  it("doesn't see-saw when one step up is too much: that level is left alone for a while, longer each time", () => {
    // The GPU keeps up at 0.9 and below, and not above.
    const d = new DynamicResolution({ max: 1.5 });
    const gpu = (ratio: number) => (ratio > 0.9 ? 28 : 16.7);
    const changes = run(d, 300, gpu);
    const ups = changes.filter((c, i) => c.ratio > (i ? changes[i - 1]!.ratio : 1.5));
    // Down to 0.9, then a handful of retries of 1.0 in five minutes, each further apart than the last.
    expect(changes.slice(0, 6).map((c) => c.ratio)).toEqual([1.4, 1.3, 1.2, 1.1, 1, 0.9]);
    expect(ups.length).toBeGreaterThan(0);
    expect(ups.length).toBeLessThanOrEqual(4);
    for (let i = 2; i < ups.length; i++) expect(ups[i]!.at - ups[i - 1]!.at).toBeGreaterThan(ups[i - 1]!.at - ups[i - 2]!.at);
    // Most of the time is spent where the GPU keeps up.
    expect(d.ratio).toBe(0.9);
  });

  it('a step up that holds resets the retry wait', () => {
    const d = new DynamicResolution({ max: 1.5 });
    let heavy = true;
    // Heavy scene first (keeps up at 0.9 only), then light (keeps up everywhere).
    const changes = run(d, 120, (r) => (heavy && r > 0.9 ? 28 : 16.7));
    expect(changes.length).toBeGreaterThan(5);
    heavy = false;
    run(d, 400, (r) => (heavy && r > 0.9 ? 28 : 16.7), 120);
    expect(d.ratio).toBe(1.5);
  });
});
