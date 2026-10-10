import { beforeAll, describe, expect, it } from 'vitest';
import { loadPhysics } from '../../physics';
import { Arena } from '../sim/arena';
import { OBS_SIZE } from '../observe';
import { defendedSite, goalFor, newPatrol } from '../objective';
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
    expect(h(5)).toEqual(bases.enemyBase);
  });

  it('races for their dropped flag without waiting for company', () => {
    const ctf: CtfView = { ...home, enemy: { at: 'ground', x: 3, y: 0, z: -12 } };
    expect(goal({ id: 'r1', x: 0, z: 20 }, [body('r2', 'red', 0, 29), body('r3', 'red', 0, 28)], ctf)).toEqual(ctf.enemy);
  });

  it('plays for the flags, not for kills: attackers ignore fights off their route and keep going when hurt', () => {
    const g = (known: { x: number; y: number; z: number }[], hp = 1) => goalFor({
      self: { id: 'r1', team: 'red', x: 0, y: 0, z: -10, carrying: false },
      others: [body('r2', 'red', 0, 25), body('r3', 'red', 9, 26), body('r4', 'red', 2, -8)], mode: 'ctf', ctf: home,
      patrolPoints: [], patrol: { ...newPatrol(), rallied: true }, now: 0, hp, known,
    });
    // An enemy called out 10 m to the side: still the flag.
    expect(g([{ x: 10, y: 0, z: -10 }])).toEqual(bases.enemyBase);
    // Badly hurt: still the flag (no falling back to heal).
    expect(g([], 0.2)).toEqual(bases.enemyBase);
  });

  it('clears the guards off their flag before grabbing it, but not forever', () => {
    const patrol = { ...newPatrol(), rallied: true };
    const g = (z: number, known: { x: number; y: number; z: number }[], now: number) => goalFor({
      self: { id: 'r1', team: 'red', x: 0, y: 0, z, carrying: false },
      others: [body('r2', 'red', 0, 25), body('r3', 'red', 9, 26), body('r4', 'red', 2, -8)], mode: 'ctf', ctf: home,
      patrolPoints: [], patrol, now, known,
    });
    const guard = [{ x: 3, y: 0, z: -33 }];
    // 20 m out with someone at their flag: hold 10 m short of it and fight.
    expect(g(-10, guard, 0)).toMatchObject({ x: 0, z: -20 });
    // Nobody there any more: go and take it.
    expect(g(-20, [], 1)).toEqual(bases.enemyBase);
    // Still guarded after a long wait: go anyway.
    expect(g(-20, guard, 2)).toMatchObject({ z: -20 });
    expect(g(-20, guard, 30)).toEqual(bases.enemyBase);
  });

  it('has defenders go for enemies closing in on the flag, but not for fights elsewhere', () => {
    const g = (known: { x: number; y: number; z: number }[]) => goalFor({
      self: { id: 'r2', team: 'red', x: 0, y: 0, z: 24, carrying: false }, others: [body('r1', 'red', 0, 0), body('r3', 'red', 2, 0)],
      mode: 'ctf', ctf: home, patrolPoints: [], patrol: newPatrol(), now: 0, known,
    });
    // Someone 8 m from our flag: go get them.
    expect(g([{ x: 6, y: 0, z: 25 }])).toMatchObject({ x: 6, z: 24 });
    // A fight 12 m from the defender but 25 m from the flag: hold the spot.
    expect(g([{ x: 0, y: 0, z: 12 }])).toMatchObject({ x: 0, z: 24 });
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

describe('pushing (CTF / S&D)', () => {
  it('keeps heading for the objective past enemies further off, and stands to fight one close by', async () => {
    const { OBS_LAYOUT } = await import('../observe');
    const { shouldPush, pushAction } = await import('../objective');
    const obs = new Float32Array(OBS_SIZE);
    const E = OBS_LAYOUT.enemies;
    obs[OBS_LAYOUT.attack + 1] = 1; // the route goes straight ahead
    obs[OBS_LAYOUT.attack + 2] = 40 / 60; // 40 m to go
    obs[OBS_LAYOUT.attack + 3] = 1;
    obs[E] = 1; // an enemy in view...
    obs[E + 4] = 30 / 60; // ...30 m away
    expect(shouldPush(obs)).toBe(true);
    const fight = { move: 3, sprint: true, jump: false, crouch: false, fire: true, aimYaw: 0.2, aimPitch: 0 } as unknown as BotAction;
    const a = pushAction(fight, obs);
    // Walks the route (forward), shooting as it goes.
    expect(a.move).toBe(1);
    expect(a.fire).toBe(true);
    // 10 m away: stand and fight (running past people shooting at it got bots killed).
    obs[E + 4] = 10 / 60;
    expect(shouldPush(obs)).toBe(false);
    // Only remembered, far off: sprint on.
    obs[E] = 0;
    obs[E + 4] = 30 / 60;
    expect(pushAction(fight, obs).sprint).toBe(true);
    // At the goal (a defender at its spot): the policy fights.
    obs[OBS_LAYOUT.attack + 2] = 2 / 60;
    expect(shouldPush(obs)).toBe(false);
  });
});

describe('the objective layer (S&D defenders)', () => {
  const sites = { a: { x: -30, y: 0, z: 30 }, b: { x: 30, y: 0, z: 30 } };
  const self = (id: string, x = 0, z = 10) => ({ id, team: 'red' as const, x, y: 0, z, carrying: false });
  const bot = (id: string, x = 0, z = 10, alive = true) => body(id, 'red', x, z, alive);
  const person = (id: string, x: number, z: number) => ({ ...body(id, 'red', x, z), human: true });

  it('splits two bots over both sites', () => {
    expect(defendedSite(self('b1'), [bot('b2')], sites)).not.toBe(defendedSite(self('b2'), [bot('b1')], sites));
  });

  it('covers both sites with three, and spreads back when a guard dies', () => {
    const team = ['b1', 'b2', 'b3'];
    const picks = team.map((id) => defendedSite(self(id), team.filter((m) => m !== id).map((m) => bot(m)), sites));
    expect(new Set(picks)).toEqual(new Set(['a', 'b']));
    // b1 (on A) is down: the other two take one site each.
    const left = ['b2', 'b3'].map((id) => defendedSite(self(id), [bot('b1', 0, 10, false), bot(id === 'b2' ? 'b3' : 'b2')], sites));
    expect(new Set(left)).toEqual(new Set(['a', 'b']));
  });

  it('takes the site a person is not holding', () => {
    expect(defendedSite(self('b1'), [person('p1', -28, 30)], sites)).toBe('b');
    // A second bot helps the person on A.
    expect(defendedSite(self('b2'), [person('p1', -28, 30), bot('b1')], sites)).toBe('a');
  });

  it('a lone bot holds the closer site', () => {
    expect(defendedSite(self('b1', 25, 20), [], sites)).toBe('b');
  });
});
