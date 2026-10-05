import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GunKind } from '../types';

export type PickupGun = Exclude<GunKind, 'rifle'>;

export interface GunDef {
  name: string;
  /** Short label for the kill feed and HUD */
  icon: string;
  /** Pickup colour on the map */
  color: number;
  /** Keeps firing while the trigger is held */
  auto: boolean;
  /** Seconds between shots */
  fireInterval: number;
  mag: number;
  /** Spare rounds a fresh pickup comes with (the rifle never runs out) */
  reserve: number;
  reloadTime: number;
  /** Projectiles per shot (shotgun pellets) */
  pellets: number;
  bodyDamage: number;
  headDamage: number;
  /** Damage fades from full at `start` metres to `min` (fraction) at `end` metres */
  falloff?: { start: number; end: number; min: number };
  /** Spread in radians: base, extra while moving, extra in the air */
  spread: number;
  movingSpread: number;
  airSpread: number;
  /** Spread multiplier when fully aimed down sights */
  adsSpread: number;
  /** Camera kick per shot (radians) */
  recoil: number;
  /** Field of view when aimed (degrees); hip is 75 */
  adsFov: number;
  /** Aims through a scope overlay instead of iron sights */
  scope: boolean;
  /** Bullet range (m) */
  range: number;
  description: string;
}

export const GUNS: Record<GunKind, GunDef> = {
  rifle: {
    name: 'Rifle', icon: '▸', color: 0xcfd6e2, auto: true, fireInterval: 0.1, mag: 30, reserve: 90, reloadTime: 1.4,
    pellets: 1, bodyDamage: 20, headDamage: 50, falloff: { start: 25, end: 65, min: 0.6 }, spread: 0.002, movingSpread: 0.012, airSpread: 0.04, adsSpread: 0.3,
    recoil: 0.012, adsFov: 50, scope: false, range: 200, description: 'Automatic; ammo boxes refill it',
  },
  shotgun: {
    name: 'Shotgun', icon: '💥', color: 0xff7a45, auto: false, fireInterval: 0.85, mag: 6, reserve: 12, reloadTime: 2,
    pellets: 9, bodyDamage: 12, headDamage: 18, falloff: { start: 7, end: 28, min: 0.25 },
    spread: 0.065, movingSpread: 0.01, airSpread: 0.02, adsSpread: 0.65,
    recoil: 0.05, adsFov: 62, scope: false, range: 60, description: '9 pellets, devastating up close',
  },
  sniper: {
    name: 'Sniper', icon: '🎯', color: 0xa78bff, auto: false, fireInterval: 1.3, mag: 5, reserve: 10, reloadTime: 2.4,
    pellets: 1, bodyDamage: 75, headDamage: 150, falloff: { start: 80, end: 160, min: 0.8 }, spread: 0.06, movingSpread: 0.03, airSpread: 0.08, adsSpread: 0.015,
    recoil: 0.09, adsFov: 18, scope: true, range: 300, description: 'One-shot headshots; aim to use the scope',
  },
  deagle: {
    name: 'Deagle', icon: '🔫', color: 0xffd166, auto: false, fireInterval: 0.32, mag: 7, reserve: 21, reloadTime: 1.6,
    pellets: 1, bodyDamage: 40, headDamage: 90, falloff: { start: 15, end: 45, min: 0.5 }, spread: 0.004, movingSpread: 0.014, airSpread: 0.04, adsSpread: 0.4,
    recoil: 0.045, adsFov: 55, scope: false, range: 150, description: 'Hard-hitting semi-auto pistol',
  },
};

export const PICKUP_GUNS: PickupGun[] = ['shotgun', 'sniper', 'deagle'];

/** Most spare rounds a gun can hold: its starting reserve plus one extra magazine */
export const maxReserve = (kind: GunKind) => GUNS[kind].reserve + GUNS[kind].mag;

export const isPickupGun = (type: string): type is PickupGun => (PICKUP_GUNS as string[]).includes(type);

/** Most damage one shot can deal, used to reject impossible numbers from other clients. */
export const maxShotDamage = (kind: GunKind) => GUNS[kind].headDamage * GUNS[kind].pellets;

/** Damage of one pellet / bullet at `distance`. */
export function shotDamage(kind: GunKind, head: boolean, distance: number): number {
  const def = GUNS[kind];
  const base = head ? def.headDamage : def.bodyDamage;
  const f = def.falloff;
  if (!f || distance <= f.start) return base;
  const t = Math.min(1, (distance - f.start) / (f.end - f.start));
  return Math.round(base * (1 - t * (1 - f.min)));
}

// ---------------------------------------------------------------- models

// Low-poly guns from Quaternius's Ultimate Gun Pack (CC0), converted into one file with a mesh per gun:
// metres, barrel along -Z, muzzle at GUN_LAYOUT's `muzzle`. See the README's Credits.
const GUNS_URL = `${import.meta.env.BASE_URL}models/guns.glb`;

export interface GunModel {
  group: THREE.Group;
  /** Muzzle position in model space */
  muzzle: THREE.Vector3;
  /** Height of the sight line in model space (centred on screen when aiming) */
  sightHeight: number;
  /** Where the model sits at the hip, and how far in front when aiming */
  hip: THREE.Vector3;
  adsZ: number;
  /** Size in first person (1 = life size); bulky guns are drawn smaller so they don't fill the view */
  fpScale: number;
  /** Points on the barrel axis your hands hold: the grip (right hand), the fore-end (left), and where the left
   *  hand goes mid-reload (the magazine / loading port). The wrists sit at fixed offsets from these (fpArms.ts). */
  grip: THREE.Vector3;
  support: THREE.Vector3;
  mag: THREE.Vector3;
}

