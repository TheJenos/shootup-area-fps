/**
 * Outdoor maps: grassy hills (plateaus with ramps, some with a second tier), big rocks, patches
 * of forest (trunks block you, canopies stop bullets but you walk under them), a cabin or two,
 * fallen logs, log piles, tents and fences.
 */

import { building, openingsFor } from './building';
import { GAP, INNER, Placer, rectOf, round } from './core';
import { propPiece, propSize, propsTagged } from './props';
import { fillCover } from './pieces';
import { carveOutline } from './outline';
import type { MapBox, MapLayout, Piece, PropRot } from './types';

const rots = [0, 1, 2, 3] as const;

/** A hill: a rock body with a turf top, a ramp up one side, and sometimes a second tier. */
function hill(p: Placer, x: number, z: number): Piece {
  const w = round(p.range(6, 10));
  const d = round(p.range(5, 9));
  const h = round(p.range(1.3, 2.4));
  const rock = p.pick([0xb3aa9a, 0xa39c8e, 0xbdb3a2]);
  const turf = 0x6f9a4f;
  const boxes: MapBox[] = [
    { x: round(x), z: round(z), w, d, h: round(h - 0.15), y: 0, color: rock, surface: 'rock' },
    { x: round(x), z: round(z), w, d, h: 0.15, y: round(h - 0.15), color: turf, surface: 'grass' },
  ];
  // Ramp up from the floor on one side.
  const side = p.pick(['x+', 'x-', 'z+', 'z-'] as const);
  const run = round(h * 2.4);
  const rw = round(Math.min(3, (side[0] === 'x' ? d : w) - 1));
  const ramp: MapBox = side === 'x+'
    ? { x: round(x + w / 2 + run / 2), z: round(z), w: run, d: rw, h, y: 0, color: turf, surface: 'grass', ramp: 'x-' }
    : side === 'x-'
      ? { x: round(x - w / 2 - run / 2), z: round(z), w: run, d: rw, h, y: 0, color: turf, surface: 'grass', ramp: 'x+' }
      : side === 'z+'
        ? { x: round(x), z: round(z + d / 2 + run / 2), w: rw, d: run, h, y: 0, color: turf, surface: 'grass', ramp: 'z-' }
        : { x: round(x), z: round(z - d / 2 - run / 2), w: rw, d: run, h, y: 0, color: turf, surface: 'grass', ramp: 'z+' };
  boxes.push(ramp);
  if (w >= 8 && d >= 7 && p.chance(0.5)) {
    // A smaller second tier, reached by a short ramp on top.
    const h2 = round(p.range(1, 1.4));
    const w2 = round(w * 0.45);
    const d2 = round(d * 0.5);
    const tx = round(x + (side === 'x+' ? -w / 4 : side === 'x-' ? w / 4 : 0));
    const tz = round(z + (side === 'z+' ? -d / 4 : side === 'z-' ? d / 4 : 0));
    boxes.push({ x: tx, z: tz, w: w2, d: d2, h: round(h2 - 0.15), y: h, color: rock, surface: 'rock' });
    boxes.push({ x: tx, z: tz, w: w2, d: d2, h: 0.15, y: round(h + h2 - 0.15), color: turf, surface: 'grass' });
    const run2 = round(h2 * 2.4);
    boxes.push(side[0] === 'x'
      ? { x: round(tx + (side === 'x+' ? 1 : -1) * (w2 / 2 + run2 / 2)), z: tz, w: run2, d: 1.8, h: h2, y: h, color: turf, surface: 'grass', ramp: side === 'x+' ? 'x-' : 'x+' }
      : { x: tx, z: round(tz + (side === 'z+' ? 1 : -1) * (d2 / 2 + run2 / 2)), w: 1.8, d: run2, h: h2, y: h, color: turf, surface: 'grass', ramp: side === 'z+' ? 'z-' : 'z+' });
  }
  // A rock or bush on top as cover.
  const top = p.chance(0.5) ? propPiece('bush', x, z, p.pick(rots), h) : propPiece(p.pick(['rock-tall-e', 'log']), x, z, p.pick(rots), h);
  return { boxes: [...boxes, ...top.boxes], props: top.props };
}

/** A clump of trees, trunks at least GAP apart. */
function forest(p: Placer, x: number, z: number): Piece {
  const trees = propsTagged('tree').filter((id) => id !== 'tree-street');
  const n = 4 + Math.floor(p.rand() * 4);
  const piece: Piece = { boxes: [], props: [], ground: [] };
  const spots: [number, number][] = [];
  for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
    const tx = x + p.range(-5, 5);
    const tz = z + p.range(-5, 5);
    if (spots.some(([sx, sz]) => Math.hypot(sx - tx, sz - tz) < GAP + 0.8)) continue;
    spots.push([tx, tz]);
    const t = propPiece(p.pick(trees), tx, tz, p.pick(rots), 0, p.range(0.85, 1.2));
    piece.boxes.push(...t.boxes);
    piece.props!.push(...t.props!);
    i++;
  }
  // Undergrowth: bushes you can walk through.
  for (let i = 0; i < 3; i++) piece.props!.push(...propPiece(p.pick(['bush', 'bush-small']), x + p.range(-5, 5), z + p.range(-5, 5), p.pick(rots)).props!);
  // Leaf litter under the trees: dirt on sand, nothing extra on snow or grass floors.
  if (p.theme.surface === 'sand' && p.theme.floorTexture === 'sand') piece.ground!.push({ x: round(x), z: round(z), w: 13, d: 13, kind: 'dirt' });
  return piece;
}

