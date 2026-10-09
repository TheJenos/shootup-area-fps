import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadPhysics } from '../../physics';
import { groundHeight } from '../../mapgen';
import { Arena } from '../sim/arena';
import { OBS_LAYOUT, OBS_SIZE } from '../observe';
import { MAX_TURN, type BotAction } from '../policy';

beforeAll(async () => {
  await loadPhysics();
});

const still: BotAction = { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 };

describe('shaping rewards', () => {
  it("can't be farmed by an enemy going in and out of sight", () => {
    const arena = new Arena({ seed: 'SHAPE1', size: 's', mode: 'ffa', players: 2, seconds: 300 });
    const [a, b] = arena.agents as [typeof arena.agents[0], typeof arena.agents[0]];
    // Two open spots in sight of each other.
    const occ = arena.senses.occlusion;
    let pair: [number, number, number, number] | null = null;
    for (let x = -30; x <= 30 && !pair; x += 2) {
      for (let z = -30; z <= 30 && !pair; z += 2) {
        if (!occ.blocked(x, z) && !occ.blocked(x, z - 6) && occ.sees(x, z, x, z - 6)) pair = [x, z, x, z - 6];
      }
    }
    const [ax, az, bx, bz] = pair!;
    a.mover.teleport(new THREE.Vector3(ax, groundHeight(arena.map.ground, ax, az), az));
    b.mover.teleport(new THREE.Vector3(bx, groundHeight(arena.map.ground, bx, bz), bz));
    const obs = new Float32Array(OBS_SIZE);
    let seenCount = 0;
    for (let i = 0; i < 1200; i++) {
      // The enemy keeps vanishing (as if behind cover) and showing up again.
      b.alive = i % 20 < 10;
      b.respawnAt = Infinity;
      arena.observe(a, obs);
      arena.shape(a, obs);
      // The exploit: turn away while they're hidden, and aim at them when they show up.
      const seen = obs[OBS_LAYOUT.enemies]! > 0.5;
      if (seen) seenCount++;
      const toward = Math.max(-1, Math.min(1, (obs[OBS_LAYOUT.enemies + 5]! * Math.PI) / MAX_TURN.yaw));
      arena.step([{ ...still, aimYaw: seen ? toward : 1 }, still]);
    }
    expect(seenCount).toBeGreaterThan(300);
    // A potential adds up to at most its range over a whole episode, however often it's cycled.
    expect(Math.abs(a.rewardParts.aim ?? 0)).toBeLessThan(0.25 * Math.PI * 1.5 + 1e-6);
    arena.dispose();
  });
});
