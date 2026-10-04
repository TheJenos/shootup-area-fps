import * as THREE from 'three';
import { canvas2d } from './canvas';
import { ARENA_HALF, type MapLayout } from './mapgen';

export { ARENA_HALF };

export interface World {
  /** Axis-aligned boxes the player collides with */
  colliders: THREE.Box3[];
  /** Meshes bullets can hit */
  solids: THREE.Mesh[];
  spawnPoints: THREE.Vector3[];
}

function gridTexture(base: string, line: string, size = 512, cells = 8): THREE.CanvasTexture {
  const { canvas: c, g } = canvas2d(size);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = line;
  g.lineWidth = 3;
  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function crateTexture(): THREE.CanvasTexture {
  const size = 256;
  const { canvas: c, g } = canvas2d(size);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 14;
  g.strokeRect(7, 7, size - 14, size - 14);
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.15)';
  g.strokeRect(28, 28, size - 56, size - 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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

  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.Fog(theme.sky, 45, 130);

  scene.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 1.1));
  const sun = new THREE.DirectionalLight(theme.sun, 2.2);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const floorTex = gridTexture(theme.floor, theme.floorLine);
  floorTex.repeat.set(ARENA_HALF / 2, ARENA_HALF / 2);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  solids.push(floor);

  const crateMap = crateTexture();
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const material = (color: number) => {
    let mat = materials.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, map: crateMap, roughness: 0.8 });
      materials.set(color, mat);
    }
    return mat;
  };

  const addBox = (x: number, z: number, w: number, h: number, d: number, color: number, y = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    mesh.updateMatrixWorld();
    colliders.push(new THREE.Box3().setFromObject(mesh));
    solids.push(mesh);
  };

  // Perimeter walls
  const W = ARENA_HALF;
  addBox(0, -W, W * 2 + 1, 6, 1, theme.wall);
  addBox(0, W, W * 2 + 1, 6, 1, theme.wall);
  addBox(-W, 0, 1, 6, W * 2 + 1, theme.wall);
  addBox(W, 0, 1, 6, W * 2 + 1, theme.wall);

  for (const b of layout.boxes) addBox(b.x, b.z, b.w, b.h, b.d, b.color, b.y);

  const spawnPoints = layout.spawnPoints.map(([x, z]) => new THREE.Vector3(x, 0, z));

  return { colliders, solids, spawnPoints };
}
