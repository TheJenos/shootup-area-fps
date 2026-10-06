# Map generation v2: lane-graph generator

## Context

Today's maps (`src/game/mapgen.ts` + `src/game/levelgen/*`) scatter boxes and props across a flat arena. Hills come from value noise added afterwards (`levelgen/terrain.ts`).

The resulting maps play and look badly:
- cluttered and samey
- no readable lanes
- poor sightlines and base balance
- hills that feel tacked on (the slope limiter can only *lower* ground, so raised features get flattened)

There are also correctness problems:
- **Generation can differ between browsers:**
  - the sort-based shuffle at `building.ts:207`
  - `Math.hypot` used in decisions
  - no generator version
- **Reachability is checked before terrain exists.**
- **Physics and gameplay disagree with the terrain:**
  - the player and grenade clamps ignore it
  - deployables float on slopes
  - the terrain triangle mesh can snag players on internal edges
- **The cached layout is mutated in place.**
- **Generation runs on the main thread** on every lobby keystroke.

**Decisions:**
- A full rework built around a **lane graph**: generate an abstract, symmetric CTF layout first (bases, mid, 2–3 lanes, connectors, chokes, overlooks), shape the terrain *from* that graph, then dress it per biome.
- New biomes are fine.
- **S/M/L map size** is a room setting.
- **Moderate verticality:** walkable rooftops, platforms, bridges.
- Random seeds may produce new maps, but **CLASSIC stays identical** (`e2e/ctf.spec.ts` relies on BASE = ±32).
- The generator version is stored with the room.

## Architecture

`src/game/mapgen.ts` becomes `src/game/mapgen/index.ts`, so existing import paths still resolve. New modules:

```
mapgen/
  index.ts       generateMap(spec), getMapSync, requestMap, mapName(spec), layoutName, normalizeSeed,
                 randomSeed, CLASSIC_SEED, SEED_MAX_LENGTH, GENERATOR_VERSION, MAP_SIZES, isPlayableSpec
  spec.ts        MapSpec {seed,size,gen}, SIZE_PARAMS, specKey
  types.ts       MapData, HeightField, LaneGraph, Spawn{team}, PickupSpot, zones (MapBox/MapProp move here)
  rng.ts         Rng: same sequence as core.rngFor; fork(label); Fisher-Yates shuffle
  dmath.ts       len() = sqrt(dx²+dz²), q() rounding to 0.01, segIntersect; NO trig, hypot, pow
  symmetry.ts    'rotate' (-x,-z) | 'mirror' (x,-z); applyT generalised from core.mirrored()
  heightField.ts sample/normal/slopeAt, one triangle-split rule shared by rendering, physics and validation, toRapier()
  distance.ts    exact distance transform (EDT) + slope-envelope resolver (raises AND lowers; replaces limitSlope)
  graph/         build.ts (nodes), route.ts (Catmull-Rom lanes, chokes, connectors), metrics.ts
  zones.ts       zone and lane-id grids from the graph
  terrain.ts     graph -> heights (lane floors, base plateaus, ridges between lanes, pins, paint)
  structures/    placer.ts (zone-aware, symmetric, budgets), cover.ts, platform.ts, bridge.ts,
                 building.ts (moved; walkable roofs; Fisher-Yates), props.ts (moved)
  biomes/        index.ts + quarry.ts, oldtown.ts, highlands.ts, refinery.ts
  dress.ts       landmark -> base kit -> overlooks -> bridges -> chokes -> cover fill -> edges -> pickups
  sightlines.ts  occlusion grid, line-of-sight rays, breaker-placement loop
  navgrid.ts     2.5D walk grid using the shared player dimensions
  validate.ts    validateMap(data): {ok, problems, metrics}
  classic.ts     CLASSIC in the new format (boxes copied verbatim, ground null, half 40)
  legacy.ts      temporary adapter: v1 levelgen output -> MapData
  hash.ts, cache.ts (LRU(6) by gen:size:seed, deep-frozen), worker.ts, client.ts
src/game/playerDims.ts   RADIUS/HEIGHT/STEP_UP/MAX_SLOPE/HEADROOM (removes the copies in check.ts)
src/game/spatialGrid.ts  4 m grid index for colliders, ramps and ground patches
```

### Pipeline

Each stage uses its own forked RNG stream, so a change in dressing never reshuffles the graph.

```
spec -> meta (biome, theme, symmetry, landmark, name)  [mapName needs only this stage]
     -> graph -> zones -> terrain sculpt -> dress (pads re-pin terrain) -> sightline fixups
     -> symmetry finalise -> validate (AFTER terrain) -> freeze + hash
retry graph #1..#3; last resort = fixed 3-lane SAFE_TEMPLATE graph dressed by the same biome
```

