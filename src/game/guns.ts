import * as THREE from 'three';
import { woodTexture, wornMetalTexture } from './textures';
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
    name: 'Rifle', icon: '▸', color: 0xcfd6e2, auto: true, fireInterval: 0.1, mag: 30, reserve: Infinity, reloadTime: 1.4,
    pellets: 1, bodyDamage: 20, headDamage: 50, spread: 0.002, movingSpread: 0.012, airSpread: 0.04, adsSpread: 0.3,
    recoil: 0.012, adsFov: 50, scope: false, range: 200, description: 'Automatic, never runs out of ammo',
  },
  shotgun: {
    name: 'Shotgun', icon: '💥', color: 0xff7a45, auto: false, fireInterval: 0.85, mag: 6, reserve: 12, reloadTime: 2,
    pellets: 9, bodyDamage: 12, headDamage: 18, falloff: { start: 7, end: 28, min: 0.25 },
    spread: 0.065, movingSpread: 0.01, airSpread: 0.02, adsSpread: 0.65,
    recoil: 0.05, adsFov: 62, scope: false, range: 60, description: '9 pellets, devastating up close',
  },
  sniper: {
    name: 'Sniper', icon: '🎯', color: 0xa78bff, auto: false, fireInterval: 1.3, mag: 5, reserve: 10, reloadTime: 2.4,
    pellets: 1, bodyDamage: 75, headDamage: 150, spread: 0.06, movingSpread: 0.03, airSpread: 0.08, adsSpread: 0.015,
    recoil: 0.09, adsFov: 18, scope: true, range: 300, description: 'One-shot headshots; aim to use the scope',
  },
  deagle: {
    name: 'Deagle', icon: '🔫', color: 0xffd166, auto: false, fireInterval: 0.32, mag: 7, reserve: 21, reloadTime: 1.6,
    pellets: 1, bodyDamage: 40, headDamage: 90, spread: 0.004, movingSpread: 0.014, airSpread: 0.04, adsSpread: 0.4,
    recoil: 0.045, adsFov: 55, scope: false, range: 150, description: 'Hard-hitting semi-auto pistol',
  },
};

export const PICKUP_GUNS: PickupGun[] = ['shotgun', 'sniper', 'deagle'];

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

// ---------------------------------------------------------------- first-person models

export interface GunModel {
  group: THREE.Group;
  /** Muzzle position in model space */
  muzzle: THREE.Vector3;
  /** Height of the sight line in model space (centred on screen when aiming) */
  sightHeight: number;
  /** Where the model sits at the hip, and how far in front when aiming */
  hip: THREE.Vector3;
  adsZ: number;
}

type Mat = THREE.Material;

function builder(group: THREE.Group) {
  return (geo: THREE.BufferGeometry, mat: Mat, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    group.add(m);
    return m;
  };
}

let shared: { dark: Mat; wood: Mat; scopeGlass: Mat } | null = null;
function materials() {
  shared ??= {
    dark: new THREE.MeshStandardMaterial({ map: wornMetalTexture(), roughness: 0.5, metalness: 0.4 }),
    wood: new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.8 }),
    scopeGlass: new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.8, emissive: 0x112233 }),
  };
  return shared;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const tube = (r: number, len: number) => new THREE.CylinderGeometry(r, r, len, 12);

