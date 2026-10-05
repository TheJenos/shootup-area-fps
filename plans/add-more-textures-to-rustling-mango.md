# Plan: new map generator — Town, Industrial and Outdoor maps with CC0 models

## Context
Every non-classic seed today makes the same kind of map: an 80×80 box arena with crates, walls, pillars, low cover and a few ramps (`src/game/mapgen.ts`, `makePiece`). The user wants richer maps with real 3D models. Agreed choices:
- **Models:** free CC0 packs (Kenney), downloaded only after explicit approval of the exact files.
- **Layouts:** all four — enterable buildings & rooms, streets/town, outdoor terrain, industrial.
- **Classic:** the `classic` seed stays exactly as it is; every other seed uses the new generator. The old box generator stays only as a safety fallback.
- **Height:** second floors (stairs, catwalks) yes; roofs not reachable.
- **Tooling:** OK to add dev-only `@gltf-transform/core`, `@gltf-transform/functions`, `pngjs`.

Constraints found in the code that the design keeps:
- The map is pure data from the seed; every client builds the same thing. Collision is `Box3` colliders + `Ramp`s (player, ragdolls, grenades); bullets and ally x-ray raycast `world.solids` **non-recursively**.
- `world.dispose()` frees all geometry/materials under the map root (must not free shared model geometry).
- The map is built in the `Game` constructor before assets load.
- Fixed 20 spawn points and CTF flag spots (0, ±32) that must match `FLAG_BASES` in `modes.ts`; layouts are mirrored on both axes.
- Player: radius 0.35, height 1.75, step-up 0.7, jump apex ≈ 1.31 m.

**Accepted side effect:** every non-classic seed (and shared invite seeds) produces a different map after this update.

## Approach

### 1. Data model (`src/game/mapgen.ts`)
Keep boxes as the single source of collision; models are visual only, with invisible proxy boxes for collision.
```ts
export type BoxBlocks = 'all' | 'move' | 'shots'; // all: collide + bullets; move: railings (shoot through); shots: tree canopies (block bullets/sight, walk under)
export interface MapBox { /* existing */ visible?: false; blocks?: BoxBlocks; step?: StepSurface }
export type PropRot = 0 | 1 | 2 | 3;               // quarter turns so mirroring stays exact
export interface MapProp { id: PropId; x: number; z: number; y: number; rot: PropRot; scale?: number }
export type GroundKind = 'road' | 'sidewalk' | 'grass' | 'dirt' | 'concrete' | 'hazard';
export interface GroundPatch { x: number; z: number; w: number; d: number; kind: GroundKind }
export type MapStyle = 'arena' | 'town' | 'industrial' | 'outdoor';
export interface MapLayout { seed; theme; style: MapStyle; boxes; props: MapProp[]; ground: GroundPatch[]; spawnPoints }
```
- `classicMap()` returns `style: 'arena', props: [], ground: []`, boxes unchanged.
- `generateMap`: first two `rand()` calls pick style then theme, so a new `mapName(seed)` gets the name cheaply (use it in `RoomBrowser.tsx`, `DiscordLobby.tsx:177`, `game.mapInfo`). Add a small LRU cache around `generateMap`.
- Theme pairing: Industrial → Toxic Works / Dusk Yard; Town → Training Yard / Dusk Yard / Dust Bowl / Frostbite; Outdoor → Frostbite / Dust Bowl / new **Greenwood** (grass floor).
- After generating, `checkLayout()` runs; on failure retry with `rngFor(seed + '#' + n)` (n = 1..4), then fall back to the old box generator. Deterministic on every client.

