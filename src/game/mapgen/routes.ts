/**
 * The map's routes as a graph, to check its loops. What makes a multiplayer map work is loops: a
 * hallway gives one line of attack, a loop lets players move round each other and pick their angle.
 * Good maps (de_dust2) overlay about three big loops with a few small ones, and no single spot every
 * route has to pass; too many ways in ("guess maps") and nobody can tell where an enemy will come
 * from.
 *
 * Junctions are the bases, the crossings on the middle line and wherever a connector meets a lane;
 * routes are the lanes, connectors and the street through the middle. The number of independent
 * loops is edges − junctions + 1, and a junction's entrances are the routes meeting at it.
 */

import { dist } from './dmath';
import type { Graph, LaneSample } from './graph';
import { tPoint } from './symmetry';

export interface Routes {
  /** Independent loops (the cyclomatic number of the route graph) */
  loops: number;
  /** Most routes meeting at one junction */
  busiest: number;
}

/** A design has to have at least this many loops */
export const MIN_LOOPS = 3;
/** A junction with more ways in than this is a guess spot */
export const MAX_ENTRANCES = 4;

export function routesOf(g: Graph): Routes {
  type Pt = [number, number];
  const copy = (pts: Pt[]): Pt[] => pts.map(([x, z]) => tPoint(g.sym, x, z));
  const pts = (s: readonly LaneSample[]): Pt[] => s.map((p) => [p.x, p.z]);
  const paths: Pt[][] = [];
  for (const l of g.lanes) paths.push(pts(l.samples), copy(pts(l.samples)));
  for (const c of g.connectors) {
    paths.push(pts(c.samples));
    // The street along the middle line is its own copy.
    if (!c.samples.every((p) => Math.abs(p.z) < 0.5)) paths.push(copy(pts(c.samples)));
  }

  const nodes: { x: number; z: number; r: number }[] = [];
  const [bx, bz] = tPoint(g.sym, g.base.x, g.base.z);
  nodes.push({ x: g.base.x, z: g.base.z, r: g.base.r }, { x: bx, z: bz, r: g.base.r });
  const nodeAt = (x: number, z: number) => {
    const at = nodes.findIndex((n) => dist(n.x, n.z, x, z) <= n.r + 0.5);
    if (at >= 0) return at;
    nodes.push({ x, z, r: 2.5 });
    return nodes.length - 1;
  };
  for (const p of paths) {
    nodeAt(...p[0]!);
    nodeAt(...p[p.length - 1]!);
  }

  // Each route runs from junction to junction: one edge per stretch between the junctions on it.
  const degree = new Array<number>(nodes.length).fill(0);
  let edges = 0;
  for (const p of paths) {
    const on: { node: number; at: number }[] = [];
    nodes.forEach((n, i) => {
      let at = -1;
      for (let k = 0; k < p.length && at < 0; k++) if (dist(n.x, n.z, p[k]![0], p[k]![1]) <= n.r + 0.5) at = k;
      if (at >= 0) on.push({ node: i, at });
    });
    on.sort((a, b) => a.at - b.at);
    for (let k = 1; k < on.length; k++) {
      edges++;
      degree[on[k - 1]!.node]!++;
      degree[on[k]!.node]!++;
    }
  }
  return { loops: edges - nodes.length + 1, busiest: Math.max(...degree) };
}