### Key algorithms

- **Sizes (S/M/L):**
  - half-width 40/54/70, flag z 30/42/56
  - lanes: S has 2–3, M has 3 or 2, L has 3 plus a possible high lane
  - choke width 4.5/5/5.5 m
  - spawns per team 6/8/10
- **Symmetry:** 70% rotational (fairer peeks, both teams get "the long lane on the left"), 30% mirror. The existing `mirrorRot`, `mirrorRampDir` and `mirrorPivotBox` already support sx = sz = -1.
- **Lanes:**
  - Red's half is built first, then transformed to blue's.
  - Crossing points on z = 0 at x ∈ {−c, 0, +c}, which makes paired lane lengths equal by construction.
  - Straight runs are capped at the sightline budget by inserting a waypoint when a run is too long.
  - No lane crossings, and lanes keep a gap of at least 8 m for the ridge between them.
  - Each lane gets a choke at 35–60% of its length; connectors cut saddles through the ridges.
- **Terrain from the graph:**
  - Base plateaus are 1.6–2.4 m and descend to lane floors.
  - Ridges between lanes rise ≥ 2.6 m above both lane floors, so terrain blocks line of sight between lanes.
  - The mid is one of: plaza, hill, ravine or tower.
  - Pinned heights (base, lanes, spawns, structure pads) are reconciled by the envelope resolver with a maximum slope of 0.5. All heights stay ≥ 0, so the floor slab can stay.
  - Paint channels (path, rough, rock) plus valley darkening fix the bland look.
- **Sightline budgets (S/M/L):**
  - main lane 35/45/55 m, flank lane 25/30/35 m, mid 40/50/60 m
  - the flag can't be seen from more than 30 m inside the enemy half
  - no spawn can be seen from the enemy half
  - Fixup loop: up to 6 rounds placing tall cover or terrain knolls, otherwise retry the graph.
- **Dressing budgets:**
  - Each zone gets a footprint density (lane 0.08, choke 0.14, ridge 0.20, …).
  - Lanes get no dead zones: along each lane there is always cover within 7 m (S/M) or 9 m (L).
  - **Clutter cap:** solid footprint ≤ 18% of the walkable area.
  - Pickup spots are placed by design rather than randomly.
- **Verticality kits:**
  - platforms: ramps ≤ 26.6°, or stairs with 0.35 m steps
  - walkable rooftops: parapet, exterior stairs
  - bridges: clearance ≥ 2.4 m over lanes, with railings
  - Target: 8–25% of the walkable area raised above the lane floor + 1.5 m.

### Biomes

All four use existing props from `propManifest.ts`.

| Biome | Terrain | Mid landmark | Kits |
|---|---|---|---|
| Quarry | deep lanes, rocky ridges, possible ravine mid | Ore Derrick or a steel bridge over the ravine | containers, tall rocks, logs |
| Old Town | nearly flat, building rows act as ridges, streets as lanes | clock-tower plaza or fountain | shops and houses, enterable buildings at chokes, walkable rooftops, rooftop bridges |
| Highlands | soft ridges with forest on the crests | fire-lookout tower or log bridge over a ford | trees, rocks, cabins, tents |
| Refinery | factory blocks as ridges, catwalk high lane on L | tank farm or cooling stack | factories, tanks, catwalk bridges, barrels |

The name format `"<Landmark> · <Biome>"` keeps the `·` that `create-room.spec.ts` checks.

## Determinism and versioning

- **One RNG and Fisher-Yates only.**
- **Banned in `src/game/mapgen/**`:** `Math.hypot`, the trig, exp, log and pow functions, and `Math.random`. `check-maps` scans for them.
- **All outputs are quantised with `q()`.** Iteration uses arrays and Maps only.
- **Golden hashes** (30 seeds × 3 sizes) in `mapgen/__tests__/golden.json`. If the output changes without a `GENERATOR_VERSION` bump, CI fails.
- **Firebase fields:**
  - `lobby/{code}`: `gen`, `size`
  - `rooms/{code}/game`: `gen`, `size`, `mapHash`
  - Rules for these go in `database.rules.json`, with cases added to `scripts/test-rules.mjs`.
  - `roomSetup` defaults missing values to gen 1 and size 'm'.
- **Version mismatch:**
  - RoomBrowser shows an "Older/Newer version" badge and disables Join.
  - Joining by code shows a notice, plus a reload button in Discord.
  - `onGame` guards with a blocking overlay.
  - If the `mapHash` written by the client that starts the round differs from a client's own hash, that client gets a warning toast.

## World, physics and gameplay changes

