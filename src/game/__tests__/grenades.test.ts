import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { setThrowGravity, simulateGrenade, THROW_LIFT, THROW_SPEED } from '../grenades';

/** A throw straight ahead over open ground (no physics engine loaded: the plain integrator) */
const arc = () => simulateGrenade(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, THROW_LIFT, THROW_SPEED), [], 'grenade', () => 0);
const apex = (points: THREE.Vector3[]) => Math.max(...points.map((p) => p.y));

describe('thrown arcs', () => {
  afterEach(() => setThrowGravity(1));

  it('follow the mode\'s gravity rule: lower gravity, higher and longer flights', () => {
    const normal = arc();
    setThrowGravity(0.35);
    const moon = arc();
    expect(apex(moon.points)).toBeGreaterThan(apex(normal.points) + 0.5);
    expect(moon.end.z).toBeGreaterThan(normal.end.z + 2);
    expect(moon.duration).toBeGreaterThan(normal.duration);
  });

  it('are the same for every client on the same rules', () => {
    setThrowGravity(1.5);
    const a = arc();
    const b = arc();
    expect(a.points.map((p) => p.toArray())).toEqual(b.points.map((p) => p.toArray()));
    expect(a.end.toArray()).toEqual(b.end.toArray());
  });

  it('ignore a broken rule value', () => {
    const normal = arc();
    setThrowGravity(Number.NaN);
    expect(arc().end.toArray()).toEqual(normal.end.toArray());
  });
});
