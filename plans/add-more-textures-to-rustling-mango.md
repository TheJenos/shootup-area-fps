# Plan: time limits, winner screen, MVP replay, new map every round

## Context
Rounds currently end only at a score limit (25 kills / 50 team kills / 3 captures). An 8 s "round over" screen
follows, then the next round starts on the **same** map: the room's seed is fixed and the world is built once
in the `Game` constructor.

The user wants:
- a time limit per mode;
- a winner screen when the round ends;
- then an **MVP moment**: a short in-engine replay of the round's best highlight, e.g. a quick multi-kill, or in
  CTF a capture combined with kills;
- then the next round on a **new map with a different seed**.

Decisions (from the user):
- Replay, not just a card.
- Time limits: FFA 8, TDM 10, CTF 12 minutes.
- Score limits still end a round early.

## Round lifecycle (all times are estimated **server** time, so every client stays in step)
1. **Playing** from `game.startedAt` until `startedAt + timeLimit`, or until a score limit is reached.
2. **Results**, 6 s: the winner (or "Draw") and the top players.
3. **MVP**, 10 s: replay of the MVP's highlight with a banner. Skipped if nobody did anything.
4. **Next round:** `round + 1`, seed = `ended.nextSeed`, scores and flags reset, pickups cleared. Every
   client rebuilds the world and respawns.

## Data changes
- **`src/types.ts`**
  - `GameRecord` gains:
    - `seed` (the current map);
    - `startedAt` (server ms);
    - `ended: { winner, name, reason: 'time' | 'score', at, nextSeed, mvp? }`, where `winner` can be `'draw'`.
  - `PlayerState` gains `moment?: Moment = { score, title, start, end }` (server ms). Each player reports
    their own best highlight, like their other stats.
  - `MvpInfo = { id, name, color, team?, title, start, end, kills, deaths, captures, damage }`.
- **`src/game/modes.ts`**: `timeLimit` per mode (480 / 600 / 720 s), `RESULTS_TIME = 6`, `MVP_TIME = 10`.
  Drop `INTERMISSION`.
- **`src/net/network.ts`**
  - `RoomConnection` subscribes to `.info/serverTimeOffset` and exposes `serverNow()`.
  - `createRoom` also writes `rooms/{code}/game = { round: 0, seed, startedAt: serverTimestamp() }`.
  - New helpers: `clearPickups()` and `setLobbySeed(seed)` (so the lobby list shows the current map).
  - Old rooms without `startedAt` get one set by the leader through `mutateGame`.

## Ending a round (`src/game/game.ts`)
- Add one helper, `finishRound(g, winner, name, reason)`, used inside every ending transaction. It fills in:
  - `at` = `serverNow()`;
  - `nextSeed` = `randomSeed()`, different from `g.seed` (reuse `randomSeed` in `mapgen.ts`);
  - `mvp` = `pickMvp()` from the local `players` map, so everyone shows the same MVP.
- It's called from the existing score-limit paths (`endRound`, `addTeamScore`, CTF capture) and a new time
  check in `updateMode()`: once `serverNow() >= startedAt + limit`, any client attempts the transaction.
  - Team modes take the winner from `g.score` inside the transaction; equal scores are a draw.
  - FFA takes the winner from player kills; a tie is a draw.
- `requestNextRound()` (existing) runs once `serverNow() >= ended.at + RESULTS + MVP`, or `+ RESULTS` when
  there's no MVP. It sets `seed = nextSeed` and `startedAt = serverNow()`. The client whose transaction
  commits also calls `clearPickups()` and `setLobbySeed()`.

## New map each round
- **`src/game/world.ts`**
  - `buildWorld` puts everything (lights, sky, floor, boxes, markers) under one `root` group and returns
    `dispose()`.
  - It fills `colliders` / `solids` arrays that the caller passes in, so `LocalPlayer` and `PickupField` keep
    valid references to them.
- **`Game.loadMap(seed)`**
  - disposes the old root;
  - clears the arrays in place (`length = 0`);
  - rebuilds, and updates `floorSurface` and `hud.map`.
- When it runs:
  - from `onGame` when `g.seed` differs from the map currently built, i.e. on a new round, or for a late
    joiner whose room has already moved on from the lobby seed;
  - before `startRound()` respawns the player.
- Spawn points and flag bases are the same on every map, so `FlagField` and team spawns need no changes.

## MVP highlights: new `src/game/moments.ts`
- `MomentTracker` runs on each client, for itself only. It's fed by:
  - kill events where we're the killer;
  - our CTF captures (with the time we took the flag);
  - kills of the enemy flag carrier (who was carrying is known from `game.flags` just before the kill).