- **`world.ts buildWorld(scene, data: MapData, …)`:**
  - The floor is built from the `HeightField` with a splat material driven by the paint attribute.
  - Spawns are typed by team.
  - `groundAt` uses the height field plus the spatial grid instead of a linear scan.
  - New: `terrainAt`, `slopeUnder`, `addDynamic` / `removeDynamic`, `anyColliderIn`.
  - The sun sits on the x axis so neither team attacks into it.
- **`physics.ts setMap(colliders, ramps, ground)`:** a Rapier `heightfield` collider with `FIX_INTERNAL_EDGES` replaces the triangle mesh. A DEV-only self-test casts rays and checks the hits against `HeightField.sample`, to verify the triangle split and orientation.
- **`player.ts:303`:** the clamp uses terrain height. **`grenades.ts`:** the terrain clamp, and the fallback path bounces off the height field.
- **`modes.ts`:** `teamSpawns` filters by `team`, which fixes the dropped z = 0 spawns. `setFlagBases` takes y from the ground, so flag pickup works on plateaus.
- **Deployables** (`game.ts` ~2445/2635, `deployables.ts`): refuse placement when the ground under the footprint varies by more than 0.45 m; otherwise extend the collider down to the ground (a "skirt").
- **`pickups.ts`:** use `data.pickupSpots`, and query the spatial grid.
- **`MapPreview.tsx`:** the 2D fallback shades by height and draws the lanes.
- **`PauseMenu.tsx`:** reads the current map from the HUD instead of regenerating it.
- **Size UI:** a Small/Medium/Large radio in `Lobby.tsx` and `DiscordLobby.tsx`.
  - Disabled for classic.
  - The last choice is remembered in localStorage.
  - The size is shown in RoomBrowser.
  - It flows through `createRoom` / `createRoomWithCode` / `setLobbyMap` / `requestNextRound` in `network.ts` and `game.ts`.
- **Performance:**
  - Generation runs in a module Web Worker (`requestMap`), with a synchronous fallback.
  - Lobby input is debounced by 250 ms via a `useMapData` hook.
  - The next map is prefetched during the intermission.
  - The first join waits for the map in `GameView`.
  - Budget for M: under 150 ms on desktop, under 400 ms on mobile.

## Phased delivery (the game stays playable after each phase)

0. **Safety nets:**
   - `playerDims.ts`
   - vitest, or `node:test` if vitest doesn't support Vite 8
   - tests pinning the RNG sequence and the CLASSIC checksum (50 boxes, sum 406.6)
   - `.github/workflows/checks.yml` running typecheck, tests and `check:maps`
1. **New format on v1 output:**
   - move `mapgen.ts` to `mapgen/index.ts`
   - add the types, spec, rng, heightField, classic, legacy adapter, hash and cache modules
   - switch all consumers to `MapData` / `MapSpec`
   - add gen and size to Firebase and the rules (size fixed at 'm', radio hidden)
   - update `create-room.spec.ts`
2. **World and physics foundation:**
   - spatial grid
   - heightfield collider
   - clamp fixes
   - slope-aware deployables
   - worker and debounce
   - check `discord.spec` (workers behind the Discord proxy) and the movement, deployables, pickups and ctf specs
3. **v2 core, dev-only** (`?gen=2`, graybox biome):
   - graph, zones, distance transform, terrain, sightlines, navgrid, validate
   - rewrite `check-maps` around `validateMap`
   - unit tests
4. **Structures and verticality:** platforms, bridges, walkable-roof buildings, the dressing pipeline, pickup spots, manual playtest of ramps and stairs.
5. **Biomes and visuals:** the four biomes, landmarks, splat material, preview overlay.
6. **Ship:**
   - set `GENERATOR_VERSION = 2`
   - enable the size radio and version badges
   - generate the golden hashes
   - delete `src/game/levelgen/*` and `legacy.ts`
   - update the e2e specs (create-room, discord, lobby)
7. **Optional:** the host changes size between rounds (`nextSize`), a minimap and debug overlay from `data.graph`, bot waypoints.

## Verification

- `npm run typecheck`, then `npm test` (unit tests: rng, symmetry, distance transform vs brute force, envelope keeps pins and the slope bound, heightField sample vs mesh, graph has no crossings and holds parity, CLASSIC passes validation, a broken fixture fails).
- `npm run check:maps -- --count 200 --size s,m,l --golden`: zero failures; the report shows p50/p95 for parity, sightline, cover, clutter and verticality metrics and timing. `--dump SEED` writes a PNG to inspect visually.
- `npm run test:rules` for the new Firebase fields.
- The full Playwright suite with the emulator; `ctf.spec` and `movement.spec` stay unchanged on CLASSIC.
- Manual: run the dev server and open S/M/L maps for each biome. Walk every ramp, stair and bridge, check for heightfield snagging, place turrets and walls on slopes, throw grenades on hills, and run one Discord activity session to confirm the worker loads.
