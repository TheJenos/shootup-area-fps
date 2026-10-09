import { NavGrid } from '../mapgen/navgrid';
import { Occlusion } from '../mapgen/sightlines';
import { groundHeight, type MapData } from '../mapgen';
import { GROUP, groups, type PhysicsWorld } from '../physics';
import { BotNav } from './nav';
import type { Senses } from './observe';

/*
 * A bot's senses on one map: line of sight from the map's occlusion grid, the way around from its
 * walk grid, and walls nearby from the physics world. The grids depend only on the map, so they're
 * built once per map and shared by every bot on it.
 */

interface MapKnowledge {
  nav: BotNav;
  occlusion: Occlusion;
}

const known = new Map<string, MapKnowledge>();
const KEEP = 24;

function knowledgeOf(map: MapData): MapKnowledge {
  const key = `${map.spec.seed}:${map.spec.size}:${map.spec.gen}:${map.hash}`;
  let k = known.get(key);
  if (k) return k;
  k = { nav: new BotNav(new NavGrid(map.ground, map.half, map.boxes)), occlusion: new Occlusion(map.ground, map.half, map.boxes) };
  known.set(key, k);
  if (known.size > KEEP) known.delete(known.keys().next().value!);
  return k;
}

/** Distance along a ray to the first piece of the map (or `max`). `extra` adds collision groups to hit. */
export function castWorld(
  physics: PhysicsWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, extra = 0,
): number {
  const { R, world } = physics;
  const hit = world.castRay(new R.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }), max, true, undefined, groups(0xffff, GROUP.WORLD | extra));
  return hit ? hit.timeOfImpact : max;
}

export class MapSenses implements Senses {
  readonly nav: BotNav;
  readonly occlusion: Occlusion;
  readonly center: { x: number; y: number; z: number };

  constructor(readonly map: MapData, private readonly physics: PhysicsWorld) {
    const k = knowledgeOf(map);
    this.nav = k.nav;
    this.occlusion = k.occlusion;
    this.center = { x: 0, y: groundHeight(map.ground, 0, 0), z: 0 };
  }

  sees(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.occlusion.visible(ax, ay, az, bx, by, bz);
  }

  probe(x: number, y: number, z: number, dx: number, dz: number, max: number): number {
    return castWorld(this.physics, x, y, z, dx, 0, dz, max);
  }
}
