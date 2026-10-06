import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_HALF, type MapBox, type MapLayout, type StepSurface } from './mapgen';
import type { Quality } from './settings';
import { overRamp, rampHeightAt, wedgeGeometry, type Ramp } from './ramps';
import {
  FLOOR_TILE, GROUND_TILE, SURFACE_TILE, boxTexture, floorTexture, groundTexture, scaleBoxUVs, skyTexture, spawnMarkerTexture,
  type BoxSurface,
} from './textures';
import { propParts, whenPropsReady } from './props';

/** The sky dome sits inside the camera's far plane (300 m) and follows the camera. */
const SKY_RADIUS = 250;

export { ARENA_HALF };

/** The lists a world fills in place, so everything holding them sees each new map. */
export interface WorldLists {
  /** Axis-aligned boxes the player collides with */
  colliders: THREE.Box3[];
  /** Meshes bullets can hit (invisible proxies for the merged map geometry) */
  solids: THREE.Mesh[];
  /** Sloped surfaces the player walks up */
  ramps: Ramp[];
  /** Everything that takes up floor space (boxes and ramps), for placing pickups */
  obstacles: THREE.Box3[];
}

export interface WorldOptions {
  /** Prop models the caller will simulate as loose physics bodies: they're left out of the static map */
  looseProps?: ReadonlySet<string>;
}

export interface World extends WorldLists {
  spawnPoints: THREE.Vector3[];
  /** Keep this centered on the camera so the horizon never gets closer */
  sky: THREE.Object3D;
  /** Everything the map added to the scene */
  root: THREE.Group;
  /** The props left out for the caller to simulate (see WorldOptions.looseProps) */
  looseProps: MapLayout['props'];
  /**
   * The top of whatever is under `p` (the floor is 0) and what footsteps on it sound like (null
   * means the map's floor). Boxes count if their top is at most 5 cm above p, ramps 30 cm.
   */
  groundAt(p: THREE.Vector3): { y: number; surface: StepSurface | null };
  /** Shadow map resolution and surface detail (bump maps) for the graphics quality setting */
  setQuality(quality: Quality): void;
  /** Remove the map from the scene and free its geometry and materials (textures and models are shared) */
  dispose(): void;
}

/**
 * A cylinder's collision: three boxes (half-sizes as fractions of its width and depth) whose union is
 * an eight-sided shape inside the circle. Each box's corners touch the circle (0.46² + 0.19² ≈ 0.5²).
 */
const CYLINDER_FIT = [[0.46, 0.19], [0.19, 0.46], [0.3535, 0.3535]] as const;

/** The invisible boundary around the map: how high it goes and how thick it is (m) */
const BOUNDARY_HEIGHT = 200;
const BOUNDARY_THICKNESS = 4;

const SHADOW_SIZE: Record<Quality, number> = { low: 512, medium: 1024, high: 2048 };

/** Footsteps on a box's top, from its texture unless the layout says otherwise. */
const stepFor = (b: { surface: BoxSurface; step?: StepSurface }): StepSurface =>
  b.step ?? (b.surface === 'crate' || b.surface === 'planks' ? 'wood' : b.surface === 'grass' ? 'sand' : 'hard');

/** Ground patches that change the footstep sound */
const GROUND_STEP: Partial<Record<string, StepSurface>> = { grass: 'sand', dirt: 'sand' };

/**
 * Builds the map from a generated layout (see mapgen.ts). Every client generates
 * the same layout from the room's seed, so they all see the same map.
 *
 * Boxes are merged into one mesh per texture and colour (per quarter of the map, so frustum
 * culling still works), with an invisible box per obstacle in `solids` for bullets. Models
 * (layout.props) are drawn as InstancedMeshes once props.glb has loaded; their collision is
 * the invisible boxes the generator placed with them.
 *
 * Fills `colliders` (Box3, for movement) and `solids` (meshes, for bullet raycasts) in place,
 * so code holding on to those arrays sees the new map when it's rebuilt for the next round.
 */
