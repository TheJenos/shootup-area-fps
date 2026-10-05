import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/*
 * Map prop models: Kenney CC0 buildings, street furniture, industrial pieces and nature, converted
 * by scripts/build-props.mjs into one file with a node per prop (named by its id), all sharing
 * one vertex-coloured material. The map generator only uses their footprints (propManifest.ts);
 * the world draws them as InstancedMeshes once the file has loaded.
 */

const PROPS_URL = `${import.meta.env.BASE_URL}models/props.glb`;

/** One drawable part of a prop: shared geometry and material (never disposed by a world). */
export interface PropPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

const parts = new Map<string, PropPart[]>();
let pending: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

/** Loads the prop models once; later calls share the same promise. */
export function loadPropModels(): Promise<void> {
  pending ??= new GLTFLoader()
    .loadAsync(PROPS_URL)
    .then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      for (const node of gltf.scene.children) {
        const list: PropPart[] = [];
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // Bake the node's transform: quantized models keep their dequantizing scale and offset there.
          const geometry = mesh.geometry.clone();
          geometry.applyMatrix4(mesh.matrixWorld);
          geometry.computeBoundingSphere();
          list.push({ geometry, material: mesh.material as THREE.Material });
        });
        if (list.length) parts.set(node.name, list);
      }
      loaded = true;
      for (const cb of [...listeners]) cb();
      listeners.clear();
    })
    .catch((err: unknown) => {
      pending = null; // allow a retry on the next join
      throw err;
    });
  return pending;
}

/** The parts of a prop, or null until the models have loaded (or if the id is unknown). */
export function propParts(id: string): readonly PropPart[] | null {
  return parts.get(id) ?? null;
}

/** Call back once the models are loaded (right away if they already are). Returns an unsubscribe. */
export function whenPropsReady(cb: () => void): () => void {
  if (loaded) {
    cb();
    return () => {};
  }
  listeners.add(cb);
  return () => listeners.delete(cb);
}
