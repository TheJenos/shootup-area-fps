/**
 * What maps are filled with: cover, models (props.glb), huts and the middle's centrepiece. Every
 * kit builds a Piece standing on y = 0 around a point; fill.ts sets it on the ground.
 *
 * Sizes follow the player (playerDims.ts): 0.7 m wide, 1.75 m tall, steps up 0.7 m, jumps about
 * 1.3 m. Low cover (~1.1 m) hides you crouching, mid cover (~1.8 m) standing, tall cover (2.4 m+)
 * breaks sightlines.
 */

import { PROPS, type PropId } from '../propManifest';
import type { BoxSurface } from '../textures';
import { q } from './dmath';
import type { Rng } from './rng';
import { turn } from './symmetry';
import type { MapBox, MapTheme, Piece, PropRot } from './types';

/** A kit that builds something at (x, z), turned to run along `axis` */
export type Kit = (k: KitContext, x: number, z: number, axis: 'x' | 'z') => Piece;

export interface KitContext {
  rng: Rng;
  theme: MapTheme;
  color(): number;
}

export const box = (x: number, z: number, w: number, h: number, d: number, y: number, color: number, surface: BoxSurface, extra: Partial<MapBox> = {}): MapBox => ({
  x: q(x), z: q(z), w: q(w), h: q(h), d: q(d), y: q(y), color, surface, ...extra,
});

/** A box that runs along `axis`: `long` along it, `thick` across. */
const along = (axis: 'x' | 'z', x: number, z: number, long: number, thick: number, h: number, y: number, color: number, surface: BoxSurface, extra: Partial<MapBox> = {}) =>
  axis === 'x' ? box(x, z, long, h, thick, y, color, surface, extra) : box(x, z, thick, h, long, y, color, surface, extra);

/** A model at (x, z) standing on `y`, turned `rot` quarter turns, with its collision boxes. */
export function propPiece(id: PropId, x: number, z: number, rot: PropRot, y = 0, scale = 1): Piece {
  const info = PROPS[id];
  const boxes: MapBox[] = info.colliders.map((c) => {
    const [dx, dz] = turn(c.dx * scale, c.dz * scale, rot);
    const odd = rot % 2 === 1;
    return {
      x: q(x + dx), z: q(z + dz),
      w: q((odd ? c.d : c.w) * scale), d: q((odd ? c.w : c.d) * scale), h: q(c.h * scale), y: q(y + c.y * scale),
      color: info.color, surface: 'concrete', visible: false, ...(c.blocks ? { blocks: c.blocks } : {}),
      ...(c.dx || c.dz ? { pivot: { x: q(x), z: q(z), rot, dx: c.dx * scale, dz: c.dz * scale, w: c.w * scale, d: c.d * scale } } : {}),
    } satisfies MapBox;
  });
  return { boxes, props: [{ id, x: q(x), z: q(z), y: q(y), rot, ...(scale !== 1 ? { scale } : {}) }] };
}

/** A model kit: one of `ids`, turned to suit the axis (or any way, `anyTurn`) */
export const model = (ids: readonly PropId[], scale: [number, number] = [1, 1], anyTurn = false): Kit => (k, x, z, axis) => {
  const id = k.rng.pick(ids);
  const rot = (anyTurn ? k.rng.int(0, 3) : ((axis === 'x' ? 0 : 1) + (k.rng.chance(0.5) ? 2 : 0)) % 4) as PropRot;
  return propPiece(id, x, z, rot, 0, scale[0] === scale[1] ? scale[0] : q(k.rng.range(scale[0], scale[1])));
};

/** Merge pieces */
export function merge(...pieces: Piece[]): Piece {
  return {
    boxes: pieces.flatMap((p) => p.boxes),
    props: pieces.flatMap((p) => p.props ?? []),
    patches: pieces.flatMap((p) => p.patches ?? []),
  };
}