interface Layout {
  /** Length of the model, metres (first person; others see it a bit smaller) */
  length: number;
  muzzle: [number, number, number];
  /** Just over the top of the model (so you look over the iron sights), or the scope's centre */
  sightHeight: number;
  hip: [number, number, number];
  adsZ: number;
  fpScale?: number;
  grip: [number, number, number];
  support: [number, number, number];
  mag: [number, number, number];
}

const GUN_LAYOUT: Record<GunKind, Layout> = {
  // At the hip the guns sit low and to the right so the centre of the screen stays clear, pitched up a
  // little (HIP_CANT in weapon.ts). fpScale draws the bulkier ones smaller in first person only.
  rifle: { length: 0.95, muzzle: [0, 0.02, -0.55], sightHeight: 0.072, hip: [0.13, -0.11, -0.24], adsZ: -0.3, fpScale: 0.85,
    grip: [0, 0.02, 0.125], support: [0, 0.02, -0.17], mag: [0, -0.1, -0.12] },
  // The shotgun's pump is wider than a rifle handguard, so the left hand holds its side, not its centre line.
  shotgun: { length: 1.1, muzzle: [0, 0.035, -0.77], sightHeight: 0.078, hip: [0.13, -0.12, -0.2], adsZ: -0.25, fpScale: 0.75,
    grip: [0, 0.035, 0.06], support: [-0.017, 0.02, -0.25], mag: [0, -0.03, -0.06] },
  sniper: { length: 1.3, muzzle: [0, 0.02, -0.96], sightHeight: 0.069, hip: [0.14, -0.13, -0.14], adsZ: -0.22, fpScale: 0.8,
    grip: [0, 0.02, 0.04], support: [0, 0.02, -0.3], mag: [0, -0.06, -0.03] },
  // The pistol is held in the right hand only (fpArms hides the left arm), so its support point is unused. Its
  // grip point is lower and further back than the rifle's so the hand sits below the slide, not in it.
  deagle: { length: 0.3, muzzle: [0, 0.02, -0.22], sightHeight: 0.058, hip: [0.11, -0.13, -0.3], adsZ: -0.3, fpScale: 0.7,
    grip: [0, -0.002, 0.05], support: [-0.026, -0.01, 0.04], mag: [0, -0.12, 0.03] },
};

const meshes = new Map<GunKind, THREE.Object3D>();
let pendingGuns: Promise<void> | null = null;
/** Groups built before the file arrived, filled in when it does */
const waiting: { kind: GunKind; group: THREE.Group }[] = [];

/** Loads the gun models once; later calls share the same promise. */
export function loadGunModels(): Promise<void> {
  pendingGuns ??= new GLTFLoader()
    .loadAsync(GUNS_URL)
    .then((gltf) => {
      for (const kind of Object.keys(GUN_LAYOUT) as GunKind[]) {
        const mesh = gltf.scene.getObjectByName(kind);
        if (!mesh) throw new Error(`Gun models are missing "${kind}"`);
        mesh.traverse((o) => { o.castShadow = true; });
        mesh.removeFromParent();
        mesh.position.set(0, 0, 0);
        meshes.set(kind, mesh);
      }
      for (const { kind, group } of waiting.splice(0)) group.add(gunMesh(kind));
    })
    .catch((err: unknown) => {
      pendingGuns = null; // allow a retry on the next join
      throw err;
    });
  return pendingGuns;
}

/** A copy of a gun's mesh (geometry and materials are shared). */
function gunMesh(kind: GunKind): THREE.Object3D {
  return meshes.get(kind)!.clone();
}

/** The gun in first person (and on pickups): -Z forward, laid out per GUN_LAYOUT. */
export function buildGunModel(kind: GunKind): GunModel {
  const layout = GUN_LAYOUT[kind];
  const group = new THREE.Group();
  if (meshes.has(kind)) group.add(gunMesh(kind));
  else waiting.push({ kind, group });
  return {
    group,
    muzzle: new THREE.Vector3(...layout.muzzle),
    sightHeight: layout.sightHeight,
    hip: new THREE.Vector3(...layout.hip),
    adsZ: layout.adsZ,
    fpScale: layout.fpScale ?? 1,
    grip: new THREE.Vector3(...layout.grip),
    support: new THREE.Vector3(...layout.support),
    mag: new THREE.Vector3(...layout.mag),
  };
}

/** Other players hold a slightly smaller copy, so it fits the character's hands. */
const REMOTE_SCALE = 0.85;

/** Length of the gun in other players' hands (metres). */
export const remoteGunLength = (kind: GunKind): number => GUN_LAYOUT[kind].length * REMOTE_SCALE;

/**
 * The gun for another player's hands: +Z forward, origin on the bore halfway along, so the hand
 * (a fixed offset behind the centre) lands around the grip.
 */
export function buildRemoteGun(kind: GunKind): THREE.Group {
  const layout = GUN_LAYOUT[kind];
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = Math.PI;
  inner.position.set(0, -layout.muzzle[1], 0).multiplyScalar(REMOTE_SCALE);
  // Centre along the barrel: the muzzle is `length` in front of the back of the stock.
  inner.position.z = (layout.muzzle[2] + layout.length / 2) * REMOTE_SCALE;
  inner.scale.setScalar(REMOTE_SCALE);
  group.add(inner);
  if (meshes.has(kind)) inner.add(gunMesh(kind));
  else waiting.push({ kind, group: inner });
  return group;
}
