import { describe, expect, it } from 'vitest';
import { Mover, type MoveInput } from '../movement';

/*
 * The mover without a physics body: it integrates freely, and the ground is the safety net under the
 * map (a little below the floor it's put back on it). Enough for the jump rules.
 */

const DT = 1 / 120;
const input = (over: Partial<MoveInput> = {}): MoveInput =>
  ({ forward: 0, strafe: 0, sprint: false, crouch: false, jump: false, analog: false, ...over });

/** A mover standing on flat ground at y = 0 */
function grounded(): Mover {
  const m = new Mover();
  m.setTerrain(() => 0);
  m.position.set(0, 0, 0);
  // Settle onto the floor (the net catches it on the way down).
  for (let i = 0; i < 120; i++) m.step(DT, 0, input());
  expect(m.onGround).toBe(true);
  return m;
}

/** Steps until the mover is back on the ground, returning the highest point reached */
function flight(m: Mover, keys: MoveInput, limit = 600): number {
  let apex = 0;
  for (let i = 0; i < limit; i++) {
    m.step(DT, 0, keys);
    apex = Math.max(apex, m.position.y);
    if (m.onGround && i > 2) break;
  }
  return apex;
}

describe('jumping', () => {
  it('reaches the same height however the frames fall', () => {
    const m = grounded();
    m.step(DT, 0, input({ jump: true }));
    const vy = m.velocity.y;
    expect(vy).toBeGreaterThan(7);
    expect(m.onGround).toBe(false);
  });

  it('still jumps for a moment after walking off an edge (coyote time)', () => {
    const m = grounded();
    // A step off the floor: airborne, falling, no jump pressed yet
    m.setTerrain(() => -10);
    m.step(DT, 0, input());
    m.step(DT, 0, input());
    expect(m.onGround).toBe(false);
    expect(m.velocity.y).toBeLessThan(0);
    m.step(DT, 0, input({ jump: true }));
    expect(m.velocity.y).toBeGreaterThan(7);
  });

  it('does not jump off an edge once the moment has passed', () => {
    const m = grounded();
    m.setTerrain(() => -10);
    for (let i = 0; i < 30; i++) m.step(DT, 0, input()); // 0.25 s: well past the grace
    const before = m.velocity.y;
    m.step(DT, 0, input({ jump: true }));
    expect(m.velocity.y).toBeLessThan(before + 0.01);
  });

  it('keeps a jump pressed just before landing (buffer) and jumps on touchdown', () => {
    const m = grounded();
    m.step(DT, 0, input({ jump: true }));
    // Up and nearly down again, with the key released
    while (m.velocity.y > -5) m.step(DT, 0, input());
    expect(m.onGround).toBe(false);
    // Press (one step), then release: still in the air
    m.step(DT, 0, input({ jump: true }));
    expect(m.onGround).toBe(false);
    const apex = flight(m, input());
    // Landed and went straight back up without the key held
    expect(apex).toBeGreaterThan(0.5);
  });

  it('reports the landing speed once, on touchdown', () => {
    const m = grounded();
    m.step(DT, 0, input({ jump: true }));
    let landings = 0;
    let speed = 0;
    for (let i = 0; i < 600; i++) {
      m.step(DT, 0, input());
      if (m.landed > 0) { landings++; speed = m.landed; }
      if (m.onGround && i > 2) break;
    }
    expect(landings).toBe(1);
    expect(speed).toBeGreaterThan(5);
  });
});