/** A piece moved up by dy */
export function lift(piece: Piece, dy: number): Piece {
  return {
    boxes: piece.boxes.map((b) => ({ ...b, y: q(b.y + dy) })),
    ...(piece.props ? { props: piece.props.map((p) => ({ ...p, y: q(p.y + dy) })) } : {}),
    ...(piece.patches ? { patches: piece.patches.map((g) => ({ ...g, y: q(g.y + dy) })) } : {}),
  };
}

// ---------------------------------------------------------------- cover

export const crate: Kit = (k, x, z) => {
  const s = k.rng.range(1.2, 1.8);
  return { boxes: [box(x, z, s, Math.min(2.2, s * k.rng.range(1, 1.3)), s, 0, k.color(), 'crate')] };
};

/** A step crate, a tall crate and a small one on top: climbable mid cover */
export const crateStack: Kit = (k, x, z, axis) => {
  const c = k.color();
  const dir = k.rng.chance(0.5) ? 1 : -1;
  const ox = axis === 'x' ? dir * 2.05 : 0;
  const oz = axis === 'z' ? dir * 2.05 : 0;
  return {
    boxes: [box(x, z, 2, 2, 2, 0, c, 'crate'), box(x + ox, z + oz, 2, 1, 2, 0, c, 'crate'), box(x, z, 1.2, 1, 1.2, 2, k.color(), 'crate')],
  };
};

/** Concrete jersey barrier: hides you crouching, shoot over it standing */
export const lowWall: Kit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(2.4, 3.6), 0.7, k.rng.range(1.05, 1.2), 0, 0xb9b6ad, 'concrete')] });

export const sandbags: Kit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(2.4, 3.4), 0.9, 1.1, 0, k.rng.pick([0xa89a72, 0x9c8e66, 0xb3a57c]), 'planks', { step: 'sand' })] });

export const wall: Kit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, k.rng.range(3.5, 5), 0.8, k.rng.range(2, 2.7), 0, k.color(), k.theme.wallSurface)] });

export const pillar: Kit = (k, x, z) => {
  const s = k.rng.range(1.8, 2.4);
  return { boxes: [box(x, z, s, k.rng.range(3, 4.4), s, 0, k.color(), k.theme.pillarSurface)] };
};

export const barrels: Kit = (k, x, z) => {
  const color = k.rng.pick([0x3f6fa8, 0xb5482f, 0x5c6b4a, 0xc9a23a]);
  const r = 0.66;
  const spots = ([[0, 0], [r, 0], [0, r], [r, r]] as [number, number][]).slice(0, 2 + k.rng.int(0, 2));
  return { boxes: spots.map(([dx, dz]) => box(x + dx - r / 2, z + dz - r / 2, 0.62, 0.95, 0.62, 0, color, 'metal', { shape: 'cylinder', step: 'hard' })) };
};

export const pallets: Kit = (k, x, z, axis) =>
  ({ boxes: [along(axis, x, z, 1.4, 1.2, k.rng.pick([1.1, 1.3]), 0, k.rng.pick([0xa07a4f, 0x8a6a45]), 'crate')] });

const CONTAINER = { len: 6, h: 2.6, w: 2.4 };
const CONTAINER_COLORS = [0xb5482f, 0x2f6fa8, 0x3f8a4a, 0xd08a2a, 0x7d8597, 0x8a3f5f];

/** A shipping container, sometimes with a crate step at one end so its roof is a vantage point */
export const container: Kit = (k, x, z, axis) => {
  const boxes = [along(axis, x, z, CONTAINER.len, CONTAINER.w, CONTAINER.h, 0, k.rng.pick(CONTAINER_COLORS), 'container', { step: 'hard' })];
  if (k.rng.chance(0.4)) {
    const dir = k.rng.chance(0.5) ? 1 : -1;
    const end = (axis === 'x' ? x : z) + dir * (CONTAINER.len / 2 + 0.65);
    boxes.push(axis === 'x' ? box(end, z, 1.3, 1.6, 1.3, 0, k.color(), 'crate') : box(x, end, 1.3, 1.6, 1.3, 0, k.color(), 'crate'));
  }
  return { boxes };
};

