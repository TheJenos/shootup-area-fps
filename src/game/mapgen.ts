/**
 * Seeded map generator. Pure data (no Three.js), so the lobby can draw a preview
 * and every client builds exactly the same arena from the room's seed.
 *
 * Maps are mirrored on both axes, so every spawn and both CTF bases see the same
 * layout. Obstacles always leave a gap of at least GAP between each other and the
 * outer walls, so no part of the floor can be sealed off.
 */

export const ARENA_HALF = 40;
/** Seed of the original hand-made map (also used for rooms made before seeds existed) */
export const CLASSIC_SEED = 'CLASSIC';
export const SEED_MAX_LENGTH = 16;

export interface MapBox {
  x: number;
  z: number;
  /** Size along x / y / z */
  w: number;
  h: number;
  d: number;
  /** Height of the bottom face */
  y: number;
  color: number;
}

export interface MapTheme {
  name: string;
  /** What footsteps on the floor sound like */
  surface: 'hard' | 'sand' | 'snow';
  sky: number;
  hemiSky: number;
  hemiGround: number;
  sun: number;
  floor: string;
  floorLine: string;
  wall: number;
  /** Colors for cover, picked per obstacle */
  palette: number[];
}

export interface MapLayout {
  seed: string;
  theme: MapTheme;
  boxes: MapBox[];
  /** [x, z] pairs */
  spawnPoints: [number, number][];
}

export const THEMES: MapTheme[] = [
  {
    name: 'Training Yard', surface: 'hard', sky: 0x9cc6ea, hemiSky: 0xe4f1ff, hemiGround: 0x5a4d3a, sun: 0xfff4e0,
    floor: '#5d6b58', floorLine: '#4d5a49', wall: 0x8a8f99,
    palette: [0x9a6b4f, 0xc28a4a, 0x6f7d8c, 0x4f7a6a, 0x4f6a7a, 0x7d8597],
  },
  {
    name: 'Dust Bowl', surface: 'sand', sky: 0xe8cfa4, hemiSky: 0xfff0d6, hemiGround: 0x7a5a36, sun: 0xffe2b0,
    floor: '#b8955f', floorLine: '#a3824f', wall: 0xa88a64,
    palette: [0x8c5a3c, 0xc9a26b, 0x6e4f3a, 0xb0703f, 0x998066],
  },
  {
    name: 'Frostbite', surface: 'snow', sky: 0xcfe6f5, hemiSky: 0xf2fbff, hemiGround: 0x6c7f91, sun: 0xeaf6ff,
    floor: '#d9e4ec', floorLine: '#c3d1dc', wall: 0x9fb3c4,
    palette: [0x5d7f9e, 0x86a7c2, 0x3e5a73, 0xb3c9d9, 0x6f8fa3],
  },
  {
    name: 'Dusk Yard', surface: 'hard', sky: 0x3d3b63, hemiSky: 0xffb38a, hemiGround: 0x2a2440, sun: 0xffa36b,
    floor: '#4a4560', floorLine: '#3d3852', wall: 0x5d5778,
    palette: [0x8a4f6b, 0xd07a52, 0x5a6b9a, 0x9c6b9e, 0x4f8a8a],
  },
  {
    name: 'Toxic Works', surface: 'hard', sky: 0xa9c79b, hemiSky: 0xe6ffd6, hemiGround: 0x3b4a2e, sun: 0xf3ffd0,
    floor: '#4f5a46', floorLine: '#414b39', wall: 0x6b7563,
    palette: [0x8fbf3f, 0x5c6b4a, 0xc9c94a, 0x3f5f5a, 0x7a8a5a],
  },
];

/** Same spawns on every map; the generator keeps them clear. */
const SPAWN_POINTS: [number, number][] = [];
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) SPAWN_POINTS.push([sx * 35, sz * 35], [sx * 17, sz * 26], [sx * 26, sz * 17]);
  SPAWN_POINTS.push([0, sx * 34], [sx * 34, 0]);
}

/** Matches FLAG_BASES in modes.ts */
const FLAG_SPOTS: [number, number][] = [[0, 32], [0, -32]];

/** Narrowest gap left between obstacles (players are 0.7 m wide) */
const GAP = 1.6;
const SPAWN_CLEARANCE = 2.5;
const FLAG_CLEARANCE = 4;
/** Inner face of the outer walls */
const INNER = ARENA_HALF - 0.5;

/** Seeds are case-insensitive letters and digits, so they're easy to read out and type. */
export function normalizeSeed(seed: string): string {
  return seed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, SEED_MAX_LENGTH);
}