### 2. Generator code (`src/game/levelgen/`)
`mapgen.ts` stays the public facade (types, themes, seeds, `classicMap`, dispatch). Internals move to:
- `core.ts` — `rngFor`, `Rect`, `gapBetween`, `mirrored` (extended to props/ground; rot mirrors as `(4-r)%4` in x, `(6-r)%4` in z, w/d swap on odd rot), and a `Placer` class (`fits` with today's GAP/spawn/flag rules + reserved zones, `place` mirrored, `placeAsIs`, `reserve`, `addGround`, `result`).
- `pieces.ts` — today's `makePiece` moved as-is (filler cover + fallback), crate stacks, barriers, sandbags.
- `building.ts` — enterable building template: walls made of solid spans + sill + lintel around openings; ≥2 doors on different sides (≥1.8 wide, ≥2.3 tall); windows sill 1.0 / top 2.0 (shoot through, can't climb through); walls/slabs ≥ 0.25 thick; optional 2nd floor at 3.25 with a ramp stair and a railing (`blocks:'move'`) round the hole; solid roof (not reachable). Variants: house, warehouse (14–18 × 10–14, 6–7 m tall, catwalk at 3.25 with high window strips), cabin.
- `industrial.ts`, `town.ts`, `outdoor.ts` — one function per style (below).
- `props.ts` — `propPiece(id, x, z, rot, y?)` → prop + proxy boxes from the manifest.
- `check.ts` — `checkLayout()`: 0.25 m grid flood fill from a spawn (boxes grown by player radius); fails if any spawn, flag spot or building door is unreachable, anything is overhead within 2.5 m of a spawn, anything sits in flag clearance, a ramp top doesn't meet a surface, or an upper floor isn't reachable from its stairs. Also reports walkable ratio.

**Styles** (each places in one quarter and mirrors, like today):
- **Industrial** (first, needs few models): symmetric centerpiece (central warehouse with catwalk ring / crane gantry bridge / tank farm); 6 m open lanes along both axes near the flags; one warehouse per quarter; 2–4 container rows (6 × 2.6 × 2.4, stacked up to 2 high, crate steps to climb); catwalk bridges between same-height tops; tanks, pipes, barrels, pallets as props; hazard/concrete ground under buildings; `makePiece` filler.
- **Town**: mirrored street grid (avenues on both axes, cross streets at 26, outer ring) drawn as road + sidewalk ground; blocks split by BSP into lots (≥7 × 7, 2–3 m alleys); 1–2 enterable buildings per quarter (2 floors on ~40% of maps), ~half the lots closed Kenney buildings facing the street (one proxy box each), the rest plazas with cover; lamp posts, jersey barriers, cones (and cars if a car kit is approved); ≥35% of block area walkable.
- **Outdoor**: hills as plateau boxes (h 1.2–2.6, grass/rock tops) with ramps and a second tier, edges dressed with rock models; 3–6 big rock outcrops (proxy ≈ 0.85 × AABB); 2–3 forest patches per quarter (trunk proxy 0.5 × 0.5 × 3, canopy proxy `blocks:'shots'`, trunks ≥1.2 m apart); 0–1 cabin per quarter; fences and sandbags.

### 3. World building (`src/game/world.ts`)
- Visible boxes merged per `surface:color` (`mergeGeometries`, in 4 quadrant chunks) → ~20–40 draw calls instead of hundreds.
- `solids` gets one invisible proxy mesh per box (shared unit `BoxGeometry`, scaled); raycasts ignore `visible`, so shooting/x-ray code needs no change. Ramps keep their wedge mesh.
- `blocks` decides lists: `all` → colliders + obstacles + solids; `move` → colliders + obstacles; `shots` → solids.
- Props: one `InstancedMesh` per prop id, shadows on, tagged `userData.shared` so `dispose()` frees only instance buffers.
- Ground patches: flat planes merged by kind, `polygonOffset` like the spawn markers; new canvas textures for road lines, grass, hazard.
- Footsteps: `stepOf: WeakMap<Box3, StepSurface>`; new `world.groundAt(p) → { y, surface }`; `game.ts` `groundBelow` (~1592) and `surfaceAt` (~2657) use it (wood floors/crates → wood, concrete/metal/container/rock → hard, grass → sand until a grass sound exists).
- `src/game/textures.ts`: new `BoxSurface`s `planks`, `container`, `rock`, `grass`, `plaster` (flat, so code-built town buildings sit well next to flat Kenney models); new `FloorTexture` `grass`.

### 4. Models
**Packs to download (after approval, all Kenney, CC0):** City Kit Commercial (3.9 MB), City Kit Suburban (2.9 MB), City Kit Roads (2.7 MB), City Kit Industrial (4.8 MB), Nature Kit (10 MB). Optional: Kenney Car Kit; `footstep_grass` / metal steps from the already-used Impact Sounds pack.

**Pipeline:**
- Raw packs in `assets-src/kenney/` (gitignored, README with URLs).
- `scripts/props.config.mjs` lists chosen models (id, pack, file, scale, collider rule, tags, styles).
- `scripts/build-props.mjs` (`npm run build:props`): reads each GLB with gltf-transform, pivots to base centre, bakes scale (metres), bakes the colormap texture into vertex colours (pngjs), joins into one shared material, weld/dedup/prune/quantize → `public/models/props.glb` (target < 1 MB), and generates `src/game/propManifest.ts` (`PropId` union, `PROPS` table: w/d/h, tags, collider boxes, preview colour). Both outputs committed; prints a size/footprint report for tuning.
- `src/game/props.ts`: `loadPropModels()` (shared promise, retry on failure), `propParts(id)`, `whenPropsReady(cb)` — same waiting-list pattern as `loadGunModels` in `src/game/guns.ts`. Collision exists immediately; visuals attach when loaded. Preload in `Lobby.tsx` / `DiscordLobby.tsx` and add to `Game.start()`'s `Promise.all`. If loading fails, proxies render in a flat colour.
- Credits added to `public/credits.html` and README.

### 5. Preview (`src/ui/MapPreview.tsx`)
Draw ground patches first (roads with a dashed centre line, grass, hazard), then boxes by top height including invisible proxies in the prop's manifest colour (skip `shots` boxes), trees as canopy circles, building walls so door gaps show; spawns and flag rings as now. Map label shows "Theme · Style".

### 6. Performance
Expected < ~100 draw calls (merged boxes, instanced props). Box count grows from ~60 to ~250–500: add a coarse 4 m grid `ColliderIndex` (or per-frame nearby filter) for ragdoll collision in `src/game/ragdoll.ts`; player and grenade cost is fine. `generateMap` with checks ≈ 5–20 ms, cached.

## Phases
1. **Groundwork** — data model, world merging/proxies/blocks/ground/`groundAt`/shared dispose, new surfaces and textures, `check.ts` + `npm run check:maps` (bundle `scripts/check-maps.ts` with the existing rolldown, run with node: 500 seeds, invariants, determinism, CLASSIC unchanged vs a stored snapshot, style/theme spread). Classic must look and play the same.
2. **Generator refactor** — `levelgen/core.ts` `Placer`, dispatch, `mapName`, retry + fallback.
3. **Industrial** (code-built) — building/warehouse template, containers, catwalks. First playable new style.
4. **Asset pipeline** — ask approval, download packs, add dev deps, build `props.glb` + manifest, loader, instancing; add industrial props.
5. **Town** — streets, lots, Kenney buildings, enterable buildings, street furniture.
6. **Outdoor** — hills, rocks, forests with canopy proxies, cabins, fences, Greenwood theme.
7. **Polish** — preview, collider index, optional grass/metal step sounds, credits, README Maps section, style weights.

## Critical files
- `src/game/mapgen.ts` (facade; `classicMap` untouched) and new `src/game/levelgen/*`
- `src/game/world.ts`, `src/game/textures.ts`
- `src/game/game.ts` (`loadMap`, `start()` ~597, `groundBelow` ~1592, `mapInfo`, `surfaceAt` ~2657)
- new `src/game/props.ts` (pattern from `src/game/guns.ts`), generated `src/game/propManifest.ts`
- `src/ui/MapPreview.tsx`, `RoomBrowser.tsx`, `Lobby.tsx`, `DiscordLobby.tsx`
- `src/game/ragdoll.ts`, `package.json` (`build:props`, `check:maps`), `.gitignore`, `public/credits.html`, `README.md`

## Verification
- Each phase: `npm run typecheck`, `npm run build`, `npm run check:maps` (all seeds pass; CLASSIC snapshot identical; same seed → same layout).
- In the browser with `npm run emulator` + `npx vite --mode emulator`, two tabs in one room on several seeds of each style:
  - both tabs show the same map (preview and in game)
  - walk through doors, up stairs, onto catwalks and container tops; can't get onto roofs
  - shoot through windows and railings; bullets stop on walls, rocks, trees, buildings
  - grenades bounce off thin walls; ragdolls rest on floors and slabs
  - teammate x-ray appears behind buildings/props
  - footsteps change on wood floors, metal/concrete, grass
  - CTF flags and spawns are open; pickups don't spawn inside buildings or props
  - next-map transition: no console errors, `renderer.info.memory` stable over several rounds
  - quality Low at phone size: watch `renderer.info.render.calls` and FPS
  - `classic` seed looks and plays as before