// ---------------------------------------------------------------- huts

export interface HutStyle {
  wall: BoxSurface;
  roof: BoxSurface;
  colors: readonly number[];
  wallH: number;
}

const DOOR = { width: 1.8, top: 2.4 };
const WINDOW = { width: 1.2, bottom: 1, top: 2 };

/**
 * A small hut you can go into: four walls, a door on two opposite sides (so it's a way through,
 * never a trap), windows, a flat roof. Returns the spots outside each door, which must be reachable.
 */
export function hut(rng: Rng, style: HutStyle, x: number, z: number, axis: 'x' | 'z'): { piece: Piece; doors: [number, number][] } {
  const long = q(rng.range(5, 6.5));
  const short = q(rng.range(4, 5));
  const w = axis === 'x' ? long : short;
  const d = axis === 'x' ? short : long;
  const t = 0.3;
  const H = style.wallH;
  const color = rng.pick(style.colors);
  const boxes: MapBox[] = [];
  // Walls along x (south and north): doors in them when the hut runs along x.
  const wallX = (zc: number, door: boolean) => {
    const holes = door ? [{ at: q(rng.range(-0.8, 0.8)), width: DOOR.width, bottom: 0, top: DOOR.top }] : [{ at: 0, width: WINDOW.width, bottom: WINDOW.bottom, top: WINDOW.top }];
    boxes.push(...spans(w, holes).map(([a, b, y0, y1]) => box(x + (a + b) / 2, zc, b - a, y1 - y0, t, y0, color, style.wall)));
    return holes[0]!;
  };
  const wallZ = (xc: number, door: boolean) => {
    const inner = d - 2 * t;
    const holes = door ? [{ at: q(rng.range(-0.6, 0.6)), width: DOOR.width, bottom: 0, top: DOOR.top }] : [{ at: 0, width: WINDOW.width, bottom: WINDOW.bottom, top: WINDOW.top }];
    boxes.push(...spans(inner, holes).map(([a, b, y0, y1]) => box(xc, z + (a + b) / 2, t, y1 - y0, b - a, y0, color, style.wall)));
    return holes[0]!;
  };
  const doorsAlongZ = axis === 'z';
  const s = wallX(z - d / 2 + t / 2, doorsAlongZ);
  const nn = wallX(z + d / 2 - t / 2, doorsAlongZ);
  const e = wallZ(x + w / 2 - t / 2, !doorsAlongZ);
  const ww = wallZ(x - w / 2 + t / 2, !doorsAlongZ);
  boxes.push(box(x, z, w, 0.3, d, H, rng.pick(style.colors), style.roof));
  const out = 1.4;
  const doors: [number, number][] = doorsAlongZ
    ? [[q(x + s.at), q(z - d / 2 - out)], [q(x + nn.at), q(z + d / 2 + out)]]
    : [[q(x + w / 2 + out), q(z + e.at)], [q(x - w / 2 - out), q(z + ww.at)]];
  return { piece: { boxes }, doors };

  function spans(length: number, holes: { at: number; width: number; bottom: number; top: number }[]): [number, number, number, number][] {
    const parts: [number, number, number, number][] = [];
    let cursor = -length / 2;
    for (const o of holes) {
      const a = o.at - o.width / 2;
      const b = o.at + o.width / 2;
      if (a > cursor + 0.01) parts.push([cursor, a, 0, H]);
      if (o.bottom > 0.01) parts.push([a, b, 0, o.bottom]);
      if (o.top < H - 0.01) parts.push([a, b, o.top, H]);
      cursor = b;
    }
    if (cursor < length / 2 - 0.01) parts.push([cursor, length / 2, 0, H]);
    return parts;
  }
}

// ---------------------------------------------------------------- the middle's centrepiece

