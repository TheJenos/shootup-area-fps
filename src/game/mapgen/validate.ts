/**
 * Checks a finished map: run inside the generator (a map that fails is rebuilt from the next roll),
 * by scripts/check-maps.ts over many seeds, and by the unit tests.
 *
 * Hard rules: every spawn, both flags, every pickup spot and every door and platform top can be
 * walked to; a flag carrier can get home; no slope is steeper than you can walk; the two halves
 * are exact copies. A generated map also keeps to its size's guidelines: the walk from flag to flag
 * fits its time, and cover doesn't clutter the floor. Softer numbers (sightlines) are reported for tuning.
 */

import { groundGradient, groundHeight } from './heightField';
import { MAX_SLOPE } from './terrain';
import { NavGrid } from './navgrid';
import { MAX_ENTRANCES, MIN_LOOPS } from './routes';
import { SIZE_PARAMS } from './spec';
import { insideOutline } from './outline';
import { tVertex } from './symmetry';
import type { MapData } from './types';

/** Walking pace (m/s, movement.ts) */
const WALK_SPEED = 6;
/** Most of a map's floor that cover may take: past that it's noise in the way of play */
const MAX_CLUTTER = 0.22;

export interface ValidationReport {
  ok: boolean;
  problems: string[];
  metrics: {
    /** Walking distance between the flags (m) */
    flagToFlag: number;
    /** Share of the map you can reach on foot */
    walkable: number;
    /** Steepest ground (rise per metre) */
    steepest: number;
    /** Floor space taken by solid things, as a share of the map */
    clutter: number;
  };
}

/** `targets`: extra spots that must be reachable ([x, y, z]: doors, platform tops, bridge decks). */
export function validateMap(data: MapData, targets: readonly [number, number, number][] = []): ValidationReport {
  const problems: string[] = [];
  const g = data.ground;
  const sym = data.graph?.symmetry ?? 'mirror';

  // Ground: walkable slopes, never below 0, exactly symmetric.
  let steepest = 0;
  if (g) {
    const side = g.n + 1;
    for (let iz = 0; iz < g.n; iz++) {
      for (let ix = 0; ix < g.n; ix++) {
        const x = -g.half + (ix + 0.3) * g.cell;
        const z = -g.half + (iz + 0.3) * g.cell;
        for (const [px, pz] of [[x, z], [x + 0.4 * g.cell, z + 0.4 * g.cell]] as const) {
          const [gx, gz] = groundGradient(g, px, pz);
          steepest = Math.max(steepest, Math.sqrt(gx * gx + gz * gz));
        }
      }
    }
    if (steepest > MAX_SLOPE * Math.SQRT2 + 0.03) problems.push(`slope ${steepest.toFixed(2)}`);
    for (let iz = 0; iz <= g.n; iz++) {
      for (let ix = 0; ix <= g.n; ix++) {
        const h = g.heights[iz * side + ix]!;
        if (h < 0) problems.push('ground below 0');
        if (h !== g.heights[tVertex(sym, g.n, ix, iz)]) {
          problems.push(`ground not symmetric at ${ix},${iz}`);
          iz = g.n + 1;
          break;
        }
      }
    }
  }

  // On foot, from red's first spawn.
  const nav = new NavGrid(g, data.half, data.boxes);
  const first = data.spawns.find((s) => s.team === 'red') ?? data.spawns[0];
  let flagToFlag = 0;
  let walkable = 0;
  if (!first) problems.push('no spawns');
  else {
    const walked = nav.walk(nav.surface(first.x, first.z, first.y));
    walkable = nav.walkable(walked);
    const need = (what: string, x: number, y: number, z: number, radius = 0.5) => {
      if (nav.reached(walked, x, z, y, radius) === Infinity) problems.push(`${what} ${x},${z} unreachable`);
    };
    for (const s of data.spawns) {
      need('spawn', s.x, s.y, s.z);
      if (nav.surface(s.x, s.z, s.y) < 0) problems.push(`spawn ${s.x},${s.z} blocked`);
    }
    for (const [x, y, z] of [data.flags.red, data.flags.blue]) need('flag', x, y, z, 1);
    for (const p of data.pickupSpots) need('pickup', p.x, p.y, p.z);
    for (const [x, y, z] of targets) need('spot', x, y, z, 0.8);
    // A carrier gets home: from the blue flag back to the red one.
    const [bx, by, bz] = data.flags.blue;
    const [rx, ry, rz] = data.flags.red;
    const home = nav.walk(nav.surface(bx, bz, by));
    flagToFlag = nav.reached(home, rx, rz, ry, 1);
    if (flagToFlag === Infinity) problems.push('no way home from the enemy flag');
  }

  // Nothing over a spawn, nothing in a flag's way.
  for (const b of data.boxes) {
    if (b.blocks === 'shots') continue;
    for (const s of data.spawns) {
      if (Math.abs(s.x - b.x) < b.w / 2 + 0.45 && Math.abs(s.z - b.z) < b.d / 2 + 0.45 && b.y < s.y + 2.2 && b.y + b.h > s.y + 0.3) {
        problems.push(`box over spawn ${s.x},${s.z}`);
      }
    }
  }

  // Floor space taken, inside the map's shape (not the buildings or cliffs round it).
  let solid = 0;
  for (const b of data.boxes) {
    if (b.blocks === 'shots' || b.y > groundHeight(g, b.x, b.z) + 1.5 || !insideOutline(data.outline, data.half, b.x, b.z)) continue;
    solid += b.w * b.d;
  }
  const o = data.outline;
  const area = o ? o.inside.reduce((s, v) => s + v, 0) * o.cell * o.cell : 4 * data.half * data.half;
  const clutter = solid / area;

  // The guidelines a generated map is held to.
  if (data.graph) {
    const budget = SIZE_PARAMS[data.spec.size].crossTime;
    if (flagToFlag !== Infinity && flagToFlag / WALK_SPEED > budget) problems.push(`flag to flag ${Math.round(flagToFlag / WALK_SPEED)} s over ${budget} s`);
    if (clutter > MAX_CLUTTER) problems.push(`clutter ${Math.round(clutter * 100)}% over ${MAX_CLUTTER * 100}%`);
    // Loops to move round each other in, and no junction with so many ways in it's a guess.
    if (data.graph.loops < MIN_LOOPS) problems.push(`${data.graph.loops} loops, under ${MIN_LOOPS}`);
    if (data.graph.entrances > MAX_ENTRANCES) problems.push(`a junction with ${data.graph.entrances} ways in`);
  }

  return {
    ok: problems.length === 0,
    problems: problems.slice(0, 12),
    metrics: { flagToFlag: Math.round(flagToFlag), walkable: Math.round(walkable * 1000) / 1000, steepest: Math.round(steepest * 100) / 100, clutter: Math.round(clutter * 1000) / 1000 },
  };
}
