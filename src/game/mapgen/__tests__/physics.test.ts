import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateMap, groundHeight, rapierHeights, toSpec } from '../index';

describe('the physics heightfield', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('is exactly the ground the game draws and checks (same layout, same triangle split)', () => {
    const g = generateMap(toSpec('PHYSIC', 's')).ground!;
    const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.heightfield(g.n, g.n, rapierHeights(g), { x: g.n * g.cell, y: 1, z: g.n * g.cell }), body);
    world.step();
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      // Spread over the map without randomness: a fixed lattice of offsets.
      const x = ((i * 37) % 100) / 100 * (g.half * 2 - 2) - g.half + 1;
      const z = ((i * 61) % 100) / 100 * (g.half * 2 - 2) - g.half + 1;
      const hit = world.castRay(new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }), 100, true);
      expect(hit).not.toBeNull();
      worst = Math.max(worst, Math.abs(60 - hit!.timeOfImpact - groundHeight(g, x, z)));
    }
    expect(worst).toBeLessThan(1e-3);
    world.free();
  });
});
