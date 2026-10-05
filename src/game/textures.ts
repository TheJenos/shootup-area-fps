import * as THREE from 'three';
import { canvas2d } from './canvas';
import type { MapTheme } from './mapgen';

/*
 * Procedural textures, drawn once into canvases and cached for the lifetime of the page.
 * Patterns use tileable noise (the lattice wraps), so every texture repeats without seams.
 * Box surfaces are drawn in light neutral tones so each box's palette color tints them.
 */

export type BoxSurface =
  | 'crate' | 'concrete' | 'brick' | 'metal' | 'perimeter'
  | 'planks' | 'container' | 'rock' | 'grass' | 'plaster';
export type FloorTexture = 'tiles' | 'sand' | 'snow' | 'asphalt' | 'plate' | 'grass';
/** Flat overlays on the floor (streets, lawns...); see GroundPatch in mapgen.ts */
export type GroundKind = 'road' | 'sidewalk' | 'grass' | 'dirt' | 'concrete' | 'hazard';

/** Metres covered by one repeat of each box surface; crates show one whole frame per face instead. */
export const SURFACE_TILE: Record<BoxSurface, number | null> = {
  crate: null,
  concrete: 4,
  brick: 2,
  metal: 2.5,
  perimeter: 6,
  planks: 2,
  container: 2.4,
  rock: 3,
  grass: 3,
  plaster: 3,
};

/** Metres covered by one repeat of each ground patch texture */
export const GROUND_TILE: Record<GroundKind, number> = {
  road: 8, sidewalk: 2, grass: 4, dirt: 4, concrete: 4, hazard: 2,
};

/** Metres covered by one repeat of the floor texture */
export const FLOOR_TILE = 4;

// ---------------------------------------------------------------- noise

/** Small deterministic PRNG so every client draws identical textures. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATTICE = 256;
const lattice = (() => {
  const rand = rng(1337);
  return Float32Array.from({ length: LATTICE * LATTICE }, () => rand());
})();

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in 0..1 that repeats every `period` units on both axes. */
function noise(x: number, y: number, period: number): number {
  return noise2(x, y, period, period);
}

function noise2(x: number, y: number, periodX: number, periodY: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const wrapX = (n: number) => (((n % periodX) + periodX) % periodX) % LATTICE;
  const wrapY = (n: number) => (((n % periodY) + periodY) % periodY) % LATTICE;
  const at = (ix: number, iy: number) => lattice[wrapY(iy) * LATTICE + wrapX(ix)] ?? 0;
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/**
 * Fractal noise in roughly 0..1. `u`/`v` run 0..1 across the texture and it tiles seamlessly
 * as long as the scales are whole numbers; a different `scaleY` stretches the pattern.
 */
function fbm(u: number, v: number, scale: number, octaves = 4, scaleY = scale): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = scale;
  let py = scaleY;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(u * px, v * py, px, py) * amp;
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- drawing helpers

type RGB = [number, number, number];

/** 0..255 sRGB channels, as canvases expect (THREE.Color itself stores linear values). */
const srgb = (c: THREE.Color): RGB => {
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, THREE.SRGBColorSpace);
  return [out.r * 255, out.g * 255, out.b * 255];
};

const rgbOf = (hex: number | string): RGB => srgb(new THREE.Color(hex));

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);

/** Fill a canvas pixel by pixel; `shade` gets u, v in 0..1 and returns a color and optional alpha. */
function paint(width: number, height: number, shade: (u: number, v: number, x: number, y: number) => [number, number, number, number?]) {
  const { canvas, g } = canvas2d(width, height);
  const img = g.createImageData(width, height);
  const data = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, gr, b, a = 255] = shade(x / width, y / height, x, y);
      const i = (y * width + x) * 4;
      data[i] = clamp255(r);
      data[i + 1] = clamp255(gr);
      data[i + 2] = clamp255(b);
      data[i + 3] = clamp255(a);
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas, g };
}

