import * as THREE from 'three';
import { ARENA_HALF, type MapBox, type MapLayout } from './mapgen';
import type { Quality } from './settings';
import { wedgeGeometry, type Ramp } from './ramps';
import {
  FLOOR_TILE, SURFACE_TILE, boxTexture, floorTexture, scaleBoxUVs, skyTexture, spawnMarkerTexture,
  type BoxSurface,
} from './textures';

/** The sky dome sits inside the camera's far plane (300 m) and follows the camera. */
const SKY_RADIUS = 250;

export { ARENA_HALF };

/** The lists a world fills in place, so everything holding them sees each new map. */
export interface WorldLists {
  /** Axis-aligned boxes the player collides with */
  colliders: THREE.Box3[];
  /** Meshes bullets can hit */
  solids: THREE.Mesh[];
  /** Sloped surfaces the player walks up */
  ramps: Ramp[];
  /** Everything that takes up floor space (boxes and ramps), for placing pickups */
  obstacles: THREE.Box3[];
}

export interface World extends WorldLists {
  spawnPoints: THREE.Vector3[];
  /** Keep this centered on the camera so the horizon never gets closer */
  sky: THREE.Object3D;
  /** Everything the map added to the scene */
  root: THREE.Group;
  /** Shadow map resolution for the graphics quality setting */
  setShadowQuality(quality: Quality): void;
  /** Remove the map from the scene and free its geometry and materials (textures are shared) */
  dispose(): void;
}

const SHADOW_SIZE: Record<Quality, number> = { low: 512, medium: 1024, high: 2048 };

/**
 * Builds the arena from a generated layout (see mapgen.ts). Every client generates
 * the same layout from the room's seed, so they all see the same map.
 *
 * Fills `colliders` (Box3, for movement) and `solids` (meshes, for bullet raycasts) in place,
 * so code holding on to those arrays sees the new map when it's rebuilt for the next round.
 */
export function buildWorld(scene: THREE.Scene, layout: MapLayout, lists: WorldLists): World {
  const { colliders, solids, ramps, obstacles } = lists;
  colliders.length = 0;
  solids.length = 0;
  ramps.length = 0;
  obstacles.length = 0;
  const { theme } = layout;
  const root = new THREE.Group();
  root.name = `map:${layout.seed}`;
  scene.add(root);

  // Flat color behind the sky dome, in case anything peeks past it.
  scene.background = new THREE.Color(theme.sky);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(theme), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  root.add(sky);
  scene.fog = new THREE.Fog(theme.sky, 45, 130);

  root.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 1.1));
  const sun = new THREE.DirectionalLight(theme.sun, 2.2);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  root.add(sun);

  // The texture is shared between games, so tile through the UVs rather than its repeat setting.
  const floorGeo = new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2);
  const floorUv = floorGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < floorUv.count; i++) {
    floorUv.setXY(i, (floorUv.getX(i) * ARENA_HALF * 2) / FLOOR_TILE, (floorUv.getY(i) * ARENA_HALF * 2) / FLOOR_TILE);
  }
  const floorMap = floorTexture(theme.floorTexture, theme);
  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({ map: floorMap, bumpMap: floorMap, bumpScale: 0.6, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);
  solids.push(floor);

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (surface: BoxSurface, color: number) => {
    const key = `${surface}:${color}`;
    let mat = materials.get(key);
    if (!mat) {
      const map = boxTexture(surface);
      mat = new THREE.MeshStandardMaterial({
        color,
        map,
        bumpMap: map,
        bumpScale: surface === 'metal' ? 1.2 : 0.8,
        roughness: surface === 'metal' ? 0.55 : 0.85,
        metalness: surface === 'metal' ? 0.35 : 0,
      });
      materials.set(key, mat);
    }
    return mat;
  };

  const addBox = (x: number, z: number, w: number, h: number, d: number, color: number, surface: BoxSurface, y = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const tile = SURFACE_TILE[surface];
    if (tile) scaleBoxUVs(geo, w, h, d, tile);
    const mesh = new THREE.Mesh(geo, material(surface, color));
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    mesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(mesh);
    colliders.push(box);
    obstacles.push(box);
    solids.push(mesh);
  };

  const addRamp = (b: MapBox) => {
    const geo = wedgeGeometry(b.w, b.h, b.d, b.ramp!);
    const tile = SURFACE_TILE[b.surface];
    if (tile) {
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 2) / tile, (uv.getY(i) * 2) / tile);
    }
    const mesh = new THREE.Mesh(geo, material(b.surface, b.color));
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    mesh.updateMatrixWorld();
    const box = new THREE.Box3(
      new THREE.Vector3(b.x - b.w / 2, b.y, b.z - b.d / 2),
      new THREE.Vector3(b.x + b.w / 2, b.y + b.h, b.z + b.d / 2),
    );
    ramps.push({ box, dir: b.ramp! });
    obstacles.push(box);
    solids.push(mesh);
  };

  // Perimeter walls
  const W = ARENA_HALF;
  addBox(0, -W, W * 2 + 1, 6, 1, theme.wall, 'perimeter');
  addBox(0, W, W * 2 + 1, 6, 1, theme.wall, 'perimeter');
  addBox(-W, 0, 1, 6, W * 2 + 1, theme.wall, 'perimeter');
  addBox(W, 0, 1, 6, W * 2 + 1, theme.wall, 'perimeter');

  for (const b of layout.boxes) {
    if (b.ramp) addRamp(b);
    else addBox(b.x, b.z, b.w, b.h, b.d, b.color, b.surface, b.y);
  }

  const spawnPoints = layout.spawnPoints.map(([x, z]) => new THREE.Vector3(x, 0, z));

  // Painted markers on the floor at each spawn, pointing toward the middle of the map.
  // Decoration only: not colliders, not hit by bullets.
  const markerGeo = new THREE.PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2);
  const markerMat = new THREE.MeshStandardMaterial({
    map: spawnMarkerTexture(),
    transparent: true,
    depthWrite: false,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  for (const p of spawnPoints) {
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(p.x, 0.01, p.z);
    // The arrow points along the texture's top, which is -z before rotating; face the center.
    marker.rotation.y = Math.atan2(p.x, p.z);
    marker.receiveShadow = true;
    root.add(marker);
  }

  const setShadowQuality = (quality: Quality) => {
    const size = SHADOW_SIZE[quality];
    if (sun.shadow.mapSize.x === size) return;
    sun.shadow.mapSize.set(size, size);
    // The map is allocated at the old size; drop it so it's rebuilt.
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  };

  const dispose = () => {
    scene.remove(root);
    const geometries = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geometries.add(o.geometry);
      for (const m of [o.material].flat()) mats.add(m as THREE.Material);
    });
    geometries.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    sun.shadow.map?.dispose();
  };

  return { colliders, solids, ramps, obstacles, spawnPoints, sky, root, setShadowQuality, dispose };
}
