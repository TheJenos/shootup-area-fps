/**
 * The map's symmetry: everything is built in red's half (z > 0) and copied into blue's, so both
 * teams get exactly the same map.
 *
 * - rotate: (x, z) → (-x, -z), a half turn about the middle. Both teams see the same thing on
 *   their left and right, so neither gets the easier peek around a corner.
 * - mirror: (x, z) → (x, -z), a reflection across the middle line.
 *
 * Models are turned rather than reflected (a reflected model would be inside out), so a lopsided
 * model's collision boxes are re-placed from their pivot (MapBox.pivot).
 */

import { mirrorRampDir } from '../rampMath';
import { q } from './dmath';
import type { MapBox, MapProp, Piece, PropRot } from './types';

export type Symmetry = 'rotate' | 'mirror';

/** The other team's copy of a point */
export function tPoint(sym: Symmetry, x: number, z: number): [number, number] {
  return sym === 'rotate' ? [q(-x), q(-z)] : [q(x), q(-z)];
}

/** Rotate an offset by quarter turns (same as a model's rotation.y). */
export function turn(dx: number, dz: number, rot: PropRot): [number, number] {
  switch (rot) {
    case 1: return [dz, -dx];
    case 2: return [-dx, -dz];
    case 3: return [-dz, dx];
    default: return [dx, dz];
  }
}

/** A model's turn in the other team's copy */
export function tRot(sym: Symmetry, rot: PropRot): PropRot {
  return (sym === 'rotate' ? (rot + 2) % 4 : (6 - rot) % 4) as PropRot;
}

function tBox(sym: Symmetry, b: MapBox): MapBox {
  const sx = sym === 'rotate' ? -1 : 1;
  if (b.pivot) {
    const p = b.pivot;
    const [x, z] = tPoint(sym, p.x, p.z);
    const rot = tRot(sym, p.rot);
    const [dx, dz] = turn(p.dx, p.dz, rot);
    const odd = rot % 2 === 1;
    return { ...b, x: q(x + dx), z: q(z + dz), w: q(odd ? p.d : p.w), d: q(odd ? p.w : p.d), pivot: { ...p, x, z, rot } };
  }
  const [x, z] = tPoint(sym, b.x, b.z);
  return { ...b, x, z, ...(b.ramp ? { ramp: mirrorRampDir(b.ramp, sx, -1) } : {}) };
}

function tProp(sym: Symmetry, p: MapProp): MapProp {
  const [x, z] = tPoint(sym, p.x, p.z);
  return { ...p, x, z, rot: tRot(sym, p.rot) };
}

/** The other team's copy of a piece */
export function tPiece(sym: Symmetry, piece: Piece): Piece {
  return {
    boxes: piece.boxes.map((b) => tBox(sym, b)),
    ...(piece.props ? { props: piece.props.map((p) => tProp(sym, p)) } : {}),
    ...(piece.patches ? { patches: piece.patches.map((g) => { const [x, z] = tPoint(sym, g.x, g.z); return { ...g, x, z }; }) } : {}),
  };
}

/** Index of the other team's copy of ground vertex (ix, iz) on an n-cell grid */
export function tVertex(sym: Symmetry, n: number, ix: number, iz: number): number {
  return sym === 'rotate' ? (n - iz) * (n + 1) + (n - ix) : (n - iz) * (n + 1) + ix;
}
