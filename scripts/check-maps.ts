/**
 * Generates many maps and checks them all (mapgen/validate.ts): reachability, slopes, symmetry,
 * plus how many rolls each map took, sightlines and timing per size. Also checks determinism,
 * that the classic arena hasn't changed, that the generator never calls engine-dependent maths,
 * and (with --golden) that no map changed without a GENERATOR_VERSION bump.
 *
 *   npm run check:maps -- [--count 200] [--size s,m,l] [--seed X] [--dump SEED] [--golden] [--update-golden]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { CLASSIC_SEED, GENERATOR_VERSION, generateMap, groundHeight, mapName, toSpec, type MapData, type MapSize } from '../src/game/mapgen/index';
import { generateWithReport } from '../src/game/mapgen/generate';
import { Rng } from '../src/game/mapgen/rng';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const COUNT = Number(opt('count', '120'));
const SIZES = opt('size', 's,m,l').split(',') as MapSize[];
const GOLDEN_FILE = 'src/game/mapgen/golden.json';
const GOLDEN_SEEDS = 30;

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`✗ ${msg}`); };

// ---------------------------------------------------------------- engine-dependent maths
const BANNED = /Math\.(hypot|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log2|log10|log1p|pow|cbrt|random)\b|\*\*/;
for (const file of readdirSync('src/game/mapgen')) {
  if (!file.endsWith('.ts')) continue;
  readFileSync(join('src/game/mapgen', file), 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/^\s*(\/\*\*|\*).*$/, '');
    if (BANNED.test(code) && !line.includes('det-ok')) fail(`mapgen/${file}:${i + 1} uses engine-dependent maths: ${line.trim()}`);
  });
}

// ---------------------------------------------------------------- the classic arena
const CLASSIC_BOXES = 50;
const CLASSIC_SUM = 406.6;
const classic = generateMap(toSpec(CLASSIC_SEED));
const sum = Math.round(classic.boxes.reduce((s, b) => s + b.x * 3 + b.z * 7 + b.w + b.h + b.d + b.y, 0) * 10) / 10;
if (classic.boxes.length !== CLASSIC_BOXES || sum !== CLASSIC_SUM) fail(`classic changed: ${classic.boxes.length} boxes, checksum ${sum}`);

// ---------------------------------------------------------------- one map as a picture
function dump(map: MapData, file: string, lines: { ax: number; az: number; bx: number; bz: number }[] = []): void {
  const S = 6;
  const W = Math.round(map.half * 2 * S);
  const png = new PNG({ width: W, height: W });
  const put = (px: number, py: number, [r, g, b]: [number, number, number]) => {
    if (px < 0 || py < 0 || px >= W || py >= W) return;
    const i = (py * W + px) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  };
  const toPx = (x: number, z: number) => [Math.round((x + map.half) * S), Math.round((map.half - z) * S)] as const;
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const x = px / S - map.half;
      const z = map.half - py / S;
      const h = groundHeight(map.ground, x, z);
      const l = Math.min(255, 70 + h * 28);
      put(px, py, [l * 0.8, l, l * 0.7]);
    }
  }
  const rect = (x: number, z: number, w: number, d: number, c: [number, number, number]) => {
    const [x0, y0] = toPx(x - w / 2, z + d / 2);
    const [x1, y1] = toPx(x + w / 2, z - d / 2);
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) put(px, py, c);
  };
  for (const b of map.boxes) {
    const top = b.y + b.h - groundHeight(map.ground, b.x, b.z);
    const c: [number, number, number] = b.blocks === 'shots' ? [40, 110, 40] : b.ramp ? [220, 200, 80] : top > 2.2 ? [150, 40, 40] : top > 1.4 ? [210, 100, 60] : [230, 170, 120];
    rect(b.x, b.z, b.w, b.d, c);
  }
  for (const l of map.graph?.lanes ?? []) for (const [x, z] of l.points) { const [px, py] = toPx(x, z); put(px, py, [255, 255, 255]); }
  for (const s of map.spawns) rect(s.x, s.z, 1, 1, s.team === 'red' ? [255, 0, 0] : s.team === 'blue' ? [0, 80, 255] : [255, 0, 255]);
  for (const p of map.pickupSpots) rect(p.x, p.z, 0.8, 0.8, [0, 255, 255]);
  for (const l of lines) {
    const n = Math.ceil(Math.hypot(l.bx - l.ax, l.bz - l.az) * S);
    for (let i = 0; i <= n; i++) { const [px, py] = toPx(l.ax + ((l.bx - l.ax) * i) / n, l.az + ((l.bz - l.az) * i) / n); put(px, py, [255, 0, 255]); }
  }
  rect(map.flags.red[0], map.flags.red[2], 2, 2, [255, 255, 0]);
  rect(map.flags.blue[0], map.flags.blue[2], 2, 2, [255, 255, 0]);
  writeFileSync(file, PNG.sync.write(png));
}