const grey = (l: number): [number, number, number] => [l * 255, l * 255, l * 255];
const scaled = (c: RGB, l: number): [number, number, number] => [c[0] * l, c[1] * l, c[2] * l];

function toTexture(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const cache = new Map<string, THREE.CanvasTexture>();
function cached(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let tex = cache.get(key);
  if (!tex) {
    tex = make();
    cache.set(key, tex);
  }
  return tex;
}

/** Distance (0..0.5) from the nearest edge of a cell `size` wide, for seams and grout. */
const edgeDistance = (t: number, cells: number) => {
  const f = (t * cells) % 1;
  return Math.min(f, 1 - f);
};

// ---------------------------------------------------------------- box surfaces

function drawCrate(): HTMLCanvasElement {
  const S = 256;
  const frame = 0.085;
  const planks = 4;
  return paint(S, S, (u, v) => {
    const grain = fbm(u, v, 2, 3, 24);
    const inFrame = u < frame || u > 1 - frame || v < frame || v > 1 - frame;
    // Diagonal brace across the middle.
    const brace = Math.abs(u - v) < 0.06 && !inFrame;
    let l = 0.86 + (grain - 0.5) * 0.22;
    if (inFrame || brace) l -= 0.1;
    if (!inFrame && !brace && edgeDistance((v - frame) / (1 - 2 * frame), planks) < 0.02) l -= 0.35;
    const border = Math.min(u, 1 - u, v, 1 - v);
    if (Math.abs(border - frame) < 0.006) l -= 0.3;
    if (brace && Math.abs(Math.abs(u - v) - 0.06) < 0.006) l -= 0.25;
    // Nail heads in the frame corners.
    for (const cx of [frame / 2, 1 - frame / 2]) {
      for (const cy of [frame / 2, 1 - frame / 2]) if (Math.hypot(u - cx, v - cy) < 0.012) l -= 0.35;
    }
    return grey(l);
  }).canvas;
}

function drawConcrete(): HTMLCanvasElement {
  const S = 512;
  const { canvas, g } = paint(S, S, (u, v) => {
    let l = 0.8 + (fbm(u, v, 6) - 0.5) * 0.2 + (noise(u * 128, v * 128, 128) - 0.5) * 0.06;
    // Two cast panels per repeat, with a seam and form-tie holes.
    const seamU = edgeDistance(u, 2);
    const seamV = edgeDistance(v, 2);
    if (seamU < 0.004 || seamV < 0.004) l -= 0.22;
    for (const tx of [0.25, 0.75]) {
      for (const ty of [0.25, 0.75]) if (Math.hypot(u - tx, v - ty) < 0.008) l -= 0.28;
    }
    return grey(l);
  });
  // Air pockets, drawn on top rather than tested for every pixel.
  const pits = rng(7);
  g.fillStyle = 'rgba(0, 0, 0, 0.14)';
  for (let i = 0; i < 140; i++) {
    const size = (0.004 + pits() * 0.008) * S;
    g.fillRect(pits() * S, pits() * S, size, size);
  }
  return canvas;
}

function drawBrick(): HTMLCanvasElement {
  const S = 512;
  const rows = 8;
  const cols = 4;
  const shade = rng(11);
  const brickShade = Float32Array.from({ length: rows * cols * 2 }, () => shade());
  return paint(S, S, (u, v) => {
    const row = Math.floor(v * rows);
    const offset = row % 2 ? 0.5 / cols : 0;
    const bu = (u + offset) % 1;
    const col = Math.floor(bu * cols);
    const fu = (bu * cols) % 1;
    const fv = (v * rows) % 1;
    const mortar = fu < 0.04 || fu > 0.96 || fv < 0.08 || fv > 0.92;
    const n = fbm(u, v, 16, 3);
    if (mortar) return grey(0.9 + (n - 0.5) * 0.1);
    const base = 0.62 + (brickShade[row * cols + col] ?? 0.5) * 0.18;
    // Darker, worn edges on each brick.
    const edge = Math.min(fu, 1 - fu, (fv - 0.08) / 0.84, 1 - (fv - 0.08) / 0.84);
    return grey(base + (n - 0.5) * 0.16 - (edge < 0.06 ? 0.06 : 0));
  }).canvas;
}

function drawMetal(): HTMLCanvasElement {
  const S = 512;
  const ribs = 10;
  return paint(S, S, (u, v) => {
    // Corrugated sheet: light catches one side of each rib.
    const rib = Math.sin(u * ribs * Math.PI * 2);
    let l = 0.78 + rib * 0.1;
    // Rust / grime streaks running down from the top.
    const streak = fbm(u, v, 16, 3, 2);
    l -= Math.max(0, streak - 0.55) * 0.6;
    l += (noise(u * 200, v * 200, 200) - 0.5) * 0.04;
    // Horizontal seam with rivets in the middle of the repeat.
    if (Math.abs(v - 0.5) < 0.006) l -= 0.3;
    const rivetU = edgeDistance(u + 0.05, ribs);
    if (Math.abs(v - 0.5) < 0.03 && Math.abs(v - 0.5) > 0.012 && rivetU < 0.06) l += 0.12;
    return grey(l);
  }).canvas;
}

function drawPerimeter(): HTMLCanvasElement {
  const W = 512;
  return paint(W, W, (u, v) => {
    let l = 0.82 + (fbm(u, v, 5) - 0.5) * 0.18 + (noise(u * 160, v * 160, 160) - 0.5) * 0.05;
    // 3 m panels, a cap line near the top, and grime rising from the ground.
    if (edgeDistance(u, 2) < 0.003) l -= 0.25;
    if (Math.abs(v - 0.06) < 0.004) l -= 0.2;
    const fromGround = 1 - v;
    const grime = Math.max(0, 0.22 - fromGround) / 0.22;
    l -= grime * (0.25 + fbm(u, v, 12, 2) * 0.2);
    // Drips running down from the cap.
    const drip = fbm(u, 0, 24, 2);
    if (drip > 0.62 && v < 0.06 + (drip - 0.62) * 1.4) l -= 0.08;
    return grey(l);
  }).canvas;
}

/** Floorboards / wall planks: long boards with grain, one board every 1/8 of the repeat. */
function drawPlanks(): HTMLCanvasElement {
  const S = 512;
  const boards = 8;
  const shade = rng(21);
  const boardShade = Float32Array.from({ length: boards * 3 }, () => shade());
  return paint(S, S, (u, v) => {
    const row = Math.floor(v * boards);
    // Board ends are staggered row to row.
    const offset = (boardShade[row] ?? 0) * 0.7;
    const along = (u + offset) % 1;
    const seg = Math.floor(along * 2);
    const grain = fbm(u, v, 3, 3, 32);
    let l = 0.78 + ((boardShade[row * 2 + seg + boards] ?? 0.5) - 0.5) * 0.16 + (grain - 0.5) * 0.2;
    if (edgeDistance(v, boards) < 0.03) l -= 0.32;
    if (edgeDistance(along, 2) < 0.004) l -= 0.25;
    return grey(l);
  }).canvas;
}

/** Shipping container steel: deep vertical corrugation, a frame rail top and bottom, rust at the edges. */
function drawContainer(): HTMLCanvasElement {
  const S = 512;
  const ribs = 6;
  return paint(S, S, (u, v) => {
    const t = (u * ribs) % 1;
    // Trapezoid profile: flat face, bevel, recess, bevel.
    const face = t < 0.35 ? 0.1 : t < 0.45 ? -0.12 : t < 0.85 ? -0.02 : 0.08;
    let l = 0.76 + face + (noise(u * 220, v * 220, 220) - 0.5) * 0.05;
    const rail = Math.min(v, 1 - v);
    if (rail < 0.05) l = 0.62 + (noise(u * 64, v * 64, 64) - 0.5) * 0.06;
    const rust = fbm(u, v, 10, 4);
    if (rust > 0.6) l -= (rust - 0.6) * 0.9;
    return grey(l);
  }).canvas;
}

/** Weathered rock: big soft blotches and cracks. */
function drawRock(): HTMLCanvasElement {
  const S = 512;
  return paint(S, S, (u, v) => {
    let l = 0.74 + (fbm(u, v, 4, 5) - 0.5) * 0.36 + (noise(u * 150, v * 150, 150) - 0.5) * 0.08;
    if (Math.abs(fbm(u, v, 3, 4) - 0.5) < 0.008) l -= 0.25;
    return grey(l);
  }).canvas;
}

/** Turf on top of hills (tinted green by the palette color). */
function drawGrassBox(): HTMLCanvasElement {
  const S = 512;
  return paint(S, S, (u, v) => {
    const blade = noise(u * 260, v * 90, 260);
    const l = 0.78 + (fbm(u, v, 6, 4) - 0.5) * 0.3 + (blade - 0.5) * 0.18;
    return grey(l);
  }).canvas;
}

/** Smooth painted render: almost flat, a little dirt toward the bottom. */
function drawPlaster(): HTMLCanvasElement {
  const S = 256;
  return paint(S, S, (u, v) => {
    let l = 0.9 + (fbm(u, v, 3, 3) - 0.5) * 0.06 + (noise(u * 120, v * 120, 120) - 0.5) * 0.03;
    l -= Math.max(0, v - 0.85) * 0.4 * fbm(u, v, 12, 2);
    return grey(l);
  }).canvas;
}

const BOX_DRAWERS: Record<BoxSurface, () => HTMLCanvasElement> = {
  crate: drawCrate,
  concrete: drawConcrete,
  brick: drawBrick,
  metal: drawMetal,
  perimeter: drawPerimeter,
  planks: drawPlanks,
  container: drawContainer,
  rock: drawRock,
  grass: drawGrassBox,
  plaster: drawPlaster,
};

export function boxTexture(surface: BoxSurface): THREE.CanvasTexture {
  return cached(`box:${surface}`, () => toTexture(BOX_DRAWERS[surface]()));
}

// ---------------------------------------------------------------- floors

function drawFloor(kind: FloorTexture, theme: MapTheme): HTMLCanvasElement {
  const S = 512;
  const base = rgbOf(theme.floor);
  const line = rgbOf(theme.floorLine);
  switch (kind) {
    case 'tiles': {
      const shade = rng(3);
      const tileShade = Float32Array.from({ length: 16 }, () => shade());
      return paint(S, S, (u, v) => {
        // 1 m tiles: 4 x 4 per repeat.
        const grout = Math.min(edgeDistance(u, 4), edgeDistance(v, 4));
        if (grout < 0.025) return scaled(line, 0.95);
        const t = tileShade[Math.floor(v * 4) * 4 + Math.floor(u * 4)] ?? 0.5;
        const l = 0.94 + (t - 0.5) * 0.1 + (fbm(u, v, 8, 3) - 0.5) * 0.12;
        return scaled(base, l);
      }).canvas;
    }
    case 'sand':
      return paint(S, S, (u, v) => {
        const warp = fbm(u, v, 4, 3) * 3;
        const ripple = Math.sin((v * 14 + warp) * Math.PI * 2);
        let l = 1 + ripple * 0.06 + (fbm(u, v, 10, 3) - 0.5) * 0.16;
        // Pebbles
        const p = noise(u * 90, v * 90, 90);
        if (p > 0.93) l -= 0.25;
        return scaled(base, l);
      }).canvas;
    case 'snow':
      return paint(S, S, (u, v) => {
        let l = 1 + (fbm(u, v, 5) - 0.5) * 0.12;
        // Footprint-ish dimples and the odd sparkle.
        if (noise(u * 70, v * 70, 70) > 0.9) l -= 0.06;
        if (noise(u * 230, v * 230, 230) > 0.97) l += 0.1;
        return scaled(base, l);
      }).canvas;
    case 'asphalt':
      return paint(S, S, (u, v) => {
        let l = 0.92 + (noise(u * 180, v * 180, 180) - 0.5) * 0.3 + (fbm(u, v, 6, 3) - 0.5) * 0.15;
        // Cracks along a few noise contours, darker tar patches and the odd oil stain.
        if (Math.abs(fbm(u, v, 5, 4) - 0.5) < 0.006) l -= 0.3;
        const patch = fbm(u, v, 3, 3);
        if (patch > 0.62) l -= 0.12;
        const oil = fbm(u, v, 4, 4);
        if (oil < 0.3) l -= (0.3 - oil) * 0.9;
        return scaled(base, l);
      }).canvas;
    case 'plate':
      return paint(S, S, (u, v) => {
        // Diamond plate: raised lozenges alternating direction in a staggered grid.
        const cells = 12;
        const cu = u * cells;
        const cv = v * cells;
        const ix = Math.floor(cu);
        const iy = Math.floor(cv);
        const fx = cu - ix - 0.5;
        const fy = cv - iy - 0.5;
        const flip = (ix + iy) % 2 === 0;
        const a = flip ? fx + fy : fx - fy;
        const b = flip ? fx - fy : fx + fy;
        const raised = Math.abs(a) < 0.34 && Math.abs(b) < 0.08;
        let l = 0.86 + (fbm(u, v, 6, 3) - 0.5) * 0.14 + (noise(u * 150, v * 150, 150) - 0.5) * 0.05;
        if (raised) l += 0.16 - Math.abs(b) * 1.2;
        if (Math.min(edgeDistance(u, 2), edgeDistance(v, 2)) < 0.003) return scaled(line, 0.8);
        return scaled(base, l);
      }).canvas;
    case 'grass':
      return paint(S, S, (u, v) => {
        const blade = noise(u * 300, v * 110, 300);
        let l = 1 + (fbm(u, v, 5, 4) - 0.5) * 0.24 + (blade - 0.5) * 0.14;
        // Dry patches and clover.
        const dry = fbm(u, v, 3, 3);
        if (dry > 0.64) l += (dry - 0.64) * 0.6;
        if (noise(u * 60, v * 60, 60) > 0.92) l -= 0.12;
        return scaled(base, l);
      }).canvas;
  }
}

/** Ground patch textures (streets, lawns, painted zones), in full color. */
export function groundTexture(kind: GroundKind): THREE.CanvasTexture {
  return cached(`ground:${kind}`, () => {
    const S = 512;
    switch (kind) {
      case 'road':
        // 8 m of asphalt across, with a dashed centre line running along v.
        return toTexture(paint(S, S, (u, v) => {
          let l = 0.95 + (noise(u * 200, v * 200, 200) - 0.5) * 0.28 + (fbm(u, v, 5, 3) - 0.5) * 0.14;
          if (Math.abs(fbm(u, v, 4, 4) - 0.5) < 0.005) l -= 0.25;
          const c: RGB = [62, 64, 70];
          if (Math.abs(u - 0.5) < 0.012 && v % 0.5 < 0.3) return scaled([228, 206, 120], 0.9 + (fbm(u, v, 20, 2) - 0.5) * 0.3);
          if (Math.abs(u - 0.04) < 0.008 || Math.abs(u - 0.96) < 0.008) return scaled([220, 220, 214], 0.85);
          return scaled(c, l);
        }).canvas);
      case 'sidewalk': {
        const shade = rng(31);
        const slab = Float32Array.from({ length: 4 }, () => shade());
        return toTexture(paint(S, S, (u, v) => {
          const joint = Math.min(edgeDistance(u, 2), edgeDistance(v, 2));
          if (joint < 0.012) return grey(0.42);
          const s = slab[Math.floor(v * 2) * 2 + Math.floor(u * 2)] ?? 0.5;
          return scaled([168, 166, 160], 0.95 + (s - 0.5) * 0.08 + (fbm(u, v, 8, 3) - 0.5) * 0.12);
        }).canvas);
      }
      case 'grass':
        return toTexture(paint(S, S, (u, v) => {
          const l = 1 + (fbm(u, v, 5, 4) - 0.5) * 0.3 + (noise(u * 300, v * 110, 300) - 0.5) * 0.16;
          return scaled([86, 128, 62], l);
        }).canvas);
      case 'dirt':
        return toTexture(paint(S, S, (u, v) => {
          let l = 1 + (fbm(u, v, 6, 4) - 0.5) * 0.3;
          if (noise(u * 120, v * 120, 120) > 0.9) l -= 0.2;
          return scaled([120, 96, 70], l);
        }).canvas);
      case 'concrete':
        return toTexture(paint(S, S, (u, v) => {
          let l = 0.9 + (fbm(u, v, 6) - 0.5) * 0.16 + (noise(u * 128, v * 128, 128) - 0.5) * 0.05;
          if (Math.min(edgeDistance(u, 1), edgeDistance(v, 1)) < 0.004) l -= 0.2;
          const stain = fbm(u, v, 3, 4);
          if (stain < 0.32) l -= (0.32 - stain) * 0.8;
          return scaled([150, 150, 146], l);
        }).canvas);
      case 'hazard':
        return hazardTexture();
    }
  });
}

export function floorTexture(kind: FloorTexture, theme: MapTheme): THREE.CanvasTexture {
  return cached(`floor:${kind}:${theme.name}`, () => toTexture(drawFloor(kind, theme)));
}

// ---------------------------------------------------------------- props

/** Gunmetal with brushed streaks and lighter worn edges (each box face shows the whole texture). */
export function wornMetalTexture(): THREE.CanvasTexture {
  return cached('wornMetal', () => {
    const base = rgbOf(0x4d5560);
    return toTexture(paint(256, 256, (u, v) => {
      let l = 1 + (fbm(u, v, 1, 3, 24) - 0.5) * 0.35 + (noise(u * 128, v * 128, 128) - 0.5) * 0.08;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      if (edge < 0.05) l += (1 - edge / 0.05) * 0.45 * fbm(u, v, 20, 2);
      return scaled(base, l);
    }).canvas);
  });
}

export function woodTexture(): THREE.CanvasTexture {
  return cached('wood', () => {
    const base = rgbOf(0x8a6a45);
    return toTexture(paint(256, 256, (u, v) => {
      const warp = fbm(u, v, 3, 3) * 2.5;
      const rings = Math.sin((v * 9 + warp) * Math.PI * 2);
      const l = 1 + rings * 0.08 + (fbm(u, v, 4, 2, 20) - 0.5) * 0.18;
      return scaled(base, l);
    }).canvas);
  });
}

/** Segmented "pineapple" shell for the sphere's UVs. */
export function grenadeTexture(): THREE.CanvasTexture {
  return cached('grenade', () => {
    const base = rgbOf(0x4a6630);
    return toTexture(paint(256, 128, (u, v) => {
      const groove = Math.min(edgeDistance(u, 8), edgeDistance(v, 5));
      let l = 1 + (fbm(u, v, 8, 2) - 0.5) * 0.2;
      if (groove < 0.06) l -= 0.45;
      else if (groove < 0.12) l += 0.12;
      return scaled(base, l);
    }).canvas);
  });
}

/** Worn yellow/black diagonal stripes. */
export function hazardTexture(): THREE.CanvasTexture {
  return cached('hazard', () => toTexture(paint(256, 256, (u, v) => {
    const stripe = ((u + v) * 8) % 1 < 0.5;
    const wear = fbm(u, v, 10, 3);
    const l = 1 - (wear > 0.62 ? (wear - 0.62) * 2 : 0);
    return stripe ? scaled([240, 196, 40], l) : scaled([30, 30, 32], 1 + (wear - 0.5) * 0.4);
  }).canvas));
}

/** Painted corner brackets and an arrow; transparent elsewhere. */
export function spawnMarkerTexture(): THREE.CanvasTexture {
  return cached('spawnMarker', () => {
    const S = 256;
    const { canvas, g } = canvas2d(S);
    g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    g.lineWidth = 12;
    g.lineCap = 'square';
    const m = 24;
    const len = 56;
    for (const [x, y, dx, dy] of [[m, m, 1, 1], [S - m, m, -1, 1], [m, S - m, 1, -1], [S - m, S - m, -1, -1]] as const) {
      g.beginPath();
      g.moveTo(x, y + dy * len);
      g.lineTo(x, y);
      g.lineTo(x + dx * len, y);
      g.stroke();
    }
    // Arrow toward the top of the texture (rotated in the world to face the middle of the map).
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.beginPath();
    g.moveTo(S / 2, 70);
    g.lineTo(S / 2 + 42, 130);
    g.lineTo(S / 2 + 16, 130);
    g.lineTo(S / 2 + 16, 186);
    g.lineTo(S / 2 - 16, 186);
    g.lineTo(S / 2 - 16, 130);
    g.lineTo(S / 2 - 42, 130);
    g.closePath();
    g.fill();
    // Scuff the paint.
    const img = g.getImageData(0, 0, S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4 + 3;
        const wear = fbm(x / S, y / S, 12, 3);
        img.data[i] = (img.data[i] ?? 0) * Math.min(1, Math.max(0, (0.72 - wear) * 3));
      }
    }
    g.putImageData(img, 0, 0);
    return toTexture(canvas, false);
  });
}