export type LandmarkId = 'tower' | 'fountain' | 'tanks' | 'stones' | 'ruin' | 'crates';

/**
 * The middle plaza's centrepiece, at (x, 0). Symmetric under both a half turn and a reflection
 * across the middle line, so it's placed once for both teams.
 */
export function landmark(id: LandmarkId, k: KitContext, x: number): Piece {
  const c = k.color();
  const at = (p: Piece): Piece => ({
    boxes: p.boxes.map((b) => ({ ...b, x: q(b.x + x) })),
    ...(p.props ? { props: p.props.map((m) => ({ ...m, x: q(m.x + x) })) } : {}),
    ...(p.patches ? { patches: p.patches.map((g) => ({ ...g, x: q(g.x + x) })) } : {}),
  });
  switch (id) {
    case 'tower': {
      const s = 3.2;
      const boxes = [box(0, 0, s, 8, s, 0, c, k.theme.pillarSurface), box(0, 0, s + 0.6, 0.6, s + 0.6, 8, 0x6f6a66, 'concrete')];
      for (const [bx, bz, w, d] of [[s / 2 + 2, 0, 0.7, 2.4], [-(s / 2 + 2), 0, 0.7, 2.4], [0, s / 2 + 2, 2.4, 0.7], [0, -(s / 2 + 2), 2.4, 0.7]] as const) {
        boxes.push(box(bx, bz, w, 1.1, d, 0, 0xb9b6ad, 'concrete'));
      }
      return at({ boxes });
    }
    case 'fountain':
      return at({
        boxes: [
          box(0, 0, 5.5, 0.8, 5.5, 0, 0xb9b6ad, 'concrete', { shape: 'cylinder' }),
          box(0, 0, 1.4, 2.4, 1.4, 0, 0x9aa3ad, 'concrete', { shape: 'cylinder' }),
          box(0, 0, 2.8, 0.4, 2.8, 2.4, 0x9aa3ad, 'concrete', { shape: 'cylinder' }),
        ],
        patches: [{ x: 0, z: 0, w: 12, d: 12, kind: 'sidewalk', y: 0 }],
      });
    case 'tanks': {
      const color = k.rng.pick([0xc9c9c0, 0x8fbf3f, 0xb9b6ad]);
      const boxes: MapBox[] = [];
      for (const sx of [1, -1]) for (const sz of [1, -1]) boxes.push(box(sx * 3, sz * 3, 3, 4.6, 3, 0, color, 'metal', { shape: 'cylinder' }));
      boxes.push(box(0, 0, 2.2, 1.1, 2.2, 0, 0x7d8597, 'metal'));
      return at({ boxes, patches: [{ x: 0, z: 0, w: 14, d: 14, kind: 'concrete', y: 0 }] });
    }
    case 'stones': {
      const parts = ([[4, 0], [-4, 0], [0, 4], [0, -4]] as const).map(([sx, sz]) => propPiece('rock-tall-c', sx, sz, 0));
      return at(merge(...parts));
    }
    case 'ruin': {
      const boxes: MapBox[] = [];
      const a = 3.2;
      for (const sx of [1, -1]) for (const sz of [1, -1]) {
        boxes.push(box(sx * a, sz * (a + 1), 2.6, 2.4, 0.8, 0, c, k.theme.wallSurface));
        boxes.push(box(sx * (a + 1), sz * a, 0.8, 2.4, 2.6, 0, c, k.theme.wallSurface));
      }
      return at({ boxes });
    }
    case 'crates': {
      const boxes: MapBox[] = [box(0, 0, 2.2, 2.2, 2.2, 0, c, 'crate')];
      for (const [sx, sz] of [[3.2, 0], [-3.2, 0], [0, 3.2], [0, -3.2]] as const) boxes.push(box(sx, sz, 1.4, 1.1, 1.4, 0, c, 'crate'));
      return at({ boxes });
    }
  }
}
