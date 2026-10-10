import { describe, expect, it } from 'vitest';
import { generateMap, GENERATOR_VERSION } from '../mapgen';
import { roundSpawn, spawnSalt, spreadOrder, type SpawnSpot } from '../spawnPlan';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, '0')}`);
const spotOf = (points: readonly SpawnSpot[], plan: ReturnType<typeof roundSpawn>) => ({ x: points[plan!.index]!.x + plan!.dx, z: points[plan!.index]!.z + plan!.dz });
const minGap = (spots: readonly SpawnSpot[]) => {
  let gap = Infinity;
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) gap = Math.min(gap, Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z));
  return gap;
};

describe('round spawns', () => {
  const line: SpawnSpot[] = Array.from({ length: 5 }, (_, i) => ({ x: i * 10, z: 0 }));

  it('orders spawns so each is as far as possible from the ones before', () => {
    expect(spreadOrder(line, 0)).toEqual([0, 4, 2, 1, 3]);
    expect(spreadOrder([], 3)).toEqual([]);
  });

  it('gives everyone a different spot, the same whatever order the ids come in', () => {
    const players = ids(5);
    const spots = players.map((id) => roundSpawn(line, players, id, 7)!.index);
    expect(new Set(spots).size).toBe(5);
    expect(roundSpawn(line, [...players].reverse(), 'p02', 7)).toEqual(roundSpawn(line, players, 'p02', 7));
    expect(roundSpawn(line, players, 'nobody', 7)).toBeNull();
  });

  it('stands extra players beside a taken spot when there are more players than spawns', () => {
    const players = ids(7);
    const spots = players.map((id) => spotOf(line, roundSpawn(line, players, id, 1)));
    expect(minGap(spots)).toBeGreaterThan(1);
  });

  it('changes who starts where from one round to the next', () => {
    const players = ids(3);
    const plan = (round: number) => players.map((id) => roundSpawn(line, players, id, spawnSalt(`${round}:0:SEED`))!.index).join();
    expect(new Set([0, 1, 2, 3, 4, 5].map(plan)).size).toBeGreaterThan(1);
  });

  it('spreads a free-for-all over generated maps', () => {
    for (const seed of ['alpha', 'harbor', 'dunes7', 'k2', 'zeta']) {
      for (const size of ['s', 'm', 'l'] as const) {
        const map = generateMap({ seed, size, gen: GENERATOR_VERSION });
        // As game.ts plans a free-for-all start: the spawns and the pickup spots.
        const points = [...map.spawns, ...map.pickupSpots].map((s) => ({ x: s.x, z: s.z }));
        const players = ids(8);
        const spots = players.map((id) => spotOf(points, roundSpawn(points, players, id, spawnSalt(seed))));
        // Nobody shares a spawn, and they're well apart (the map is ~2·half across).
        expect(new Set(spots.map((s) => `${s.x},${s.z}`)).size).toBe(players.length);
        expect(minGap(spots)).toBeGreaterThan(map.half * 0.25);
      }
    }
  });
});
