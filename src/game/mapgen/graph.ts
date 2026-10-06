/**
 * The lane graph: the map's design before anything is built. Two bases, two or three lanes from each
 * base to the middle line, connectors between neighbouring lanes, a chokepoint on every lane, and
 * the floor height along each lane (base plateaus, lane floors, the middle).
 *
 * Only red's half (z > 0) is designed; blue's is its copy under the map's symmetry. Every lane
 * meets the middle line square on at a fixed crossing point, so red's route to the crossing at
 * x = c joins blue's copy of red's route to -c (rotate) or to c (mirror): every route has a twin of
 * exactly the same length on the other team's side.
 */

import { clamp, dist, len, q, segDistance, segIntersect, smoothstep } from './dmath';
import type { Rng } from './rng';
import type { SizeParams } from './spec';
import type { Symmetry } from './symmetry';

export interface LaneSample {
  x: number;
  z: number;
  /** Distance from the lane's start (m) */
  s: number;
  /** Lane width here (narrower at the choke) */
  w: number;
  /** Floor height */
  h: number;
  /** Unit direction along the lane */
  dx: number;
  dz: number;
}

export interface Lane {
  id: number;
  role: 'main' | 'flank';
  width: number;
  /** Where it crosses the middle line (x) */
  cross: number;
  /** Red's half, from the base to the crossing */
  samples: LaneSample[];
  length: number;
  /** Arc position of the chokepoint */
  chokeS: number;
}

export interface Connector {
  width: number;
  samples: LaneSample[];
  /** The two lanes it joins (a connector on the middle line joins a lane to its own copy) */
  lanes: [number, number];
}

export type MidKind = 'plaza' | 'hill' | 'sunken';

export interface Overlook {
  lane: number;
  /** Pad centre, and the lane point it looks over */
  x: number;
  z: number;
  /** Unit direction from the pad toward the lane */
  nx: number;
  nz: number;
  /** Lane floor height beside it */
  h: number;
}

export interface Graph {
  sym: Symmetry;
  half: number;
  base: { x: number; z: number; r: number; h: number };
  /** Lane floor height away from the bases and the middle */
  datum: number;
  lanes: Lane[];
  connectors: Connector[];
  mid: { kind: MidKind; r: number; h: number };
  overlooks: Overlook[];
}

/** Why lane rolls were rejected (for tuning; scripts/check-maps.ts prints it) */
export const graphStats: Record<string, number> = {};
const reject = (why: string) => { graphStats[why] = (graphStats[why] ?? 0) + 1; };

/** Steepest a lane floor gets along its length (rise per metre) */
const LANE_SLOPE = 0.16;
/** Minimum ridge between two lanes (m, edge to edge) */
const RIDGE_MIN = 10;
/** Keep lanes this far inside the outer walls */
const EDGE_MARGIN = 7;

/** Catmull-Rom through `pts`, sampled roughly every `step` metres. Only + - * /. */
function spline(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  const at = (i: number) => {
    if (i < 0) {
      const [a, b] = [pts[0]!, pts[1]!];
      return [2 * a[0] - b[0], 2 * a[1] - b[1]] as [number, number];
    }
    if (i >= pts.length) {
      const [a, b] = [pts[pts.length - 1]!, pts[pts.length - 2]!];
      return [2 * a[0] - b[0], 2 * a[1] - b[1]] as [number, number];
    }
    return pts[i]!;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const segs = Math.max(2, Math.ceil(dist(p1[0], p1[1], p2[0], p2[1]) / step) * 2);
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]!);
  // Resample evenly by arc length.
  const even: [number, number][] = [out[0]!];
  let carry = 0;
  for (let i = 1; i < out.length; i++) {
    const [ax, az] = out[i - 1]!;
    const [bx, bz] = out[i]!;
    const l = dist(ax, az, bx, bz);
    let t = step - carry;
    while (t <= l) {
      even.push([ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l]);
      t += step;
    }
    carry = l - (t - step);
  }
  const last = pts[pts.length - 1]!;
  const tail = even[even.length - 1]!;
  if (dist(tail[0], tail[1], last[0], last[1]) > step * 0.3) even.push(last);
  else even[even.length - 1] = last;
  return even;
}

/** Turn points into samples with arc length and direction. */
function toSamples(pts: [number, number][], width: number): LaneSample[] {
  const out: LaneSample[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]!;
    if (i > 0) s += dist(pts[i - 1]![0], pts[i - 1]![1], x, z);
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const l = dist(a[0], a[1], b[0], b[1]) || 1;
    out.push({ x, z, s, w: width, h: 0, dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l });
  }
  return out;
}

