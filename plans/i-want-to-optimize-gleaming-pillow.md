# Optimization plan: discord-flag

## Context
There's no specific symptom to fix. The goal is a general optimization pass over frame rate, load time and network/Firebase cost, taking low-risk, high-value wins first.

All findings come from read-only audits; nothing was measured. So **Phase 0 adds measurement**, and each later phase is checked against it.

The phases are independent and can each ship as their own commit or PR. Each phase is ordered by value for the risk taken.

---

## Phase 0: Measurement (do first)
- Extend the FPS counter (`src/ui/Hud.tsx:512-532`) into a debug overlay. It should show:
  - frame time (average and worst over 1 s)
  - `renderer.info.render.calls` and `.triangles`
  - `renderer.info.programs.length`
  - JS heap where available
- Show the overlay only when a setting or `?debug` is on. Read the values from the `Game` instance in `src/game/game.ts`.
- Log Firebase bytes approximately: in `src/net/network.ts`, sum the JSON length sent and received per second (debug only).
- Record the baseline on a Retina Mac in the Discord desktop app, with 1 and 4 players.

## Phase 1: Quick, low-risk wins

### Rendering
- **Antialiasing and resolution.** Create the renderer with `antialias` only when quality is high and the device pixel ratio is at most 1.5. Lower the high-quality pixel-ratio cap to 1.5. (`game.ts:78, 320, 384-392`)
  - `antialias` can't be changed after the renderer exists, so read the setting before creating it. Changing quality mid-game then needs a reload or a re-created renderer.
- **Static objects.** Set `matrixAutoUpdate = false` on static world meshes, the proxies group, spawn markers and instanced props (`world.ts:151-158, 227-231, 264-271, 322-337, 356-363`), after one `updateMatrixWorld()`.
- **Explosion lights.** Cut the always-present point lights from 2 to 1 (`grenades.ts:77-95`).
- **Bump maps.** Drop `bumpMap` on low and medium quality (`world.ts:118, 132-139`).
- **Anisotropy.** Clamp it to `renderer.capabilities.getMaxAnisotropy()` (`textures.ts:143`).

### Bug
- `pickups.remove` disposes geometry shared with the cached gun models (`pickups.ts:234`, `guns.ts:171`). Stop disposing shared geometry; dispose only the materials or geometry the pickup created itself.

### Load time
- Cache headers in `netlify.toml` for `/models/*` and `/sounds/*`: `public, max-age=86400, stale-while-revalidate=604800`. They aren't content-hashed, so don't mark them `immutable`.
- In `vite.config.ts`, set `build.target: 'es2022'` and split `three`, `firebase` and `react` into separate vendor chunks so they stay cached across deploys.

### Network
- Remove stats from the 15 Hz pose send and send them at most once per second (`game.ts:2887-2893`).
- Leave out pose fields that haven't changed: `aim`, `rl`, `th`, `stance` (`game.ts:839-845`). Receivers must keep the last known value. Check how `onChildChanged` merges in `remotePlayer.setData`.
- Leave `hit`, `dmg` and `head` out of shot events that missed (`game.ts:1954`).
- Publish `ping` only when it changes by more than 15 ms or every 10 s (`game.ts:3067-3079`). Raise the pose heartbeat from 2 s to about 5 s (`game.ts:48`).
- Change kill credit to run its transaction or `increment(1)` on `players/{id}/kills` only, not on the whole record (`network.ts:329-336`).

## Phase 2: Model compression and loading (biggest load-time win)
- Add a script, `scripts/optimize-models.mjs`, that uses gltf-transform (already a dev dependency). It runs `dedup`, `prune`, `resample` (animations), `quantize`, `reorder` and `meshopt`, and resizes and converts textures to WebP (about 1024 px or less).
  - Apply it to `Soldier.glb`, `guns.glb` and `fpArms.glb`.
  - In `scripts/build-props.mjs:176`, add `quantize()`, `reorder()` and `meshopt()`, and write Uint16 indices when they fit (line 160).
  - This needs the `meshoptimizer` dev dependency.
- Register `MeshoptDecoder` (from `three/examples/jsm/libs/meshopt_decoder.module.js`) on the 4 GLTFLoaders: `character.ts:20`, `props.ts:26`, `guns.ts:149`, `fpArms.ts:68`.
- Re-encode `tension_loop.mp3` (538 KB) at a lower bitrate. Load the music after the sound effects (`audio.ts:57-66`).
- **Target:** models go from 4.6 MB to about 1 MB or less. Check each one visually in the game and in the map preview.

## Phase 3: Hitches and CPU work per frame
- **Shader warmup.** After the map and models are ready in `Game.start` (`game.ts:645-655`), call `await renderer.compileAsync(scene, camera)` (and the same for the viewmodel scene) before clearing `connecting`.
- **Pool effect meshes and materials** instead of creating and disposing them:
  - tracers and impacts (`weapon.ts:502-533`)
  - grenade blasts (`grenades.ts:132,161`)
  - field effects (`fieldfx.ts:76-110, 358-438`)
  - pickups (`pickups.ts:196-232`)