function cabin(p: Placer, x: number, z: number): Piece {
  const w = round(p.range(7, 9));
  const d = round(p.range(6, 7.5));
  const t = 0.3;
  const piece = building({
    x, z, w, d, wallH: 3.2, t, wall: 'planks', wallColor: 0x8a6a45, floor: 'planks', floorColor: 0xa07a4f,
    roof: 'planks', roofColor: 0x5c4a3a, openings: openingsFor(p.rand, w, d, t, { windowsPerSide: [1, 1] }),
  });
  piece.ground = [{ x: round(x), z: round(z), w: round(w + 4), d: round(d + 4), kind: 'dirt' }];
  return piece;
}

/** Small outdoor cover: logs, log piles, tents, fences, stumps. */
function outdoorCover(p: Placer, x: number, z: number): Piece {
  const id = p.pick(['log', 'log-stack', 'tent', 'fence-wood', 'stump', 'rock-tall-c', 'rock-tall-e'] as const);
  return propPiece(id, x, z, p.pick(rots));
}

export function outdoorLayout(seed: string, p: Placer): MapLayout {
  carveOutline(p, 'outdoor');
  // A hill or a rock outcrop in the middle.
  if (p.chance(0.5)) {
    const s = round(p.range(5, 7));
    const h = round(p.range(1.2, 1.6));
    const boxes: MapBox[] = [
      { x: 0, z: 0, w: s, d: s, h: round(h - 0.15), y: 0, color: 0xb3aa9a, surface: 'rock' },
      { x: 0, z: 0, w: s, d: s, h: 0.15, y: round(h - 0.15), color: 0x6f9a4f, surface: 'grass' },
    ];
    for (const [dir, dx, dz] of [['x-', 1, 0], ['x+', -1, 0], ['z-', 0, 1], ['z+', 0, -1]] as const) {
      const run = round(h * 2.4);
      boxes.push(dx
        ? { x: round(dx * (s / 2 + run / 2)), z: 0, w: run, d: 2.4, h, y: 0, color: 0x6f9a4f, surface: 'grass', ramp: dir }
        : { x: 0, z: round(dz * (s / 2 + run / 2)), w: 2.4, d: run, h, y: 0, color: 0x6f9a4f, surface: 'grass', ramp: dir });
    }
    p.placeAsIs({ boxes });
  } else {
    // Two different outcrops either side of the middle.
    for (const sx of [1, -1]) {
      p.place(propPiece(p.pick(['rock-d', 'rock-f', 'rock-b']), round(sx * p.range(4, 7)), round(p.range(4, 6)), p.pick(rots)));
    }
  }

  const tryPlace = (make: (x: number, z: number) => Piece, count: number, attempts: number, margin = GAP) => {
    let placed = 0;
    for (let i = 0; i < attempts && placed < count; i++) {
      const piece = make(p.range(-INNER + 3, INNER - 3), p.range(3, INNER - 3));
      const r = rectOf(piece.boxes.filter((b) => b.blocks !== 'shots'));
      if (r.minZ < margin) continue;
      if (!p.fits(piece)) continue;
      p.place(piece);
      placed++;
    }
    return placed;
  };

  tryPlace((x, z) => hill(p, x, z), 2 + Math.floor(p.rand() * 3), 120);
  tryPlace((x, z) => cabin(p, x, z), p.chance(0.75) ? 1 + (p.chance(0.5) ? 1 : 0) : 0, 120);
  tryPlace((x, z) => forest(p, x, z), 4 + Math.floor(p.rand() * 3), 160);
  // Big rocks as cover.
  tryPlace((x, z) => {
    const id = p.pick(propsTagged('rock'));
    const rot: PropRot = p.pick(rots);
    const s = propSize(id, rot);
    return s.h >= 1.6 ? propPiece(id, x, z, rot) : propPiece('rock-tall-a', x, z, rot);
  }, 6 + Math.floor(p.rand() * 5), 160);
  tryPlace((x, z) => outdoorCover(p, x, z), 10 + Math.floor(p.rand() * 8), 240, GAP / 2);
  fillCover(p, 3 + Math.floor(p.rand() * 4), 200);
  return p.result(seed, 'outdoor');
}
