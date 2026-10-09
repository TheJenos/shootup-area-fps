import type { GunKind } from '../types';

/*
 * Gun numbers only (no models): shared by the game, bots and the headless training simulator.
 */

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
