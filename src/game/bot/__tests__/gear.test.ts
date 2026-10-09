import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// The bot host only needs ids from the network module and a pure helper from the flags module;
// keep Firebase and the texture painters out of Node.
vi.mock('../../../net/network', () => ({
  BOT_PREFIX: 'b_',
  isBotId: (id: string) => id.startsWith('b_'),
  randomId: () => Math.random().toString(36).slice(2, 10).toUpperCase(),
}));
vi.mock('../../textures', () => ({ boxTexture: () => null, hazardTexture: () => null, wornMetalTexture: () => null }));

import { loadPhysics, type PhysicsWorld } from '../../physics';
import { generateMap, groundHeight, toSpec, type MapData } from '../../mapgen';
import { baseRules } from '../../rules';
import { Policy } from '../policy';
import { Gear } from '../gear';
import { buildPhysics } from '../sim/arena';
import { BotHost, type BotHostApi } from '../botHost';
import type { GameState, PickupRecord, PickupType, PlayerState } from '../../../types';

beforeAll(async () => {
  await loadPhysics();
});

describe('a bot\'s gear', () => {
  const rules = { standard: true, guns: true, abilities: true, ammo: true };

  it('wants a gun, then only more rounds for it; ammo only for a picked-up gun', () => {
    const g = new Gear();
    expect(g.wants('ammo', rules)).toBe(false);
    expect(g.wants('shotgun', rules)).toBe(true);
    g.take('shotgun', undefined);
    expect(g.special).toEqual({ kind: 'shotgun', mag: 6, reserve: 12 });
    expect(g.wants('sniper', rules)).toBe(false);
    // The same gun again: only while there's room for its rounds.
    expect(g.wants('shotgun', rules)).toBe(true);
    g.special!.reserve = 18;
    expect(g.wants('shotgun', rules)).toBe(false);
    g.special!.reserve = 2;
    expect(g.wants('ammo', rules)).toBe(true);
    g.take('ammo', undefined);
    expect(g.special!.reserve).toBe(8);
  });

  it('fills its three slots, then leaves abilities lying; drops everything on death', () => {
    const g = new Gear();
    for (const t of ['medkit', 'grenade', 'shield'] as const) g.take(t, undefined);
    expect(g.wants('speed', rules)).toBe(false);
    expect(g.take('speed', undefined)).toBe('speed');
    g.take('deagle', 9);
    const drops = g.dropAll();
    expect(drops.map((d) => d.type).sort()).toEqual(['deagle', 'grenade', 'medkit', 'shield']);
    expect(drops.find((d) => d.type === 'deagle')!.uses).toBe(9);
    expect(g.special).toBeNull();
    expect(g.inventory.hasRoom).toBe(true);
  });

  it('respects the rules: no guns in a fixed-gun mode, nothing when pickups are off', () => {
    const g = new Gear();
    expect(g.wants('sniper', { ...rules, standard: false })).toBe(false);
    expect(g.wants('medkit', { ...rules, abilities: false })).toBe(false);
  });
});

/** A room with one bot (ours) and one enemy human, on a real map and physics, with the network faked. */
function room(seed = 'GEARTEST') {
  const map: MapData = generateMap(toSpec(seed, 's'));
  const physics: PhysicsWorld = buildPhysics(map);
  const rules = { ...baseRules('ffa'), bots: 2 };
  const game: GameState = { round: 0, score: {}, flags: {} };
  const players: Record<string, PlayerState> = {};
  const pickups = new Map<string, PickupRecord & { y: number }>();
  const enemy = { x: 0, y: 0, z: 0, alive: true };
  const roster: Record<string, { base: string; skill: 'easy' | 'normal' | 'hard' | 'expert'; at: number }> = { s_test: { base: 'Kai', skill: 'hard', at: 0 } };
  const log = { states: [] as Partial<PlayerState>[], events: [] as { type: string }[], throws: [] as string[], placed: [] as string[], spawned: [] as PickupRecord[], renamed: [] as string[], removed: [] as string[] };
  const raycaster = new THREE.Raycaster();
  void raycaster;
  const api: BotHostApi = {
    selfId: 'HUMAN',
    net: {
      addBot: async (id: string, state: PlayerState) => { players[id] = state; },
      sendStateAs: async (id: string, s: Partial<PlayerState>) => { log.states.push(s); Object.assign(players[id] ?? {}, s); },
      sendEventAs: (_id: string, e: { type: string }) => { log.events.push(e); },
      claimPickup: async (id: string) => { const p = pickups.get(id) ?? null; pickups.delete(id); return p; },
      spawnPickup: (r: PickupRecord) => { log.spawned.push(r); return 'x'; },
      mutateGame: async () => false,
      creditKill: async () => null,
      renameBot: async (_id: string, name: string) => { log.renamed.push(name); },
      removeBot: async (id: string) => { log.removed.push(id); },
    } as unknown as BotHostApi['net'],
    joined: () => true,
    physics: () => physics,
    map: () => map,
    rules: () => rules,
    game: () => game,
    roundOver: () => false,
    players: () => players,
    bodyOf: (id) => (id === 'HUMAN' ? { ...enemy, stance: 'stand' as const } : null),
    wallDistance: (_ox, _oy, _oz, _dx, _dy, _dz, max) => max,
    groundBelow: (x, _y, z) => groundHeight(map.ground, x, z),
    terrainAt: (x, z) => groundHeight(map.ground, x, z),
    spawns: () => map.spawns.map((s) => ({ pos: new THREE.Vector3(s.x, s.y, s.z), team: s.team })),
    colorFor: () => '#ffffff',
    creditKill: () => {},
    finishRound: () => {},
    sites: () => null,
    endSndRound: () => {},
    headcount: () => ({ red: { size: 0, alive: 0 }, blue: { size: 0, alive: 0 } }),
    maxDamage: () => 200,
    pickups: () => [...pickups].map(([id, p]) => ({ id, type: p.type, x: p.x, y: p.y, z: p.z, ...(p.uses !== undefined ? { uses: p.uses } : {}) })),
    scatterAround: (x, z, n) => Array.from({ length: n }, (_, i) => ({ x: x + i, z })),
    place: (kind) => { log.placed.push(kind); return true; },
    throwFor: (_id, kind) => { log.throws.push(kind); },
    landing: (_kind, eye, dir) => {
      // A rough ballistic estimate is enough for the test: range grows with pitch.
      const pitch = Math.asin(dir[1]);
      const range = 6 + 22 * Math.max(0, Math.sin(2 * (pitch + 0.3)));
      const h = Math.hypot(dir[0], dir[2]) || 1;
      return { end: new THREE.Vector3(eye.x + (dir[0] / h) * range, 0, eye.z + (dir[2] / h) * range), duration: 1 };
    },
    arcOf: () => ({ end: new THREE.Vector3(), duration: 1 }),
    firesAt: () => [],
    botRoster: () => roster,
  };
  const host = new BotHost(api);
  host.setOwner(true);
  const internals = host as unknown as {
    policy: Policy;
    add(slotId: string, slot: { base: string; skill: 'hard'; at: number }): void;
    bots: Map<string, { id: string; name: string; skill: string; hp: number; alive: boolean; mover: { position: THREE.Vector3 }; gear: Gear; gun: string; brain: { memory: { seen: Map<string, unknown> } } }>;
    hurt(bot: unknown, dmg: number, from: string, head: boolean, weapon: string, source: undefined): void;
  };
  internals.policy = new Policy();
  players.HUMAN = { name: 'Human', color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true, kills: 0, deaths: 0 };
  internals.add('s_test', { base: 'Kai', skill: 'hard', at: 0 });
  const bot = [...internals.bots.values()][0]!;
  // The enemy stands far away, out of the fight, unless a test moves them.
  enemy.x = bot.mover.position.x + 60;
  enemy.z = bot.mover.position.z;
  const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 30) host.update(1 / 30); };
  const putPickup = (type: PickupType, x: number, z: number, uses?: number) =>
    pickups.set(`p${pickups.size}`, { type, x, z, y: groundHeight(map.ground, x, z), ...(uses !== undefined ? { uses } : {}) });
  return { host, internals, bot, enemy, players, pickups, log, run, putPickup, physics, roster };
}

