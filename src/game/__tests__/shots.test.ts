import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CLASSIC_SEED, generateMap, groundHeight, toSpec, type MapData } from '../mapgen';
import { loadPhysics, PhysicsWorld } from '../physics';
import { buildWorld } from '../world';

// The world's textures are drawn on a canvas, which Node doesn't have; bullets don't need them.
vi.mock('../textures', async (importOriginal) => {
  const blank = () => new THREE.Texture();
  return {
    ...(await importOriginal<typeof import('../textures')>()),
    boxTexture: blank, floorTexture: blank, groundTexture: blank, skyTexture: blank, spawnMarkerTexture: blank,
  };
});

function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * What bullets used to raycast (world.ts before M5.2): an invisible box per obstacle that stops shots,
 * the perimeter walls, the drawn floor and ramps (still in `solids`). Cylinders are drawn finer than
 * the old 16-sided stand-in, so they check the round shape bullets should stop at.
 */
function oldTargets(map: MapData, solids: THREE.Mesh[]): { meshes: THREE.Object3D[]; round: Set<THREE.Object3D> } {
  const meshes: THREE.Object3D[] = [...solids];
  const round = new Set<THREE.Object3D>();
  const mat = new THREE.MeshBasicMaterial();
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 256);
  const add = (b: { x: number; z: number; w: number; h: number; d: number; y: number }, cylinder: boolean) => {
    const mesh = new THREE.Mesh(cylinder ? cylGeo : boxGeo, mat);
    mesh.position.set(b.x, b.y + b.h / 2, b.z);
    mesh.scale.set(b.w, b.h, b.d);
    mesh.updateMatrixWorld();
    meshes.push(mesh);
    if (cylinder) round.add(mesh);
  };
  const W = map.half;
  const h = 6 + map.edge.height;
  if (!map.outline) {
    for (const [x, z, w, d] of [[0, -W, W * 2 + 1, 1], [0, W, W * 2 + 1, 1], [-W, 0, 1, W * 2 + 1], [W, 0, 1, W * 2 + 1]] as const) add({ x, z, w, h, d, y: 0 }, false);
  }
  for (const b of map.boxes) if (!b.ramp && b.blocks !== 'move') add(b, b.shape === 'cylinder');
  return { meshes, round };
}

