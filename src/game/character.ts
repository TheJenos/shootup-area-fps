import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Quaternius's SWAT character (CC0), converted by scripts/build-character.mjs. Served from public/.
const MODEL_URL = `${import.meta.env.BASE_URL}models/Soldier.glb`;

/** The rig's bones (three.js drops the dots from the file's names: "Wrist.R" is "WristR"). */
export const BONES = {
  /** Moves the whole body: the animations translate it, and the legs and upper body hang off it */
  body: 'Body',
  chest: 'Chest',
  head: 'Head',
  rightArm: ['UpperArmR', 'LowerArmR', 'WristR'],
  leftArm: ['UpperArmL', 'LowerArmL', 'WristL'],
  thighs: ['UpperLegL', 'UpperLegR'],
  shins: ['LowerLegL', 'LowerLegR'],
  feet: ['FootL', 'FootR'],
  /** Each hand's fingers, knuckle to tip (each finger's first bone is the palm), then the thumb's last two joints */
  rightFingers: fingers('R'),
  leftFingers: fingers('L'),
} as const;

function fingers(side: 'R' | 'L'): string[][] {
  return [
    ...['Index', 'Middle', 'Ring', 'Pinky'].map((f) => [2, 3, 4].map((n) => `${f}${n}${side}`)),
    [`Thumb2${side}`, `Thumb3${side}`],
  ];
}

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