/** Longest stretch of a lane that runs straight (direction within ~25° of where it started). */
export function longestStraight(samples: readonly LaneSample[]): number {
  // cos²(25°)
  const COS2 = 0.8214;
  let best = 0;
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[start]!;
    const b = samples[i]!;
    const dot = a.dx * b.dx + a.dz * b.dz;
    if (dot < 0 || dot * dot < COS2) start = i;
    else best = Math.max(best, b.s - a.s);
  }
  return best;
}

/** Shortest distance between two polylines, ignoring points within `skip` of (sx, sz). */
function polylineGap(a: readonly LaneSample[], b: readonly LaneSample[], sx: number, sz: number, skip: number): number {
  let best = Infinity;
  for (const p of a) {
    if (dist(p.x, p.z, sx, sz) < skip) continue;
    for (let j = 1; j < b.length; j++) {
      const s0 = b[j - 1]!;
      const s1 = b[j]!;
      if (dist(s1.x, s1.z, sx, sz) < skip && dist(s0.x, s0.z, sx, sz) < skip) continue;
      best = Math.min(best, segDistance(p.x, p.z, s0.x, s0.z, s1.x, s1.z).d);
    }
  }
  return best;
}

function crosses(a: readonly LaneSample[], b: readonly LaneSample[], sx: number, sz: number, skip: number): boolean {
  for (let i = 1; i < a.length; i++) {
    const p0 = a[i - 1]!;
    const p1 = a[i]!;
    if (dist(p1.x, p1.z, sx, sz) < skip) continue;
    for (let j = 1; j < b.length; j++) {
      const r0 = b[j - 1]!;
      const r1 = b[j]!;
      if (dist(r1.x, r1.z, sx, sz) < skip) continue;
      if (segIntersect(p0.x, p0.z, p1.x, p1.z, r0.x, r0.z, r1.x, r1.z)) return true;
    }
  }
  return false;
}

export interface GraphOptions {
  /** Plateau height above the lane floors (m) */
  plateau: [number, number];
  mids: readonly (readonly [MidKind, number])[];
}