export function buildWorld(scene: THREE.Scene, layout: MapLayout, lists: WorldLists, options: WorldOptions = {}): World {
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

  // Indoor maps lean on the sky light: rooms only get the sun through windows and skylights.
  const indoor = layout.style === 'industrial' || layout.style === 'town';
  root.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, indoor ? 1.45 : 1.1));
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
  const floorMat = new THREE.MeshStandardMaterial({ map: floorMap, bumpMap: floorMap, bumpScale: 0.6, roughness: 0.95 });
  /** Materials whose colour texture doubles as a bump map; the bump is dropped below high quality. */
  const bumped: THREE.MeshStandardMaterial[] = [floorMat];
  const floor = new THREE.Mesh(floorGeo, floorMat);
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
      const shiny = surface === 'metal' || surface === 'container';
      mat = new THREE.MeshStandardMaterial({
        color,
        map,
        bumpMap: map,
        bumpScale: shiny ? 1.2 : surface === 'plaster' ? 0.3 : 0.8,
        roughness: shiny ? 0.55 : 0.85,
        metalness: shiny ? 0.35 : 0,
      });
      materials.set(key, mat);
      bumped.push(mat);
    }
    return mat;
  };

  // Invisible boxes bullets and line-of-sight rays hit (raycasting ignores `visible`).
  const proxies = new THREE.Group();
  proxies.visible = false;
  root.add(proxies);
  const proxyGeo = new THREE.BoxGeometry(1, 1, 1);
  const proxyMat = new THREE.MeshBasicMaterial();
  const addProxy = (b: { x: number; z: number; w: number; h: number; d: number; y: number }) => {
    const mesh = new THREE.Mesh(proxyGeo, proxyMat);
    mesh.position.set(b.x, b.y + b.h / 2, b.z);
    mesh.scale.set(b.w, b.h, b.d);
    proxies.add(mesh);
    mesh.updateMatrixWorld();
    solids.push(mesh);
  };

  /** Footsteps on each collider or ramp, for groundAt */
  const stepOf = new WeakMap<THREE.Box3, StepSurface>();

  // Visible boxes are gathered per material and quarter, then merged.
  const batches = new Map<string, { surface: BoxSurface; color: number; geos: THREE.BufferGeometry[] }>();
  const addVisual = (b: MapBox) => {
    let geo: THREE.BufferGeometry;
    if (b.shape === 'cylinder') {
      geo = new THREE.CylinderGeometry(b.w / 2, b.w / 2, b.h, 18);
      geo.scale(1, 1, b.d / b.w);
    } else {
      const box = new THREE.BoxGeometry(b.w, b.h, b.d);
      const tile = SURFACE_TILE[b.surface];
      if (tile) scaleBoxUVs(box, b.w, b.h, b.d, tile);
      geo = box;
    }
    geo.translate(b.x, b.y + b.h / 2, b.z);
    const key = `${b.surface}:${b.color}:${b.x >= 0 ? 1 : 0}${b.z >= 0 ? 1 : 0}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { surface: b.surface, color: b.color, geos: [] };
      batches.set(key, batch);
    }
    batch.geos.push(geo);
  };

  /** A round thing's invisible stand-in for bullets: the cylinder itself, not its box. */
  const proxyCylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
  const addCylinderProxy = (b: MapBox) => {
    const mesh = new THREE.Mesh(proxyCylGeo, proxyMat);
    mesh.position.set(b.x, b.y + b.h / 2, b.z);
    mesh.scale.set(b.w, b.h, b.d);
    proxies.add(mesh);
    mesh.updateMatrixWorld();
    solids.push(mesh);
  };

  const addBox = (b: MapBox) => {
    const blocks = b.blocks ?? 'all';
    if (b.visible !== false) addVisual(b);
    if (blocks !== 'shots') {
      // Cylinders (tanks, barrels) collide as an eight-sided shape that stays inside them, not as
      // their box: no invisible corners to bump into.
      const parts = b.shape === 'cylinder' ? CYLINDER_FIT : [[0.5, 0.5] as const];
      for (const [fx, fz] of parts) {
        const box = new THREE.Box3(
          new THREE.Vector3(b.x - b.w * fx, b.y, b.z - b.d * fz),
          new THREE.Vector3(b.x + b.w * fx, b.y + b.h, b.z + b.d * fz),
        );
        colliders.push(box);
        obstacles.push(box);
        stepOf.set(box, stepFor(b));
      }
    }
    if (blocks !== 'move') {
      if (b.shape === 'cylinder') addCylinderProxy(b);
      else addProxy(b);
    }
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
    mesh.visible = b.visible !== false;
    root.add(mesh);
    mesh.updateMatrixWorld();
    const box = new THREE.Box3(
      new THREE.Vector3(b.x - b.w / 2, b.y, b.z - b.d / 2),
      new THREE.Vector3(b.x + b.w / 2, b.y + b.h, b.z + b.d / 2),
    );
    ramps.push({ box, dir: b.ramp! });
    obstacles.push(box);
    stepOf.set(box, stepFor(b));
    solids.push(mesh);
  };

  // Perimeter walls
  const W = ARENA_HALF;
  const wall = (x: number, z: number, w: number, d: number): MapBox => ({ x, z, w, h: 6, d, y: 0, color: theme.wall, surface: 'perimeter' });
  for (const b of [wall(0, -W, W * 2 + 1, 1), wall(0, W, W * 2 + 1, 1), wall(-W, 0, 1, W * 2 + 1), wall(W, 0, 1, W * 2 + 1)]) addBox(b);

  // Invisible boundary: tall walls over the perimeter so nobody gets out of the map, however high
  // they get (a jump off a roof edge, a dash, a ragdoll, a grenade). Movement only: bullets still fly
  // out into the sky, and pickups don't treat them as floor space.
  const T = BOUNDARY_THICKNESS;
  for (const [x0, z0, x1, z1] of [
    [-W - T, -W - T, W + T, -W + 0.5], [-W - T, W - 0.5, W + T, W + T],
    [-W - T, -W - T, -W + 0.5, W + T], [W - 0.5, -W - T, W + T, W + T],
  ] as const) {
    colliders.push(new THREE.Box3(new THREE.Vector3(x0, -10, z0), new THREE.Vector3(x1, BOUNDARY_HEIGHT, z1)));
  }

  for (const b of layout.boxes) {
    if (b.ramp) addRamp(b);
    else addBox(b);
  }

  for (const batch of batches.values()) {
    const merged = mergeGeometries(batch.geos, false);
    batch.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material(batch.surface, batch.color));
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Ground patches: flat overlays (streets, lawns...), merged per kind.
  const groundGeos = new Map<string, THREE.BufferGeometry[]>();
  for (const g of layout.ground) {
    const geo = new THREE.PlaneGeometry(g.w, g.d).rotateX(-Math.PI / 2);
    const tile = GROUND_TILE[g.kind];
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    // Roads run along their long side: the texture's centre line follows it.
    const along = g.d >= g.w;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (g.kind === 'road') uv.setXY(i, along ? u : v * (g.d / tile), along ? v * (g.d / tile) : u);
      else uv.setXY(i, (u * g.w) / tile, (v * g.d) / tile);
    }
    geo.translate(g.x, 0, g.z);
    const list = groundGeos.get(g.kind) ?? [];
    list.push(geo);
    groundGeos.set(g.kind, list);
  }
  for (const [kind, geos] of groundGeos) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const map = groundTexture(kind as MapLayout['ground'][number]['kind']);
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      map, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    mesh.position.y = 0.004;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Models, drawn once props.glb has loaded (their collision is already in place).
  const propsRoot = new THREE.Group();
  root.add(propsRoot);
  let disposed = false;
  const addProps = () => {
    if (disposed) return;
    const byId = new Map<string, MapLayout['props']>();
    for (const p of layout.props) {
      if (options.looseProps?.has(p.id)) continue;
      const list = byId.get(p.id) ?? [];
      list.push(p);
      byId.set(p.id, list);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [id, list] of byId) {
      const parts = propParts(id);
      if (!parts) continue;
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        mesh.userData.shared = true;
        list.forEach((p, i) => {
          q.setFromAxisAngle(up, (p.rot * Math.PI) / 2);
          m.compose(pos.set(p.x, p.y, p.z), q, scale.setScalar(p.scale ?? 1));
          mesh.setMatrixAt(i, m);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = mesh.receiveShadow = true;
        propsRoot.add(mesh);
      }
    }
    freeze(propsRoot);
  };
  const unsubscribe = layout.props.length ? whenPropsReady(addProps) : () => {};

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

  const groundAt = (p: THREE.Vector3): { y: number; surface: StepSurface | null } => {
    let y = 0;
    let surface: StepSurface | null = null;
    for (const c of colliders) {
      if (p.x > c.min.x && p.x < c.max.x && p.z > c.min.z && p.z < c.max.z && c.max.y <= p.y + 0.05 && c.max.y > y) {
        y = c.max.y;
        surface = stepOf.get(c) ?? 'wood';
      }
    }
    for (const r of ramps) {
      if (!overRamp(r, p.x, p.z)) continue;
      const h = rampHeightAt(r, p.x, p.z);
      if (h <= p.y + 0.3 && h > y) {
        y = h;
        surface = stepOf.get(r.box) ?? 'hard';
      }
    }
    if (surface === null) {
      // On the floor: a lawn or a dirt patch changes the sound.
      for (const g of layout.ground) {
        const s = GROUND_STEP[g.kind];
        if (s && Math.abs(p.x - g.x) < g.w / 2 && Math.abs(p.z - g.z) < g.d / 2) surface = s;
      }
    }
    return { y, surface };
  };

  const setQuality = (quality: Quality) => {
    const size = SHADOW_SIZE[quality];
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      // The map is allocated at the old size; drop it so it's rebuilt.
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // Bump mapping costs a few texture reads per pixel on nearly every surface.
    const bump = quality === 'high';
    for (const mat of bumped) {
      if ((mat.bumpMap !== null) === bump) continue;
      mat.bumpMap = bump ? mat.map : null;
      mat.needsUpdate = true;
    }
  };

  // Nothing in the map moves (except the sky, which follows the camera): work out every matrix
  // once instead of every frame.
  freeze(root);
  sky.matrixAutoUpdate = true;

  const dispose = () => {
    disposed = true;
    unsubscribe();
    scene.remove(root);
    const geometries = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.userData.shared) {
        // The model's geometry and material belong to props.ts; free only the instance data.
        o.dispose();
        return;
      }
      if (!(o instanceof THREE.Mesh)) return;
      geometries.add(o.geometry);
      for (const m of [o.material].flat()) mats.add(m as THREE.Material);
    });
    geometries.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    sun.shadow.map?.dispose();
  };

  const looseProps = layout.props.filter((p) => options.looseProps?.has(p.id));
  return { colliders, solids, ramps, obstacles, spawnPoints, sky, root, looseProps, groundAt, setQuality, dispose };
}

/** Compute `root`'s matrices now and stop three.js recomputing them each frame (for things that never move). */
function freeze(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => { o.matrixAutoUpdate = false; });
}
