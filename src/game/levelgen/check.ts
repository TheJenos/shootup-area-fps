/**
 * Sanity checks for a generated layout, run by generateMap (it retries or falls back when they
 * fail) and by scripts/check-maps.ts over many seeds.
 *
 * The main one is a flood fill over the floor: every spawn, both flag spots and the outside of
 * every building door must be reachable on foot from the first spawn. Terrain needs no check of its
 * own: it's flat wherever anything stands and never steeper than the player climbs (terrain.ts).
 */

import { FLAG_CLEARANCE } from './core';
import type { MapLayout } from './types';

/** Player half-width (player.ts RADIUS) */
const RADIUS = 0.35;
/** Ledges up to this are walked onto (player.ts STEP_UP); anything lower doesn't block */
const STEP_UP = 0.7;
/** Things starting this high are walked under */
const HEADROOM = 1.9;
const CELL = 0.25;

export interface CheckReport {
  ok: boolean;
  problems: string[];
  /** Share of the floor you can walk on */
  walkable: number;
}

export function checkLayout(l: MapLayout): CheckReport {
  const problems: string[] = [];
  const half = l.half - 0.5;
  const n = Math.ceil((half * 2) / CELL);
  const blocked = new Uint8Array(n * n);
  const cell = (v: number) => Math.floor((v + half) / CELL);
  const centre = (i: number) => -half + (i + 0.5) * CELL;

  for (const b of l.boxes) {
    if (b.blocks === 'shots') continue;
    if (b.ramp) continue; // walked up from the low end; their sides are checked as walls only above STEP_UP
    if (b.y >= HEADROOM || b.y + b.h <= STEP_UP) continue;
    const x0 = Math.max(0, cell(b.x - b.w / 2 - RADIUS));
    const x1 = Math.min(n - 1, cell(b.x + b.w / 2 + RADIUS));
    const z0 = Math.max(0, cell(b.z - b.d / 2 - RADIUS));
    const z1 = Math.min(n - 1, cell(b.z + b.d / 2 + RADIUS));
    for (let iz = z0; iz <= z1; iz++) {
      const cz = centre(iz);
      if (cz <= b.z - b.d / 2 - RADIUS || cz >= b.z + b.d / 2 + RADIUS) continue;
      for (let ix = x0; ix <= x1; ix++) {
        const cx = centre(ix);
        if (cx > b.x - b.w / 2 - RADIUS && cx < b.x + b.w / 2 + RADIUS) blocked[iz * n + ix] = 1;
      }
    }
  }
  // The outer walls (grown by the player's radius).
  const edge = Math.ceil(RADIUS / CELL);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < edge; k++) {
      blocked[k * n + i] = blocked[(n - 1 - k) * n + i] = blocked[i * n + k] = blocked[i * n + (n - 1 - k)] = 1;
    }
  }

  const at = (x: number, z: number) => cell(z) * n + cell(x);
  const start = l.spawnPoints[0];
  if (!start || blocked[at(start[0], start[1])]) return { ok: false, problems: ['first spawn is blocked'], walkable: 0 };

  const seen = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  queue[tail++] = at(start[0], start[1]);
  seen[at(start[0], start[1])] = 1;
  while (head < tail) {
    const i = queue[head++]!;
    const ix = i % n;
    const iz = (i / n) | 0;
    for (const j of [ix > 0 ? i - 1 : -1, ix < n - 1 ? i + 1 : -1, iz > 0 ? i - n : -1, iz < n - 1 ? i + n : -1]) {
      if (j < 0 || seen[j] || blocked[j]) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }

  const reached = (x: number, z: number, radius = 0) => {
    if (radius === 0) return seen[at(x, z)] === 1;
    for (let dz = -radius; dz <= radius; dz += CELL) for (let dx = -radius; dx <= radius; dx += CELL) {
      if (seen[at(x + dx, z + dz)]) return true;
    }
    return false;
  };
  for (const [x, z] of l.spawnPoints) if (!reached(x, z, 0.5)) problems.push(`spawn ${x},${z} unreachable`);
  for (const [x, z] of l.flags) if (!reached(x, z, 1)) problems.push(`flag ${x},${z} unreachable`);
  for (const [x, z] of l.doors) if (!reached(x, z, 0.6)) problems.push(`door ${x},${z} unreachable`);

  // Nothing over a spawn (you'd spawn inside it) or in a flag's clearance.
  for (const b of l.boxes) {
    for (const [x, z] of l.spawnPoints) {
      if (Math.abs(x - b.x) < b.w / 2 + 0.5 && Math.abs(z - b.z) < b.d / 2 + 0.5 && b.y < 2.5) problems.push(`box over spawn ${x},${z}`);
    }
    for (const [x, z] of l.flags) {
      const dx = Math.max(0, Math.abs(x - b.x) - b.w / 2);
      const dz = Math.max(0, Math.abs(z - b.z) - b.d / 2);
      if (Math.hypot(dx, dz) < FLAG_CLEARANCE - 0.01 && b.blocks !== 'shots') problems.push(`box in flag clearance ${x},${z}`);
    }
  }

  let open = 0;
  for (let i = 0; i < n * n; i++) if (!blocked[i]) open++;
  return { ok: problems.length === 0, problems, walkable: open / (n * n) };
}
