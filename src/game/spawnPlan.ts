/*
 * Where everyone starts a round. At a round start every client respawns at the same moment, and picking
 * "the spawn farthest from enemies" from where people stood on the last map sent them all to the same few
 * spots. Instead every client (and the bot host) works out the same plan from the same inputs: the spawn
 * points ordered so each next one is as far as possible from those before it, handed out to the players in
 * id order, and rotated every round so nobody always gets the same spot.
 */

export interface SpawnSpot {
  x: number;
  z: number;
}

/** Spread a round's players this far apart when there are more of them than spawn points (m) */
const CROWD_STEP = 1.4;

/** A small, stable hash of a string (for the round's rotation) */
export function spawnSalt(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The spawn points' indices, ordered so each is as far as possible from all the ones before it (farthest-point
 * order). The first is picked by `salt`; ties go to the lower index, so every client gets the same order.
 */
export function spreadOrder(points: readonly SpawnSpot[], salt: number): number[] {
  const n = points.length;
  if (!n) return [];
  const order = [salt % n];
  const nearest = points.map((p) => Math.hypot(p.x - points[order[0]!]!.x, p.z - points[order[0]!]!.z));
  const taken = new Set(order);
  while (order.length < n) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (!taken.has(i) && (best < 0 || nearest[i]! > nearest[best]! + 1e-9)) best = i;
    }
    order.push(best);
    taken.add(best);
    const b = points[best]!;
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i]!, Math.hypot(points[i]!.x - b.x, points[i]!.z - b.z));
  }
  return order;
}

/**
 * Where `id` starts the round: its point in the plan (index into `points`), and a sideways nudge for when
 * there are more players than points (each extra lap stands a bit further to the side).
 * `ids` is everyone sharing these points (the whole room in FFA, one team otherwise); null if `id` isn't in it.
 */
export function roundSpawn(
  points: readonly SpawnSpot[], ids: readonly string[], id: string, salt: number,
): { index: number; dx: number; dz: number } | null {
  const rank = [...ids].sort().indexOf(id);
  if (rank < 0 || !points.length) return null;
  const order = spreadOrder(points, salt);
  const lap = Math.floor(rank / order.length);
  const angle = lap * 2.4;
  const r = lap ? CROWD_STEP * lap : 0;
  return { index: order[rank % order.length]!, dx: Math.cos(angle) * r, dz: Math.sin(angle) * r };
}
