# Arena FPS

A multiplayer browser FPS built with **Three.js**, with realtime sync over **Firebase Realtime Database**.
Pick a name, create or join a room, and shoot each other in Free-for-all, Team Deathmatch or Capture the Flag.

## Quick start (local, no Firebase account needed)

Requires Node 20+ and Java (for the Firebase emulator).

```bash
npm install
npm run emulator      # terminal 1 — local Realtime Database on :9000
npm run dev:emu       # terminal 2 — game on http://localhost:5173
```

Open the game in two browser windows, create a room in one and join it from the other.

## Using a real Firebase project

1. Create a project at https://console.firebase.google.com
2. **Build → Realtime Database → Create database**, picking the location closest to your players (it can't be
   changed later; this game's live database is in Singapore, `asia-southeast1`)
3. **Project settings → Your apps → Web app**, then copy the config values.
4. `cp .env.example .env` and fill them in (`VITE_FIREBASE_DATABASE_URL` is the important one).
5. Paste `database.rules.json` into **Realtime Database → Rules** (or `firebase deploy --only database`).
6. `npm run dev`. Use `npm run build` to get a static `dist/` you can host anywhere (Firebase Hosting, Netlify, …).

To play with friends on your LAN while developing, run `npm run dev -- --host`.

## Game modes

The room's creator picks the mode; the lobby shows it next to each room.

| Mode | Goal | Time limit | Or ends early at |
| --- | --- | --- | --- |
| **FFA** — Free-for-all | Most kills | 8 min | 25 kills by one player |
| **TDM** — Team Deathmatch | Red vs Blue; every kill scores for the killer's team | 10 min | 50 team kills |
| **CTF** — Capture the Flag | Grab the enemy flag and bring it to your own base | 12 min | 3 captures |

- **Teams:** you join the smaller team. Teammates show up in the team color with their name always visible,
  bullets and grenades pass through them, and you spawn on your own half (red owns +z, blue −z).
  The pause menu (Esc) has a **Switch team** button.
- **Capture the Flag:** each base is a glowing pad near the back wall with the team's flag on it.
  Walk over the enemy flag to take it, then walk onto your own base to score — only while your own flag is home.
  A carrier who dies (or switches team, or leaves) drops the flag where they stood. Touch your own dropped flag
  to send it home; otherwise it returns by itself after 20 s. The score bar shows where both flags are.
- **Rounds:** the score bar shows the round clock, which turns red in the last 30 s. When the time runs out,
  the best score wins; a tie is a draw. A score limit ends the round early. Then:
  1. **Results** (6 s): the winner, why the round ended, and the top three.
  2. **MVP** (10 s): a replay of the MVP's highlight, seen from behind them, with their card and the next
     map. It's skipped when nobody got a kill or a capture.
  3. **Next map:** a new round starts on a new map with a fresh seed. Scores reset, flags go home, pickups
     are cleared and everyone respawns. The lobby list shows the map currently being played.

### MVP

Each player tracks their own best highlight of the round and publishes it with their stats:

| Highlight | Score |
| --- | --- |
| Multi-kill: each kill within 4 s of the last (Double / Triple / Quad Kill / Rampage) | 10 × kills² |
| Flag capture (CTF), plus 25 for each kill made while carrying | 60 + 25 per kill |
| Killing the enemy flag carrier | 35 |
| Streak of 5+ kills without dying | 8 per kill |
| Any kill (headshot) | 5 (15) |

The MVP has the best highlight score plus 0.3 × (kills × 4 + captures × 25 + damage ÷ 40). The client that
ends the round picks the MVP and the next map, and stores them in the round record, so everyone shows the
same ones.

The replay works because every client records the round as it plays: everyone's positions about 10 times a
second, plus shots, kills, grenades and flag moves. When the MVP screen starts, it replays the highlight from
1.5 s before to 1.5 s after with stand-in avatars, tracers, grenades and carried flags, under a chase camera.
A player who joined after the highlight sees a slow fly-around of the map instead. Highlights longer than
9 s play faster to fit.

Round times use the Firebase server clock (`.info/serverTimeOffset`), so every client moves through the
screens together.

Limits and team colors are in `src/game/modes.ts`.

## Maps

Every room gets its own arena, generated from a **seed**. The lobby shows a top-down preview of the map for the
current seed: press 🎲 for a new one, type a seed a friend shared to get the same map, or type `classic` for
the original hand-built arena (rooms made before seeds existed also use it). The pause menu and the Tab
summary show the room's map and seed.

- The seed picks a theme (Training Yard, Dust Bowl, Frostbite, Dusk Yard, Toxic Works: sky, floor and colors),
  a centerpiece and 10–16 pieces of cover (crates, low walls, pillars, climbable stacks, L-shaped corners).
- Maps are mirrored on both axes, so every spawn and both CTF bases face the same layout.
- Cover never blocks a spawn point or a flag base, and every gap between obstacles is at least 1.6 m wide,
  so no part of the floor can be sealed off.
- Generation is pure, seeded code (`src/game/mapgen.ts`), so every client builds the identical arena.

### Textures

Every texture is drawn in code when the game starts (`src/game/textures.ts`), so there are no image files.
They take a few hundred ms the first time and are cached after that. They use tileable noise so they repeat
without seams, and they tile at real-world scale instead of stretching across long walls.

| Theme | Floor | Walls | Pillars |
| --- | --- | --- | --- |
| Training Yard | tiles | concrete | corrugated metal |
| Dust Bowl | sand ripples | brick | concrete |
| Frostbite | snow | concrete | corrugated metal |
| Dusk Yard | cracked asphalt | brick | corrugated metal |
| Toxic Works | diamond plate | corrugated metal | concrete |

- Crates are wooden, with planks and a brace.
- The outer wall is concrete panels with grime at the bottom.
- The sky is a dome with a gradient and clouds.
- Spawn points have painted floor markers, and CTF bases have hazard stripes.
- The gun is worn metal and wood, grenades have a segmented shell, and pickups sit on metal pedestals.
- A map's surfaces come from its theme and piece types, never from the seed's random numbers, so adding
  textures didn't change any existing seed's layout.

## Damage direction

When you're hit, a red arc around the crosshair points toward where it came from: the shooter's position for
bullets, the explosion for grenades. Each attacker gets their own arc, which keeps pointing at that spot as you
turn, stays up for 0.6 s and fades over the next second. Bigger hits draw a thicker arc. It still shows when your
shield absorbs the damage.

## Sound

All sound is synthesized with Web Audio (no audio files), including footsteps:

- One step per stride while moving on the ground (faster and louder when sprinting), plus a thud when you land
  from a jump or a drop.
- Other players' steps fade with distance (silent beyond 35 m) and are panned left/right toward where they are,
  so you can hear someone coming.
- Each step layers a scuff, a heel click and a deep thud: a falling 55–75 Hz sine with a quiet octave above it
  (so laptop speakers still carry it) plus low, muffled noise. Landings go deeper and longer. All game sound
  runs through a limiter so stacked sounds don't distort.
- The sound depends on what's underfoot: hard floor, sand (Dust Bowl), snow (Frostbite), or hollow wood on top
  of a crate.

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim |
| Left click (hold) | Shoot (automatic) |
| Space | Jump |
| Shift | Sprint |
| Ctrl (hold) | Crouch; press while sprinting to slide |
| R | Reload |
| 1 / 2 / 3 | Use the ability in that slot |
| I | Inventory (details + drop items) |
| Tab (hold) | Match summary |
| Esc | Pause / switch team / leave room |

These are the defaults. **Settings** (in the lobby, or the pause menu) lets you change mouse sensitivity
(0.1×–4×), invert vertical look and rebind every key except shooting (left click) and Esc. Binding a key
that's already in use swaps the two. Settings are saved in your browser (`src/game/settings.ts`).

## Crouch and slide

- **Crouch** (hold Ctrl): lower eyes, a smaller hitbox, walking at about half speed, 40% tighter aim and much
  quieter footsteps. You stay crouched under anything too low to stand up under.
- **Slide** (press Ctrl while sprinting on the ground): a burst of up to 13 m/s along the way you're running
  that bleeds off over about 0.8 s (roughly 6 m), with the camera dipping and tilting, then you're
  crouching. You can't steer mid-slide, but jumping out of one keeps its speed. There's a 1.2 s cooldown.
- Other players see you crouch and slide, and hear the scrape of a slide. The model has no crouch
  animation, so `remotePlayer.ts` bends its legs in code and lowers the hips to keep the feet on the ground.
  Stance is also recorded for the MVP replay.

Crouch defaults to Ctrl. Holding Ctrl while pressing other keys would normally trigger browser shortcuts,
so the game guards against that while you're playing (see below). Players whose saved settings had the old
default, C, are moved to Ctrl; anyone who picked a key themselves keeps it.

## Ctrl+W / Cmd+W

Browsers normally don't let a page catch the close-tab shortcut, so the game uses two safeguards:

- **Keyboard Lock (Chrome, Edge, Opera):** "Click to play" also goes fullscreen and asks the browser for every
  bound key, plus W, T, N, Q, Tab and 1–9 (`navigator.keyboard.lock`). The game then receives Ctrl+W, Ctrl+T,
  Ctrl+1 (switch tab), Ctrl+Tab and Cmd+W itself and ignores them, so crouching never closes or switches the
  tab. Esc isn't locked, so it still releases the mouse and leaves fullscreen as usual. Turn off
  **Fullscreen while playing** in Settings to play windowed (and lose this protection).
- **Ctrl shortcuts a page can block** (Ctrl+S save, Ctrl+D bookmark, Ctrl+A, Ctrl+R, Ctrl+F...) are blocked
  while the mouse is captured, in every browser.
- **Mac:** Ctrl+click is a right-click there, so it counts as a normal shot, and the context menu is blocked
  while playing. macOS itself uses Ctrl+Space to switch input language, and no web page can intercept that.
  If you have more than one keyboard language, crouch-jumping may switch it; rebind crouch or jump if so.
- **"Leave site?" prompt (all browsers):** while you're in a room, closing or reloading the tab asks first.
  This is the only protection in Firefox and Safari, which don't support Keyboard Lock. Leaving through the
  menu doesn't prompt.

## Abilities

Ability pickups spawn at random open spots on the map (up to 6 at once). Walk over one to put it in your
first free slot (3 slots). Each ability has a number of uses and a cooldown; when its uses run out it removes
itself from the slot. Dying empties your slots.

Press **I** to open the inventory: it frees the mouse and lists each slot's uses and cooldown with a **Drop**
button. Dropped abilities land in front of you with their remaining uses, and anyone can pick them up.

| | Ability | Effect | Uses | Cooldown |
|---|---|---|---|---|
| 🩹 | Medkit | +50 HP (refused at full health) | 2 | 8 s |
| 🛡️ | Shield | Absorbs the next 50 damage for 8 s; others see a bubble | 2 | 15 s |
| ⚡ | Speed Boost | 1.6× movement for 5 s | 3 | 12 s |
| 💨 | Dash | Burst forward where you look | 4 | 3 s |
| 💣 | Grenade | Thrown arc, up to 90 damage in a 5 m radius, blocked by walls | 3 | 6 s |

All numbers live in `src/game/abilities.ts`.

- **Spawning:** the player with the lowest id keeps the map stocked; if they leave, the next one takes over.
- **Picking up:** claimed with a database transaction, so only one player gets a pickup even if two touch it at once.
- **Grenades:** every client simulates the same arc from the thrower's start position and velocity. The thrower
  decides who the blast hit (with a line-of-sight check) and the victims apply the damage, like rifle hits.

## Match summary

Hold **Tab** for the room name, match clock and every player's kills, deaths, K/D, damage dealt, accuracy,
headshots, best kill streak and ping, plus a "Your match" panel. Each player reports their own stats with their
position updates; damage dealt doesn't count overkill.

**Ping** is each player's round trip to the Firebase server, which every update between players passes
through. Each client times a small write until the server confirms it every 2 s, smooths it, and publishes it
in its player record. Green is under 80 ms, amber under 150 ms, red above. The delay between two players is
roughly their two pings added together.

## How it works

```
lobby/{code}               room name, mode, map seed, host, members (presence)
rooms/{code}/players/{id}  position, yaw/pitch, hp, alive, kills, deaths, team
rooms/{code}/events/{id}   'shot', 'kill', 'grenade', 'blast' events, auto-deleted after 3 s
rooms/{code}/pickups/{id}  abilities lying on the map
rooms/{code}/game          round number, map seed, start time, winner + MVP + next seed, scores, flags
```

- Each client sends its own position ~15×/s (only when it changes) and interpolates everyone else.
- Shooting is hitscan: the shooter raycasts locally against the map and other players' hitboxes,
  then publishes a `shot` event (tracer + who was hit). Body shots do 20, headshots 50.
- The victim applies the damage to itself, and on death publishes a `kill` event and credits the killer
  (via a transaction). Respawn after 3 s at the spawn point furthest from enemies.
- The `game` node is only ever changed with transactions (scoring, ending a round, taking / dropping /
  capturing flags), so two players can't both grab the same flag or both start the next round.
  The TDM victim scores the point for the killer's team; the FFA victim ends the round when crediting
  the killer's 25th kill. Sending abandoned flags home is done by the same "lowest id" player who spawns pickups.
- Presence uses `onDisconnect()`, so closing the tab removes you; empty rooms get cleaned up.

The game is **client-authoritative**, which is fine for playing with friends but means a modified client can cheat.
The included rules also allow anyone to read/write. For a public game you would add Firebase Auth
(e.g. anonymous sign-in), restrict writes to `auth.uid === $pid`, and validate hits server-side (Cloud Functions).

## Project layout

TypeScript (strict) + React for the UI, bundled by Vite. The 3D game itself is plain Three.js:
the engine runs its own render loop and publishes HUD state to a small store (`game/hudStore.ts`)
that React reads with `useSyncExternalStore`, so React never re-renders per frame.

`npm run typecheck` runs `tsc`; `npm run build` typechecks and then builds.

```
src/
  main.tsx           React entry
  types.ts           shared types: PlayerState, GameEvent, RoomSummary, ...
  ui/
    App.tsx          lobby <-> game screen switching
    Lobby.tsx        name, create / join / list rooms
    GameView.tsx     mounts the Game engine for the current room
    Hud.tsx          health, ammo, ability bar, kill feed, death / pause overlays
    InventoryPanel.tsx  inventory (I) with drop buttons
    MatchSummary.tsx    match summary (Tab)
    SettingsPanel.tsx   sensitivity + key binding editor
    MapPreview.tsx      top-down map preview in the lobby
  game/
    game.ts          game loop, shooting, damage, respawn, rendering
    hudStore.ts      engine -> React state bridge
    mapgen.ts        seeded map generator (layout + theme), and the classic map
    textures.ts      procedural textures (surfaces, floors, sky, props) + world-scale box UVs
    world.ts         turns a map layout into meshes, lighting, colliders, spawn points
    player.ts        first-person controller + collisions
    remotePlayer.ts  other players' avatars + interpolation
    nameTag.ts       name + health tag revealed to the shooter
    modes.ts         game modes, score + time limits, teams, flag bases
    moments.ts       tracks our highlights (multi-kills, flag runs, ...) for MVP
    replay.ts        records the round and replays the MVP's highlight
    flags.ts         CTF bases and flags (waving, carried, dropped)
    settings.ts      mouse sensitivity + key bindings (saved in localStorage)
    abilities.ts     ability definitions, tuning numbers, 3-slot inventory
    pickups.ts       ability pickups on the map
    grenades.ts      deterministic grenade arcs + explosion effects
    weapon.ts        viewmodel, ammo/reload/recoil, tracers & impacts
    audio.ts         synthesized sound effects (Web Audio), including footsteps per surface
    footsteps.ts     turns movement into footfalls and landings
    canvas.ts        helper for procedural textures
  net/
    firebase.ts      Firebase init (real project or emulator)
    network.ts       RoomConnection: presence, player sync, events, empty-room cleanup
```

## Assets

`public/models/Soldier.glb` is the soldier from the [three.js examples](https://github.com/mrdoob/three.js/tree/r186/examples/models/gltf)
(originally a [Mixamo](https://www.mixamo.com) character), with Idle / Walk / Run animations.
Other players use it; the rifle, hitboxes, aim lean, player-color tint and death fall are added in code
(`src/game/remotePlayer.ts`). To swap in another Mixamo-rigged model, keep the clip names
and the `mixamorigSpine2` / `mixamorigHead` / `mixamorigRightHand` bones.
