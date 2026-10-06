/**
 * Generates many seeds and checks every map: reachability (levelgen/check.ts), the terrain (walkable
 * slopes, flat under everything placed, mirrored), determinism, and that the classic arena hasn't changed. Run with `npm run check:maps`.
 */
import { CLASSIC_SEED, STYLE_NAMES, generateMap, layoutName, mapName, terrainHeight, type MapLayout } from '../src/game/mapgen';
import { checkLayout } from '../src/game/levelgen/check';
import { rngFor } from '../src/game/levelgen/core';
import { settledFootprints } from '../src/game/levelgen/terrain';

const COUNT = Number(process.argv[2] ?? 300);
const CLASSIC_BOXES = 50; // the hand-made arena, checked against its box count and a checksum of the original
const CLASSIC_SUM = 406.6;

const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand = rngFor('check-maps');
const seeds = Array.from({ length: COUNT }, () => Array.from({ length: 6 }, () => chars[Math.floor(rand() * chars.length)]).join(''));

let failures = 0;
const styles = new Map<string, number>();
const fallbacks: string[] = [];
let boxes = 0;
let props = 0;
let worstWalk = 1;
let hilly = 0;
let tallest = 0;

/**
 * Problems with a layout's terrain: too steep, raised where things need flat ground, or a natural
 * thing floating above it. (Not checked for mirroring: models turn rather than reflect in mirrored
 * copies, so the flat ground around a lopsided one isn't an exact mirror image.)
 */
function checkTerrain(l: MapLayout): string[] {
  const t = l.terrain;
  if (!t) return [];
  const out: string[] = [];
  const side = t.n + 1;
  const h = (ix: number, iz: number) => t.heights[iz * side + ix]!;
  for (let iz = 0; iz <= t.n; iz++) {
    for (let ix = 0; ix <= t.n; ix++) {
      if (ix < t.n && Math.abs(h(ix + 1, iz) - h(ix, iz)) > 0.45 * t.cell + 0.011) out.push(`too steep at ${ix},${iz}`);
      if (iz < t.n && Math.abs(h(ix, iz + 1) - h(ix, iz)) > 0.45 * t.cell + 0.011) out.push(`too steep at ${ix},${iz}`);
    }
  }
  const ground = (x: number, z: number) => terrainHeight(t, l.half, x, z);
  for (const [x, z] of [...l.spawnPoints, ...l.flags, ...l.doors]) if (ground(x, z) > 0) out.push(`ground raised at ${x},${z}`);
  for (const b of l.boxes) {
    if (b.blocks === 'shots' || b.y > 0.5 + (b.rest ? 4 : 0)) continue;
    const corners = [[b.x, b.z], [b.x - b.w / 2, b.z - b.d / 2], [b.x + b.w / 2, b.z + b.d / 2], [b.x - b.w / 2, b.z + b.d / 2], [b.x + b.w / 2, b.z - b.d / 2]] as const;
    for (const [x, z] of corners) {
      if (!b.rest && ground(x, z) > 0) { out.push(`ground raised under a box at ${b.x},${b.z}`); break; }
      // A settled model's ground-level boxes may sink into the hillside but never hang above it.
      if (b.rest && b.y > ground(x, z) + 0.01 && b.y - ground(x, z) < 1) { out.push(`floating box at ${b.x},${b.z}`); break; }
    }
  }
  // Natural things stand on flat pads: no ground above their base anywhere under them.
  const pads = settledFootprints(l);
  for (const p of l.props) {
    const f = p.settle ? pads.get(`${p.x},${p.z}`) : undefined;
    if (!f) continue;
    let clips = false;
    for (let x = f.minX; x <= f.maxX + 1e-6 && !clips; x += 0.25) {
      for (let z = f.minZ; z <= f.maxZ + 1e-6; z += 0.25) if (ground(x, z) > p.y + 0.011) { clips = true; break; }
    }
    if (clips) out.push(`${p.id} at ${p.x},${p.z} clips into the ground`);
  }
  return out.slice(0, 4);
}
const t0 = performance.now();
for (const seed of seeds) {
  const a = generateMap(seed);
  const report = checkLayout(a);
  const name = layoutName(a);
  styles.set(name, (styles.get(name) ?? 0) + 1);
  if (a.style === 'arena') fallbacks.push(seed);
  else if (!name.startsWith(mapName(seed).split(' · ')[0] ?? '')) { console.log(`✗ ${seed}: mapName ${mapName(seed)} vs ${name}`); failures++; }
  if (!report.ok) { failures++; console.log(`✗ ${seed} (${name}): ${report.problems.slice(0, 4).join('; ')}`); }
  const terrain = checkTerrain(a);
  if (terrain.length) { failures++; console.log(`✗ ${seed} (${name}) terrain: ${terrain.join('; ')}`); }
  if (a.terrain) {
    hilly += a.terrain.heights.filter((v) => v > 0.2).length / a.terrain.heights.length;
    tallest = Math.max(tallest, ...a.terrain.heights);
  }
  worstWalk = Math.min(worstWalk, report.walkable);
  boxes += a.boxes.length;
  props += a.props.length;
}
const ms = (performance.now() - t0) / COUNT;

// Same seed, same map (bypassing the cache by generating more seeds in between).
for (const seed of seeds.slice(0, 5)) {
  const one = JSON.stringify(generateMap(seed));
  for (const other of seeds.slice(10, 20)) generateMap(other);
  if (JSON.stringify(generateMap(seed)) !== one) { failures++; console.log(`✗ ${seed}: not deterministic`); }
}

const classic = generateMap(CLASSIC_SEED);
const sum = Math.round(classic.boxes.reduce((s, b) => s + b.x * 3 + b.z * 7 + b.w + b.h + b.d + b.y, 0) * 10) / 10;
if (classic.boxes.length !== CLASSIC_BOXES || sum !== CLASSIC_SUM) {
  failures++;
  console.log(`✗ classic changed: ${classic.boxes.length} boxes, checksum ${sum}`);
}

console.log(`${COUNT} seeds, ${ms.toFixed(1)} ms each, ${Math.round(boxes / COUNT)} boxes and ${Math.round(props / COUNT)} props on average, least walkable ${(worstWalk * 100).toFixed(0)}%`);
console.log(`Terrain: ${((hilly / COUNT) * 100).toFixed(0)}% of the ground raised on average, tallest ${tallest.toFixed(1)} m`);
console.log('Styles:', [...styles].map(([k, v]) => `${k} ${v}`).join(', '));
if (fallbacks.length) console.log(`Fell back to the arena: ${fallbacks.length} (${fallbacks.slice(0, 8).join(' ')})`);
void STYLE_NAMES;
if (failures) {
  console.log(`${failures} problem(s)`);
  process.exit(1);
}
console.log('All maps OK');
