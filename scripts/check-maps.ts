/**
 * Generates many seeds and checks every map: reachability (levelgen/check.ts), determinism,
 * and that the classic arena hasn't changed. Run with `npm run check:maps`.
 */
import { CLASSIC_SEED, STYLE_NAMES, generateMap, layoutName, mapName } from '../src/game/mapgen';
import { checkLayout } from '../src/game/levelgen/check';
import { rngFor } from '../src/game/levelgen/core';

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
const t0 = performance.now();
for (const seed of seeds) {
  const a = generateMap(seed);
  const report = checkLayout(a);
  const name = layoutName(a);
  styles.set(name, (styles.get(name) ?? 0) + 1);
  if (a.style === 'arena') fallbacks.push(seed);
  else if (!name.startsWith(mapName(seed).split(' · ')[0] ?? '')) { console.log(`✗ ${seed}: mapName ${mapName(seed)} vs ${name}`); failures++; }
  if (!report.ok) { failures++; console.log(`✗ ${seed} (${name}): ${report.problems.slice(0, 4).join('; ')}`); }
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
console.log('Styles:', [...styles].map(([k, v]) => `${k} ${v}`).join(', '));
if (fallbacks.length) console.log(`Fell back to the arena: ${fallbacks.length} (${fallbacks.slice(0, 8).join(' ')})`);
void STYLE_NAMES;
if (failures) {
  console.log(`${failures} problem(s)`);
  process.exit(1);
}
console.log('All maps OK');
