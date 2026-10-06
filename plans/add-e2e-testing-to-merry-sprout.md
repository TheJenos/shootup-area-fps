# Add end-to-end tests (Playwright + Firebase emulator)

## Context
The only automated test today is `scripts/test-rules.mjs`, which checks the database rules. Nothing tests the actual game: the lobby, rooms, multiplayer sync, combat, the modes, or round flow. Changes like the recent flag, deployable and physics commits can't be checked before they ship. The goal is a Playwright suite that runs real browsers against the local Firebase RTDB emulator and covers every user-facing scenario: single-player UI flows and two-player matches.

Three facts shape the design:
- **Input needs pointer lock.** It is unreliable in headless Chromium.
- **The game is client-authoritative.** The shooter decides hits. The victim applies the damage and reports its own death.
- **Dev builds already set `window.game`.** `GameView.tsx:32` exposes it, but only behind `import.meta.env.DEV`.

## Approach

### 1. Tooling
- Add the dev dependency `@playwright/test`.
- Add scripts in `package.json`:
  - `"test:e2e": "firebase emulators:exec --only database --project demo-fps \"playwright test\""`. This uses the same wrapper pattern as `test:rules`.
  - `"test:e2e:ui"`: the same command with `playwright test --ui`, for local debugging.
- Create `playwright.config.ts`:
  - `webServer`: `vite --mode e2e --port 5174 --strictPort`, with `reuseExistingServer: !CI`.
  - Chromium launch args: `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`, `--ignore-gpu-blocklist`, `--autoplay-policy=no-user-gesture-required`.
  - Viewport 960×540.
  - Timeouts: 90 s per test, 15 s for `expect`.
  - `workers: 2`, with `retries: 1` in CI.
  - `trace` and `video` on first retry.
  - Projects: `ui` (lobby/settings specs), `match` (multiplayer specs), and `serial` (leaderboard). The `serial` project runs with `fullyParallel: false` because it reads global DB state.
- Create `.env.e2e`: `VITE_FIREBASE_EMULATOR=true` and `VITE_E2E=true`. This is a separate mode so tests never touch `.env` production values (the emulator branch already ignores them).
- Add `test-results/`, `playwright-report/` and `e2e/.auth` to `.gitignore`.

### 2. A small test hook in the game (the only app-code change)
- `src/vite-env.d.ts`: add `VITE_E2E?: string`.
- `src/ui/GameView.tsx:32`: change the condition to `import.meta.env.DEV || import.meta.env.VITE_E2E === 'true'`.
- `src/game/game.ts`: add a public `readonly test` facade next to the touch API (~L438), tree-shaken in prod by guarding its use. Each member wraps existing internals, so no game logic changes:
  - `play()`: does what `startTouchPlay()` does (`locked = true`, `player.setEnabled(true)`, `hud.update({paused:false})`). This removes the pointer-lock dependency.
  - `teleport(x, y, z, yaw?)`: `player.teleport(...)`, and resets `lastPose` to force a full send.
  - `aimAt(pid, part: 'body'|'head')`: computes yaw/pitch from the camera to `remotes.get(pid)`'s position or head bone. It uses the convention forward = (-sin yaw, -cos yaw).
  - `fire()`: calls the existing `shoot()` path once.
  - `give(type)`: `inventory.add`. `useAbility(slot)`: the existing `useAbility`.
  - `state()`: `{ id, hp, alive, kills, deaths, team, pos, gun, ammo, slots, carrying, game: this.game, players }`.
  - `remoteSettled(pid)`: true when the interpolated position is within 0.05 m of the target, so tests can wait before aiming.
- Keyboard and DOM interactions (WASD, R, E, Q, Tab, I, the pause menu buttons) still go through the real inputs after `play()`, so the input bindings get exercised too.

### 3. Test helpers (`e2e/support/`)
- `db.ts`: REST helpers against `http://127.0.0.1:9000/...json?ns=demo-fps` with `Authorization: Bearer owner`, the same pattern as `scripts/test-rules.mjs`.
  - Reads: `get(path)`.
  - Writes: `put(path, value)`, `patch(path, value)`, `del(path)`, `waitFor(path, predicate)`.
  - Room helpers: `seedPickup(room, {type, x, z})`, `setScore(room, team, n)`, `expireClock(room, minutes)` (writes `game/startedAt` into the past), `skipIntermission(room)` (writes an old `game/ended/at`).
- `player.ts`: a `Player` class wrapping a `BrowserContext` + `Page`.
  - `addInitScript` seeds localStorage:
    - `fps-name`
    - `fps-settings` = `{fullscreen:false, quality:'low', sfxVolume:0, musicVolume:0, screenShake:false, showFps:false, version:2}`
    - `fps-hints` (all hint ids)
    - `fps-touch-intro`
    - a seeded `Math.random` per player
  - Routes `**/sounds/*.mp3` to an empty 200 response.
  - Methods: `gotoLobby()`, `createRoom({mode, seed:'classic', name})` (returns the code from `#room-tag strong`), `joinByCode(code)`, `waitJoined()` (`window.game.joined` and `#connecting-overlay` hidden), `play()`, `hud()` (returns `game.hud.get()`), `state()`, `shootAt(other, part, n)` (aim → fire → re-aim to beat recoil), `leave()` (clicks `Leave room`).
