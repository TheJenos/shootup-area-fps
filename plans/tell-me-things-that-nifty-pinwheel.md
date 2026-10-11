# Arena FPS — improvement roadmap

## Context

The game was built in one week (4–11 Oct 2026) and already has an unusual amount of content: four base modes plus
13 presets and custom rules, 14 abilities, four guns, RL-trained bots, a seeded map generator with four biomes,
MVP replays, kill cam, a Discord Activity, touch controls, two leaderboards and ~118 unit + ~118 e2e tests that
pass (`tsc` clean, `vitest` green). Three read-only audits (netcode/core loop, UI/UX/mobile/Discord,
gameplay/bots/maps/tests) found no TODO/FIXME markers and no crashes, but a consistent set of gaps.

**Audience (from you): friends and Discord servers you're in.** So the ordering below favours *robustness,
feel and solo/first-run experience* over anti-cheat. Database hardening is still included, but as "stop
accidents and casual tampering", not "defeat a determined cheater".

**Deliverable: a full roadmap.** Every finding is an implementation task, grouped into milestones ordered by
value ÷ risk. Each task names the files and how to verify. Nothing here has been implemented yet.

How to read the milestones: **M0–M2 are what I'd do first** (a weekend each); M3–M9 are content, polish and
hygiene you can pick from.

---

## M0 — Bugs that bite friends today (small, high value)