// ---------------------------------------------------------------- sky

/** Equirectangular sky: zenith-to-horizon gradient with soft clouds tinted by the sun. */
export function skyTexture(theme: MapTheme): THREE.CanvasTexture {
  return cached(`sky:${theme.name}`, () => {
    const horizon = rgbOf(theme.sky);
    const zenith = srgb(new THREE.Color(theme.sky).offsetHSL(0.02, 0.06, -0.13));
    const cloudRgb = srgb(new THREE.Color(0xffffff).lerp(new THREE.Color(theme.sun), 0.35));
    return toTexture(paint(512, 256, (u, v) => {
      // v = 0 is the top of the canvas, which maps to the top of the sphere.
      const height = 1 - v * 2; // 1 at zenith, 0 at horizon, negative below
      const t = Math.max(0, Math.min(1, height));
      const k = Math.pow(t, 0.6);
      const sky: RGB = [
        horizon[0] + (zenith[0] - horizon[0]) * k,
        horizon[1] + (zenith[1] - horizon[1]) * k,
        horizon[2] + (zenith[2] - horizon[2]) * k,
      ];
      // Clouds live between just above the horizon and two-thirds up; stretched sideways.
      const band = Math.max(0, Math.min(1, (t - 0.04) / 0.12)) * Math.max(0, Math.min(1, (0.7 - t) / 0.3));
      const c = fbm(u, v, 6, 5, 3);
      const amount = Math.max(0, Math.min(1, (c - 0.5) * 3.2)) * band;
      return [
        sky[0] + (cloudRgb[0] - sky[0]) * amount,
        sky[1] + (cloudRgb[1] - sky[1]) * amount,
        sky[2] + (cloudRgb[2] - sky[2]) * amount,
      ];
    }).canvas);
  });
}

// ---------------------------------------------------------------- UVs

/**
 * Rescale a BoxGeometry's UVs so its texture repeats every `tile` metres instead of
 * stretching once across each face. Faces are +x, -x, +y, -y, +z, -z, four vertices each.
 */
export function scaleBoxUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const spans: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  spans.forEach(([su, sv], face) => {
    for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, (uv.getX(i) * su) / tile, (uv.getY(i) * sv) / tile);
  });
  uv.needsUpdate = true;
}