- Highlights and scores:

  | Highlight | Score | Title |
  | --- | --- | --- |
  | 2+ kills, each within 4 s of the last | 10·n² | Double / Triple / Quad Kill / Rampage, "n kills in X.Xs" |
  | Capture | 60 + 25 per kill made while carrying | "Flag run + 2 kills" |
  | Killing the enemy flag carrier | 35 | "Stopped the flag carrier" |
  | Streak of 5+ | 8 per kill (replay covers the last 8 s) | "n-kill streak" |
  | Headshot kill | 15 | "Headshot" (fallback) |

- `best()` is published as `moment` with the regular stats send in `Game.update`, and reset in
  `startRound()`.
- **`pickMvp()`:** highest `moment.score + 0.3 × (kills·4 + captures·25 + damage/40)`, ties broken by id.
  With no moments at all, the best performer gets "Top fragger". With no kills at all, there's no MVP.

## Replay: new `src/game/replay.ts`
- **`ReplayRecorder`**: per client, for the current round only, using server time.
  - Records every remote pose as it arrives (`onPlayerChanged`) and our own pose at 10 Hz.
  - Records shot, kill, grenade and blast events, plus flag placement changes.
  - Plain arrays per player (about 1–3 MB for a full round); cleared on each new round.
- **`ReplayDirector`**: plays the window from `mvp.start − 1.5 s` to `mvp.end + 1.5 s` (capped at 10 s;
  longer windows play faster).
  - Creates ghost `RemotePlayer`s (the existing class; it works for us too) for everyone in the window, and
    feeds them interpolated poses through `setData()` and `update()`.
  - Replays tracers through `Effects.tracer` / `impact` and grenades through `GrenadeFx`. Kills make the ghost
    fall, then it reappears at its next sample.
  - Drives `FlagField.set()` from recorded flag placements, and restores the live ones afterwards.
  - Chase camera: behind and above the MVP, looking a few metres ahead of them, smoothed.
  - While it plays, live avatars are hidden (new `RemotePlayer.setVisible`), the viewmodel isn't drawn and
    player input is frozen. `Game.frame` applies the replay camera after `player.update`.
- **Fallback:** a client with no samples for the MVP in that window (it joined late) shows the banner over a
  slow orbit of the map center.

## HUD (`src/game/hudStore.ts`, `src/ui/Hud.tsx`, `src/style.css`)
- **Score bar:** a round clock (mm:ss), which turns red and pulses in the last 30 s.
- **Results phase:** the existing round-over overlay (`#round-over`), extended with the reason ("Time's up" /
  "Score limit"), "Draw", the top 3 players, and "MVP in N…" or "Next map in N…".
- **MVP phase:**
  - letterbox bars;
  - a banner with "MVP", the name in their team/player color, the highlight title, and stat chips (kills,
    deaths, captures, damage);
  - a progress bar;
  - "Next map: <theme> · seed X", using `generateMap(nextSeed).theme.name`.
- The Tab summary (`MatchSummary.tsx`) shows the time left.

## Critical files
- New: `src/game/moments.ts`, `src/game/replay.ts`
- Edit:
  - `src/game/game.ts`
  - `src/game/world.ts`
  - `src/game/modes.ts`
  - `src/types.ts`
  - `src/net/network.ts`
  - `src/game/remotePlayer.ts`
  - `src/game/hudStore.ts`
  - `src/ui/Hud.tsx`
  - `src/ui/MatchSummary.tsx`
  - `src/style.css`
  - `README.md`
- Reuse:
  - `mutateGame` / `normalizeGame` (`network.ts`);
  - `randomSeed` / `generateMap` (`mapgen.ts`);
  - `RemotePlayer`, `Effects`, `GrenadeFx`, `FlagField.set`, `placementOf`;
  - the existing `startRound` / `requestNextRound` / `refreshScore` flow in `game.ts`.

## Verification
1. `npm run typecheck` and `npm run build`. Also rerun the map reachability script (mapgen is unchanged, but
   this confirms it).
2. **Emulator, two tabs, FFA:**
   - Simulate a quick triple kill with kill events.
   - Force time-up by moving `game.startedAt` back in the DB through `mutateGame`.
   - Check: the results overlay names the winner → the MVP replay shows a "Triple Kill" banner with ghosts and
     tracers in screenshots → the next round has a different seed on both clients (`hud.map`, collider hash),
     scores are reset, pickups are cleared, and the lobby list shows the new map.
3. **CTF:** a flag run with 2 kills while carrying becomes the MVP ("Flag run + 2 kills"), and the replay
   shows the carried flag.
4. **Draws:** equal TDM scores at time-up show "Draw".
5. **Late joiner:** joins after the room has rotated maps → builds the current seed. A late joiner during the
   MVP phase gets the fallback banner.
6. **Leaks:** `renderer.info.memory.geometries` / `textures` stay flat across 3 map rotations.
