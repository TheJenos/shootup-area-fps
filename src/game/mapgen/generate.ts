/**
 * The generator's pipeline, from a spec to a finished, checked map:
 *
 *   meta (biome, theme, name)  →  shape  →  lane graph  →  terrain  →  dressing  →  edge  →  checks
 *
 * Each stage draws from its own random stream. A roll whose graph can't be made fair, or whose
 * finished map fails its checks, is rebuilt from the next roll; the meta stage is shared by every
 * roll, so the name never changes.
 */

import { BIOMES, BIOME_WEIGHTS, type Biome } from './biomes';
import { dress, type SightReport } from './dress';
import { buildGraph, type Graph, type Shape } from './graph';
import { mapHash } from './hash';
import { MAX_SHARE, carveBlocks, designFootprint, edgeDistance, edgeMasses, skyline, insideShare, type Footprint, type Outline } from './outline';
import { routesOf } from './routes';
import { Rng } from './rng';
import { SIZE_PARAMS, type MapSpec } from './spec';
import { tPoint } from './symmetry';
import { Terrain } from './terrain';
import { themeNamed } from './themes';
import type { LaneGraph, MapData, MapTheme } from './types';
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
  sight: SightReport;
  /** Which roll it is (0 = the first) */
  roll: number;
  /** Rolls whose graph couldn't be made fair */
  graphFailures: number;
}

export function generateWithReport(spec: MapSpec): Generated {
  const meta = metaFor(spec.seed);
  const P = SIZE_PARAMS[spec.size];
  const root = new Rng(`${spec.seed}:${spec.size}`);
  let best: Generated | null = null;
  let graphFailures = 0;
  for (let roll = 0; roll < ROLLS; roll++) {
    const rng = root.fork(`roll${roll}`);
    const sym = rng.fork('symmetry').chance(0.7) ? 'rotate' : 'mirror';
    // A shape, then lanes that fit in it: a shape no fair lanes fit is redrawn.
    let graph: Graph | null = null;
    let outline: Outline | null = null;
    for (let attempt = 0; attempt < 12 && !graph; attempt++) {
      const f = designFootprint(rng.fork(`shape${attempt}`), sym, P);
      if (attempt < 11 && insideShare(f.outline, P.half) > MAX_SHARE) continue;
      const shape = shapeOf(f);
      outline = shape.outline;
      for (let tries = 0; tries < 3 && !graph; tries++) {
        graph = buildGraph(rng.fork(`graph${attempt}.${tries}`), sym, P, meta.biome.graph, shape);
        if (!graph) graphFailures++;
      }
    }
    if (!graph || !outline) continue;
    carveBlocks(outline, graph, rng.fork('blocks'));
    const terrain = new Terrain(graph, rng.fork('terrain'), meta.biome.terrain, outline);
    const d = dress(rng.fork('dress'), graph, terrain, meta.biome, meta.theme, P);
    const [bx, bz] = tPoint(sym, graph.base.x, graph.base.z);
    const body: Omit<MapData, 'hash'> = {
      spec,
      name: meta.name,
      biome: meta.biome.label,
      theme: meta.theme,
      indoor: meta.biome.indoor,
      half: graph.half,
      ground: d.ground,
      boxes: [
        ...d.boxes,
        ...edgeMasses(outline, d.ground, sym, meta.biome.edge, rng.fork('edge')),
        ...skyline(outline, d.ground, meta.biome.edge, rng.fork('skyline')),
      ],
      props: d.props,
      patches: d.patches,
      flags: { red: [graph.base.x, graph.base.h, graph.base.z], blue: [bx, graph.base.h, bz] },
      spawns: d.spawns,
      pickupSpots: d.pickupSpots,
      graph: laneGraph(graph, d.overpasses),
      outline,
      edge: { height: terrain.rimHeight() },
      path: meta.biome.path,
    };
    const map: MapData = { ...body, hash: mapHash(body) };
    const report = validateMap(map, d.targets);
    const result: Generated = { map, report, sight: d.sight, roll, graphFailures };
    if (report.ok) return result;
    for (const p of new Set(report.problems.map((p) => p.split(' ').slice(0, 2).join(' ')))) rollStats[p] = (rollStats[p] ?? 0) + 1;
    if (!best || report.problems.length < best.report.problems.length) best = result;
  }
  if (!best) throw new Error(`No map for ${spec.seed}`);
  return best;
}

/** The shape, with how far each spot is from its edge */
export function shapeOf(f: Footprint): Shape {
  const o = f.outline;
  const room = edgeDistance(o, 24);
  const side = Math.round(o.half * 2) + 1;
  return {
    outline: o,
    base: f.base,
    room: (x, z) => {
      const ix = Math.round(x + o.half);
      const iz = Math.round(z + o.half);
      return ix < 0 || iz < 0 || ix >= side || iz >= side ? 0 : room[iz * side + ix]!;
    },
  };
}

export function generate(spec: MapSpec): MapData {
  return generateWithReport(spec).map;
}

/** The design, kept with the map for the preview and debugging */
function laneGraph(g: Graph, overpasses: number): LaneGraph {
  const routes = routesOf(g);
  const both = (pts: [number, number][]): [number, number][] => [...pts, ...pts.map(([x, z]) => tPoint(g.sym, x, z)).reverse()];
  const thin = <T>(list: T[], every: number) => list.filter((_, i) => i % every === 0 || i === list.length - 1);
  return {
    symmetry: g.sym,
    lanes: g.lanes.map((l) => ({ role: l.role, width: l.width, points: both(thin(l.samples, 3).map((s) => [s.x, s.z])) })),
    connectors: g.connectors.map((c) => ({ width: c.width, points: thin(c.samples, 3).map((s) => [s.x, s.z] as [number, number]) })),
    chokes: g.lanes.map((l) => {
      const s = l.samples.reduce((b, p) => (Math.abs(p.s - l.chokeS) < Math.abs(b.s - l.chokeS) ? p : b));
      return [s.x, s.z] as [number, number];
    }),
    overlooks: g.overlooks.map((o) => [o.x, o.z] as [number, number]),
    mid: { kind: g.mid.kind, radius: g.mid.r },
    loops: routes.loops,
    entrances: routes.busiest,
    overpasses,
  };
}
