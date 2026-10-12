# Maze-first map generator (rewrite)

## Context
The current generator (`src/game/mapgen/`) designs a blocky footprint, fits a lane graph in it, shapes terrain and dresses it (~4.7k lines: outline/graph/terrain/dress/kits/placer/routes/…). The user wants it rebuilt from scratch around a different idea, shown in their two sketches:

1. **Maze → path**: generate a maze, take a winding path through it (sketch 1: one snaking corridor).
2. **Widen**: grow open areas (blobs) around that path (sketch 2) and **fill the open spaces with objects**.

Decisions (from the user):
- **Symmetric halves**: the maze/path is generated in red's half (z > 0) from base to middle line, then copied under `rotate` or `mirror` symmetry. Flags sit at the path's two ends.
- **Main path + a few loops**: one winding main path, plus 1–3 reopened maze walls / short side pockets per half so there are flanks.
- **Walkable fill**: the blobs are playable, filled with biome objects (rocks, trees, crates, containers, small buildings) with gaps to move through; the path core stays mostly clear.
- **Full rewrite** of the generation code. Only the runtime plumbing that the game, bots, preview and physics import is kept (listed below), since rewriting it would change nothing the player sees.

## What stays vs goes
**Kept as is** (imported by game/bots/UI, not part of the "how a map is designed"):
`rng.ts`, `hash.ts`, `dmath.ts`, `heightField.ts`, `navgrid.ts`, `symmetry.ts`, `classic.ts` (the hand-made CLASSIC map must not change; tested), `themes.ts`, `client.ts`, `worker.ts`, and `Occlusion` from `sightlines.ts` (used by `bot/senses.ts`).

**Kept, edited**: `types.ts` (replace `LaneGraph` with a `MazeLayout` — nothing outside mapgen reads `map.graph`), `spec.ts` (new `SizeParams`), `index.ts` (re-exports; bump `GENERATOR_VERSION` to 4; `insideOutline`/`outsideRects` now come from `layout.ts`), `validate.ts` (rewritten, smaller).

**Deleted**: `outline.ts`, `graph.ts`, `routes.ts`, `terrain.ts`, `dress.ts`, `kits.ts`, `placer.ts`, `biomes.ts` (re-written), the rest of `sightlines.ts` beyond `Occlusion`, `golden.json` (regenerated), and their tests.

`MapData` keeps every field the game reads: `ground`, `boxes`, `props`, `patches`, `flags`, `spawns`, `pickupSpots`, `outline` (same `Outline` shape: `cell/n/half/inside`), `edge.height`, `path`, `indoor`, `theme`, `name`, `biome`, `half`, `spec`, `hash`.

## New pipeline (`generate.ts`)
```
meta (biome/theme/name) → maze → path + loops → widen → ground → objects → edge → checks
```
Each stage forks its own `Rng` stream; a roll failing checks is retried (up to 6 rolls, keep the best), as today.

### 1. `maze.ts` — maze on red's half
- Grid of maze cells over red's half. Cell = 2 outline blocks (8 m). Grid size from `SizeParams` (e.g. s ≈ 9×5, m ≈ 12×6, l ≈ 16×8; exact values tuned so the map fits `gridHalf`).
- Perfect maze via iterative recursive-backtracker (DFS with seeded random neighbour order) → spanning tree. Optional bias: prefer horizontal moves to get long snaking runs like the sketch.
- Output: `walls` bitmask per cell + adjacency.