describe('bots in a room', () => {
  it('walk over to a gun lying nearby, take it and use it', async () => {
    const r = room();
    const p = r.bot.mover.position;
    r.putPickup('shotgun', p.x + 3, p.z);
    for (let i = 0; i < 20 && r.bot.gun !== 'shotgun'; i++) {
      r.run(0.5);
      await Promise.resolve();
    }
    expect(r.bot.gear.special?.kind).toBe('shotgun');
    expect(r.bot.gun).toBe('shotgun');
    expect(r.pickups.size).toBe(0);
    r.physics.dispose();
  });

  it('heal with a medkit when badly hurt', () => {
    const r = room();
    r.bot.gear.take('medkit', undefined);
    r.bot.hp = 30;
    r.run(0.5);
    expect(r.bot.hp).toBe(80);
    expect(r.log.states.some((s) => s.hp === 80)).toBe(true);
  });

  it('shield up under fire, and the shield soaks the next hits', () => {
    const r = room();
    r.bot.gear.take('shield', undefined);
    r.bot.hp = 60;
    // An enemy in plain sight a few metres away.
    const p = r.bot.mover.position;
    r.enemy.x = p.x + 6;
    r.enemy.z = p.z;
    r.bot.brain.memory.seen.set('HUMAN', { x: r.enemy.x, y: p.y, z: r.enemy.z, stance: 'stand', t: 1e9 });
    r.run(0.3);
    expect(r.log.states.some((s) => s.shield === true)).toBe(true);
    r.internals.hurt(r.bot, 30, 'HUMAN', false, 'rifle', undefined);
    expect(r.bot.hp).toBe(60);
    r.internals.hurt(r.bot, 30, 'HUMAN', false, 'rifle', undefined);
    expect(r.bot.hp).toBe(50);
  });

  it('lob a grenade at an enemy it knows is out of reach', () => {
    const r = room();
    r.bot.gear.take('grenade', undefined);
    const p = r.bot.mover.position;
    r.bot.brain.memory.seen.set('HUMAN', { x: p.x + 14, y: p.y, z: p.z, stance: 'stand', t: 1e9 });
    r.run(0.3);
    expect(r.log.throws).toContain('grenade');
  });

  it('drop its gun and abilities where it dies', () => {
    const r = room();
    r.bot.gear.take('sniper', undefined);
    r.bot.gear.take('scan', undefined);
    r.internals.hurt(r.bot, 500, 'HUMAN', false, 'rifle', undefined);
    expect(r.bot.alive).toBe(false);
    expect(r.log.spawned.map((s) => s.type).sort()).toEqual(['scan', 'sniper']);
    expect(r.bot.gear.special).toBeNull();
  });

  it('follow the room\'s list: a new level renames the bot, a removed entry takes it out', async () => {
    const r = room();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(r.bot.name).toBe('Kai [Hard]');
    r.roster.s_test = { ...r.roster.s_test!, skill: 'expert' };
    r.run(1.2);
    await settle();
    expect(r.bot.skill).toBe('expert');
    expect(r.log.renamed).toContain('Kai [Expert]');
    delete r.roster.s_test;
    r.run(1.2);
    expect(r.log.removed).toContain(r.bot.id);
    expect(r.internals.bots.size).toBe(0);
  });
});
