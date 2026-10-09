import { beforeAll, describe, expect, it } from 'vitest';
import { loadPhysics } from '../../physics';
import { groundHeight } from '../../mapgen';
import { Arena } from '../sim/arena';
import { OBS_LAYOUT, OBS_SIZE } from '../observe';
import { scriptedAction, Wanderer } from '../scripted';
import { hitPlayer, lookDir } from '../hitscan';
import type { BotAction } from '../policy';

function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

beforeAll(async () => {
  await loadPhysics();
});

describe('hitscan', () => {
  const target = { id: 't', x: 0, y: 0, z: -10, stance: 'stand' as const };
  it('hits the body and the head where they are', () => {
    const body = hitPlayer({ ox: 0, oy: 1, oz: 0, dx: 0, dy: 0, dz: -1 }, target, 100);
    expect(body).toEqual({ dist: expect.closeTo(9.7, 3), head: false });
    const head = hitPlayer({ ox: 0, oy: 1.62, oz: 0, dx: 0, dy: 0, dz: -1 }, target, 100);
    expect(head?.head).toBe(true);
  });
  it('misses beside, above and beyond', () => {
    expect(hitPlayer({ ox: 0.6, oy: 1, oz: 0, dx: 0, dy: 0, dz: -1 }, target, 100)).toBeNull();
    expect(hitPlayer({ ox: 0, oy: 2, oz: 0, dx: 0, dy: 0, dz: -1 }, target, 100)).toBeNull();
    expect(hitPlayer({ ox: 0, oy: 1, oz: 0, dx: 0, dy: 0, dz: -1 }, target, 5)).toBeNull();
  });
  it('looks where the camera looks', () => {
    const [x, y, z] = lookDir(0, 0);
    expect([x, y, z].map((v) => Math.round(v * 1000) / 1000)).toEqual([-0, 0, -1]);
    expect(lookDir(Math.PI / 2, 0)[0]).toBeCloseTo(-1);
  });
});

describe('the training arena', () => {
  it('plays a CTF match with scripted bots without anyone falling out of the world', () => {
    const rand = lcg(42);
    const arena = new Arena({ seed: 'ARENA1', size: 's', mode: 'ctf', players: 3, seconds: 60 }, rand);
    const obs = arena.agents.map(() => new Float32Array(OBS_SIZE));
    let steps = 0;
    while (!arena.done) {
      const actions: BotAction[] = arena.agents.map((a, i) => {
        arena.observe(a, obs[i]!);
        for (const v of obs[i]!) expect(Number.isFinite(v)).toBe(true);
        return scriptedAction(obs[i]!, rand);
      });
      arena.step(actions);
      steps++;
      for (const a of arena.agents) {
        const p = a.mover.position;
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
        expect(Math.abs(p.x)).toBeLessThan(arena.map.half + 1);
        expect(Math.abs(p.z)).toBeLessThan(arena.map.half + 1);
        expect(p.y).toBeGreaterThan(-1);
      }
    }
    expect(steps).toBeGreaterThan(100);
    // Scripted bots fight: somebody got shot.
    expect(arena.agents.reduce((n, a) => n + a.deaths, 0)).toBeGreaterThan(0);
    arena.dispose();
  });

  it('gives a path toward the enemy flag', () => {
    const arena = new Arena({ seed: 'ARENA2', size: 's', mode: 'ctf', players: 1, seconds: 10 }, lcg(1));
    const a = arena.agents[0]!;
    const obs = arena.observe(a, new Float32Array(OBS_SIZE));
    expect(obs[OBS_LAYOUT.attack + 3]).toBe(1);
    expect(Number.isFinite(arena.lastObjectiveDistance)).toBe(true);
    // Follow the waypoints: the distance should come down.
    const start = arena.lastObjectiveDistance;
    for (let i = 0; i < 80; i++) {
      arena.observe(a, obs);
      arena.step([scriptedAction(obs, lcg(i)), { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 }]);
    }
    arena.observe(a, obs);
    expect(arena.lastObjectiveDistance).toBeLessThan(start - 10);
    arena.dispose();
  });

  it('does not see enemies through walls', () => {
    const arena = new Arena({ seed: 'ARENA3', size: 'm', mode: 'tdm', players: 1, seconds: 10 }, lcg(2));
    const [a, b] = arena.agents as [typeof arena.agents[0], typeof arena.agents[0]];
    const obs = new Float32Array(OBS_SIZE);
    // Find a spot pair the occlusion grid says is blocked, and put them there.
    const occ = arena.senses.occlusion;
    let blocked: [number, number, number, number] | null = null;
    for (let x = -30; x <= 30 && !blocked; x += 3) {
      for (let z = -30; z <= 30 && !blocked; z += 3) {
        if (!occ.blocked(x, z) && !occ.blocked(x + 8, z) && !occ.sees(x, z, x + 8, z)) blocked = [x, z, x + 8, z];
      }
    }
    expect(blocked).not.toBeNull();
    const [ax, az, bx, bz] = blocked!;
    a.mover.position.set(ax, groundHeight(arena.map.ground, ax, az), az);
    b.mover.position.set(bx, groundHeight(arena.map.ground, bx, bz), bz);
    arena.observe(a, obs);
    expect(obs[OBS_LAYOUT.enemies]).toBe(0);
    arena.dispose();
  });

  it('lets a learner practise on wandering dummies', () => {
    const arena = new Arena({ seed: 'ARENA4', size: 's', mode: 'ffa', players: 3, dummies: 2, seconds: 5 }, lcg(3));
    expect(arena.agents.map((a) => a.dummy)).toEqual([false, true, true]);
    const w = new Wanderer();
    const act = w.act(0, lcg(4));
    expect(act.fire).toBe(false);
    arena.dispose();
  });
});
