/**
 * The generator's pipeline, from a spec to a finished, checked map:
 *
 *   meta (biome, theme, name)  →  maze  →  route  →  layout  →  ground  →  fill  →  edge  →  checks
 *
 * A maze is carved over red's half (maze.ts); a winding path is cut through it from the base to
 * the middle, with pockets and loops (route.ts); the path is widened into corridors with open
 * areas grown round it (layout.ts); the ground is shaped (ground.ts) and the open spaces filled
 * (fill.ts); everything outside is walled in (edge.ts); then it's all copied for blue.
 *
 * Each stage draws from its own random stream. A roll whose finished map fails its checks is
 * rebuilt from the next roll; the meta stage is shared by every roll, so the name never changes.
 */

import { BIOMES, BIOME_WEIGHTS, type Biome } from './biomes';
import { edgeMasses } from './edge';
import { fill } from './fill';
import { buildGround } from './ground';
import { mapHash } from './hash';
import { buildLayout, cellCentre, type Layout } from './layout';
import { planRoute } from './route';
import { Rng } from './rng';
import { SIZE_PARAMS, type MapSpec, type SizeParams } from './spec';
import { tPoint } from './symmetry';
import { themeNamed } from './themes';
import type { MapData, MapTheme, MazeLayout } from './types';
import { validateMap, type ValidationReport } from './validate';

export interface Meta {
  biome: Biome;
  theme: MapTheme;
  name: string;
}

/** Biome, theme and name: the same for every size of a seed, and cheap (no generating). */
export function metaFor(seed: string): Meta {
  const rng = new Rng(seed).fork('meta');
  const biome = BIOMES[rng.weighted(BIOME_WEIGHTS)];
  const theme = themeNamed(rng.pick(biome.themes));
  const name = `${rng.pick(biome.names)} · ${biome.label}`;
  return { biome, theme, name };
}

/** Why finished rolls failed their checks (for tuning; scripts/check-maps.ts prints it) */
export const rollStats: Record<string, number> = {};

/** How many rolls before settling for the best failing one */
const ROLLS = 6;

export interface Generated {
  map: MapData;
  report: ValidationReport;
  /** The layout it was built from (for scripts/check-maps.ts pictures) */
  layout: Layout;
  /** Which roll it is (0 = the first) */
  roll: number;
}

export function generateWithReport(spec: MapSpec): Generated {
  const meta = metaFor(spec.seed);
  const P = SIZE_PARAMS[spec.size];
  const root = new Rng(`${spec.seed}:${spec.size}`);
  let best: Generated | null = null;
  for (let roll = 0; roll < ROLLS; roll++) {
    const rng = root.fork(`roll${roll}`);
    const sym = rng.fork('symmetry').chance(0.6) ? 'rotate' : 'mirror';
    const route = planRoute(rng.fork('route'), sym, P);
    if (!route) continue;
    const layout = buildLayout(rng.fork('layout'), sym, P, route);
    const ground = buildGround(rng.fork('ground'), layout, meta.biome.ground, P.baseR);
    const f = fill(rng.fork('fill'), layout, ground, meta.biome, meta.theme, P);
    let edge = 0;
    for (let v = 0; v < ground.heights.length; v++) edge = Math.max(edge, ground.heights[v]!);
    const body: Omit<MapData, 'hash'> = {
      spec,
      name: meta.name,
      biome: meta.biome.label,
      theme: meta.theme,
      indoor: meta.biome.indoor,
      half: layout.outline.half,
      ground,
      boxes: [...f.boxes, ...edgeMasses(layout.outline, ground, sym, meta.biome.edge, rng.fork('edge'))],
      props: f.props,
      patches: f.patches,
      flags: f.flags,
      spawns: f.spawns,
      pickupSpots: f.pickupSpots,
      layout: mazeLayout(layout, P),
      outline: layout.outline,
      edge: { height: Math.round(edge * 100) / 100 },
      path: meta.biome.path,
    };
    const map: MapData = { ...body, hash: mapHash(body) };
    const report = validateMap(map, f.targets);
    const result: Generated = { map, report, layout, roll };
    if (report.ok) return result;
    for (const p of new Set(report.problems.map((p) => p.split(' ').slice(0, 2).join(' ')))) rollStats[p] = (rollStats[p] ?? 0) + 1;
    if (!best || report.problems.length < best.report.problems.length) best = result;
  }
  if (!best) throw new Error(`No map for ${spec.seed}`);
  return best;
}

export function generate(spec: MapSpec): MapData {
  return generateWithReport(spec).map;
}

/** The design, kept with the map for the preview and debugging */
function mazeLayout(l: Layout, P: SizeParams): MazeLayout {
  const r = l.route;
  const centre = (c: number) => cellCentre(P, c);
  const copy = (pts: [number, number][]) => pts.map(([x, z]) => tPoint(l.sym, x, z));
  const main = r.main.map(centre);
  const routes: MazeLayout['routes'] = [{ role: 'main', points: [...main, ...copy(main).reverse()] }];
  for (const p of r.pockets) {
    const pts = p.map(centre);
    routes.push({ role: 'pocket', points: pts }, { role: 'pocket', points: copy(pts) });
  }
  for (const lp of r.loops) {
    const pts = lp.cells.map(centre);
    routes.push({ role: 'loop', points: pts }, { role: 'loop', points: copy(pts) });
  }
  return { symmetry: l.sym, routes, loops: r.loops.length, pathCells: r.main.length };
}
