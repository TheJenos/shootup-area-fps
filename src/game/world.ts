import * as THREE from 'three';
import { ARENA_HALF, type MapLayout } from './mapgen';
import {
  FLOOR_TILE, SURFACE_TILE, boxTexture, floorTexture, scaleBoxUVs, skyTexture, spawnMarkerTexture,
  type BoxSurface,
} from './textures';

/** The sky dome sits inside the camera's far plane (300 m) and follows the camera. */
const SKY_RADIUS = 250;

export { ARENA_HALF };

export interface World {
  /** Axis-aligned boxes the player collides with */
  colliders: THREE.Box3[];
  /** Meshes bullets can hit */
  solids: THREE.Mesh[];
  spawnPoints: THREE.Vector3[];
  /** Keep this centered on the camera so the horizon never gets closer */
  sky: THREE.Object3D;
}

/**
 * Builds the arena from a generated layout (see mapgen.ts). Every client generates
 * the same layout from the room's seed, so they all see the same map.
 * Returns colliders (Box3) for movement and solids (meshes) for bullet raycasts.
 */
export function buildWorld(scene: THREE.Scene, layout: MapLayout): World {
  const colliders: THREE.Box3[] = [];
  const solids: THREE.Mesh[] = [];
  const { theme } = layout;

  // Flat color behind the sky dome, in case anything peeks past it.
  scene.background = new THREE.Color(theme.sky);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(theme), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  scene.add(sky);
  scene.fog = new THREE.Fog(theme.sky, 45, 130);

  scene.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 1.1));
  const sun = new THREE.DirectionalLight(theme.sun, 2.2);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

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
  scene.add(floor);
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
    scene.add(mesh);
    mesh.updateMatrixWorld();
    colliders.push(new THREE.Box3().setFromObject(mesh));
    solids.push(mesh);
  };

  // Perimeter walls
  const W = ARENA_HALF;
  addBox(0, -W, W * 2 + 1, 6, 1, theme.wall, 'perimeter');
  addBox(0, W, W * 2 + 1, 6, 1, theme.wall, 'perimeter');
  addBox(-W, 0, 1, 6, W * 2 + 1, theme.wall, 'perimeter');
  addBox(W, 0, 1, 6, W * 2 + 1, theme.wall, 'perimeter');

  for (const b of layout.boxes) addBox(b.x, b.z, b.w, b.h, b.d, b.color, b.surface, b.y);

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
    scene.add(marker);
  }

  return { colliders, solids, spawnPoints, sky };
}