describe('bullets in the physics world', () => {
  beforeAll(async () => {
    await loadPhysics();
  });

  it('stop where the old mesh raycasts did (within 1 cm), round things at their round side', () => {
    const rand = lcg(7);
    const raycaster = new THREE.Raycaster();
    const RANGE = 150;
    let rays = 0;
    let hits = 0;
    let roundHits = 0;
    let worst = 0;
    const misses: string[] = [];
    // The classic map, three large generated ones (one with thousands of boxes), and one with tanks.
    for (const seed of [CLASSIC_SEED, 'RAYCAST', 'BULLET', 'ALPHA', 'HOTEL']) {
      const map = generateMap(toSpec(seed, 'l'));
      const lists = { colliders: [] as THREE.Box3[], solids: [] as THREE.Mesh[], ramps: [], obstacles: [] as THREE.Box3[] };
      const world = buildWorld(new THREE.Scene(), map, lists);
      const physics = new PhysicsWorld();
      physics.setMap(world.colliders, world.ramps, world.ground, world.shots);
      const { meshes, round } = oldTargets(map, world.solids);
      const inside = meshes.slice(world.solids.length).map((m) => new THREE.Box3().setFromObject(m));
      for (const r of world.ramps) inside.push(r.box);
      const origin = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const check = () => {
        raycaster.set(origin, dir);
        raycaster.far = RANGE;
        const old = raycaster.intersectObjects(meshes, false)[0];
        const now = physics.castRay(origin, dir, RANGE);
        const ray = `${seed} ${origin.toArray().map((v) => v.toFixed(2))} → ${dir.toArray().map((v) => v.toFixed(3))}`;
        rays++;
        if (!old || !now) {
          if (old || now) misses.push(`${ray}: old ${old?.distance} now ${now?.toi}`);
          return;
        }
        hits++;
        if (round.has(old.object)) roundHits++;
        const off = Math.abs(old.distance - now.toi);
        worst = Math.max(worst, off);
        if (off >= 0.01) misses.push(`${ray}: old ${old.distance.toFixed(3)} now ${now.toi.toFixed(3)}${round.has(old.object) ? ' (round)' : ''}`);
      };
      for (let n = 0; n < 200; n++) {
        // Somewhere in the map, at or above head height, not inside anything.
        do {
          const x = (rand() * 2 - 1) * (map.half - 2);
          const z = (rand() * 2 - 1) * (map.half - 2);
          origin.set(x, groundHeight(map.ground, x, z) + 0.5 + rand() * 5, z);
        } while (inside.some((b) => b.containsPoint(origin)));
        // Mostly level or downward: those are the shots that hit things.
        dir.set(rand() * 2 - 1, rand() * 0.8 - 0.5, rand() * 2 - 1).normalize();
        check();
      }
      // Round things are rare: aim at each one's bounding box from a few metres off, corners included.
      for (const b of map.boxes.filter((bx) => bx.shape === 'cylinder')) {
        for (let n = 0; n < 40; n++) {
          const a = rand() * Math.PI * 2;
          const r = Math.max(b.w, b.d) / 2 + 2 + rand() * 4;
          origin.set(b.x + Math.cos(a) * r, b.y + rand() * b.h, b.z + Math.sin(a) * r);
          if (inside.some((box) => box.containsPoint(origin))) continue;
          const aim = new THREE.Vector3(b.x + (rand() - 0.5) * b.w, b.y + rand() * b.h, b.z + (rand() - 0.5) * b.d);
          dir.copy(aim).sub(origin).normalize();
          check();
        }
      }
      physics.dispose();
      world.dispose();
    }
    expect(misses).toEqual([]);
    expect(rays).toBeGreaterThan(1000);
    // Enough of them hit something (round things included) for this to mean anything.
    expect(hits).toBeGreaterThan(rays * 0.6);
    expect(roundHits).toBeGreaterThan(30);
    expect(worst).toBeLessThan(0.01);
  });

  it('fly out through the invisible boundary, and stop at deployables (saying which)', () => {
    const map = generateMap(toSpec('RAYCAST', 'm'));
    const lists = { colliders: [] as THREE.Box3[], solids: [] as THREE.Mesh[], ramps: [], obstacles: [] as THREE.Box3[] };
    const world = buildWorld(new THREE.Scene(), map, lists);
    const physics = new PhysicsWorld();
    physics.setMap(world.colliders, world.ramps, world.ground, world.shots);
    // High over everything: the boundary (200 m tall) stops people, not bullets.
    const from = { x: 0, y: 150, z: 0 };
    const east = { x: 1, y: 0, z: 0 };
    expect(physics.castRay(from, east, 400)).toBeNull();
    const key = {};
    physics.addBox(key, new THREE.Box3(new THREE.Vector3(10, 149, -1), new THREE.Vector3(10.4, 152, 1)));
    // At once, before the step that puts it in Rapier's query structure (shot the frame it goes up)...
    expect(physics.castRay(from, east, 400)).toEqual({ toi: expect.closeTo(10, 4), key });
    physics.update(0.05);
    // ...and after.
    expect(physics.castRay(from, east, 400)).toEqual({ toi: expect.closeTo(10, 4), key });
    expect(physics.clearLine(from, { x: 20, y: 150, z: 0 })).toBe(false);
    // ...except the one it's told to skip (a turret firing past its own box).
    expect(physics.castRay(from, east, 400, key)).toBeNull();
    physics.removeBox(key);
    expect(physics.clearLine(from, { x: 20, y: 150, z: 0 })).toBe(true);
    physics.dispose();
    world.dispose();
  });
});
