import { beforeAll, describe, expect, it } from 'vitest';
import { loadPhysics } from '../../physics';
import { Arena } from '../sim/arena';
import { OBS_SIZE } from '../observe';
import { goalFor, newPatrol } from '../objective';
import type { BodyView, CtfView } from '../observe';
import type { BotAction } from '../policy';

beforeAll(async () => {
  await loadPhysics();
});

const body = (id: string, team: 'red' | 'blue', x: number, z: number, alive = true): BodyView =>
  ({ id, x, y: 0, z, stance: 'stand', alive, hp: 100, maxHp: 100, team, carrying: false });
const bases = { ownBase: { x: 0, y: 0, z: 30 }, enemyBase: { x: 0, y: 0, z: -30 } };

function goal(self: { id: string; x: number; z: number; carrying?: boolean }, others: BodyView[], ctf: CtfView) {
  return goalFor({
    self: { id: self.id, team: 'red', x: self.x, y: 0, z: self.z, carrying: !!self.carrying },
    others, mode: 'ctf', ctf, patrolPoints: [], patrol: newPatrol(), now: 0,
  });
}

describe('the objective layer (CTF)', () => {
  const home: CtfView = { ...bases, own: { at: 'base' }, enemy: { at: 'base' } };

  it('sends the carrier home', () => {
    expect(goal({ id: 'r1', x: 0, z: -20, carrying: true }, [], { ...home, enemy: { at: 'carried', carrier: 'r1' } })).toEqual(bases.ownBase);
  });

  it('sends only the nearest to return our dropped flag', () => {
    const ctf: CtfView = { ...home, own: { at: 'ground', x: 0, y: 0, z: 10 } };
    const mates = [body('r2', 'red', 0, 25)];
    expect(goal({ id: 'r1', x: 0, z: 12 }, mates, ctf)).toEqual(ctf.own);
    expect(goal({ id: 'r1', x: 0, z: -25 }, mates, ctf)).not.toEqual(ctf.own);
  });

  it('chases whoever has our flag (the two nearest of us)', () => {
    const thief = body('b1', 'blue', 5, 0);
    const ctf: CtfView = { ...home, own: { at: 'carried', carrier: 'b1' } };
    const others = [thief, body('r2', 'red', 6, 2), body('r3', 'red', 0, 28)];
    // (Followed on a 3 m grid.)
    expect(goal({ id: 'r1', x: 4, z: 4 }, others, ctf)).toMatchObject({ x: 6, z: 0 });
  });

  it('keeps one of three in front of the flag, and sends the rest for theirs', () => {
    const others = [body('r2', 'red', 0, 29), body('r3', 'red', 2, 10)];
    // r1 is at the rally point with r3 beside it: they push on together.
    expect(goal({ id: 'r1', x: 0, z: 5 }, others, home)).toEqual(bases.enemyBase);
    // r2 is nearest home: it holds a spot 6 m in front of the flag, toward the middle.
    expect(goal({ id: 'r2', x: 0, z: 29 }, [body('r1', 'red', 0, 5), body('r3', 'red', 2, 10)], home)).toMatchObject({ x: 0, z: 24 });
  });

  it('gathers attackers at a rally point, and pushes once a second one arrives or it has waited long enough', () => {
    const patrol = newPatrol();
    const g = (x: number, z: number, others: BodyView[], now: number) => goalFor({
      self: { id: 'r1', team: 'red', x, y: 0, z, carrying: false }, others, mode: 'ctf', ctf: home, patrolPoints: [], patrol, now,
    });
    // Three of us: r3 holds home, r1 and r2 attack. r1 leaves first: to the rally point (40% of the way).
    const defender = body('r3', 'red', 0, 29);
    const rally = g(0, 20, [defender, body('r2', 'red', 0, 28)], 0);
    expect(rally).toMatchObject({ x: 0, z: 6 });
    // There, alone: it waits.
    expect(g(0, 6, [defender, body('r2', 'red', 0, 28)], 1)).toMatchObject({ x: 0, z: 6 });
    // r2 arrives: both go.
    expect(g(0, 6, [defender, body('r2', 'red', 2, 8)], 2)).toEqual(bases.enemyBase);
    // Waiting alone for too long also ends it.
    const patrol2 = newPatrol();
    const h = (now: number) => goalFor({
      self: { id: 'r1', team: 'red', x: 0, y: 0, z: 6, carrying: false }, others: [defender, body('r2', 'red', 0, 28)], mode: 'ctf', ctf: home,
      patrolPoints: [], patrol: patrol2, now,
    });
    expect(h(0)).toMatchObject({ z: 6 });
    expect(h(20)).toEqual(bases.enemyBase);
  });

  it('sends a badly hurt bot back to its team', () => {
    const mate = body('r2', 'red', 0, 25);
    const g = goalFor({
      self: { id: 'r1', team: 'red', x: 0, y: 0, z: -10, carrying: false }, others: [mate, body('r3', 'red', 9, 26)], mode: 'ctf', ctf: home,
      patrolPoints: [], patrol: newPatrol(), now: 0, hp: 0.2,
    });
    expect(Math.hypot(g.x - mate.x, g.z - mate.z)).toBeLessThan(3);
  });
});

describe('the objective layer (FFA / TDM)', () => {
  const points = [{ x: 30, y: 0, z: -30, team: 'blue' as const }, { x: -30, y: 0, z: -30, team: 'blue' as const }, { x: 0, y: 0, z: 30, team: 'red' as const }];

  it('goes to a fight a teammate called out, if it\'s close enough', () => {
    const input = (known: { x: number; y: number; z: number }[]) => goalFor({
      self: { id: 'r1', team: 'red', x: 0, y: 0, z: 0, carrying: false }, others: [body('r2', 'red', 5, 5)], mode: 'tdm', ctf: null,
      patrolPoints: points, patrol: newPatrol(), now: 0, known,
    });
    expect(input([{ x: 12, y: 0, z: 0 }])).toMatchObject({ x: 12, z: 0 });
    // Too far: keep patrolling (toward the enemy's half).
    expect(input([{ x: 80, y: 0, z: 0 }]).z).toBe(-30);
  });
});

describe('travelling', () => {
  it('walks a bot to the enemy flag and home with it on its own', () => {
    // One red bot walking by the objective layer alone; blue stands still in its base area.
    // Seeded, so the run is the same every time.
    let r = 12345;
    const rand = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const arena = new Arena({ seed: 'TRAVEL1', size: 's', mode: 'ctf', players: 1, seconds: 240 }, rand);
    const obs = new Float32Array(OBS_SIZE);
    const still: BotAction = { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 };
    const red = arena.agents.find((a) => a.team === 'red')!;
    const blue = arena.agents.find((a) => a.team === 'blue')!;
    // Keep blue out of the way (it never fights back here).
    blue.mover.position.set(arena.map.half - 3, blue.mover.position.y, arena.map.half - 3);
    while (!arena.done && red.captures === 0) {
      arena.step(arena.agents.map((a) => (a === red ? arena.travel(a, arena.observe(a, obs)) : still)));
    }
    expect(red.captures).toBeGreaterThan(0);
    arena.dispose();
  });
});
