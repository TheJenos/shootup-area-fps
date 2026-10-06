/**
 * Models as pieces: the model itself (visual only) plus its collision boxes from the manifest,
 * rotated with it. The boxes are invisible; they stop players and bullets and show in the preview.
 */

import { PROPS, type PropId, type PropTag } from '../propManifest';
import { round, turn } from './core';
import type { MapBox, Piece, PropRot } from './types';

export { PROPS, type PropId };

/** Size of a prop after `rot` quarter turns. */
export function propSize(id: PropId, rot: PropRot, scale = 1): { w: number; d: number; h: number } {
  const p = PROPS[id];
  const odd = rot % 2 === 1;
  return { w: (odd ? p.d : p.w) * scale, d: (odd ? p.w : p.d) * scale, h: p.h * scale };
}


/** Natural things that can stand on a hillside (see MapProp.settle); everything else wants flat ground. */
const SETTLES = new Set<string>(['stump', 'bush', 'bush-small', 'log', 'campfire']);
const settles = (id: PropId) => SETTLES.has(id) || PROPS[id].tags.includes('tree') || PROPS[id].tags.includes('rock');

/** A model at (x, z) standing on `y`, turned `rot` quarter turns (its front, +z, turns toward +x first). */
export function propPiece(id: PropId, x: number, z: number, rot: PropRot, y = 0, scale = 1): Piece {
  const info = PROPS[id];
  const color = info.color;
  // Only things standing on the floor settle onto the terrain (not a bush on top of a hill piece).
  const settle = y === 0 && settles(id);
  const boxes: MapBox[] = info.colliders.map((c) => {
    const [dx, dz] = turn(c.dx * scale, c.dz * scale, rot);
    const odd = rot % 2 === 1;
    return {
      x: round(x + dx), z: round(z + dz),
      w: round((odd ? c.d : c.w) * scale), d: round((odd ? c.w : c.d) * scale), h: round(c.h * scale), y: round(y + c.y * scale),
      color, surface: 'concrete', visible: false, ...(c.blocks ? { blocks: c.blocks } : {}),
      // Off-centre boxes need re-placing in mirrored copies (see MapBox.pivot).
      ...(c.dx || c.dz ? { pivot: { x: round(x), z: round(z), rot, dx: c.dx * scale, dz: c.dz * scale, w: c.w * scale, d: c.d * scale } } : {}),
      ...(settle ? { rest: { x: round(x), z: round(z) } } : {}),
    };
  });
  return { boxes, props: [{ id, x: round(x), z: round(z), y: round(y), rot, ...(scale !== 1 ? { scale } : {}), ...(settle ? { settle: true as const } : {}) }] };
}

/** Every prop with a tag. */
export const propsTagged = (tag: PropTag): PropId[] =>
  (Object.keys(PROPS) as PropId[]).filter((id) => PROPS[id].tags.includes(tag));
