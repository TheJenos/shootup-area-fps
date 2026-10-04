# Plan: richer procedural textures (map, weapon & props, sky & details)

## Context
Today the whole game uses two canvas-drawn textures: a grid on the floor and one "crate frame" texture on
**every** box. That includes 9 m walls and the 81 m perimeter, where BoxGeometry's 0–1 UVs stretch one crate
frame across the whole face. Themes only change colors. The user wants more textures, procedural like the
current ones (no image files), covering:
- map surfaces
- weapon & props
- sky & small details

## Approach

### 1. New `src/game/textures.ts`: procedural texture library
- Reuse `canvas2d()` from `src/game/canvas.ts`. Add a small seeded value-noise / fBm helper (fixed seed, so
  every client draws the same thing) for grain, stains and ripples.
- Each texture is drawn mostly in neutral greys/whites, so the existing per-box palette color still tints
  it (`MeshStandardMaterial.color` × map). Use the same canvas as `bumpMap` for cheap depth.
- Textures are generated once and cached at module level, so rejoining a room doesn't redraw them.
  Set `RepeatWrapping`, `SRGBColorSpace` and anisotropy 8, matching the current `gridTexture`.
- Kinds:
  - **Box surfaces:** `crate` (planks + frame, the improved current one), `concrete` (panels, seams, pitting,
    grime at the base), `brick` (bricks with mortar), `metal` (ribbed container sheet with rivets),
    `perimeter` (tall concrete panels with a darker grime band at the bottom).
  - **Floors:** `tiles` (Training Yard), `sand` (ripples + pebbles, Dust Bowl), `snow` (soft drifts,
    Frostbite), `asphalt` (grain, cracks, tar patches, Dusk Yard), `plate` (steel diamond plate, Toxic Works).
  - **Props:** `wornMetal` (brushed streaks + edge wear), `wood` (grain), `grenade` (segmented shell),
    `hazard` (yellow/black stripes), `spawnMarker`.

### 2. Real-world-scale UVs (fixes the stretching)
- Add `scaleBoxUVs(geo, w, h, d, tile)` in `textures.ts`. It rescales each BoxGeometry face's UVs by that
  face's size in metres divided by `tile` (face order +x, −x, +y, −y, +z, −z).
- Crates keep one frame per face (they're crate-sized); every other surface tiles at a fixed size per metre.
- Use it in `addBox` in `src/game/world.ts`.

### 3. Surfaces from the map layout, without changing existing seeds
- Add `surface` to `MapBox` and per-theme `floorTexture` / `wallSurface` / `pillarSurface` in
  `src/game/mapgen.ts`.
- Assign surfaces from the piece kind in `makePiece`: crate/stack → crate, wall/L → theme wall surface,
  pillar → theme pillar surface; centerpieces likewise.
- **Assigning surfaces must not call `rand()`.** Any extra call would shift the random sequence and change
  every existing seed's layout.
- Tag `classicMap()` boxes by hand.
- `world.ts`: the material cache key becomes `surface + color`. The floor uses the theme's floor texture,
  tiled about 4 m. The perimeter uses `perimeter`, tinted with `theme.wall`.

### 4. Sky dome and details (`world.ts`)
- **Sky:** a big inverted sphere (radius ~250, inside camera far = 300) with `fog: false`. It uses a canvas
  gradient from zenith (darker theme sky) to horizon (`theme.sky`, which already matches the fog), with soft
  fBm clouds tinted by `theme.sun`. Replaces the flat `scene.background`. `Game.update` keeps it centered
  on the camera.
- **Decals:** transparent planes just above the floor (`polygonOffset` to avoid flicker), not added to
  colliders or `solids`:
  - painted spawn markers at each spawn point;
  - a hazard-stripe ring around each CTF base pad (`src/game/flags.ts`).

### 5. Weapon & props
- `src/game/weapon.ts` `buildGun()`: `dark` → `wornMetal`, `accent` → `wood`.
- `src/game/remotePlayer.ts` `gunMat` → `wornMetal`.
- `src/game/grenades.ts` `grenadeMat` → `grenade` texture (keeps its emissive glow).
- `src/game/flags.ts`: pole → `wornMetal`; pad → `concrete` + hazard ring.
- `src/game/pickups.ts`: add a low shared textured pedestal disc (`plate`) under each pickup.

## Critical files
- New: `src/game/textures.ts`
- Edit:
  - `src/game/world.ts`
  - `src/game/mapgen.ts`
  - `src/game/game.ts` (sky follows camera)
  - `src/game/weapon.ts`
  - `src/game/remotePlayer.ts`
  - `src/game/grenades.ts`
  - `src/game/flags.ts`
  - `src/game/pickups.ts`
  - `README.md` (short "Textures" note + layout entry)
- Reuse: `canvas2d` (`src/game/canvas.ts`), the existing theme palette tinting, and the `World.solids` /
  `colliders` split in `world.ts`.

## Verification
1. `npm run typecheck` and `npm run build`.
2. **Seeds unchanged:** before editing, save each layout's box positions/sizes for 2,000 seeds plus
   `CLASSIC`, using the existing scratchpad script approach (`node --experimental-strip-types`). After the
   change, confirm they're identical ignoring the new `surface` field, and rerun the reachability check.
3. **Load cost:** time texture generation in the browser and aim for under ~300 ms on first load. Check
   `renderer.info.memory.textures` doesn't grow when leaving and rejoining a room.
4. **Visual pass** (emulator + dev server, Chrome tools):
   - one seed per theme: screenshot the floor, walls, pillars, crates, sky and spawn markers;
   - a CTF room for the base pad and hazard ring;
   - the viewmodel close up;
   - a thrown grenade and a pickup pedestal.
   Confirm long walls tile instead of stretching, and that the decals don't flicker at a distance.
5. Gameplay sanity: bullets still stop on walls and decals don't block shots or movement.