const dumpSeed = opt('dump', '');
if (dumpSeed) {
  const dir = opt('out', 'node_modules/.cache/maps');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const size of SIZES) {
    const g = generateWithReport(toSpec(dumpSeed, size));
    const file = join(dir, `${dumpSeed}-${size}.png`);
    dump(g.map, file, g.sight.lines);
    console.log(`${file}: ${g.map.name}, roll ${g.roll}, ${g.map.graph?.symmetry}, ${g.map.graph?.lanes.length} lanes, mid ${g.map.graph?.mid.kind}`);
    console.log('  report', JSON.stringify(g.report), 'sight', JSON.stringify({ ...g.sight, lines: g.sight.lines.length }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------- many seeds per size
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand = new Rng('check-maps');
const only = opt('seed', '');
const seeds = only ? [only] : Array.from({ length: COUNT }, () => Array.from({ length: 6 }, () => chars[Math.floor(rand.next() * chars.length)]).join(''));
const pct = (list: number[], p: number) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const stat = (label: string, list: number[], digits = 1) =>
  `${label} p50 ${pct(list, 0.5).toFixed(digits)} p95 ${pct(list, 0.95).toFixed(digits)} max ${Math.max(...list).toFixed(digits)}`;

const biomes = new Map<string, number>();
for (const size of SIZES) {
  const ms: number[] = []; const rolls: number[] = []; const laneOver: number[] = []; const flagSeen: number[] = []; const spawnSeen: number[] = [];
  const f2f: number[] = []; const clutter: number[] = []; const boxes: number[] = []; const breakers: number[] = [];
  let failed = 0;
  for (const seed of seeds) {
    const t0 = performance.now();
    const g = generateWithReport(toSpec(seed, size));
    ms.push(performance.now() - t0);
    rolls.push(g.roll);
    laneOver.push(g.sight.laneOver); flagSeen.push(g.sight.flagSeen); spawnSeen.push(g.sight.spawnSeen); breakers.push(g.sight.breakers);
    f2f.push(g.report.metrics.flagToFlag); clutter.push(g.report.metrics.clutter * 100); boxes.push(g.map.boxes.length);
    biomes.set(g.map.biome, (biomes.get(g.map.biome) ?? 0) + 1);
    if (g.map.name !== mapName(seed)) fail(`${seed} ${size}: mapName ${mapName(seed)} vs ${g.map.name}`);
    if (!g.report.ok) { failed++; fail(`${seed} ${size} (${g.map.name}): ${g.report.problems.slice(0, 4).join('; ')}`); }
  }
  console.log(`\n[${size}] ${seeds.length} seeds, ${failed} failed`);
  console.log(`  ${stat('ms', ms, 0)}; ${stat('roll', rolls, 0)}; ${stat('boxes', boxes, 0)}`);
  console.log(`  ${stat('flag-to-flag m', f2f, 0)}; ${stat('clutter %', clutter)}`);
  console.log(`  sight: ${stat('lane over m', laneOver)}; ${stat('flag seen', flagSeen, 0)}; ${stat('spawn seen', spawnSeen, 0)}; ${stat('breakers', breakers, 0)}`);
}
console.log('\nBiomes:', [...biomes].map(([k, v]) => `${k} ${v}`).join(', '));

// ---------------------------------------------------------------- determinism and golden hashes
for (const seed of seeds.slice(0, 4)) {
  const spec = toSpec(seed, 'm');
  const a = generateWithReport(spec).map.hash;
  generateWithReport(toSpec(`${seed}X`, 's'));
  if (generateWithReport(spec).map.hash !== a) fail(`${seed}: not deterministic`);
}
if (flag('golden') || flag('update-golden')) {
  const golden: Record<string, number> = {};
  for (const seed of seeds.slice(0, GOLDEN_SEEDS)) for (const size of ['s', 'm', 'l'] as const) golden[`${size}:${seed}`] = generateWithReport(toSpec(seed, size)).map.hash;
  const file: Record<string, Record<string, number>> = existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) : {};
  if (flag('update-golden')) {
    file[String(GENERATOR_VERSION)] = golden;
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(file, null, 1)}\n`);
    console.log(`Golden hashes for version ${GENERATOR_VERSION} written`);
  } else {
    const want = file[String(GENERATOR_VERSION)];
    if (!want) fail(`no golden hashes for version ${GENERATOR_VERSION} (run with --update-golden)`);
    else for (const [k, v] of Object.entries(golden)) if (want[k] !== v) fail(`${k} changed without a GENERATOR_VERSION bump`);
  }
}

if (failures) {
  console.log(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log('\nAll maps OK');
