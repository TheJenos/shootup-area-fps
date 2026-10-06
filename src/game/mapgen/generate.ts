/**
 * The generator's pipeline, from a spec to a finished, checked map:
 *
 *   meta (biome, theme, name)  →  lane graph  →  terrain  →  dressing  →  checks
 *
 * Each stage draws from its own random stream. A roll whose graph can't be made fair, or whose
 * finished map fails its checks, is rebuilt from the next roll; the meta stage is shared by every
 * roll, so the name never changes.
 */

import { BIOMES, BIOME_WEIGHTS, type Biome } from './biomes';
import { dress, type SightReport } from './dress';
import { buildGraph, type Graph } from './graph';
import { mapHash } from './hash';
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
    let graph: Graph | null = null;
    for (let attempt = 0; attempt < 8 && !graph; attempt++) {
      graph = buildGraph(rng.fork(`graph${attempt}`), sym, P, meta.biome.graph);
      if (!graph) graphFailures++;
    }
    if (!graph) continue;
    const terrain = new Terrain(graph, rng.fork('terrain'), meta.biome.terrain);
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
      boxes: d.boxes,
      props: d.props,
      patches: d.patches,
      flags: { red: [graph.base.x, graph.base.h, graph.base.z], blue: [bx, graph.base.h, bz] },
      spawns: d.spawns,
      pickupSpots: d.pickupSpots,
      graph: laneGraph(graph),
      edge: { height: terrain.rimHeight() },
      path: meta.biome.path,
    };
    const map: MapData = { ...body, hash: mapHash(body) };
    const report = validateMap(map, d.targets);
    const result: Generated = { map, report, sight: d.sight, roll, graphFailures };
    if (report.ok) return result;
    if (!best || report.problems.length < best.report.problems.length) best = result;
  }
  if (!best) throw new Error(`No map for ${spec.seed}`);
  return best;
}

export function generate(spec: MapSpec): MapData {
  return generateWithReport(spec).map;
}

/** The design, kept with the map for the preview and debugging */
function laneGraph(g: Graph): LaneGraph {
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
  };
}