- Keep the warm-up materials alive rather than disposing them (`grenades.ts:96-106`, `fieldfx.ts:59-62`). Check that `renderer.info.programs.length` stays flat while firing.
- **Allocations in `Game.update`:**
  - Skip the `pending*` filters when the lists are empty (`game.ts:2444, 2554, 2559`).
  - Run `refreshScore` and `matchEndView` only when something has changed (`game.ts:1506-1545, 3158`).
  - Replace the per-frame `JSON.stringify` diffs with cheap checks (`game.ts:2582-2590, 2977-2998`).
  - Use scratch vectors in `remotePlayer.ts:329, 600-606, 838-888`, `game.ts:2394-2403, 3146` and `world.ts:389`.
- **Turrets.** Throttle target picking to 10 Hz (`game.ts:2396-2458`). Cache `ownedBy` (`fieldfx.ts:259-261`).
- **Spatial grid.** Add a static 2D uniform grid over the map's colliders. Rebuild it when a map loads, and when walls are placed or removed if those are colliders. Use it in `world.groundAt` (`world.ts:365-390`), player collision (`player.ts:140-149, 300`) and ragdoll (`ragdoll.ts:208`). For rays, filter `solids` by grid cells along the ray before `intersectObjects`, or use `raycaster.firstHitOnly`-style early exit.

## Phase 4: Larger rendering changes
- **Static shadows.**
  - Render the sun's shadow map only when it needs to change: set `shadowMap.autoUpdate = false` and set `needsUpdate` every N frames, or when a dynamic caster moves near the camera.
  - Better: keep static shadows but let players and deployables cast through a cheap blob or decal shadow.
  - Simplest first step: turn off `castShadow` on small props on medium quality.
- **Remote players:**
  - Give skinned meshes a padded bounding sphere instead of `frustumCulled = false` (`remotePlayer.ts:259-261`).
  - Make materials transparent only while cloaked, and pre-warm both variants (`remotePlayer.ts:262-266, 647`).
  - Run one matrix update before IK instead of several (`remotePlayer.ts:757, 872`, `ik.ts:33`).
  - Skip IK and plant-feet for players off-screen or more than about 30 m away.
- **HUD.** Use per-slice selectors with `useSyncExternalStore` in `Hud.tsx:23-68`, `memo` on the panels, and write the damage-indicator angle and opacity to a CSS variable instead of React state.
- **Optional adaptive quality.** Using the Phase 0 frame-time data, step the pixel ratio down when the average stays above 20 ms.

## Phase 5: Network structure and safety
- **Snapshot interpolation in `remotePlayer.ts:328-339, 650-655`.** Buffer timestamped poses, render about 100 ms behind using server time from `.info/serverTimeOffset`, and extrapolate briefly. Then lower the send rate: 10 Hz while moving, about 3 Hz when idle (`game.ts:47`).
- **Pack the pose** into one compact field, for example `p: "x,y,z,yaw,pitch"` as integers in centimetres and milliradians. This changes the format both ways, so all clients must update together (Activities update on deploy, so that's OK).
- **Events** (`network.ts:254-262`):
  - Drop the per-event `setTimeout` remove. Instead, the leader batch-deletes events older than 5 s every few seconds with one multi-path `update`.
  - Coalesce rifle shots.
- **Lobby list.** Bound `watchRooms` with a query or a slim `lobbyIndex` (`network.ts:36-52`).
- **Rules** (`database.rules.json:72-86`):
  - Add anonymous Firebase Auth.
  - `players/$pid` must be writable only when `$pid === auth.uid`.
  - Validate event shape and size.
  - Test with `npm run test:rules`.
- **Optional:** a Netlify scheduled function that cleans up orphaned `rooms/*` and old events.
- Persisting deployables for late joiners is a correctness fix that fits here. Treat it as a separate item.

## Phase 6 (optional): Code splitting and texture generation
- In `App.tsx:2-4`, `React.lazy` `GameView` and `DiscordLobby`, and lazy-load the Discord SDK when not in Discord. This gives a small win, since the lobby still needs three.js for `MapPreview`.
- **One WebGL context.** Dispose the `MapPreview` renderer (`forceContextLoss`) when the game starts (`MapPreview.tsx:110`).
- **Procedural textures** (`textures.ts:118`): pre-bake them to WebP at build time (they're deterministic, seed 1337), or generate them in a Worker with `OffscreenCanvas`.

---

## Verification
- `npm run typecheck`, `npm run build`, `npm run check:maps` and `npm run test:rules` (Phase 5) after each phase.
- After each phase, compare the Phase 0 debug overlay against the baseline:
  - frame time
  - draw calls
  - program count stays flat during combat
  - Firebase bytes per second
- `npm run dev:emu` with the emulator and 2–4 browser tabs: check movement smoothness, shots, kills, flags, deployables and the round end.
- Compare `dist/` sizes before and after Phase 2. Check every model visually: soldier animations, guns, arms, every prop in the map preview.
- Do a final test inside the actual Discord Activity, desktop and mobile.
