import { describe, expect, it } from 'vitest';
import { BotMemory } from '../observe';
import { CALLOUT_DELAY, HEARING_JITTER, callOut, hear } from '../team';

describe('team knowledge', () => {
  it('passes what one bot sees to its teammates, as known but not seen', () => {
    const seer = new BotMemory();
    const mate = new BotMemory();
    seer.seen.set('enemy', { x: 5, y: 0, z: 9, stance: 'stand', t: 10, seenAt: 10 });
    seer.seen.set('old', { x: 1, y: 0, z: 1, stance: 'stand', t: 4, seenAt: 4 });
    callOut(seer, [mate], 10);
    expect(mate.seen.get('enemy')).toMatchObject({ x: 5, z: 9, t: 10 - CALLOUT_DELAY });
    expect(mate.seen.get('enemy')!.seenAt).toBeUndefined();
    expect(mate.inView(10)).toEqual([]);
    // Only what it saw just now gets called out.
    expect(mate.seen.has('old')).toBe(false);
  });

  it("never overwrites fresher knowledge with an older callout", () => {
    const mate = new BotMemory();
    mate.seen.set('enemy', { x: 0, y: 0, z: 0, stance: 'stand', t: 10, seenAt: 10 });
    mate.learn('enemy', 9, 0, 9, 'stand', 9.5);
    expect(mate.seen.get('enemy')).toMatchObject({ x: 0, t: 10 });
  });

  it('hears gunfire close by (roughly where it came from), not far away', () => {
    const m = new BotMemory();
    expect(hear(m, 'shooter', 'rifle', 20, 0, 0, 0, 0, 5)).toBe(true);
    const at = m.seen.get('shooter')!;
    expect(Math.hypot(at.x - 20, at.z)).toBeLessThanOrEqual(HEARING_JITTER + 1e-9);
    const far = new BotMemory();
    expect(hear(far, 'shooter', 'rifle', 50, 0, 0, 0, 0, 5)).toBe(false);
    // A sniper carries further.
    expect(hear(far, 'shooter', 'sniper', 50, 0, 0, 0, 0, 5)).toBe(true);
  });
});
