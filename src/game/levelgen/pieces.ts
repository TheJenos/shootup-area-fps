/**
 * Small cover pieces (the original arena's crates, walls, pillars, stacks, decks...) and the
 * original box-arena generator, kept as the fallback when a generated map fails its checks.
 */

import type { BoxSurface } from '../textures';
import type { RampDir } from '../ramps';
import { GAP, INNER, Placer, rectOf, round } from './core';
import type { MapBox, MapLayout, MapTheme, Piece } from './types';

type Range = (min: number, max: number) => number;

/** One obstacle (or a small cluster that acts as one) at x, z. */
export function makePiece(
  rand: () => number, range: Range, color: () => number, x: number, z: number, theme: MapTheme,
): MapBox[] {
  const kind = rand();
  const at = (
    b: Omit<MapBox, 'x' | 'z' | 'surface' | 'ramp'> & { dx?: number; dz?: number }, surface: BoxSurface, ramp?: RampDir,
  ): MapBox => {
    const { dx = 0, dz = 0, ...rest } = b;
    return {
      ...rest, x: round(x + dx), z: round(z + dz), w: round(rest.w), h: round(rest.h), d: round(rest.d), y: round(rest.y), surface,
      ...(ramp ? { ramp } : {}),
    };
  };

  if (kind < 0.22) {
    // Crate
    const s = range(1.2, 2.4);
    return [at({ w: s, h: Math.min(3, s * range(1, 1.5)), d: s, y: 0, color: color() }, 'crate')];
  }
  if (kind < 0.42) {
    // Wall
    const long = range(4, 9);
    const thick = range(0.8, 1);
    const flip = rand() < 0.5;
    return [at({ w: flip ? long : thick, h: range(1.8, 3.2), d: flip ? thick : long, y: 0, color: color() }, theme.wallSurface)];
  }
  if (kind < 0.57) {
    // Low cover: hides you crouched, shoot over it standing
    const long = range(2.5, 5);
    const flip = rand() < 0.5;
    return [at({ w: flip ? long : 0.7, h: range(1.1, 1.25), d: flip ? 0.7 : long, y: 0, color: color() }, 'concrete')];
  }
  if (kind < 0.68) {
    // Pillar
    const s = range(2.4, 3.4);
    return [at({ w: s, h: range(4, 6), d: s, y: 0, color: color() }, theme.pillarSurface)];
  }
  if (kind < 0.8) {
    // Climbable stack: a step up to a tall crate with a small crate on top
    const c = color();
    const dir = rand() < 0.5 ? 1 : -1;
    return [
      at({ w: 2, h: 2, d: 2, y: 0, color: c }, 'crate'),
      at({ dx: dir * 2.1, w: 2, h: 1, d: 2, y: 0, color: c }, 'crate'),
      at({ w: 1.2, h: 1, d: 1.2, y: 2, color: color() }, 'crate'),
    ];
  }
  if (kind < 0.9) {
    // Deck: a raised platform with a ramp up one side and a bit of cover on top
    const c = color();
    const w = range(4, 6);
    const d = range(3.5, 5);
    const h = range(1.3, 1.7);
    const dir = rand() < 0.5 ? 1 : -1;
    const rampLen = h * 2.2;
    return [
      at({ w, h, d, y: 0, color: c }, 'concrete'),
      at({ dx: dir * (w / 2 + rampLen / 2), w: rampLen, h, d: Math.min(d, 2.6), y: 0, color: c }, 'concrete', dir > 0 ? 'x-' : 'x+'),
      at({ dx: -dir * (w / 2 - 0.5), w: 0.7, h: 1.1, d: Math.min(d, 2.4), y: h, color: color() }, 'crate'),
    ];
  }
  // L-shaped corner
  const c = color();
  const a = range(3, 5);
  return [
    at({ w: a, h: 2.4, d: 0.9, y: 0, color: c }, theme.wallSurface),
    at({ dx: -(a / 2 - 0.45), dz: a / 2 - 0.45, w: 0.9, h: 2.4, d: a, y: 0, color: c }, theme.wallSurface),
  ];
}