export function randomSeed(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Deterministic PRNG (mulberry32) seeded from an FNV-1a hash of the seed text. */
function rngFor(seed: string): () => number {
  let a = 2166136261;
  for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

const rectOf = (boxes: MapBox[]): Rect => ({
  minX: Math.min(...boxes.map((b) => b.x - b.w / 2)),
  maxX: Math.max(...boxes.map((b) => b.x + b.w / 2)),
  minZ: Math.min(...boxes.map((b) => b.z - b.d / 2)),
  maxZ: Math.max(...boxes.map((b) => b.z + b.d / 2)),
});

/** Gap between two rectangles: they're apart if either axis has room. */
const gapBetween = (a: Rect, b: Rect) =>
  Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minZ - b.maxZ, b.minZ - a.maxZ);

const distanceToRect = (r: Rect, x: number, z: number) =>
  Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

const round = (n: number) => Math.round(n * 10) / 10;

/** Every mirror image of a group of boxes, without duplicating ones that sit on an axis. */
function mirrored(group: MapBox[]): MapBox[][] {
  const out: MapBox[][] = [];
  const seen = new Set<string>();
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const copy = group.map((b) => ({ ...b, x: round(b.x * sx), z: round(b.z * sz) }));
      const key = JSON.stringify(copy.map((b) => [b.x, b.z]).sort());
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(copy);
    }
  }
  return out;
}

export function generateMap(rawSeed: string): MapLayout {
  const seed = normalizeSeed(rawSeed) || CLASSIC_SEED;
  if (seed === CLASSIC_SEED) return classicMap();

  const rand = rngFor(seed);
  const range = (min: number, max: number) => min + rand() * (max - min);
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)] as T;

  const theme = pick(THEMES);
  const color = () => pick(theme.palette);
  const placed: Rect[] = [];
  const boxes: MapBox[] = [];

  const fits = (group: MapBox[], clearSpawns = true): boolean => {
    for (const copy of mirrored(group)) {
      const r = rectOf(copy);
      if (r.minX < -INNER + GAP || r.maxX > INNER - GAP || r.minZ < -INNER + GAP || r.maxZ > INNER - GAP) return false;
      if (placed.some((p) => gapBetween(p, r) < GAP)) return false;
      if (clearSpawns && SPAWN_POINTS.some(([x, z]) => distanceToRect(r, x, z) < SPAWN_CLEARANCE)) return false;
      if (FLAG_SPOTS.some(([x, z]) => distanceToRect(r, x, z) < FLAG_CLEARANCE)) return false;
    }
    return true;
  };

  const place = (group: MapBox[]): void => {
    for (const copy of mirrored(group)) placeAsIs(copy);
  };

  /** For groups that are already symmetric (centerpieces). */
  const placeAsIs = (group: MapBox[]): void => {
    placed.push(rectOf(group));
    boxes.push(...group);
  };

  // Centerpiece
  const center = pick(['platform', 'tower', 'open', 'bunker'] as const);
  if (center === 'platform') {
    const s = round(range(5, 8));
    const h = round(range(1, 1.3));
    const c = color();
    const group: MapBox[] = [{ x: 0, z: 0, w: s, h, d: s, y: 0, color: c }];
    // A half-height step on each side, and a crate on top to fight over.
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      group.push({
        x: round(sx * (s / 2 + 0.6)), z: round(sz * (s / 2 + 0.6)), w: sx ? 1.2 : 2, h: round(h / 2), d: sz ? 1.2 : 2, y: 0, color: c,
      });
    }
    placeAsIs(group);
    boxes.push({ x: round(s / 4), z: round(s / 4), w: 1.4, h: 1, d: 1.4, y: h, color: color() });
  } else if (center === 'tower') {
    const s = round(range(2.5, 4));
    placeAsIs([{ x: 0, z: 0, w: s, h: round(range(4, 6)), d: s, y: 0, color: color() }]);
  } else if (center === 'bunker') {
    // An L of wall in each corner around an open middle.
    const r = round(range(3.5, 5));
    const c = color();
    place([
      { x: r, z: r + 1.05, w: 3, h: 2.2, d: 0.9, y: 0, color: c },
      { x: r + 1.05, z: r, w: 0.9, h: 2.2, d: 3, y: 0, color: c },
    ]);
  }

  // Walls across the lanes between the bases (and between the side spawns)
  for (const axis of ['z', 'x'] as const) {
    if (rand() < 0.35) continue;
    for (let attempt = 0; attempt < 10; attempt++) {
      const along = round(range(14, 26));
      const len = round(range(6, 13));
      const wall: MapBox = axis === 'z'
        ? { x: 0, z: along, w: len, h: round(range(1.6, 2.6)), d: 0.9, y: 0, color: color() }
        : { x: along, z: 0, w: 0.9, h: round(range(1.6, 2.6)), d: len, y: 0, color: color() };
      if (fits([wall])) {
        place([wall]);
        break;
      }
    }
  }

  // Cover in one quarter of the map, mirrored into the other three.
  const target = Math.floor(range(10, 17));
  let count = 0;
  for (let attempt = 0; attempt < 400 && count < target; attempt++) {
    const x = range(GAP / 2 + 1, INNER - GAP - 1);
    const z = range(GAP / 2 + 1, INNER - GAP - 1);
    const group = makePiece(rand, range, color, x, z);
    // Keep quarter pieces off the axes so mirror images never touch.
    if (rectOf(group).minX < GAP / 2 || rectOf(group).minZ < GAP / 2) continue;
    if (!fits(group)) continue;
    place(group);
    count++;
  }

  return { seed, theme, boxes, spawnPoints: SPAWN_POINTS };
}

