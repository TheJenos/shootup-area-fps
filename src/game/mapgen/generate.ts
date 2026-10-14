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
import { fill, type Filled } from './fill';
import { buildGround } from './ground';
import { mapHash } from './hash';
import { buildLayout, type Layout } from './layout';
import { planRoute } from './route';
import { Rng } from './rng';
import { SIZE_PARAMS, type MapSpec, type SizeParams } from './spec';
import { tPoint, type Symmetry } from './symmetry';
import { themeNamed } from './themes';
import type { Ground, MapBox, MapData, MapTheme, MazeLayout } from './types';
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

/** One whole symmetric design: red's half laid out, filled and copied into blue's */
interface Design {
  sym: Symmetry;
  layout: Layout;
  ground: Ground;
  f: Filled;
  /** The buildings or cliffs round the edge (built in red's half, copied like everything else) */
  edge: MapBox[];
  maze: MazeLayout;
}

function design(rng: Rng, sym: Symmetry, P: SizeParams, meta: Meta): Design | null {
  const route = planRoute(rng.fork('route'), sym, P);
  if (!route) return null;
  const layout = buildLayout(rng.fork('layout'), sym, P, route);
  const ground = buildGround(rng.fork('ground'), layout, meta.biome.ground, P.baseR);
  const f = fill(rng.fork('fill'), layout, ground, meta.biome, meta.theme, P);
  const edge = edgeMasses(layout.outline, ground, sym, meta.biome.edge, rng.fork('edge'));
  return { sym, layout, ground, f, edge, maze: mazeLayout(layout) };
}

/**
 * An asymmetric map: red's half of one design and blue's half of another. Both are built under the
 * same (rotate) symmetry and size, so they share the grid and the middle line; each middle plaza
 * spans the map's middle columns, so the two meet across it (and the checks reject a roll where they
 * don't). The ground is held at 0 next to the middle line in every design, so the halves join without
 * a step. The centrepiece of the middle plaza is red's design's, whole.
 */
function compose(red: Design, blue: Design): Omit<Design, 'sym'> {
  const g = red.ground;
  const side = g.n + 1;
  const mid = g.n / 2;
  const heights = g.heights.slice();
  const paint = g.paint.slice();
  for (let iz = 0; iz < mid; iz++) for (let ix = 0; ix < side; ix++) {
    heights[iz * side + ix] = blue.ground.heights[iz * side + ix]!;
    paint[iz * side + ix] = blue.ground.paint[iz * side + ix]!;
  }
  const o = red.layout.outline;
  const inside = o.inside.slice();
  const tag = red.layout.tag.slice();
  const step = red.layout.step.slice();
  for (let k = 0; k < o.n / 2; k++) for (let i = 0; i < o.n; i++) {
    const b = k * o.n + i;
    inside[b] = blue.layout.outline.inside[b]!;
    tag[b] = blue.layout.tag[b]!;
    step[b] = blue.layout.step[b]!;
  }
  const rs = red.f.sides;
  const bs = blue.f.sides;
  const pieces = [...rs.red, ...bs.blue, rs.centre];
  const half = (list: [number, number][], keep: (z: number) => boolean) => list.filter(([, z]) => keep(z));
  const f: Filled = {
    sides: { red: rs.red, blue: bs.blue, centre: rs.centre, redPickups: rs.redPickups, redTargets: rs.redTargets },
    boxes: pieces.flatMap((p) => p.boxes),
    props: pieces.flatMap((p) => p.props ?? []),
    patches: pieces.flatMap((p) => p.patches ?? []),
    flags: { red: red.f.flags.red, blue: blue.f.flags.blue },
    spawns: [...red.f.spawns.filter((s) => s.team === 'red'), ...blue.f.spawns.filter((s) => s.team === 'blue')],
    pickupSpots: [...red.f.pickupSpots.slice(0, rs.redPickups), ...blue.f.pickupSpots.slice(bs.redPickups)],
    targets: [...red.f.targets.slice(0, rs.redTargets), ...blue.f.targets.slice(bs.redTargets)],
  };
  const maze: MazeLayout = {
    symmetry: 'none',
    routes: [
      ...red.maze.routes.map((r) => ({ ...r, points: half(r.points, (z) => z >= 0) })),
      ...blue.maze.routes.map((r) => ({ ...r, points: half(r.points, (z) => z <= 0) })),
    ].filter((r) => r.points.length > 1),
    loops: red.maze.loops,
    pathCells: red.maze.pathCells,
  };
  return {
    layout: { ...red.layout, outline: { ...o, inside }, tag, step },
    ground: { ...g, heights, paint },
    f,
    // Built in red's half (z > 0) and copied: each design's own side, by where they stand.
    edge: [...red.edge.filter((b) => b.z > 0), ...blue.edge.filter((b) => b.z < 0)],
    maze,
  };
}

export function generateWithReport(spec: MapSpec): Generated {
  const meta = metaFor(spec.seed);
  const P = SIZE_PARAMS[spec.size];
  const root = new Rng(`${spec.seed}:${spec.size}`);
  let best: Generated | null = null;
  for (let roll = 0; roll < ROLLS; roll++) {
    const rng = root.fork(`roll${roll}`);
    let d: Omit<Design, 'sym'> | null;
    if (spec.asym) {
      const red = design(rng.fork('red'), 'rotate', P, meta);
      const blue = red && design(rng.fork('blue'), 'rotate', P, meta);
      d = red && blue ? compose(red, blue) : null;
      // Walled in as joined, over both halves: each design only walled in its own shape, which leaves
      // holes where one half's open ground meets the other's at the middle line.
      if (d) d.edge = edgeMasses(d.layout.outline, d.ground, 'none', meta.biome.edge, rng.fork('edge'));
    } else {
      d = design(rng, rng.fork('symmetry').chance(0.6) ? 'rotate' : 'mirror', P, meta);
    }
    if (!d) continue;
    const { layout, ground, f } = d;
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
      boxes: [...f.boxes, ...d.edge],
      props: f.props,
      patches: f.patches,
      flags: f.flags,
      spawns: f.spawns,
      pickupSpots: f.pickupSpots,
      layout: d.maze,
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
function mazeLayout(l: Layout): MazeLayout {
  const copy = (pts: [number, number][]) => pts.map(([x, z]) => tPoint(l.sym, x, z));
  const routes: MazeLayout['routes'] = [];
  for (const line of l.lines) {
    const pts = line.points.map(([x, z]) => [x, z] as [number, number]);
    if (line.role === 'main') routes.push({ role: 'main', points: [...pts, ...copy(pts).reverse()] });
    else routes.push({ role: line.role, points: pts }, { role: line.role, points: copy(pts) });
  }
  return { symmetry: l.sym, routes, loops: l.route.loops.length, pathCells: l.route.main.length };
}