/** Scatter `target` pieces of makePiece cover over our half (mirrored into the other). Returns how many fit. */
export function fillCover(p: Placer, target: number, attempts = 400): number {
  let count = 0;
  for (let attempt = 0; attempt < attempts && count < target; attempt++) {
    const x = p.range(-INNER + GAP + 1, INNER - GAP - 1);
    const z = p.range(GAP / 2 + 1, INNER - GAP - 1);
    const boxes = makePiece(p.rand, (a, b) => p.range(a, b), () => p.color(), x, z, p.theme);
    // Keep pieces off the middle line so mirror images never touch.
    const r = rectOf(boxes);
    if (r.minZ < GAP / 2) continue;
    const piece: Piece = { boxes };
    if (!p.fits(piece)) continue;
    p.place(piece);
    count++;
  }
  return count;
}

/** The original box arena: a centerpiece, walls across the lanes and 10–16 pieces of cover. */
export function arenaLayout(seed: string, p: Placer): MapLayout {
  const { theme } = p;
  const center = p.pick(['platform', 'tower', 'open', 'bunker'] as const);
  if (center === 'platform') {
    const s = round(p.range(5, 8));
    const h = round(p.range(1, 1.3));
    const c = p.color();
    const group: MapBox[] = [{ x: 0, z: 0, w: s, h, d: s, y: 0, color: c, surface: 'concrete' }];
    // Ramps up on two sides, a half-height step on the other two, and a crate on top to fight over.
    for (const sx of [1, -1] as const) {
      group.push({ x: round(sx * (s / 2 + 1.5)), z: 0, w: 3, h, d: 2.4, y: 0, color: c, surface: 'concrete', ramp: sx > 0 ? 'x-' : 'x+' });
    }
    for (const sz of [1, -1] as const) {
      group.push({ x: 0, z: round(sz * (s / 2 + 0.6)), w: 2, h: round(h / 2), d: 1.2, y: 0, color: c, surface: 'concrete' });
    }
    group.push({ x: round(s / 4), z: round(s / 4), w: 1.4, h: 1, d: 1.4, y: h, color: p.color(), surface: 'crate' });
    p.placeAsIs({ boxes: group });
  } else if (center === 'tower') {
    const s = round(p.range(2.5, 4));
    p.placeAsIs({ boxes: [{ x: 0, z: 0, w: s, h: round(p.range(4, 6)), d: s, y: 0, color: p.color(), surface: theme.pillarSurface }] });
  } else if (center === 'bunker') {
    // An L of wall in each corner around an open middle.
    const r = round(p.range(3.5, 5));
    const c = p.color();
    for (const sx of [1, -1]) {
      p.place({
        boxes: [
          { x: sx * r, z: r + 1.05, w: 3, h: 2.2, d: 0.9, y: 0, color: c, surface: theme.wallSurface },
          { x: sx * (r + 1.05), z: r, w: 0.9, h: 2.2, d: 3, y: 0, color: c, surface: theme.wallSurface },
        ],
      });
    }
  }

  // Walls across the lanes between the bases (and between the side spawns)
  for (const axis of ['z', 'x'] as const) {
    if (p.chance(0.35)) continue;
    for (let attempt = 0; attempt < 10; attempt++) {
      const along = round(p.range(14, 26));
      const len = round(p.range(6, 13));
      const wall: MapBox = axis === 'z'
        ? { x: 0, z: along, w: len, h: round(p.range(1.6, 2.6)), d: 0.9, y: 0, color: p.color(), surface: theme.wallSurface }
        : { x: along, z: 0, w: 0.9, h: round(p.range(1.6, 2.6)), d: len, y: 0, color: p.color(), surface: theme.wallSurface };
      const both = axis === 'x' ? [wall, { ...wall, x: -wall.x }] : [wall];
      if (p.fits({ boxes: both })) {
        p.place({ boxes: both });
        break;
      }
    }
  }

  fillCover(p, Math.floor(p.range(20, 33)));
  return p.result(seed, 'arena');
}