**Status (11 Oct 2026): implemented**, with these notes against the original list:
- 0.4 done (`left` flag + `dispose` awaits the in-flight join) but has no e2e: the race window is a sub-millisecond microtask gap.
- 0.6 **not done**: `creditKill` can't check the round inside a single-child transaction without widening it to the whole record (which the killer rewrites 15×/s). The window is the ~16 s results+MVP intermission, so only the owner's instant restart can hit it. Left for M1.6 (one authority) to revisit.
- 0.13 revised: `loadPolicy` already caught failures; the real bug was `sync()` spinning silently with no policy. Fixed by telling the owner once (`BotHostApi.notify`).
- 0.16 **not a bug**: `setHp` is already given a percentage (`hpPercent` uses `setMaxHealth`, wired at game.ts:4105).
- 0.7 keeps the grenade base gravity at 18 (it's tuned for throw range) and scales it by the rule; the shared-constant part was dropped.
- 0.10 fixed by clamping client-side (kills/deaths ≤ 100) like captures already were, rather than loosening the rules.

| # | Task | Where | Verify |
|---|---|---|---|
| 0.1 | **Blank screen on WebGL failure.** Wrap `new Game()` in try/catch in `GameView` and route through `friendlyError`; add `webglcontextlost`/`restored` handlers on the canvas (pause loop, show "Graphics reset — click to resume"). | `src/ui/GameView.tsx:49-62`, `src/game/game.ts:411` | e2e: force `WEBGL_lose_context` via `game.test`, expect message not blank page |
| 0.2 | **React error boundary** around `<App/>` so a render exception shows "Something broke — back to lobby" instead of a white page. | `src/start.tsx`, new `src/ui/ErrorBoundary.tsx` | Throw in a child in dev, see fallback |
| 0.3 | **Room wiped when the "last" player disconnects while someone is joining.** Never arm whole-room `onDisconnect().remove()` from a client; always arm only own records (+ bots). Delete `lastOneHere` and the cancel/re-arm churn (which has its own unarmed window). Empty rooms are already reaped by `watchRooms` and `leave()`; add the same check to the `members` listener. *(Design: Appendix A.5.)* | `src/net/network.ts:210-222, 283-296, 50-54, 504-505` | e2e: A alone, B joins, A kills socket within 200 ms → B still in room; update `join-leave.spec.ts:73` |
| 0.4 | **Join/leave race leaks listeners.** `private left` flag: `leave()` sets it first and is idempotent; `join()` bails after the presence await and before each listener group; `Game.dispose` awaits the in-flight `join` before `leave()`. *(A.5.)* | `src/net/network.ts:184-255, 492-506`, `src/game/game.ts:968, 4509` | e2e: join then leave within 100 ms, assert no player record left and no console errors |
| 0.5 | **Bots corrupted after owner reconnect** (`kills === null` → `creditKill` aborts forever). Keep the last full `PlayerState` per bot; `registerPresence` re-`set`s every bot and re-arms their `onDisconnect`. *(A.5.)* | `src/net/network.ts:276-281, 339-344, 486-487` | e2e `connection.spec`: owner with bots goes offline/online, bot kill still credits |
| 0.6 | **Kill credit after round reset / overwritten by presence `set`.** Pass `round` in `creditKill` and have the transaction abort if `players/{killer}/round !== round`; make reconnect use `update()` for everything except on first join. | `src/net/network.ts:485-490, 279`, `src/game/game.ts:1679` | unit test of the transaction fn; e2e kill at round edge |
| 0.7 | **Grenades ignore gravity rule** (`GRAVITY = 18` fixed; Moon mode arcs wrong, and ≠ player's 22). Read `rules.gravity` and use the shared constant. | `src/game/grenades.ts:5`, `src/game/movement.ts:293` | unit test on arc apex vs gravity |
| 0.8 | **Map change leaves old effects running** (`smoke`, `pendingSmokes`, `pendingBlasts` not cleared). | `src/game/game.ts:473-479` | e2e: throw smoke at round end, new map has none |
| 0.9 | **Next-round pickups race** (`clearPickups` after transaction deletes freshly spawned ones). Clear pickups *inside* the `startRound` transaction or key pickups by round. | `src/game/game.ts:1824-1828` | e2e two clients, round roll, pickups count stable |
| 0.10 | **Leaderboard write silently fails over 100 kills** (TDM limit goes to 150). Raise the rules cap to match `LIMITS` or clamp before writing. | `database.rules.json`, `src/game/game.ts:1607`, `src/game/rules.ts:46` | `npm run test:rules` case |
| 0.11 | **Flag return timer resets on leader change** (uses local `performance.now()`). Store `droppedAt` as server time in `game/flags`. | `src/game/game.ts:1581, 2341-2343` | e2e: leader leaves mid-countdown, flag still returns on time |
| 0.12 | **S&D match clock can end a match mid-round** (20 min cap < 5-round match worst case). Either exempt S&D from `checkTimeLimit` or end at the round boundary after the limit. | `src/game/game.ts:4417, 1885`, `src/game/modes.ts:46`, `src/game/snd.ts:16-25` | unit test in `snd.test.ts` |
| 0.13 | **Policy load failure leaves bots "loading" forever.** Catch, log, fall back to scripted bots. | `src/game/bot/botHost.ts:250` | unit: reject fetch, bots still spawn |
| 0.14 | **Unhandled promise rejections** on `pushEvent` set/remove and `void sendState(...)` sites. Add a single `swallow(label)` helper. | `src/net/network.ts:383-388`; ~10 sites in `game.ts` | no "Uncaught (in promise)" in e2e console capture |
| 0.15 | **Touch: no unmount cleanup** — stick/look/`setTouchMove(null)` not cleared when `TouchControls` unmounts on death; stale crouch-state `setTimeout`. | `src/ui/TouchControls.tsx:52, 143`, `src/game/player.ts:84-90` | e2e touch: die mid-stick, respawn, not walking |
| 0.16 | **Name tag HP clamped to 100** regardless of `maxHp` (Tank CTF enemies look full until <100). | `src/game/nameTag.ts:57`, `src/game/hudStore.ts:145` | e2e 200 HP mode |
| 0.17 | **Inventory text hard-codes "E"** instead of the bound interact key. | `src/ui/InventoryPanel.tsx:42` | visual |
| 0.18 | **`useCopyInvite` timer leak + silent clipboard failure** (Discord: no clipboard, and link points at the web build). | `src/ui/Hud.tsx:38-46` | manual in Discord |

## M1 — Netcode feel and resilience

**Status (11 Oct 2026): 1.1, 1.2, 1.5, 1.6, 1.7, 1.8, 1.9 implemented.** Notes:
- 1.2 as designed in A.1 (`src/game/poseBuffer.ts`, 120 ms render delay, ≤100 ms extrapolation, legacy ease for poses without `t`); bots stamp `t` too; the replay recorder uses the sender's time; incoming shots from beyond the gun's range + 10 m are ignored.
- 1.5 keeps `{playerId, team, round, kills, deaths, stats}` in `sessionStorage` (`src/game/session.ts`); a refresh restores them if the round is unchanged; leaving through the menu clears it. If the server removes our record while we're connected (the old socket closing late), we re-register.
- 1.6: `isLeader()` is now "I am `lobby/{code}/hostId`" — one authority for chores and bots.
- 1.7: one host timer, per-bot diffing with a 5 s full resend, one multi-path write per tick.
- 1.8: stale events (>10 s by server time) are ignored on arrival and swept by the owner at round start.
- **1.3 deferred**: ragdolls are Verlet (no physics step), so only debris chunks and loose props would benefit — not worth per-body previous-transform bookkeeping.
- **1.4 deferred**: `movement.ts` is shared with the bot training arena; changing its step semantics changes trained behaviour and needs an `eval:bots` pass. The dt cap already bounds the fps dependence.
- **1.10 deferred**: lobby fan-out is fine at friends scale.

| # | Task | Where | Verify |
|---|---|---|---|
| 1.1 | **Fix send rate drift**: `sendTimer -= SEND_INTERVAL` instead of `= 0`. One-liner, do first. | `src/game/game.ts:4126` | log send rate at 60 vs 144 fps ≈ 15 Hz both |
| 1.2 | **Timed snapshot interpolation** for remote players: add server-time `t` to the pose, a ≤4-snapshot `PoseBuffer` per remote, render 120 ms behind, linear position + shortest-arc yaw, extrapolate ≤ 100 ms from velocity, keep the 6 m teleport snap; no-`t` poses fall back to the old ease (mixed versions). Also feed `t` to the replay recorder (free latency removal in kill cam). Add a cheap range sanity check on incoming shots. *(Design: Appendix A.1.)* | `src/types.ts` (pose), new `src/game/poseBuffer.ts`, `src/game/remotePlayer.ts:381-394, 731-736`, `src/game/game.ts:1282, 4126`, `src/game/replay.ts` (`lerpPose`) | vitest for `PoseBuffer`; e2e `duel` + `movement.spec` (`remoteSettled` unchanged); manual devtools throttle |
| 1.3 | **Physics render interpolation**: use the alpha `physics.update()` already returns to interpolate ragdolls/debris between 60 Hz steps (fixes jitter at 144 Hz). | `src/game/game.ts:4034`, `src/game/physics.ts:170-178`, `src/game/ragdoll.ts`, `src/game/debris.ts` | visual at 144 Hz |
| 1.4 | **Fixed-timestep player movement** (accumulate `dt`, step movement at 60 Hz, interpolate camera) so jump arcs don't depend on fps and <20 fps isn't slow-motion. Bots and the training arena share `movement.ts`, so keep the function signature. | `src/game/movement.ts:253-309`, `src/game/game.ts:974-991, 4031-4032` | unit: identical apex at dt=1/30 and 1/144 |
| 1.5 | **Reconnect identity**: persist `playerId` per room in `sessionStorage` so a refresh rejoins as the same player with score intact (re-`set` the record on return). | `src/ui/Lobby.tsx:138,143`, `src/ui/DiscordLobby.tsx:86,123`, `src/net/network.ts` | e2e: refresh mid-match, kills preserved |
| 1.6 | **Single source of "who runs the chores"**: replace the two authorities (lobby `hostId` owner vs lowest-id leader) with one — the owner — and have the owner run pickups/flags/clock too. Removes double-spawner windows. | `src/game/game.ts:1150-1153, 1902, 2335, 3871`, `src/net/network.ts:261-274` | e2e: leader leaves, pickups keep spawning once |
| 1.7 | **Bot pose diffing + batching**: send only changed fields for bots (like players), and batch all bots into one multi-path `update()` per tick. Cuts owner upload ~5× with 12 bots. | `src/game/bot/botHost.ts:48, 490-509`, `src/net/network.ts:339-344` | count writes/s in the net debug overlay |
| 1.8 | **Orphaned events**: have the receiver ignore events older than 3 s by server time instead of relying on the sender's `setTimeout` to delete; sweep stale events when the owner starts a round. | `src/net/network.ts:384-388` | e2e: sender closes tab right after a shot; room still clean after round |
| 1.9 | **Reconnect escalation**: after 20 s of "Reconnecting…", offer "Back to lobby" like the connecting screen does. | `src/ui/Hud.tsx:154-158, 240-251` | e2e connection-loss spec |
| 1.10 | **Lobby list fan-out**: `watchRooms` listens on the whole `lobby` tree. Keep `onValue` but move `members` out to a count field maintained by a transaction, or use `onChildChanged`. Low priority at friends scale. | `src/net/network.ts:42-59` | — |

## M2 — First run, solo play and HUD

| # | Task | Where | Verify |
|---|---|---|---|
| 2.1 | **Quick Play / Practice button** on the lobby's empty state and header: creates an FFA room with 5 Normal bots and jumps in. Also default `bots` to 3 for a room created with no one else online. | `src/ui/Lobby.tsx:57`, `src/ui/RoomBrowser.tsx:122-125`, `src/game/rules.ts:77`, `src/ui/ModePicker.tsx:97-113` | e2e: 2 clicks from name to playing against bots |
| 2.2 | **Let players change their name** (Settings → Profile). Keep `fps-profile` id; only the display name changes. | `src/ui/Lobby.tsx:55, 186-188`, `src/ui/SettingsPanel.tsx` | e2e lobby spec |
| 2.3 | **Minimap / radar** (top-left, ~140 px): draw from `map.boxes` + heightfield once per map to an offscreen canvas (`mapgen/types.ts:135` already keeps the data "for a minimap"), then per-frame draw self, teammates, visible/scanned enemies, flags, bomb sites, pickups. DOM-canvas, not React. | new `src/ui/Minimap.tsx` + `src/game/minimap.ts`, `src/game/hudStore.ts` | visual; e2e: canvas exists, hidden when `hud.minimap=false` |
| 2.4 | **Off-screen objective markers**: screen-edge arrows with distance for enemy flag / our stolen flag / bomb sites / planted bomb / our carrier. Project with the camera each frame into a small DOM layer (like `FpsCounter`). | new `src/game/objectiveMarkers.ts`, `src/ui/Hud.tsx` | e2e CTF: marker present when flag taken |
| 2.5 | **Kill confirmation**: distinct red-cross hitmarker + "ELIMINATED name" centre line + its own sound. | `src/ui/Hud.tsx:113-116`, `src/style.css:159-181`, `src/game/audio.ts` | e2e: kill → `#hitmarker.kill` |
| 2.6 | **Spawn protection**: 1.5 s invulnerable-until-you-shoot after respawn (shimmer on the model so others know). | `src/game/game.ts:2781-2804` (`takeDamage`), `src/game/remotePlayer.ts` | e2e: shoot within 1 s of respawn → no damage |
| 2.7 | **Desktop first-match control card**: show the controls list for 6 s on first "click to play" (dismiss on any input); extend `hints.ts` with `knife`, `interact`, `sprint`, `objective`. Fix `TouchIntro` missing the knife button. | `src/game/hints.ts:8`, `src/game/game.ts:4017-4021`, `src/ui/TouchIntro.tsx:21-26` | e2e hints spec |
| 2.8 | **S&D audio**: bomb beeping that accelerates, plant/defuse progress ticks, "bomb planted/defused" stingers. Core genre cue, currently absent. | `src/game/audio.ts`, `src/game/snd.ts`, `src/game/game.ts:2358-2777`, `public/sounds/` | e2e snd spec: audio calls made (stubbed) |
| 2.9 | **FPS counter off by default**; keep it one click away. | `src/game/settings.ts:118` | — |
| 2.10 | **HUD re-render reduction**: `useHudSelector(fn)` on top of the store, `React.memo` on ScoreBar/KillFeed/AbilityBar/PauseMenu/MatchSummary; drive buff countdown and damage-arc angle with direct DOM writes like `FpsCounter`. *(Design: Appendix A.7.)* | `src/ui/Hud.tsx:26-28, 636-656`, `src/game/hudStore.ts:307-312`, `src/game/game.ts:3788-3794, 4253` | React Profiler: no full-HUD renders while a buff ticks |
| 2.11 | **Nameplate/kill-feed icons**: replace emoji with inline SVG so Android/Linux render them. | `src/ui/Hud.tsx:31-32` | visual |

## M3 — Gameplay balance, modes and feel

| # | Task | Where | Verify |
|---|---|---|---|
| 3.1 | **Deagle is a strict downgrade** of the always-carried rifle (0.64 s vs 0.40 s body TTK, worse range, worse spread). Options: body 50 (2-shot kill at close range), or tighter spread + no movement penalty as a "precision sidearm". Pick body 50 / head 100 with 0.35 s interval. | `src/game/gunStats.ts:46-68` | unit: TTK table test (new `gunStats.test.ts`) |
| 3.2 | **Rifle dominance / snowballing**: 200 m range is sniper-like; cut to 80 m and start falloff at 20 m. Consider kill-heal 0.5 → 0.3. Tune, then re-run `eval:bots` so bots don't regress. | `src/game/gunStats.ts:50`, `src/game/game.ts:135` | playtest + bots eval |
| 3.3 | **Spread is edge-biased** (`randomDirection() * spread` projects a sphere to a disc). Use a uniform-in-disc or gaussian cone. Shared helper used by both player and bots. | `src/game/game.ts:2973`, `src/game/bot/hitscan.ts:105-114` | unit: histogram of radial distance |
| 3.4 | **Recoil recovery + pattern**: pull pitch back toward the pre-burst aim over 0.3 s after firing stops; a fixed per-gun small pattern (e.g. rifle: up-up-right-left) with random jitter on top. Rifle climbs ~20° per mag today with no recovery. | `src/game/game.ts:3020-3021`, `src/game/player.ts:79-82`, `src/game/weapon.ts` | e2e: fire a mag, pitch returns within 0.5 s |
| 3.5 | **Sprint-to-fire delay** (0.15 s) and no firing during the slide's first 0.2 s; today you can shoot while sprinting instantly. | `src/game/weapon.ts:329-348` | e2e |
| 3.6 | **Coyote time (0.1 s) + jump buffering (0.12 s)**; landing camera dip. Cheap and makes movement feel much better. | `src/game/movement.ts:287`, `src/game/player.ts:120`, `src/game/game.ts:4380` | unit movement test |
| 3.7 | **FFA spawns cluster at the two bases**. Add FFA-only spawn candidates (pickup spots, lane midpoints, overlooks) to `pickSpawn`, scored by distance from enemies *and* line-of-sight. | `src/game/game.ts:2909, 2930-2940`, `src/game/spawnPlan.ts` | unit spawnPlan test: FFA spawns spread > X m |
| 3.8 | **Team auto-balance**: block `switchTeam` into the larger team; on a death, move the dead player if teams differ by ≥2 (with a toast). | `src/game/game.ts:976-983, 1131` | e2e team spec |
| 3.9 | **Overtime instead of draw** on a tie at time-out: 2 min sudden death (next point wins); CTF 0-0 → first kill wins. | `src/game/game.ts:1868-1882` | unit rules test |
| 3.10 | **Rematch / vote**: results screen gets "Same map" / "New map" votes (majority, owner tiebreak) instead of always rolling a new seed. | `src/game/game.ts:1838-1840`, `src/ui/MatchSummary.tsx` | e2e |
| 3.11 | **Warmup**: until 2 humans are present, infinite respawn and no scoring; the round starts when the owner presses Start or the second human joins. | `src/game/game.ts:1540-1725` | e2e |
| 3.12 | **S&D bomb sites are not designed** (A = flag pad, B = farthest pickup spot, fallback point unchecked for walkability). Have `mapgen` emit two `bombSites` per map (lane end-plates on the defenders' half, validated reachable), and validate site balance (route lengths within 15 %). | `src/game/snd.ts:131-155`, `src/game/mapgen/generate.ts`, `validate.ts`, `types.ts` | mapgen unit test + bump `GENERATOR_VERSION` + regenerate `golden.json` |
| 3.13 | **Gun Game finale**: last step = knife only, knife kills demote the victim one step. | `src/game/modes.ts:8-10`, `src/game/game.ts` combat | e2e gungame spec |
| 3.14 | **New mode: Domination / KOTH** (3 capture points from the lane graph's choke/middle nodes; team holds = +1/s). Reuses flag-pad rendering and `game/flags`-style transactions. | `src/game/modes.ts`, new `src/game/domination.ts`, `src/game/mapgen` points | unit + e2e |
| 3.15 | **Limb hitboxes** (legs 0.75×, arms 0.9×) on the existing bone-following rig; keep bot hit model in sync via a shared `hitModel.ts`. | `src/game/remotePlayer.ts:114-115, 354-363`, `src/game/bot/hitscan.ts:15` | e2e `duel` with `part:'leg'` |
| 3.16 | **Barrier visibility for late joiners**: store deployables in `rooms/{code}/deployables` with server-time expiry instead of 3 s events. | `src/game/deployables.ts`, `src/net/network.ts` | e2e: join after barrier placed, see it |

## M4 — Bots: fairness and navigation

| # | Task | Where | Verify |
|---|---|---|---|
| 4.1 | **Bots see 360°, through smoke, and through cloak, and know exact enemy HP.** Add a FOV test (120°, 160° on Expert) in `observe.ts`; make `senses.ts` sight check consult active smoke clouds and barriers; filter cloaked players unless within 6 m; quantise `hp` to {low, mid, high}. Needs `OBS_VERSION` bump only if the observation *layout* changes — FOV/smoke are filters, HP quantisation changes values not layout (check `observe.ts` and decide; retrain if bumped). | `src/game/bot/observe.ts:207-208`, `senses.ts:24,53-55`, `botHost.ts:536-553, 549` | unit senses tests; bots eval |
| 4.2 | **Bots can't path over jumpable ledges** (step limit 0.7 m vs 1.31 m jump apex). Add "jump edges" to the nav grid for 0.7–1.2 m rises with a landing cell, and have `brain.ts` press jump on those edges. | `src/game/bot/nav.ts:91,131`, `brain.ts`, `src/game/mapgen/navgrid.ts` | unit nav test on a ledge fixture |
| 4.3 | **Deployed barriers invisible to nav** — add dynamic blocked cells for live barriers/turrets. | `src/game/bot/senses.ts:24`, `nav.ts` | unit |
| 4.4 | **Chase re-path hitch** (full grid search every 3 m of carrier movement × N chasers). Re-path at most every 0.5 s per bot and reuse partial paths; move path search to a Web Worker if the owner's frame time shows spikes (`perfStats`). | `src/game/bot/objective.ts:94-96`, `nav.ts:15` | perf overlay: no >8 ms spikes with 8 chasing bots |
| 4.5 | **Bot infinite rifle ammo** and **bot recoil ignores ADS** (comment contradicts `aim.ads`). Give bots the same 90 spare and let them fetch ammo boxes (gear.ts already handles pickups); apply the ADS recoil factor. | `src/game/bot/botHost.ts:684, 892-899, 645` | bots eval parity |
| 4.6 | **Policy is told S&D is TDM** — confirm which stages `public/bots/policy.json` saw; if S&D was in `mix`, pass the real mode; otherwise schedule a retrain with `--stage snd`. | `src/game/bot/botHost.ts:608-609`, `scripts/train-bots.ts:426` | eval:bots on snd |
| 4.7 | **Kills on bots count on the global leaderboard** (README claims otherwise). Either exclude bot kills from `recordRound` or weight them 0.25. | `src/game/game.ts:1601-1609` | `test:rules` + unit |

## M5 — Performance and load time

| # | Task | Where | Verify |
|---|---|---|---|
| 5.1 | **Rapier bundle is 1.65 MB gz — bigger than everything else combined.** Switch the browser to `@dimforge/rapier3d` (real `.wasm`, streaming compile) via a `#rapier` subpath import that resolves to the compat build under Node (training, vitest). Expected ~1.65 → ~1.1 MB gz and no 4 MB base64 decode on the main thread. **Go/no-go first:** confirm Netlify and the Discord proxy serve `application/wasm` compressed, and that `vite-plugin-wasm` works on Vite 8/rolldown. The lobby already calls `loadPhysics()` (prefetch exists). *(Design: Appendix A.3.)* | `src/game/physics.ts:27`, `vite.config.ts`, `package.json` (`imports`), type imports in `ragdoll.ts`/`debris.ts`/`movement.ts` | `npm run build` size table; `npm run train:bots -- --steps 1`; `npm test`; Discord Activity smoke |
| 5.2 | **Bullet raycasts have no acceleration structure** (three.js `intersectObjects` over every box proxy; shotgun = 9×). Use Rapier `castRay` against the colliders already built for the map (the bot sim's `castWorld` in `senses.ts` already defines bullets this way, so play and training agree); keep player hitboxes as-is; then drop the invisible proxy meshes from `world.ts`. Not three-mesh-bvh (new dep, separate handling for deployables). *(Design: Appendix A.2.)* | `src/game/physics.ts` (`castRay`), `src/game/deployables.ts`, `src/game/world.ts:173-185, 218-226`, `src/game/game.ts:2961-2975, 3586-3590` + 5 LOS sites | vitest: 1k random rays, Rapier vs old distance within 1 cm (cylinders excepted); e2e `combat`, `deployables`, `bots` |
| 5.3 | **Tracer/impact allocation**: pool `MeshBasicMaterial` + meshes (one shared material per colour, `InstancedMesh` for impacts). Also cap `Effects.items` growth while the tab is hidden. | `src/game/weapon.ts:630-662` | heap snapshot stable over 5 min of firing |
| 5.4 | **Per-frame allocations** in hot paths: `refreshScore` JSON.stringify every frame (`game.ts:2113-2158`), `isLeader()` sort every call, `RemotePlayer.updateGait` clones, `setData` `new Vector3`, generator in `game.ts:2895-2902`. Cache keys on change, hoist scratch vectors. | listed sites | Chrome allocation sampling: < 1 KB/frame idle |
| 5.5 | **Kill-cam hitch on every death** (`ReplayDirector` clones every player's skinned mesh + materials). Pre-warm a pool of 2–4 stand-in avatars at map load, reuse. | `src/game/replay.ts:187-191`, `src/game/game.ts:2000` | perf overlay: no >30 ms frame at death |
| 5.6 | **All remote characters render transparent** (`transparent = true` forced). Only set it while cloaked/ghosted. | `src/game/remotePlayer.ts:297-299` | — |
| 5.7 | **Replay recorder grows unbounded** for 20 min rounds; `flagsAt` scans all events. Ring buffer of the last 60 s for kill cam + keep only the MVP window; index flag events. | `src/game/replay.ts:82-96` | heap |
| 5.8 | **Dynamic resolution on phones**: scale `PIXEL_RATIO` down in 0.1 steps when frame time > 20 ms for 2 s, up when < 12 ms. | `src/game/game.ts:145, 409-411`, `src/game/perfStats.ts` | on-device |
| 5.9 | **Pause-menu `MapPreview` runs a second rAF loop** while open in-game; render once and on drag only (also respects reduce-motion). | `src/ui/MapPreview.tsx:245-258, 251` | — |
| 5.10 | **`updatePresence` and the bot send cadence assume 60 fps** (`1/60` per frame). Use `dt`. | `src/game/game.ts:4428-4430` | — |

## M6 — Mobile and Discord

| # | Task | Where | Verify |
|---|---|---|---|
| 6.1 | **Safe-area top/bottom insets** and a `max-height: 400px` layout for the touch buttons (knife/ammo/kill-feed overlap on short phones). | `src/style.css:1353-1368, 1418-1428`, `index.html:6` | iPhone SE landscape |
| 6.2 | **Touch look sensitivity + ADS curve + haptics** (`navigator.vibrate` on hit/kill), optional **gyro aim**. | `src/game/game.ts:149, 581-585`, `src/ui/SettingsPanel.tsx:159`, `src/ui/TouchControls.tsx` | on-device |
| 6.3 | **Screen wake lock** while in a room. | `src/game/game.ts` start/dispose | — |
| 6.4 | **Discord participants**: `getInstanceConnectedParticipants` + `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` so "This channel" shows who's in/out of the match; use Discord avatars on scoreboard/kill feed; `openInviteDialog` instead of a web link; `timestamps.start` + assets in presence. | `src/discord/discord.ts:34-40, 98`, `src/ui/DiscordLobby.tsx:183-204`, `src/ui/Hud.tsx:38` | manual in Discord |
| 6.5 | **Pointer-lock refusal inside Discord** → explain the free-cursor fallback once (toast) and offer "Try again". | `src/game/game.ts:759-766` | manual |
| 6.6 | **`visibilitychange`**: resume AudioContext on return, mark AFK after 60 s hidden. | `src/game/audio.ts:28-32` | manual |

## M7 — Accessibility and audio/visual polish

| # | Task | Where | Verify |
|---|---|---|---|
| 7.1 | **Flashbang ignores reduce-motion** (full-screen white). Under `html.reduce-motion` cap at 60 % grey and add a "Reduce flashes" toggle. Photosensitivity risk. | `src/style.css:207-222`, `src/game/settings.ts` | — |
| 7.2 | **Colour-blind team palette** (deuteranopia/protanopia/tritanopia presets swap `#ff4d4d`/`#3d8bff` to orange/blue etc.), applied to uniforms, HUD, name tags, ping colours. | `src/game/modes.ts:57-60`, `src/ui/Hud.tsx:566`, `src/game/nameTag.ts:105`, `src/ui/MatchSummary.tsx:17` | visual |
| 7.3 | **Sound captions** option: small ring icons for footsteps/gunfire direction (feeds from the same data as damage arcs). | `src/game/game.ts:4252`, `src/ui/Hud.tsx:551-562` | — |
| 7.4 | **Focus management**: `:focus-visible` styles, focus trap + return in Settings/Pause/MatchSetup/Bots/Inventory dialogs; remove `input { outline:none }`. | `src/style.css:89, 893`, dialog components | keyboard-only lobby e2e |
| 7.5 | **Positional audio**: use `PannerNode` (HRTF) for shots, steps and explosions instead of `StereoPannerNode`; gunshots are currently not panned at all. | `src/game/audio.ts:116-121, 138-141` | manual |
| 7.6 | **Missing cues**: grenade throw/bounce, mine arm/trigger, turret fire, fire crackle loop, per-ability sounds, flag take/capture, shield break, respawn, UI clicks, lobby music. | `src/game/audio.ts:201`, `src/game/game.ts:1634, 1645, 3615`, `public/sounds/` | credits.html updated |
| 7.7 | **Text scaling**: HUD scale should also scale announcer, toasts, scoreboard (`44px`, `10–13px` fixed sizes). | `src/style.css:133-136, 256-263, 712, 757, 774, 1396` | — |
| 7.8 | **Rebindable fire/ADS and gamepad** support (`getGamepads` polling in `player.ts`). | `src/ui/SettingsPanel.tsx:178`, `src/game/player.ts` | manual |

## M8 — Database rules and code health

| # | Task | Where | Verify |
|---|---|---|---|
| 8.1 | **Rules: stop accidents and casual tampering** without auth: `$other: false` everywhere; `players/$pid` must be a *full* record (`hasChildren` — also blocks the partial bot writes from 0.5) with every field typed/ranged and `kills` only `same / +1 / 0`; events create-or-delete only, `t === now`, shape per `types.ts`; pickups/game/lobby shapes; whole-room delete only after the lobby record is gone. Note: RTDB can't forbid *deleting* another player's record without auth — accepted for a friends audience. Extend `scripts/test-rules.mjs` (needs PATCH/DELETE support) with an ok + refused case per rule. *(Design: Appendix A.4.)* | `database.rules.json`, `scripts/test-rules.mjs`, `src/net/network.ts` (`deleteRoom` order) | `npm run test:rules` |
| 8.2 | **Optional later: anonymous Firebase Auth** + `auth.uid === $pid` for own record; owner writes bots under `b_` ids checked against `lobby/$room/hostId`; leaderboard `d_` ids require the Discord token to be verified by the Netlify function and minted as a custom token. Sized in Appendix A.4; only worth it if the game goes beyond friends. | `src/net/firebase.ts`, `netlify/functions/discord-token.mjs`, rules | `test:rules` |
| 8.3 | **Split `game.ts`** (4,524 lines) into controllers via narrow `XxxApi` interfaces, copying the `BotHostApi` pattern. First three, in order: **CTF** (`2213-2358`, ~145 lines, proves the pattern), **S&D** (`2358-2778`, ~420 lines, most transactional logic, already unit-tested), **deployables** (turret/wall/mine subset of `3130-3960`, ~450 lines). Leave pickups/inventory/throws in `Game` for now. *(Design: Appendix A.6.)* | `src/game/game.ts`, new `src/game/ctf/ctfController.ts`, `src/game/snd/sndController.ts`, `src/game/deployController.ts` | tsc + `ctf`/`snd`/`deployables`/`bots` e2e unchanged after each extraction |
| 8.4 | **Shared constants**: `MAX_PITCH` ×4, `KNIFE_SLASH`/`KNIFE_TIME`, `PICKUP_RADIUS` ×2, `ADS_RATE`/`ADS_SPEED`, `WALK_SPEED` ×2, bloom `0.0015` ×2, the two differently-unitised `MAX_SLOPE`s. Single `src/game/tuning.ts` + rename one `MAX_SLOPE`. | listed in audit | tsc |
| 8.5 | **Shared hit/spread model** for player and bots (`spreadOf`, head radius, hitbox dims) in `src/game/hitModel.ts`. | `src/game/game.ts:2955-2959`, `src/game/bot/hitscan.ts:15, 88-96` | unit |
| 8.6 | **Dispose completeness**: `Game.dispose` misses `effects`, `scanFx`, `weapon`/`povWeapon`, active kill cam; `RemotePlayer.dispose` leaks knife geometry. | `src/game/game.ts:4476-4510`, `src/game/remotePlayer.ts:1108` | `renderer.info.memory` returns to baseline after leave |
| 8.7 | **CI**: add `vite build` to `checks.yml` with a bundle-size budget (fail if `start-*.js` gz > 200 KB), add `eslint` (typescript-eslint + react-hooks). Delete the empty `src/game/engine/__tests__/` and `src/game/gfx/` dirs and the stale version-2 block in `golden.json`. | `.github/workflows/checks.yml`, `package.json` | CI green |
| 8.8 | **Unit-test gaps**: `gunStats.shotDamage`/TTK table, `rules.normalizeRules`, movement (jump apex, slide), `leaderboard` score formula, `nav.ts`. | new `__tests__` files | vitest |

## M9 — Documentation drift (README promises things the code doesn't do)

- V-Sync / Max FPS settings and `src/game/frameLoop.ts` — **do not exist** (README:461-470). Either implement (a `MessageChannel`-driven loop is ~60 lines) or delete the section. Recommend implementing: it's a nice feature and already documented.
- Quality text: "High up to 2×" / "Medium native" vs code `PIXEL_RATIO = {low:1, medium:1.5, high:1.5}` (`game.ts:145`).
- "`identify` scope only" vs code requesting `rpc.activities.write` (`discord.ts:87`).
- "Bots never touch the leaderboard" vs kills on bots counting (M4.7).
- `rules.ts:40` says bots "fill the room up to this many players" vs `roster.ts:5-7`.
- README project layout lists `mapgen.ts`/`levelgen/` (old) instead of `mapgen/`; Lobby section lacks the Leaderboard tab and permanent names.
- Training sim "FFA / TDM / CTF rules" vs `sim/arena.ts:26` including S&D.

---

## Suggested order

1. **M0** (a day): all small, each with an e2e assertion; 0.3–0.6 remove the ways a friends' session dies.
2. **M1.1, 1.2, 1.5** (a weekend): send-rate fix, snapshot interpolation, refresh-rejoin. Biggest felt improvement.
3. **M2.1, 2.3, 2.4, 2.5, 2.6, 2.8** (a weekend): solo play works, HUD tells you where to go, kills feel good, S&D sounds like S&D.
4. **M5.1, 5.2** (a day): halve download, remove raycast cost.
5. **M3** balance pass with `gunStats.test.ts` TTK table as the contract, then re-eval bots.
6. **M8.1, 8.3** before any further big features: rules guards and the first three `game.ts` extractions make everything after cheaper.
7. M4, M6, M7, M9 as time allows.

## Verification (whole roadmap)

- `npm run typecheck && npm test && npm run test:maps` on every task.
- `npm run test:e2e` for anything touching netcode, rounds, modes, HUD state or touch (the suite already has a spec per area; extend the nearest one).
- `npm run test:rules` for M0.10, M8.1, M8.2.
- `npm run eval:bots` after any gun/movement tuning (M3) or observation change (M4) — bots must not regress vs the scripted baseline.
- Perf items: `perfStats` overlay (frame time, writes/s) before/after on a Large map with 8 bots; `du -sh dist/assets/*` for M5.1.
- Map changes (M3.12): bump `GENERATOR_VERSION`, regenerate `golden.json`, `npm run check:maps -- --count 200`.

## Appendix A — engineering designs

### A.1 Timed snapshot interpolation (M1.2)

- `Pose` gains `t?: number` (server ms, `r0(net.serverNow())`). `poseChanges(prev, next)` compares *without* `t`, then attaches `t` only when something else changed or on heartbeat — otherwise `t` defeats "send only on change".
- New `src/game/poseBuffer.ts` (pure, no three): `interface PoseSnap { t, x, y, z, yaw, pitch }`; `class PoseBuffer { push(s): void /* dedupe same t, keep ≤4, clear on teleport */; sample(renderT, out): 'interp'|'extrap'|'hold'|'empty'; reset() }`. `RENDER_DELAY = 120` ms (send interval 66 ms + RTDB fan-out jitter 50–150 ms), `EXTRAPOLATE_MAX = 100` ms from the last two snaps' velocity, then hold. Linear position, shortest-arc yaw: factor `dYaw` from `replay.ts:sampleAt` into `export function lerpPose(a, b, k, out)` used by both. No hermite (overshoots at 15 Hz, needs velocity in the packet).
- `RemotePlayer.setData`: `typeof data.t === 'number'` → `buffer.push`; keep the respawn / >6 m snap (+ `buffer.reset()`). `target` still means "latest reported pose" so `game.test.remoteSettled` (game.ts:702-705) and spawn logic (2932-2933) are untouched. No `t` → legacy exp-ease.
- `RemotePlayer.update(dt, serverNow)`: `buffer.sample(serverNow - RENDER_DELAY)` → group position/yaw/pitch through a tight `1-exp(-30·dt)` ease to hide corrections. Gait/ragdoll derive velocity from `group.position` deltas (remotePlayer.ts:1057-1063) so they keep working. Call site passes `this.net.serverNow()`.
- Drift fix: `this.sendTimer -= SEND_INTERVAL; if (this.sendTimer > SEND_INTERVAL) this.sendTimer = SEND_INTERVAL;` (game.ts:4126; the e2e hook at 661 still works).
- Replay/kill cam: don't share the buffer; make `onPlayerChanged` (game.ts:1282) pass `data.t ?? serverNow()` to `recorder.pose`. Share only `lerpPose`.
- Victim-side tolerance: no (can only reject hits, punishing the shooter for the render delay). Only add: drop a `shot` whose `|o − myPos| > range(w) + 10`.
- Order: poseBuffer + vitest → `t` in Pose/send loop → RemotePlayer buffer path → recorder `t` → rules allow `t` (A.4). Risks: per-client `serverOffset` a few ms off (buffer absorbs it); mixed versions (fallback path).

### A.2 Rapier raycasts for map geometry (M5.2)

- Why Rapier: already loaded, map already in it (`PhysicsWorld.setMap`, deployables mirrored via `addBox` game.ts:529), and `castWorld` in `src/game/bot/senses.ts:33-39` already defines "what a bullet stops at" for training. Lets `world.ts` drop proxy meshes (173-185, 218-226). three-mesh-bvh would need a merged static mesh, separate deployable handling, +100 kB.
- `physics.ts`: `castRay(origin, dir, max, filter = GROUP.WORLD): { toi; key: unknown | null } | null` using `world.castRay(ray, max, /*solid*/ false, undefined, groups(0xffff, filter))` (`solid=false` matches three's front-face behaviour when the muzzle is inside a wall). Keep `handleToKey: Map<number, unknown>` filled in `addBox`/cleared in `removeBox` so `key` identifies a deployable's Box3.
- `deployables.ts`: `onCollider?: (box, added, id) => void` on WallField/TurretField; `game.ts` mirror records `deployableBoxes: Map<Box3, string>` so `deployableOf` takes a key, not a mesh.
- `game.ts` shoot (2961-2975) and turret fire (3586-3590): per pellet `wall = physics.castRay(origin, dir, range)`; `raycaster.far = wall?.toi ?? range`; `intersectObjects(enemyHitboxes)` only; no hitbox hit → `end = origin + dir·toi`, deployable from `wall.key`. LOS sites (1180, 3392, 3569, 3725, 4278) → `castWorld(...) < dist`.
- Step 2 (separate PR): remove proxies from `world.ts`; keep `solids` only for deployables/replay (replay.ts:148).
- Risks: cylinders are cuboids in Rapier (world.ts:218 vs physics.ts:122-133) → corners shootable; add a `ColliderDesc.cylinder` branch if colliders carry a shape flag. Guard `physics` null before `startPhysics`.

### A.3 Shrink Rapier load (M5.1)

- Facts: compat = one 4.3 MB `rapier.mjs` with base64 WASM; its high-level API lives only in that bundle. `@dimforge/rapier3d` (same 0.21) uses wasm-bindgen's bundler target → needs `vite-plugin-wasm`. All Node paths (`train-bots.ts:19`, `eval-bots.ts`, 5 bot tests) go through `loadPhysics()`; the mapgen worker never touches Rapier; only `mapgen/__tests__/physics.test.ts` imports compat directly.
- `package.json`: add `@dimforge/rapier3d`, `vite-plugin-wasm`; keep compat for Node; `"imports": { "#rapier": { "node": "@dimforge/rapier3d-compat", "default": "@dimforge/rapier3d" } }` — Vite takes `default`, `rolldown --platform node` and vitest take `node`.
- `physics.ts`: `import type RAPIER_NS from '#rapier'`; `loading ??= import('#rapier').then(async (mod) => { if (typeof mod.init === 'function') await mod.init(); … })` (non-compat has no `init`). Type imports in `ragdoll.ts`, `debris.ts`, `movement.ts` → `#rapier`; `physics.test.ts` too if nominal types differ.
- `vite.config.ts`: `plugins: [react(), wasm()]`; add `{ name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]/ }` to `codeSplitting.groups`. es2022 already allows the TLA.
- Prefetch: already there (`loadPhysics()` in `Lobby.tsx:76`, `DiscordLobby.tsx:67`); becomes `instantiateStreaming` for free.
- Go/no-go: (1) Netlify sends `content-encoding` for `application/wasm` and the Discord proxy forwards it — uncompressed is a 3.1 MB regression; (2) `vite-plugin-wasm` on Vite 8/rolldown — smoke-test `npm run build`; fallback is a hand-written `?url` + `instantiateStreaming` + `__wbg_set_wasm` loader.

### A.4 Database rules (M8.1, optional M8.2)

- RTDB facts: `.write` cascades downward and can't be revoked; `.validate` never runs on deletes; `.validate` on a node sees the merged record for `update()`. So "forbid deleting other players" needs auth — skip without it.
- `rooms/$room`: `.write: "!newData.exists() && !root.child('lobby').child($room).exists()"` (whole-room delete only after the lobby record is gone — make `deleteRoom`/`armDisconnect` remove lobby first, sequentially); `.write: true` on `players`, `events`, `pickups`, `game`.
- `players/$pid`: `.validate: hasChildren(['name','color','x','y','z','yaw','pitch','hp','alive','kills','deaths'])`; `x/y/z` within ±600; `alive/spec/bot/shield/cloak/aim/rl` boolean; `stance`/`gun`/`team` enums; `kills`: `!data.exists() || newData.val() === data.val() || newData.val() === data.val() + 1 || newData.val() === 0`; counters ≥ 0; `moment` shape; `color` ≤ 9; `$other: false`.
- `events/$eid`: `.write: "!data.exists() || !newData.exists()"`; `.validate: hasChildren(['type','from','t']) && child('t').val() === now`; `type` enum (11 kinds); `from` ≤ 16; `o/e/p/v` children `0,1,2` numbers; `ends/$i`; `hits/$id`, `dep/$id`, `dmg` 0–1000; `hit/killer/victim` ≤ 16; `$other: false` from the allow-list in `types.ts:97-223`.
- `pickups/$id`: `hasChildren(['type','x','z'])` + `PickupRecord` fields; `game`: `round` number, `rules` reuse the lobby block; `lobby/$room`: `$other: false`.
- `scripts/test-rules.mjs`: add `method` (PATCH for `update`, DELETE); cases: full player ok / partial refused; kills +1 ok, +2 refused, 0 ok; event with `{".sv":"timestamp"}` ok, fixed `t` refused, unknown field refused; room delete with lobby present refused, after lobby gone ok.
- Optional anonymous auth (≈1 day): `signInAnonymously` (+ `connectAuthEmulator`, emulator `--only database,auth`); `playerId = auth.uid`; `players/$pid .write: auth != null && ($pid === auth.uid || $pid.beginsWith('b_' + auth.uid + '_'))` (bot ids `b_<uid>_<n>`), `players/$pid/kills .write: auth != null && newData.val() === data.val() + 1` so victims still credit. Breaks: Discord needs URL mappings + `patch.ts` rewrites for `identitytoolkit`/`securetoken`; `d_<discordId>` leaderboard ids ≠ `auth.uid` (keep regex rule, or mint custom tokens in the Netlify function); every e2e `Player` must await sign-in.

### A.5 Presence races (M0.3–0.5)

1. Room wipe: always arm only `playerRef`/`memberRef` (+ bots); delete `lastOneHere` and `addBot`'s `if (!this.lastOneHere)`; add `!snap.exists() → deleteRoom` to the `members` listener so a graceful last leaver cleans up. Behaviour change: a room whose last player closes the tab lingers until someone lists the lobby — update `join-leave.spec.ts:73` accordingly.
2. Join/leave: `private left = false`; `leave()` sets it first, idempotent; `join()` checks `left` after the presence promise and before each listener group; `registerPresence` no-ops when `left`. `game.ts`: `this.joining = this.net.join(...)`, `dispose()` awaits `this.joining?.catch(() => {})` before `net.leave()`.
3. Bots after reconnect: `bots: Map<string, { player, member, state: PlayerState }>`; `addBot` stores it; `sendStateAs` merges partials (dropping nulls); `onChildChanged` for own bot ids overwrites `state` with the server copy; `registerPresence` re-`set`s each bot and re-arms their `onDisconnect`. With A.4's `hasChildren`, a partial write on a vanished record is refused instead of orphaning. Small pure `mergeBotState` helper + vitest.

### A.6 `game.ts` split — first three controllers (M8.3)

Pattern: class taking a narrow `XxxApi` built in `Game` (like `createBotHost`, game.ts:1156-1209); fields move with methods; `Game` keeps thin delegates for e2e hooks (`state()` at 700-738 reads private fields — keep getters). `frame()` ordering must stay (`updateFlags` before `updateMode`).

1. **CTF** → `src/game/ctf/ctfController.ts`: `class CtfController { update(); dropFlag(): Promise; carrying(): boolean; referee(); onGame(prev, next) }`, owns `flagBusy, refereeBusy, carry, flagLeftAt, flagDroppedAt, flagHomeToast`. `CtfApi { selfId; net; team(); game(); players(); roundOver(); isLeader(); myPos(); groundBelow(p); dropSpot(); flagSpot(team); stats(); moments; hud; finishRound(...); setGunPrompt(text) }`.
2. **S&D** → `src/game/snd/sndController.ts`, owns `snd, sites, sitesKey, sndKey, bombBusy, sndRefereeBusy`. `SndApi` = CtfApi + `alive(); hp(); spectating()/sitOut/stopWatching; channel get/set; player (position, stance); camera; bombField; touch; respawn(); pickSpawn(); roundSpawnFor(); bots (startSndRound); shake()`. `BotHostApi.sites/endSndRound/headcount` delegate to it.
3. **Deployables** → `src/game/deployController.ts` (placeTurret/Wall/Mine, runTurret/runMine, deployableOf/canBreak/damageDeployables, deployHeight/occupied, targetsOf, detonate). `DeployApi { selfId; net; physics(); world(); walls; turrets; mines; fires; remotes(); players(); isAlly(id); me(): Actor; hud; recorder; effects; castRay; bodyOf(id) }`.

### A.7 HUD re-render reduction (M2.10)

- `src/ui/hudHooks.ts`: `useHudSelector<T>(game, select: (s: HudState) => T): T` = `useSyncExternalStore(game.hud.subscribe, () => select(game.hud.get()))`. Safe because `HudStore.update` keeps untouched keys by reference; rule: return a field or primitive, never a fresh object (`useHudShallow` with ref + shallow compare for tuples).
- `React.memo` on `ScoreBar`, `SndScoreBar`, `KillFeed`, `AbilityBar`, `AbilitySlot`, `HealthPanel`, `AmmoPanel`, `DamageDirections`, `RoundClock`; change `ScoreBar({ hud })` → `ScoreBar({ game })` reading via selectors. Root `Hud` keeps only layout flags.
- Countdowns: `buffs.speed: number` (re-sent 10/s) → `speedUntil: number | null` (ms on `performance.now()`), same for cloak/lifesteal/scan; `<Countdown until>` writes `textContent` via rAF like `FpsCounter` (636-656). `SlotView.cooldown` → `readyAt`; `.cooldown` bar = CSS `animation: drain <s> linear` keyed on `readyAt`. Then `lastSlotsKey` changes only on pickup/use/expiry.
- Debug: `perfStats.hudRenders++` in `Hud` render (dev), shown in `perfLine` (`?debug`). Target: ~0 renders/s idle, ≤ 2/s in a fight.
- Risks: selectors returning fresh objects → infinite loop; `Countdown` must use the engine's clock.
