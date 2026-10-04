import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Soldier.glb from the three.js examples (a Mixamo character). Served from public/.
const MODEL_URL = `${import.meta.env.BASE_URL}models/Soldier.glb`;

export const GAITS = ['Idle', 'Walk', 'Run'] as const;
export type Gait = (typeof GAITS)[number];

export interface CharacterAsset {
  scene: THREE.Object3D;
  clips: Record<Gait, THREE.AnimationClip>;
}

let pending: Promise<CharacterAsset> | null = null;

/** Loads the player model once; later calls share the same promise. */
export function loadCharacter(): Promise<CharacterAsset> {
  pending ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      const clip = (name: Gait) => {
        const found = THREE.AnimationClip.findByName(gltf.animations, name);
        if (!found) throw new Error(`Character model is missing the "${name}" animation`);
        return found;
      };
      return { scene: gltf.scene, clips: { Idle: clip('Idle'), Walk: clip('Walk'), Run: clip('Run') } };
    })
    .catch((err: unknown) => {
      pending = null; // allow a retry on the next join
      throw err;
    });
  return pending;
}

/** A fresh copy of the model with its own skeleton, so each player animates independently. */
export function cloneCharacter(asset: CharacterAsset): THREE.Object3D {
  return SkeletonUtils.clone(asset.scene);
}