/** Design red's half. Returns null when the roll can't make a fair layout (the caller retries). */
export function buildGraph(rng: Rng, sym: Symmetry, P: SizeParams, o: GraphOptions): Graph | null {
  const H = P.half;
  const zb = P.baseZ;
  const three = rng.chance(P.threeLanes);
  // Off-centre bases only under rotation (a mirror keeps them on the axis).
  const bx = sym === 'rotate' ? q(rng.range(-0.1, 0.1) * H) : 0;
  const datum = 1;
  const base = { x: bx, z: zb, r: P.baseR, h: q(datum + rng.range(o.plateau[0], o.plateau[1])) };
  const midKind = rng.weighted(o.mids);
  const midR = q(H * (three ? 0.15 : 0.13));
  const midH = midKind === 'hill' ? datum + 1.6 : midKind === 'sunken' ? datum - 0.8 : datum;
  const c = q(H * (three ? rng.range(0.55, 0.62) : rng.range(0.4, 0.5)));
  const crossings = three ? [-c, 0, c] : [-c, c];
  const flankH = q(datum + rng.range(-0.3, 0.7));

  // Every lane swings side to side at the same points, in step, so neighbouring lanes keep their
  // distance while each bends often enough that no stretch runs straight for long.
  const approachZ = q(Math.min(7, zb * 0.18));
  const m = Math.max(2, Math.round((zb - approachZ) / 13));
  const steps = Array.from({ length: m }, (_, i) => Math.min(0.94, Math.max(0.06, (i + 1) / (m + 1) + rng.range(-0.04, 0.04))));
  const first = rng.chance(0.5) ? 1 : -1;

  const lanes: Lane[] = [];
  for (const [id, xc] of crossings.entries()) {
    // With two lanes, both are main routes.
    const main = xc === 0;
    const role: Lane['role'] = main || !three ? 'main' : 'flank';
    const width = three ? (main ? P.laneWidth.main : P.laneWidth.flank) : P.laneWidth.main - 1;
    const limit = H - EDGE_MARGIN - width / 2;
    let lane: Lane | null = null;
    for (let attempt = 0; attempt < 14 && !lane; attempt++) {
      const outward = Math.sign(xc) || (rng.chance(0.5) ? 1 : -1);
      // Under a half turn a lane through the very middle carries straight on into its copy at any
      // angle, so the middle lane comes in diagonally and leaves the other way: an S through the
      // middle instead of a straight shot from base to base. (A mirror needs it square on.)
      const slant = main && sym === 'rotate' ? (rng.chance(0.5) ? 1 : -1) * rng.range(4.5, 7) : 0;
      const approach: [number, number] = [q(xc + slant), approachZ];
      const bow = main ? rng.range(-2, 2) : outward * rng.range(0.12, 0.28) * H;
      // The middle lane of three swings less: it has neighbours on both sides.
      const amp = (main ? rng.range(0.5, 0.75) : rng.range(0.7, 1)) * width * (three ? 1 : 1.15);
      const way: [number, number][] = steps.map((t, i) => {
        const swing = i % 2 ? -first : first;
        // Swings grow as the lane leaves the base, where the lanes are still close together.
        const x = bx + (xc - bx) * t + bow * 4 * t * (1 - t) + swing * amp * rng.range(0.8, 1) * Math.min(1, 0.25 + t * 2);
        return [q(clamp(x, -limit, limit)), q(zb + (approach[1] - zb) * t)];
      });
      // Flank lanes leave the base sideways, so the lanes are apart as soon as they're off the plateau.
      if (!main) {
        const sx = clamp(bx + outward * (base.r + rng.range(5, 9)), -limit, limit);
        way.unshift([q(sx), q(zb - rng.range(1, 4))]);
        if (Math.abs(way[1]![0] - bx) < Math.abs(sx - bx)) way[1] = [q(clamp(way[1]![0] + outward * amp, -limit, limit)), way[1]![1]];
      }
      // Leave the plateau toward the first waypoint.
      const w1 = way[0]!;
      const ex = w1[0] - bx;
      const ez = w1[1] - zb;
      const el = len(ex, ez) || 1;
      const pts: [number, number][] = [[q(bx + (ex / el) * (base.r - 2)), q(zb + (ez / el) * (base.r - 2))], ...way, approach, [xc, 0]];
      const samples = toSamples(spline(pts, 1), width);
      if (samples.some((p) => Math.abs(p.x) > limit || p.z < -0.01 || p.z > H - EDGE_MARGIN)) { reject('bounds'); continue; }
      const sight = role === 'main' ? P.laneSight.main : P.laneSight.flank;
      if (longestStraight(samples) > sight * 0.75) { reject('straight'); continue; }
      const total = samples[samples.length - 1]!.s;
      // No doubling back: the lane keeps heading toward the middle overall.
      if (total > (zb + Math.abs(xc - bx)) * 1.7) { reject('long'); continue; }
      const candidate: Lane = { id, role, width, cross: xc, samples, length: total, chokeS: total * rng.range(0.38, 0.6) };
      // Lanes keep a ridge between them (away from the base, where they all start).
      let ok = true;
      for (const other of lanes) {
        // The ridge between lanes may be thin where they leave the base, full width further out.
        const need = (p: LaneSample) => (width + other.width) / 2 + 4 + (RIDGE_MIN - 4) * smoothstep(base.r + 6, base.r + 22, dist(p.x, p.z, bx, zb));
        const close = candidate.samples.some((p) => dist(p.x, p.z, bx, zb) > base.r + 4 && polylineGap([p], other.samples, bx, zb, base.r + 4) < need(p));
        if (close) { ok = false; reject('gap'); }
        else if (crosses(candidate.samples, other.samples, bx, zb, base.r + 2)) { ok = false; reject('cross'); }
      }
      if (ok) lane = candidate;
    }
    if (!lane) { reject(`lane ${id} of ${crossings.length}`); return null; }
    lanes.push(lane);
  }

  // Fair routes: no lane much longer than the shortest.
  const lengths = lanes.map((l) => l.length);
  if (Math.max(...lengths) / Math.min(...lengths) > 1.5) { reject('parity'); return null; }

  // Floors and chokes.
  const descent = (base.h - datum) / LANE_SLOPE;
  for (const lane of lanes) {
    const L = lane.length;
    const crossH = lane.cross === 0 ? midH : flankH;
    const bump = lane.role === 'flank' ? rng.range(-0.4, 1) : rng.range(-0.3, 0.4);
    // Crests across the lane: a rise you can't see over from the dip either side, so the lane is
    // fought in stretches rather than down its whole length. Kept off the choke and the ends.
    const crests: [number, number, number][] = [];
    const want = L > 52 ? 2 : 1;
    for (let attempt = 0; attempt < 12 && crests.length < want; attempt++) {
      const at = rng.range(descent + 6, L - 12);
      if (Math.abs(at - lane.chokeS) < 9 || crests.some(([c]) => Math.abs(c - at) < 18)) continue;
      crests.push([at, rng.range(1.7, 2.2), rng.range(6.5, 8.5)]);
    }
    const crest = (s: number) => {
      let h = 0;
      for (const [c, height, half] of crests) h = Math.max(h, height * (1 - smoothstep(0, half, Math.abs(s - c))));
      return h;
    };
    for (const p of lane.samples) {
      const s = p.s;
      const fromBase = (base.h - datum) * (1 - smoothstep(0, descent, s));
      const hump = bump * smoothstep(descent, descent + 9, s) * (1 - smoothstep(L - 18, L - 9, s));
      const end = (crossH - datum) * smoothstep(L - 13, L, s);
      p.h = q(datum + fromBase + hump + end + crest(s));
      const t = Math.abs(s - lane.chokeS);
      p.w = q(lane.width - (lane.width - P.chokeWidth) * (1 - smoothstep(2, 7, t)));
    }
  }

  // Connectors between neighbouring lanes, partway between the base and the middle.
  const connectors: Connector[] = [];
  const order = [...lanes].sort((a, b) => a.cross - b.cross);
  const pairs: [Lane, Lane][] = [];
  for (let i = 1; i < order.length; i++) pairs.push([order[i - 1]!, order[i]!]);
  const wanted = Math.min(pairs.length, rng.int(P.connectors[0], P.connectors[1]));
  rng.shuffle(pairs);
  for (const [a, b] of pairs.slice(0, wanted)) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const zt = zb * rng.range(0.32, 0.62);
      const pick = (l: Lane) => l.samples.reduce((best, p) => (Math.abs(p.z - zt) < Math.abs(best.z - zt) ? p : best));
      const pa = pick(a);
      const pb = pick(b);
      const mx = (pa.x + pb.x) / 2;
      const mz = (pa.z + pb.z) / 2 + rng.range(-3, 3);
      const samples = toSamples(spline([[pa.x, pa.z], [q(mx), q(mz)], [pb.x, pb.z]], 1), 4.5);
      if (samples.length < 6) continue;
      // Floor: from one lane's floor to the other's.
      const total = samples[samples.length - 1]!.s;
      for (const p of samples) p.h = q(pa.h + ((pb.h - pa.h) * p.s) / total);
      const clash = lanes.some((l) => l !== a && l !== b && crosses(samples, l.samples, bx, zb, 0))
        || connectors.some((k) => polylineGap(samples, k.samples, bx, zb, 0) < 10);
      if (clash) continue;
      connectors.push({ width: 4.5, samples, lanes: [a.id, b.id] });
      break;
    }
  }
  // Two lanes: a cross street along the middle line joins them through the middle.
  if (!three) {
    const [a, b] = order as [Lane, Lane];
    const pts: [number, number][] = [];
    for (let x = a.cross; x <= b.cross + 1e-6; x += 1) pts.push([q(x), 0]);
    const samples = toSamples(pts, 6);
    for (const p of samples) {
      const t = Math.abs(p.x) <= midR ? 1 : 1 - smoothstep(midR, midR + 8, Math.abs(p.x));
      p.h = q(flankH + (midH - flankH) * t);
    }
    connectors.push({ width: 6, samples, lanes: [a.id, b.id] });
  }

  // Overlooks: a raised spot beside some lanes, on the side away from the other lanes.
  const overlooks: Overlook[] = [];
  const want = P.half >= 70 ? 2 : P.half >= 54 ? rng.int(1, 2) : rng.int(0, 1);
  for (const lane of rng.shuffle([...lanes]).slice(0, want)) {
    const s = lane.length * rng.range(0.38, 0.62);
    const p = lane.samples.reduce((best, x) => (Math.abs(x.s - s) < Math.abs(best.s - s) ? x : best));
    // Normal pointing away from the middle lane (or outward for a main lane).
    let nx = -p.dz;
    let nz = p.dx;
    const outward = lane.cross === 0 ? Math.sign(p.x) || 1 : Math.sign(lane.cross);
    if (Math.sign(nx) !== outward) { nx = -nx; nz = -nz; }
    const off = p.w / 2 + 4.5;
    const ox = q(p.x + nx * off);
    const oz = q(p.z + nz * off);
    if (Math.abs(ox) > H - EDGE_MARGIN - 3 || oz < 6 || oz > H - EDGE_MARGIN - 3) continue;
    if (Math.abs(p.s - lane.chokeS) < 8) continue;
    overlooks.push({ lane: lane.id, x: ox, z: oz, nx: -nx, nz: -nz, h: p.h });
  }

  return { sym, half: H, base, datum, lanes, connectors, mid: { kind: midKind, r: midR, h: q(midH) }, overlooks };
}