export function buildGunModel(kind: GunKind): GunModel {
  const { dark, wood, scopeGlass } = materials();
  const group = new THREE.Group();
  const part = builder(group);

  switch (kind) {
    case 'rifle': {
      const sight = 0.118;
      part(box(0.09, 0.11, 0.5), dark, 0, 0, 0);
      part(tube(0.018, 0.3), dark, 0, 0.02, -0.38, Math.PI / 2);
      part(box(0.06, 0.18, 0.08), dark, 0, -0.13, -0.05, 0.2);
      part(box(0.07, 0.16, 0.09), wood, 0, -0.12, 0.17, -0.3);
      part(box(0.08, 0.09, 0.2), wood, 0, -0.01, 0.32);
      part(box(0.03, 0.04, 0.12), dark, 0, 0.075, -0.05);
      // Iron sights: notched rear sight on the rail, post at the muzzle.
      part(box(0.012, 0.03, 0.012), dark, -0.014, 0.11, 0);
      part(box(0.012, 0.03, 0.012), dark, 0.014, 0.11, 0);
      part(box(0.008, 0.08, 0.012), dark, 0, sight - 0.04, -0.5);
      return { group, muzzle: new THREE.Vector3(0, 0.02, -0.55), sightHeight: sight, hip: new THREE.Vector3(0.22, -0.22, -0.5), adsZ: -0.3 };
    }
    case 'shotgun': {
      const sight = 0.085;
      part(box(0.1, 0.12, 0.34), dark, 0, 0, 0.02);
      part(tube(0.026, 0.62), dark, 0, 0.035, -0.45, Math.PI / 2);
      part(tube(0.022, 0.5), dark, 0, -0.018, -0.4, Math.PI / 2);
      // Pump grip under the barrel
      part(box(0.075, 0.07, 0.2), wood, 0, -0.03, -0.32);
      part(box(0.07, 0.15, 0.08), wood, 0, -0.12, 0.13, -0.35);
      part(box(0.085, 0.1, 0.26), wood, 0, -0.03, 0.3);
      // Bead sight at the muzzle and a groove at the back
      part(new THREE.SphereGeometry(0.01, 8, 6), dark, 0, sight, -0.74);
      part(box(0.03, 0.02, 0.02), dark, 0, sight - 0.01, 0.12);
      return { group, muzzle: new THREE.Vector3(0, 0.035, -0.77), sightHeight: sight, hip: new THREE.Vector3(0.22, -0.23, -0.48), adsZ: -0.32 };
    }
    case 'sniper': {
      const sight = 0.125;
      part(box(0.08, 0.1, 0.62), dark, 0, 0, 0);
      part(tube(0.016, 0.62), dark, 0, 0.02, -0.6, Math.PI / 2);
      part(tube(0.026, 0.08), dark, 0, 0.02, -0.92, Math.PI / 2);
      part(box(0.06, 0.17, 0.07), dark, 0, -0.12, -0.04, 0.25);
      part(box(0.075, 0.13, 0.32), wood, 0, -0.04, 0.38);
      // Scope on two mounts
      part(tube(0.034, 0.34), dark, 0, sight, -0.05, Math.PI / 2);
      part(tube(0.042, 0.05), dark, 0, sight, -0.23, Math.PI / 2);
      part(new THREE.CircleGeometry(0.03, 16), scopeGlass, 0, sight, 0.121);
      part(box(0.02, 0.05, 0.03), dark, 0, 0.07, -0.13);
      part(box(0.02, 0.05, 0.03), dark, 0, 0.07, 0.04);
      return { group, muzzle: new THREE.Vector3(0, 0.02, -0.96), sightHeight: sight, hip: new THREE.Vector3(0.22, -0.24, -0.5), adsZ: -0.22 };
    }
    case 'deagle': {
      const sight = 0.07;
      part(box(0.05, 0.07, 0.27), dark, 0, 0.02, -0.04);
      part(tube(0.012, 0.04), dark, 0, 0.02, -0.19, Math.PI / 2);
      part(box(0.045, 0.16, 0.07), wood, 0, -0.08, 0.06, 0.2);
      part(box(0.04, 0.015, 0.05), dark, 0, -0.03, 0.0);
      part(box(0.01, 0.018, 0.01), dark, 0, sight - 0.009, -0.16);
      part(box(0.01, 0.016, 0.01), dark, -0.012, sight - 0.008, 0.07);
      part(box(0.01, 0.016, 0.01), dark, 0.012, sight - 0.008, 0.07);
      return { group, muzzle: new THREE.Vector3(0, 0.02, -0.22), sightHeight: sight, hip: new THREE.Vector3(0.18, -0.18, -0.42), adsZ: -0.32 };
    }
  }
}

/** Size of the box drawn in other players' hands for each gun (x, y, z in metres). */
export const REMOTE_GUN_SIZE: Record<GunKind, [number, number, number]> = {
  rifle: [0.06, 0.09, 0.55],
  shotgun: [0.07, 0.1, 0.62],
  sniper: [0.06, 0.09, 0.85],
  deagle: [0.05, 0.08, 0.26],
};