type Range = (min: number, max: number) => number;

/** One obstacle (or a small cluster that acts as one). */
function makePiece(rand: () => number, range: Range, color: () => number, x: number, z: number): MapBox[] {
  const kind = rand();
  const at = (b: Omit<MapBox, 'x' | 'z'> & { dx?: number; dz?: number }): MapBox => {
    const { dx = 0, dz = 0, ...rest } = b;
    return { ...rest, x: round(x + dx), z: round(z + dz), w: round(rest.w), h: round(rest.h), d: round(rest.d), y: round(rest.y) };
  };

  if (kind < 0.3) {
    // Crate
    const s = range(1.2, 2.4);
    return [at({ w: s, h: Math.min(3, s * range(1, 1.5)), d: s, y: 0, color: color() })];
  }
  if (kind < 0.6) {
    // Low wall
    const long = range(4, 9);
    const thick = range(0.8, 1);
    const flip = rand() < 0.5;
    return [at({ w: flip ? long : thick, h: range(1.8, 3.2), d: flip ? thick : long, y: 0, color: color() })];
  }
  if (kind < 0.75) {
    // Pillar
    const s = range(2.4, 3.4);
    return [at({ w: s, h: range(4, 6), d: s, y: 0, color: color() })];
  }
  if (kind < 0.9) {
    // Climbable stack: a step up to a tall crate with a small crate on top
    const c = color();
    const dir = rand() < 0.5 ? 1 : -1;
    return [
      at({ w: 2, h: 2, d: 2, y: 0, color: c }),
      at({ dx: dir * 2.1, w: 2, h: 1, d: 2, y: 0, color: c }),
      at({ w: 1.2, h: 1, d: 1.2, y: 2, color: color() }),
    ];
  }
  // L-shaped corner
  const c = color();
  const a = range(3, 5);
  return [
    at({ w: a, h: 2.4, d: 0.9, y: 0, color: c }),
    at({ dx: -(a / 2 - 0.45), dz: a / 2 - 0.45, w: 0.9, h: 2.4, d: a, y: 0, color: c }),
  ];
}

/** The original hand-built arena. */
function classicMap(): MapLayout {
  const boxes: MapBox[] = [];
  const add = (x: number, z: number, w: number, h: number, d: number, color: number, y = 0) =>
    boxes.push({ x, z, w, h, d, y, color });

  add(0, 0, 6, 1.2, 6, 0x7d8597);
  add(1.8, 1.8, 1.4, 1, 1.4, 0xc28a4a, 1.2);
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    add(sx * 3.6, sz * 3.6, sx ? 1.2 : 2, 0.6, sz ? 1.2 : 2, 0x7d8597);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(sx * 14, sz * 8, 8, 3, 1, 0x9a6b4f);
      add(sx * 8, sz * 14, 1, 3, 8, 0x9a6b4f);
      add(sx * 20, sz * 20, 2, 2, 2, 0xc28a4a);
      add(sx * 22.2, sz * 20, 2, 1, 2, 0xc28a4a);
      add(sx * 20, sz * 20, 1.2, 1, 1.2, 0xb5793d, 2);
      add(sx * 30, sz * 30, 3, 4, 3, 0x6f7d8c);
      add(sx * 6, sz * 22, 1.5, 1.5, 1.5, 0xc28a4a);
      add(sx * 22, sz * 6, 1.5, 1.5, 1.5, 0xc28a4a);
      add(sx * 32, sz * 14, 4, 2.2, 1, 0x4f7a6a);
      add(sx * 14, sz * 32, 1, 2.2, 4, 0x4f7a6a);
    }
    add(0, sx * 24, 12, 2, 1, 0x4f6a7a);
    add(sx * 24, 0, 1, 2, 12, 0x4f6a7a);
  }
  return { seed: CLASSIC_SEED, theme: THEMES[0] as MapTheme, boxes, spawnPoints: SPAWN_POINTS };
}
