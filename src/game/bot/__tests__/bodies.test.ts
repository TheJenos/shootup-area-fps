import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadPhysics, PhysicsWorld } from '../../physics';
import { Mover, type MoveInput } from '../../movement';
import { RADIUS } from '../../playerDims';

const forward: MoveInput = { forward: 1, strafe: 0, analog: false, sprint: false, crouch: false, jump: false };

beforeAll(async () => {
  await loadPhysics();
});

/** Flat ground and nothing else */
function flatWorld(): PhysicsWorld {
  const physics = new PhysicsWorld();
  physics.setMap([], [], null);
  return physics;
}

function mover(physics: PhysicsWorld, x: number, z: number): Mover {
  const m = new Mover();
  m.attachPhysics(physics, false);
  m.teleport(new THREE.Vector3(x, 0, z));
  return m;
}

/** Walk `m` toward -z (yaw 0) for `seconds`, stepping the world as the game does */
function walk(physics: PhysicsWorld, m: Mover, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    m.step(1 / 60, 0, forward);
    physics.world.step();
  }
}

describe('player bodies', () => {
  it("can't be walked through: you go around, never into them", () => {
    const physics = flatWorld();
    const walker = mover(physics, 0, 0);
    const other = mover(physics, 0, -5);
    let closest = Infinity;
    for (let t = 0; t < 3; t += 1 / 60) {
      walker.step(1 / 60, 0, forward);
      physics.world.step();
      closest = Math.min(closest, Math.hypot(walker.position.x - other.position.x, walker.position.z - other.position.z));
    }
    // Never closer than two body widths (less the controller's small skin and contact slop).
    expect(closest).toBeGreaterThan(RADIUS * 2 - 0.08);
    // It slid round them and carried on.
    expect(walker.position.z).toBeLessThan(-6);
    physics.dispose();
  });

  it('hold you back when you push straight into a wall of them', () => {
    const physics = flatWorld();
    const walker = mover(physics, 0, 0);
    // Shoulder to shoulder across the way: no gap to slip through.
    for (let x = -3; x <= 3; x += RADIUS * 2) mover(physics, x, -5);
    walk(physics, walker, 3);
    expect(walker.position.z).toBeGreaterThan(-5 + RADIUS * 2 - 0.1);
    physics.dispose();
  });

  it('let you walk through the dead (and you still move freely alone)', () => {
    const physics = flatWorld();
    const walker = mover(physics, 0, 0);
    const body = mover(physics, 0, -5);
    body.setSolid(false);
    walk(physics, walker, 2);
    expect(walker.position.z).toBeLessThan(-8);
    physics.dispose();
  });

  it('slide past a shoulder rather than sticking to it', () => {
    const physics = flatWorld();
    const walker = mover(physics, 0, 0);
    // Slightly off to the side: the walker glances off and keeps going.
    mover(physics, 0.4, -4);
    walk(physics, walker, 3);
    expect(walker.position.z).toBeLessThan(-8);
    physics.dispose();
  });
});