### 2. `path.ts` — winding main path + loops
- **Base cell**: random cell in the back rows (far from the middle line). **Crossing cell**: a cell in the row touching the middle line.
- Main path = the unique tree path between them (BFS on the maze). Try several base/crossing pairs and pick the one whose length lands in a target band: winding ratio 1.8–3× straight distance and walk time ≤ `crossTime` (so maps aren't endless).
- **Middle join**: the middle-row cells between crossing `c` and its symmetric copy (`-c` for rotate, `c` for mirror) are opened into a mid strip, so red's path meets blue's copy. That strip becomes the mid plaza.
- **Loops**: reopen 1–3 maze walls between two path cells whose path distance differs by ≥ 4 cells (a shortcut flank), and keep 1–2 short dead-end branches (1–2 cells) as pockets for pickups. Loops never cut the flag-to-flag walk below a minimum (re-pick otherwise).

### 3. `layout.ts` — widen to blobs, build the `Outline`
- Rasterize the path (+ loops, pockets, mid strip) onto the 4 m block grid as a corridor (`laneWidth` wide, i.e. 2–3 blocks).
- **Grow blobs** (the scribbled regions in sketch 2): seed 2–4 blobs per half at path bends, pocket ends and near the base; grow each by a noisy flood fill (random frontier, distance + value-noise threshold) up to a target area.
- **Keep the maze's winding**: every open block carries the path distance (`s`) of the path cell it grew from. A block can't open if a neighbouring open block has `|Δs|` > a few cells — so blobs never merge two far-apart path segments and turn the snake into a straight line. (Loops are the only allowed shortcuts.)
- Base yard: a round clearing of `baseR` around the flag.
- Copy red's half under symmetry → `Outline` (`inside` flags), plus helpers kept with the same signatures: `insideOutline`, `outsideRects`, `gridHalf`, and an `edgeDistance` field for later stages.
- Also outputs per-block tags: `path` (corridor core), `open` (blob), `base`, `mid` — used by ground paint and object placement.

### 4. `ground.ts` — terrain heights
- Height field (1 m grid, same `Ground` format) from smoothed value noise scaled per biome, flattened along the path core (gentle slope along it), base and mid flattened, blobs allowed small rises/dips, outside blocks raised toward the edge.
- Slope-limit relaxation pass so no slope exceeds `MAX_SLOPE` (0.6, moved here); heights ≥ 0; symmetric by copying red's half via `tVertex`.
- Paint: `path` on corridor core, `rough` in blobs, `rock` near edges, `floor` elsewhere.

### 5. `objects.ts` + `biomes.ts` — fill open spaces
- `objects.ts`: a fresh, small kit library producing `Piece`s (boxes + props from `propManifest.ts`): crate, crate stack, low wall, sandbags, barrels, container, rock/tree/bush models (prop collision boxes via `pivot`, like now), small enterable hut (4 walls + door + flat roof).
- `biomes.ts` (rewritten): per biome — themes, names, edge style (cliffs/buildings), path paint, noise amplitude, and three weighted object pools: `blob` (dense fill: trees/rocks/containers), `cover` (along the path), `landmark` (one centrepiece in the mid strip).
- Placement (red's half, then `tPiece` copy):
  - **Blobs**: Poisson-disc scatter on open blocks with a per-biome density; each candidate must keep ≥ `GAP` (1.6 m) walkable clearance to its neighbours and the outline edge, so blobs are dense but walkable.
  - **Path**: cover every `coverGap` metres alternating sides, kept out of the middle strip of the corridor; extra cover at bends (natural chokes).
  - **Mid**: one landmark + ring of cover. **Base**: kept clear within `FLAG_CLEARANCE`, a few low cover pieces at the yard edge.
  - Spawns: around the base yard (`spawnsPerTeam`), clear of objects. Pickup spots: pocket ends, loop midpoints, blob centres.
  - Sightline cap: after placement, use `Occlusion` to find path stretches seeing further than `laneSight` and drop a tall piece across them.

### 6. Edge
- Outside blocks merged greedily into rectangles → tall boxes (cliff rock or building facades from the biome edge style) above the highest ground under them; a few taller skyline pieces at the far ring. `edge.height` = rim height.

### 7. `validate.ts` (rewritten)
Hard checks: every spawn, both flags and every pickup spot reachable on the `NavGrid`; flag carrier can get home; slopes ≤ `MAX_SLOPE`; halves are exact copies; flag-to-flag walk within `crossTime`; clutter share under a cap. Reports `flagToFlag`, winding ratio, loops, longest sightline.

## Tooling & tests
- `scripts/check-maps.ts`: drop `graphStats`/`overpassStats`; add a `--stages SEED` dump writing three PNGs per map — maze + main path (like sketch 1), widened outline (like sketch 2), final map with objects — for eyeballing; keep determinism, banned-maths and golden checks.
- Regenerate `golden.json` (`npm run check:maps -- --update-golden`) after bumping `GENERATOR_VERSION` to 4.
- Rewrite `__tests__/generate.test.ts` and `outline.test.ts`/`routes.test.ts` → `maze.test.ts`, `layout.test.ts`:
  - maze is a spanning tree (cells − 1 openings, all connected);
  - main path connects base to crossing and its winding ratio is in band;
  - blobs never join path cells with `|Δs|` above the limit;
  - outline is symmetric; maps are deterministic per spec; classic map unchanged; spawns per team in own half.
- Existing game/bot tests that use generated maps (`snd.test.ts`, `spawnPlan.test.ts`, `bot/__tests__/*`) must still pass unchanged.

## Verification
1. `npm run typecheck` and `npm test`.
2. `npm run check:maps -- --count 120` (all sizes valid, deterministic, no banned maths) and `npm run test:maps`.
3. `npm run check:maps -- --stages SEED` for a few seeds; look at the three PNGs to confirm maze → snake path → blobs → filled map matches the sketches.
4. Run the app (`npm run dev`), open the lobby map preview for several seeds/sizes, start a match with bots and walk the path from flag to flag: bots navigate, objects in blobs are passable, edges are solid.