- `fixtures.ts`: Playwright fixtures.
  - `alice`, `bob`: separate contexts, with closing handled automatically.
  - `duel(mode)`: creates the room with alice and joins bob. Both call `play()`. Each is teleported to known spots on the CLASSIC map, facing each other a few metres apart.
  - In `afterEach`, delete `lobby/{code}` and `rooms/{code}` for rooms the test created. Never wipe the whole namespace, so parallel workers stay isolated.

### 4. Specs (`e2e/*.spec.ts`)
Selectors come from the existing ids, roles and aria labels the exploration found. No `data-testid` additions are needed.

| Spec | Scenarios |
|---|---|
| `onboarding.spec.ts` | First-visit name prompt: Continue disabled under 2 characters, invalid characters show the en-dash error, the name persists in `fps-name` and shows "Playing as". A returning visit skips the prompt |
| `lobby.spec.ts` | Tabs switch the panels. The open-rooms list shows a room another context created (badge, mode, map, code, player count). Search filters by name, code, mode and host, with the "No rooms match" and "Clear search" states. Join by code works, a bad code shows "Room X doesn't exist." The empty state's "Create the first one" link works |
| `create-room.spec.ts` | Every preset mode chip creates a room with the right `lobby/{code}/rules`, map name and button label. Seed input, dice and `classic`. A blank seed shows "Surprise me". The room name defaults to "{name}'s room". The map preview renders |
| `custom-modes.spec.ts` | The editor opens from `＋ New mode` and `Customize`. Base switch, name and badge, loadout select (Gun Game only for FFA), checkboxes and sliders with clamped limits, live preview text. Cancel, Esc and backdrop close it. `Use once` (not saved) vs `Save & use` (persists in `fps-custom-modes`, same name replaces). Edit and delete. The 12-mode cap. The created room carries the custom rules |
| `invite.spec.ts` | `#CODE` and `?room=CODE` auto-join after 2 s, plus `Join now` and `Stay in the lobby`. A closed room shows the "That room has closed" warning and resets the URL. The invite link copied from the pause menu has the expected format |
| `settings.spec.ts` | Open from the lobby gear and the pause menu. Each tab: sensitivity, invert, FOV, quality radios, FPS counter toggle (shows `#fps` in game), crosshair colour and size (CSS vars on `#crosshair`), volumes, reduce motion (`html.reduce-motion`), HUD size (`--hud-scale`), show tips again. Key rebinding: listening state, Esc cancels, a rebound key moves the player in game. Reset to defaults with confirm. Persistence in `fps-settings` across reloads |
| `join-leave.spec.ts` | A single player sees `#waiting-banner` with the code and the pause menu. A second player joins: both see each other in `players`, the "X joined" feed line, and the player count in the pause menu. Leaving shows "X left" for the other player and removes the member. When the last player leaves, `lobby/{code}` and `rooms/{code}` are deleted. Closing a tab (onDisconnect) cleans up the same way |
| `movement.spec.ts` | WASD after `play()` changes position, and the remote copy follows. Jump, crouch/slide, sprint. Moon Gravity jumps higher than FFA. Speed rule scales distance |
| `combat.spec.ts` | Body hit lowers the victim's HP by the rifle damage (HUD `#health`, and `players/{pid}/hp`). Hitmarker for the shooter, with the `.head` class on headshots. Kill: `#death-overlay` "You were eliminated by Alice", killfeed entry, K/D in the DB. Respawn after the rule's seconds with full HP. Kill-heal adds +50% (and +25 in Hardcore's 50 HP). Reload (R) and ammo HUD states (LOW AMMO, reload, NO AMMO). Gun swap (Q) |
| `rules.spec.ts` | Headhunter: body shots do nothing, headshots kill. Loadout-only modes (Sniper/Shotgun/Deagle): the forced gun, ∞ reserve, no gun or ammo pickups spawned. Gun Game: a kill advances the ladder ("Level N" toast, new gun), and the final kill wins. Health rule: the 200 HP bar scales. Respawn time rule |
| `ffa-scoring.spec.ts` | Lead change: "YOU TOOK THE LEAD" / "LEAD LOST", and the 👑 on the scorebar. Score limit (the limit is seeded near the end via `players/{pid}/kills`) ends the round: `#round-over` "You win!", podium, `#mvp`, then the next round (round+1, new seed, K/D reset, "Round N" toast) |
| `tdm.spec.ts` | The two players land on different teams (with a team-switch fallback). A kill adds to the killer's team score in `#scorebar`. Friendly fire is ignored. Pause-menu `Switch to Red/Blue`. With the score seeded to limit−1, one kill ends the round, and the round-over screen shows "Red team wins!" |
| `ctf.spec.ts` | Teleport to the enemy base → "FLAG TAKEN", melee mode (`#ammo.melee`), and `game/flags`. E puts the flag down. A teammate touch returns it. Auto-return after 20 s (via a seeded old drop time or a waited timer). Dying drops the flag. Capturing with your own flag away shows the "must be at your base" toast. A valid capture increments the score, and reaching the limit ends the round. Flag swing melee damages the enemy |
| `pickups.spec.ts` | Pickups seeded at the player's feet over REST: medkit (refused at full HP, heals when hurt), ammo box ("Ammo restocked" / "Ammo full"), gun (`#gun-prompt`, E picks it up, Q swaps), abilities fill slots, "Slots full". The inventory (I) shows items, and Drop spawns a pickup. Loot drops on death. The leader's spawner creates pickups. When the leader leaves, the other player takes over spawning |
| `abilities.spec.ts` | Each ability through `give`+slot key: grenade (blast damages the opponent; self-kill gives "You took yourself out"), smoke, molotov (damage over time), flash, speed/shield/cloak/lifesteal/scan buffs (`#abilities .buff.*`, shield absorbs damage), cooldown UI (`.slot.cooling`) |
| `deployables.spec.ts` | Barrier blocks shots between players. It takes damage and is destroyed ("Barrier destroyed" / "Your barrier was destroyed"), and expires. Turret fires at an enemy in range and can be destroyed. Mine arms then triggers. Deployables vanish when the owner leaves |
| `round-clock.spec.ts` | `expireClock` triggers a time-limit end ("Time's up") with the right winner, or a draw on a tie. `#match-summary` (hold Tab): columns, your stats, team rows in team modes |
| `spectate.spec.ts` | Pause → Spectate shows `#spectate` and `spec` in the DB, and the other player stops seeing the spectator. Back to the fight respawns |
| `connection.spec.ts` | `context.setOffline(true)` → `#offline-banner` "Reconnecting…" and the pause state "Connection lost". Back online recovers. Lobby with the emulator unreachable shows "Couldn't reach the server" + Retry (uses `page.route` to block port 9000) |
| `leaderboard.spec.ts` (serial project) | Empty state. After a finished round (an `ended` round seeded quickly, played for at least 60 s or with `joinedAt` adjusted through the hook), the player's row appears with `tr.me` "(you)", score/K/D/wins, medals, and the `tfoot` "your rank" row when outside the top 20 (seeded over REST) |
| `touch.spec.ts` | `?touch` + `hasTouch`, landscape viewport: touch intro shown once ("Got it"), `#touch-controls` buttons (Fire, Jump, Reload, Scoreboard, Inventory, Menu) work, the stick moves the player, the rotate hint shows in portrait |
| `discord.spec.ts` | `?frame_id=x` renders the Discord lobby's "Connecting to Discord…". This is a smoke test only, because the SDK handshake needs a real Discord parent frame |

### 5. CI
Add `.github/workflows/e2e.yml`. It runs on pull requests and on pushes to `main` that touch `src/**`, `e2e/**`, `public/**`, `database.rules.json` or the config. Steps:
1. Node 22 + Java 21 (copying `database-rules.yml`).
2. `npm ci`.
3. `npx playwright install --with-deps chromium`.
4. `npm run test:e2e`.
5. Upload `playwright-report/` as an artifact on failure.

### 6. Docs
Add an "End-to-end tests" section to `README.md`: how to run them, the `--ui` mode, the `VITE_E2E` hook, and how to add a spec with the `duel` fixture.

## Files
- New: `playwright.config.ts`, `.env.e2e`, `e2e/support/{db,player,fixtures}.ts`, `e2e/*.spec.ts` (the specs above), `.github/workflows/e2e.yml`.
- Modified: `package.json`, `.gitignore`, `src/vite-env.d.ts`, `src/ui/GameView.tsx`, `src/game/game.ts` (the `test` facade only), `README.md`.

## Risks and mitigations
- **SwiftShader is slow.** Use `quality: low` and a small viewport. Game time lags wall time when fps < 20, so wait on state (`expect.poll` on `state()`/DB) rather than fixed sleeps.
- **Randomness in spawns, teams, spread and recoil.** Teleport after joining. Use the CLASSIC seed. Seed `Math.random`. Use rifle or deagle at close range and re-aim before each shot. Use `expect.poll` with retries for hit assertions.
- **Events expire after 3 s and only reach players already listening.** Act only after both players report `joined` and the remote is settled.

## Verification
1. `npm run typecheck` and `npm run build`. The prod build must not expose `window.game` (check with `grep -r "__e2e\|window.game" dist` or an equivalent).
2. Run `npm run test:e2e` locally. All specs pass. Then run `npx playwright test --repeat-each=3` on the match specs to check for flakiness.
3. `npm run test:rules` still passes.
4. Push a branch and confirm the `e2e.yml` workflow runs green, with the report artifact uploaded on a forced failure.
