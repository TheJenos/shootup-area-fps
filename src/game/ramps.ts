import * as THREE from 'three';
import { mirrorRampDir, rampHeightAt as heightOnRamp, type RampDir } from './rampMath';

export { mirrorRampDir, type RampDir };

/** A sloped surface players walk up. `box` is its full footprint and height range. */
export interface Ramp {
  box: THREE.Box3;
  dir: RampDir;
}

/** Height of the ramp's surface at (x, z), clamped to its footprint. */
export function rampHeightAt(r: Ramp, x: number, z: number): number {
  const { min, max } = r.box;
  return heightOnRamp(r.dir, min.x, max.x, min.z, max.z, min.y, max.y, x, z);
}

/** Whether (x, z) is over the ramp (optionally grown by `pad`). */
export function overRamp(r: Ramp, x: number, z: number, pad = 0): boolean {
  const { min, max } = r.box;
  return x > min.x - pad && x < max.x + pad && z > min.z - pad && z < max.z + pad;
}

/**
 * A wedge: a box footprint (w × d) whose top slopes from the floor at the low end up to `h`
 * at the high end. Centred on x / z, bottom at y = 0. Non-indexed so every face has flat normals.
 */
export function wedgeGeometry(w: number, h: number, d: number, dir: RampDir): THREE.BufferGeometry {
  const hx = w / 2;
  const hz = d / 2;
  // Height of the top surface at each footprint corner
  const top = (x: number, z: number) => {
    const along = dir[0] === 'x' ? (x + hx) / w : (z + hz) / d;
    return h * (dir[1] === '+' ? along : 1 - along);
  };
  const corners: [number, number][] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  const positions: number[] = [];
  const uvs: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, e: THREE.Vector3, uvScale: [number, number]) => {
    for (const v of [a, b, c, a, c, e]) positions.push(v.x, v.y, v.z);
    const [su, sv] = uvScale;
    uvs.push(0, 0, su, 0, su, sv, 0, 0, su, sv, 0, sv);
  };
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    for (const v of [a, b, c]) positions.push(v.x, v.y, v.z);
    uvs.push(0, 0, 1, 0, 1, 1);
  };
  const lo = corners.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const hi = corners.map(([x, z]) => new THREE.Vector3(x, top(x, z), z));
  // Top (sloped), wound counter-clockwise seen from above
  quad(hi[0]!, hi[3]!, hi[2]!, hi[1]!, [w / 2, d / 2]);
  // Bottom
  quad(lo[0]!, lo[1]!, lo[2]!, lo[3]!, [w / 2, d / 2]);
  // Four sides (two are triangles, two are quads, depending on the slope axis); degenerate ones are skipped
  const side = (i: number, j: number) => {
    const a = lo[i]!; const b = lo[j]!; const c = hi[j]!; const e = hi[i]!;
    const ha = e.y; const hb = c.y;
    if (ha < 1e-6 && hb < 1e-6) return;
    if (ha < 1e-6) tri(a, b, c);
    else if (hb < 1e-6) tri(a, b, e);
    else quad(a, b, c, e, [Math.hypot(b.x - a.x, b.z - a.z) / 2, Math.max(ha, hb) / 2]);
  };
  side(1, 0); side(2, 1); side(3, 2); side(0, 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
