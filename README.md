<p align="center"><img src="public/brand/logo.svg" alt="Arena FPS logo" width="128"></p>

# Arena FPS

A multiplayer browser FPS built with **Three.js**, with realtime sync over **Firebase Realtime Database**.
Pick a name, create or join a room, and shoot each other in Free-for-all, Team Deathmatch or Capture the Flag.

## Lobby

- **Your name** is chosen once, on your first visit, and kept in the browser (`fps-name`); it can't be changed
  afterwards. It shows as "Playing as …" at the top, next to the ⚙ settings button. Names are 2–16 letters,
  numbers, spaces, `-` or `_`.
- **Open rooms** (the first tab) lists every room with its mode badge, mode, map, code and players. The search
  box filters by room name, code, mode, map, host or any player; type a code next to it to join directly, or
  press **＋ Create room**.
- **Create room**: pick a mode (see [Game modes](#game-modes)), a map seed, and a room name, then create it.
- **Leaderboard**: the global top 20.
- **Inside Discord** the lobby looks the same, with your Discord name as "Playing as …". Its tabs are **This
  channel** (the voice channel's match: join it if it's running, otherwise pick a mode and map and start it),
  **Open rooms** (every other room, with the same search and room-code join) and **Leaderboard**.

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

### Deploying the database rules

`.github/workflows/database-rules.yml` handles the rules:

- **On every pull request and push that changes them**, `npm run test:rules` starts the database emulator and
  checks `database.rules.json` against writes the game makes (must be allowed) and writes a cheater would try
  (must be refused): leaderboard scores that don't match the formula, too many kills in a round, bad profile
  or server ids, unknown paths. Run it locally the same way; it needs Java, like the emulator.
- **On a push to `main`** (or a manual run from the Actions tab), once the tests pass, it deploys the rules to
  the project in `.firebaserc` with `npm run deploy:rules`. Deploys run one at a time.

One-time setup:

1. In Google Cloud (**IAM & Admin → Service accounts**, same project as Firebase), create a service account
   with the **Firebase Realtime Database Admin** role, and add a JSON key to it.
2. On GitHub, **Settings → Secrets and variables → Actions**, add the key's whole JSON as
   `FIREBASE_SERVICE_ACCOUNT`. The deploy job runs in the `production` environment, so you can also put the
   secret there and require an approval before each deploy.
3. If a deploy fails with a permission error about checking enabled APIs, also give the account the
   **Service Usage Consumer** role.

### End-to-end tests

`e2e/` holds Playwright tests that play the game in real browsers against the database emulator. They cover:

- the lobby: name, rooms, search, join by code, invites, every preset mode, custom modes, settings and the leaderboard
- matches: joining and leaving, movement, shooting and damage, kills and respawns
- each mode's rules, scoring and round ends, team play and flags
- pickups, abilities and deployables, spectating, connection loss, touch controls and the Discord launch

```bash
npm run test:e2e        # starts the emulator, the game (vite --mode e2e) and the tests
npm run test:e2e:ui     # the same in Playwright's UI mode, to watch and step through them
```

Run `npx playwright install chromium` once first. It needs Java, like the emulator. If an emulator is already
running on :9000 (from `npm run emulator`), `firebase emulators:exec` can't start another. Run
`npx playwright test` instead (optionally `-g "<test name>"`) and it uses the running one.

How they work:

- **No GPU needed.** Chromium renders WebGL in software (SwiftShader). The tests seed `fps-settings` with low
  quality and no sound, and the sound files are stubbed out.
- **`vite --mode e2e`** reads `.env.e2e`. It points the game at the emulator and sets `VITE_E2E`, which
  exposes the running game as `window.game`, as dev builds already do. Production builds never set it.
- **`game.test`** (in `game.ts`) stands in for what headless browsers can't do reliably: pointer lock and
  mouse aiming. `play()` starts taking input, `aimAt(id, 'head')` + `fire()` shoot, and `teleport()`
  moves a player. `state()` reads health, kills, team, flags and more. Everything else goes through the real
  inputs: keys, the menus and the network.
- **Rooms are written straight into the database** (`e2e/support/db.ts`) with exact rules, and pickups are
  off unless a test turns them on. Each test deletes its rooms afterwards, so tests run in parallel.
- **The `duel` fixture** (`e2e/support/fixtures.ts`) gives a test two players, Alice and Bob, in their own
  browser contexts. They face each other 8 m apart on the classic map, ready to play:

```ts
test('a headshot takes 50', async ({ duel }) => {
  const { alice, bob } = await duel(rules('ffa'));
  await alice.shoot(bob, { part: 'head' });
  await expect.poll(async () => (await bob.state()).hp).toBe(50);
});
```

Wait on state, not on time. Frame rates are low in software rendering and the game caps each frame's time
step, so game time runs slower than the wall clock. Use `expect.poll`, and compare speeds and heights rather
than distances. Round clocks run on the server's time: `expireClock()` moves a round's start back instead of
waiting it out.

`.github/workflows/e2e.yml` runs them on pull requests and pushes that change the game. On failure it uploads
the HTML report, with traces and videos.

## Game modes

Every mode is one of three **base types**, which decide teams, flags and how points are scored, plus a set of
**rules** on top. The room's creator picks a mode in the lobby; the room list shows its badge and name.

| Base | Goal | Default time limit | Or ends early at |
| --- | --- | --- | --- |
| **FFA** — Free-for-all | Most kills | 8 min | 25 kills by one player |
| **TDM** — Team Deathmatch | Red vs Blue; every kill scores for the killer's team | 10 min | 50 team kills |
| **CTF** — Capture the Flag | Grab the enemy flag and bring it to your own base | 12 min | 3 captures |

**Rules** (`src/game/rules.ts`), all optional on top of the base:

| Rule | Options |
| --- | --- |
| Loadout | Standard (rifle + pickups), Rifles / Shotguns / Snipers / Deagles only (endless ammo, no other guns or ammo boxes), or the Gun Game ladder (FFA only) |
| Pickups | Gun pickups, ammo boxes, abilities: each on or off |
| Headshots only | Body hits do nothing; grenades don't spawn |
| Score limit | FFA 5–60 kills, TDM 10–150 team kills, CTF 1–10 captures |
| Time limit | 3–20 minutes |
| Health | 25–200 HP (medkits heal up to it, the health bar and name tags scale to it) |
| Respawn | 1–10 seconds |
| Speed / gravity | 70–150 % movement speed, 30–150 % gravity (low gravity = higher, floatier jumps) |

**Prebuilt modes:**

| Badge | Mode | Base | What's different |
| --- | --- | --- | --- |
| FFA / TDM / CTF | Free-for-all, Team Deathmatch, Capture the Flag | – | The plain base modes |
| GG | Gun Game | FFA | Every kill hands you the next gun on a 12-step ladder; first through it wins. No pickups |
| SNP | Sniper Only | FFA | Snipers only, 20 kills |
| SNT | Sniper TDM | TDM | Snipers only, 40 team kills |
| SNF | Sniper Flags | CTF | Snipers only |
| SHG | Shotgun Brawl | FFA | Shotguns only, 110 % speed |
| DGL | Hand Cannons | FFA | Deagles only |
| HS | Headhunter | FFA | Headshots only, 15 kills |
| HC | Hardcore TDM | TDM | 50 HP, no abilities, 6 s respawn, 40 team kills |
| TNK | Tank CTF | CTF | 200 HP, 90 % speed |
| MOON | Moon Gravity | FFA | 35 % gravity, 110 % speed |
| SPD | Speed Rush | FFA | 145 % speed, 1 s respawn, 30 kills |

**Custom modes:** **＋ Create custom mode** in the lobby opens an editor: pick the base, name it (and a badge of
up to 4 letters), set every rule, and see a live description. **Use once** plays it in the room you create;
**Save & use** also keeps it under your modes (in this browser, up to 12; ✎ edits, ✕ deletes). The Discord
lobby has the same picker. A room's rules are stored with it (`lobby/{code}/rules`, checked by the database
rules), so everyone who joins plays the same; rooms made before custom modes keep working (their old mode
names map to the matching prebuilt mode).

- **Kills heal:** every kill gives back half of your full health (+50 HP normally, +25 in a 50 HP mode, +100
  at 200 HP), never above full. A green "+50 HP" floats up from the health panel.
- **The lead (free-for-all modes):** when someone pulls clear at the top, everyone hears about it. Taking the
  lead puts **YOU TOOK THE LEAD** on screen with a rising stinger; losing it shows **LEAD LOST — Name took the
  lead** with a falling one; a change between other players is a 👑 line in the kill feed. A tie at the top
  doesn't count until someone pulls ahead again. While you lead, the score bar shows 👑 and your score in gold.
- **Teams:** you join the smaller team. Every player's uniform takes their team colour (65%, with a faint glow
  and a glowing visor, so teams stay readable in shadow). Teammates' names show whenever they're in sight, and a
  teammate hidden behind cover is drawn over the walls as just a flat 2D silhouette of their character (same pose
  and animation, gun included) in team colour (`src/game/xray.ts`; enemies are never shown through walls),
  bullets and grenades pass through them, and you spawn on your own half (red owns +z, blue −z).
  The pause menu (Esc) has a **Switch team** button.
- **Capture the Flag:** each base is a glowing pad near the back wall with the team's flag on it.
  Walk over the enemy flag to take it, then walk onto your own base to score — only while your own flag is home.
  **While you carry the flag your guns and grenades are stowed: the flag is your only weapon.** Click (or ●)
  to swing it: 55 damage, 80 to the head, 2.4 m reach, one swing every 0.7 s, so two hits take most people down.
  Swings are forgiving to aim (a fan of short rays across your view) but walls block them. Other players see
  the carrier holding the flag upright in their right hand (gun gone) and the swing as an arm strike, and the kill feed shows ⚑ for flag kills.
  The flag is swung with the right arm, so others see it tip back over the carrier's shoulder and chop forward.
  **E** (or the ✋ Drop flag button on touch screens) puts the flag down just in front of you: pass it to a
  teammate, or get your guns back. You won't pick it straight back up until you step away from it.
  A carrier who dies (or switches team, or leaves) drops the flag where they stood. Touch your own dropped flag
  to send it home; otherwise it returns by itself after 20 s. The score bar shows where both flags are.
- **Rounds:** the score bar shows the round clock, which turns red in the last 30 s. When the time runs out,
  the best score wins; a tie is a draw. A score limit ends the round early. Then:
  1. **Results** (6 s): the winner, why the round ended, and the top three.
  2. **MVP** (10 s): a replay of the MVP's highlight, seen through their eyes, with their card and the next
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
1.5 s before to 1.5 s after with stand-in avatars, tracers, grenades and carried flags, seen in first person through the MVP's eyes (their gun in view, raised when they aimed, flashing when they fired).
A player who joined after the highlight sees a slow fly-around of the map instead. Highlights longer than
9 s play faster to fit.

Round times use the Firebase server clock (`.info/serverTimeOffset`), so every client moves through the
screens together.

Limits and team colors are in `src/game/modes.ts`.

## Maps

Every room gets its own map, generated from a **seed** and a **size** (Small, Medium or Large). The lobby
shows a 3D preview of the map for the current seed (it slowly turns; drag to turn it yourself): press 🎲 for a
new one, type a seed a friend shared to get the same map, or type `classic` for the original hand-built arena
(rooms made before seeds existed also use it). The map's name ("Red Cut · Quarry") depends only on the seed,
so it stays the same at every size. The pause menu and the Tab summary show the room's map, seed and size.

### How a map is made

Generation is pure, seeded code in `src/game/mapgen/` (no three.js), run in a Web Worker so the page never
stalls (`client.ts`; it falls back to the page if workers are blocked). Every client builds the same map from
the room's map spec: seed, size and generator version. The pipeline (`generate.ts`):

1. **Meta**: the seed picks a biome, a theme and a name (cheap, so the room list names maps without building them).
2. **Lane graph** (`graph.ts`): two bases, two or three **lanes** from each base to the middle line, swinging
   side to side so no stretch runs straight for long, with a **chokepoint** on each, **connectors** between
   neighbouring lanes, **overlooks** beside some lanes and a **middle** (plaza, hill or sunken). Only red's half
   is designed; blue's is its copy under the map's **symmetry**: a half turn (most maps: both teams get the
   same left and right) or a mirror. Lanes meet the middle line at fixed points, so every route has a twin of
   the same length on the other side.
3. **Terrain** (`terrain.ts`): the land is shaped from the design. Lanes are valleys, the bases sit on plateaus
   walled in by ridges, the ridges between lanes stand taller than eye height so each lane is hidden from the
   others, lanes get crests you can't see over from the dip either side, and a rim rises along the walls.
   Pinned heights (plateaus, lane floors, the pad under every structure) are kept exactly and no slope is
   steeper than you can walk (~40° at most, under the 55° you can climb).
4. **Dressing** (`dress.ts`, kits in `kits.ts`, biomes in `biomes.ts`): structures on flat pads first (the
   middle's landmark, overlook platforms with a ramp and a parapet, footbridges over chokes, buildings and big
   models on the ridges, houses with a ramp up to a walkable roof, a raised post at each base), then cover
   along every lane at a steady rhythm (alternating sides, never in the lane's middle strip), landing cover past
   each choke, cover round the middle and the bases, and rocks, trees or buildings on the ridges.
5. **Sightlines** (`sightlines.ts`): long sightlines along each lane (base to base), at the flags from the
   enemy half and at the spawns are measured, and the worst get a tall piece of cover across them.
6. **Checks** (`validate.ts`, `navgrid.ts`): on a layered walk grid sized to the player (`playerDims.ts`), every
   spawn, both flags, every pickup spot, door, platform top and bridge must be reachable, and a carrier must be
   able to get home; slopes must be walkable and the halves exact copies. A map that fails is rebuilt from the
   next roll of the seed.

| Biome | Themes | What's in it |
| --- | --- | --- |
| **Quarry** | Dust Bowl, Training Yard | Deep canyon lanes between rocky ridges, a water tower derrick or a gantry in the middle, containers you climb, sandbags, rocks |
| **Old Town** | Training Yard, Dusk Yard, Frostbite, Dust Bowl | Low ridges lined with shops and houses facing the streets, a clock tower or a fountain, houses with walkable roofs, lamps, barriers, dumpsters |
| **Highlands** | Greenwood, Frostbite | Rolling ridges with forests on top (canopies stop bullets, you walk under them), a fire lookout or standing stones, cabins, logs, tents |
| **Refinery** | Toxic Works, Dusk Yard, Training Yard | Factories, chimneys and tanks on the ridges, a tank farm or a gantry in the middle, barrels, pallets, containers, catwalk platforms |

- **Sizes**: Small 80 m across (usually two lanes, 6 spawns a team), Medium 108 m, Large 140 m (three lanes,
  10 spawns a team).
- **Buildings** (`kits.ts`) are made of boxes, so they collide, stop bullets and show on the preview. Doors are
  at least 2 m wide; windows have a 1 m sill and are 1 m tall, so you shoot through them but can't climb through.
- **Models** (shops, houses, factories, street lights, trees, rocks...) are Kenney CC0 kits converted into one
  file (`public/models/props.glb`, see Assets). They're only looks: each comes with invisible boxes the
  generator places with it, and those are what players, bullets and grenades hit. Off-centre boxes are
  re-placed with their model in the other half (models are turned there, not reflected). Round tanks and
  barrels collide as an eight-sided shape inside the cylinder, and bullets hit the cylinder itself.
- **Ramps** (`src/game/ramps.ts`) are real slopes, at most 1 m up per 2 m along.
- **The ground** is one heightfield (`mapgen/heightField.ts`): the drawn floor, the physics engine's heightfield
  collider and the generator's checks all use the same triangles, so what you see is what you stand on.
  Turrets and barriers on a hillside are set into the slope; on ground too steep they're refused.
- **Pickups** appear at spots the map sets aside (along the lanes, the middle, the connectors, the foot of
  overlook ramps) before anywhere else.
- **Versions**: rooms store the generator version (`GENERATOR_VERSION` in `mapgen/index.ts`) with the seed and
  size. A client on another version can't join (the room list marks the room "Older version" or "Newer
  version"), since it would build a different map. The first client to build a round's map records its
  fingerprint in the round record, and anyone who builds a different one is told. Bump the version whenever
  any seed's map changes; CI fails if a map changes without it (golden hashes in `mapgen/golden.json`).
- **Determinism**: the generator uses its own seeded RNG (`rng.ts`), Fisher-Yates shuffles, and only maths that
  every browser engine computes identically (no `Math.sin`, `Math.hypot`...; `npm run check:maps` fails if any
  creep in).
- `npm run check:maps` builds hundreds of maps per size and reports failures, how many rolls each took,
  sightlines, clutter and timing; `--dump SEED` writes a top-down picture of a map (with its worst sightlines)
  to `node_modules/.cache/maps/`. `npm test` runs the unit tests (`vitest`), including one that checks the
  physics heightfield against the generator's ground.
- Footsteps follow what you stand on: wood on floorboards and crates, metal and concrete on catwalks,
  containers and decks, otherwise the map's floor.
- Boxes are merged into a few meshes per texture and models are instanced, so a map draws in a few dozen calls.

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
| Greenwood | grass | planks | rock |

Buildings, containers and platforms add their own: plaster and brick walls, floorboards, container steel and
rock. Lanes are painted with dirt or concrete blended into the floor, steep slopes look rocky, and hollows are
shaded darker than crests. Yards, plazas and hazard stripes are flat patches drawn over flat pads.

- Crates are wooden, with planks and a brace.
- The outer wall is concrete panels with grime at the bottom.
- Above the outer wall, an invisible boundary (200 m tall) keeps players, bodies and grenades inside the map;
  bullets still fly out. If anything still puts you outside, you're moved back to the edge.
- The sky is a dome with a gradient and clouds.
- Spawn points have painted floor markers, and CTF bases have hazard stripes.
- The gun is worn metal and wood, grenades have a segmented shell, and pickups sit on metal pedestals.
- A map's surfaces come from its theme and piece types, never from the seed's random numbers, so adding
  textures didn't change any existing seed's layout.

## Damage direction and hit feedback

When you're hit, a red arc around the crosshair points toward where it came from: the shooter's position for
bullets, the explosion for grenades. Each attacker gets their own arc, which keeps pointing at that spot as you
turn, stays up for 0.6 s and fades over the next second. Bigger hits draw a thicker arc. It still shows when your
shield absorbs the damage.

Hits also shake the camera for about half a second, harder for bigger hits (off in Settings → Screen shake).
At 30 health or less the edges of the screen darken red and pulse, and a heartbeat plays, both faster and
heavier the closer to death you are.

## Announcer and music

Multi-kills (two kills within 4 s of each other) put a **DOUBLE / TRIPLE / QUAD KILL / RAMPAGE** banner on
screen with a stinger that gets bigger up the ladder; every fifth kill of a streak calls out the streak. Rounds
start and end with short jingles (separate ones for a win, a loss and a draw). In the last 30 seconds of a round
a dark ambient loop fades in, speeding up slightly and getting louder as the clock runs out. Effects and music
have separate volume sliders in Settings.

## Sound

All sound is recorded audio: 54 short clips in `public/sounds/` (about 1.1 MB, mono MP3 except the music loop),
loaded once when you first join and played through Web Audio by `src/game/audio.ts`. A sound asked for before
its clip has loaded is skipped, and every sound runs through a limiter so stacked sounds don't distort.

- **Guns:** a real recording per gun (rifle, shotgun, sniper, pistol), cut to its first shot. Distant shots and
  explosions are quieter and muffled (low-passed), the way far-off gunfire loses its crack.
- **Footsteps:** five takes per surface, picked at random with a little pitch variation so they don't repeat.
  Hard floor, sand (Dust Bowl), snow (Frostbite) or hollow wood on top of a crate each have their own takes.
  Snow uses Kenney's carpet steps, low-passed and a little quieter: soft packed snow rather than a crunch.
  The low end is boosted so steps have weight, and landings play slower, deeper and louder.
- Other players' steps fade with distance (silent beyond 35 m) and are panned left/right toward where they are,
  so you can hear someone coming.
- **Reloads:** each gun has its own, laid out to finish inside its reload time: the rifle's magazine out, in and
  charging handle; the pistol's magazine drop, insert and slide; three shells into the shotgun then the pump; the
  sniper's bolt, a clip and rounds, then the bolt again. Other players' reloads match the gun they hold.
- Gun switches, hit markers (head and body differ), getting hit, melee, slides, pickups, abilities and
  the low-health heartbeat are recordings too.

To swap a sound, replace its file in `public/sounds/` (same name) or change the name in `audio.ts`. Where every
sound comes from and its license is listed under [Credits](#credits).

## Discord Activity

The same build also runs as a Discord Activity: players launch it from a voice channel and play inside
Discord, with no website to visit.

- Everyone in the same voice channel shares one match; the room code comes from Discord's instance id.
  The first player picks the mode and starts; the rest press **Join match**.
- Players are signed in with Discord (`identify` scope only) and use their Discord display name.
- Works on desktop and in Discord's mobile apps (touch controls, landscape).

### How it works

- **Proxy rewrites:** Discord only lets an Activity reach the internet through its proxy, using the URL
  mappings below. `src/discord/patch.ts` is imported first and rewrites requests onto those mappings.
  It must come first because Firebase captures the `WebSocket` constructor as soon as it loads.
  Firebase sometimes reconnects to a "shard" server whose name can't be known in advance, so those
  connections are sent back to the database's main host, which serves the same data.
- **Sign-in:** the Discord client hands over a one-time code, and `netlify/functions/discord-token.mjs`
  trades it for an access token. That step needs the app's client secret, so it runs on Netlify, never in
  the browser.
- **Differences inside Discord:** no fullscreen, key lock or "Leave site?" prompt. If Discord refuses mouse
  capture (pointer lock), aiming falls back to a hidden free cursor; looking around then stops at the edge
  of the window. Esc pauses.

### Setup

1. **Create the app:** in the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application.
2. **OAuth2:** add the redirect `https://127.0.0.1` (Discord requires one; the SDK doesn't use it). Note
   the **Client ID** and **Client Secret**.
3. **Installation:** enable **User Install** and **Guild Install**.
4. **Activities → URL Mappings:**

   | Prefix | Target |
   | --- | --- |
   | `/` | `shootup-arena-fps.netlify.app` |
   | `/firebase` | `arena-fps-asia-wezlh-default-rtdb.asia-southeast1.firebasedatabase.app` |
   | `/api` | `shootup-arena-fps.netlify.app/.netlify/functions` |

5. **Activities → Settings:** enable Activities. This creates the "Launch" command.
6. **Client ID in the build:** put `VITE_DISCORD_CLIENT_ID=<client id>` in `.env`. It's public.
7. **Secrets on Netlify:** set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` in the site's environment
   variables. Never put the secret in `.env` or in the code.
8. **Deploy:** run `npm run build && npx netlify-cli deploy --prod --dir dist --functions netlify/functions`.
9. **Launch:** in Discord, turn on Developer Mode (User Settings → Advanced), join a voice channel, open the
   Activity launcher and start the game. Until the app is verified, only you and members of its developer
   team can see it.

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim |
| Left click (hold) | Shoot (automatic) |
| Right click (hold) | Aim down sights |
| Space | Jump |
| Shift | Sprint |
| Ctrl (hold) | Crouch; press while sprinting to slide |
| R | Reload |
| Q / mouse wheel | Switch between the rifle and a picked-up gun |
| V | Knife: a quick slash at arm's length, 50 damage a hit |
| 1 / 2 / 3 | Use the ability in that slot |
| I | Inventory (details + drop items) |
| Tab (hold) | Match summary |
| Esc | Pause / switch team / spectate / leave room |

### Settings

The ⚙ panel (lobby or pause menu) is split into tabs: **Controls** (mouse / look and key bindings), **Video**
(display and crosshair), **Audio** and **Accessibility**; it reopens on the last tab you used. Altogether it has mouse sensitivity, aim sensitivity and aim toggle, invert Y, fullscreen,
**field of view** (60–110°), **graphics quality** (Low: no shadows and a 1× resolution cap; Medium: soft
shadows at native resolution; High: sharp shadows, up to 2×; phones default to Low), an **FPS counter** in the
top-right corner (on by default; green at 50+, yellow at 30+, red below), **V-Sync** and **Max FPS** (30 / 60 /
120 / 144 / 165 / 240 / Unlimited; see below), **crosshair colour and
size** (with a live preview), sound effects and music volume, screen shake, **reduce motion** (System / On /
Off: no pulsing, zooming or camera shake; "System" follows the OS setting), **HUD size** (80–140 %; panels grow
from the corner they're pinned to), a button to show the one-time tips again, and every key binding (hidden on
touch screens, where the mouse section becomes "Look"). Settings are saved in the browser.

**Frame rate** (`src/game/frameLoop.ts`). Browsers always put frames on screen at the display's refresh rate,
so V-Sync here decides when the game runs its update + render, not what the monitor shows:

- **V-Sync on:** one frame per screen refresh (`requestAnimationFrame`), or fewer if Max FPS is lower.
- **V-Sync off** (the default on computers): the next frame starts as soon as the last one is done, using a
  `MessageChannel` task (not clamped to 4 ms like `setTimeout`), up to Max FPS. Input is read and the world
  updated more often, so what's on screen at each refresh is fresher; it uses more power.
- **Max FPS** defaults to Unlimited. Phones default to V-Sync on so they don't run hot.
- A hidden tab always falls back to `requestAnimationFrame`, which the browser pauses, so an uncapped game
  doesn't burn the CPU in the background. The FPS counter counts the game's own frames.

### Leaderboards

There are two boards with the same columns:

- **Global**: everyone who has played, wherever they played (browser or Discord).
- **This server**: only rounds played in the Activity inside one Discord server. A round played there counts
  on both boards. The Discord lobby's Leaderboard tab opens on the server board and has a 🌍 Global /
  🏠 This server switch; outside a server (the browser, or an Activity in a DM) only the global board shows.
  The server is told apart by its id (`sdk.guildId`), which needs no extra Discord permission; that's also
  why the tab says "This server" instead of the server's name. Server boards start empty, so earlier rounds
  only count globally.

Each lists the **top 20 players**, live: score, K/D and wins, with medals for the top three and your own row
highlighted (or shown underneath if you're not in the top 20).

- Every **finished round** you played in adds your kills, deaths and flag captures, plus a win if your side
  (or you, in FFA / Gun Game) won. Spectators and players who joined during the results aren't counted, and
  a round is never counted twice.
- **Score = kills × 10 + captures × 30 + wins × 50.**
- Your identity is a random id saved in the browser (`fps-profile`), or your Discord account inside Discord,
  so the name shown is the one you last played with.
- Stored at `leaderboard/{profileId}` and `guildboard/{guildId}/{profileId}` (`src/net/leaderboard.ts`); the same
  rules guard both. Like the rest of the game the numbers are
  reported by each player, so the database rules limit what one round can add (≤ 100 kills / deaths, ≤ 10
  captures, ≤ 1 win, exactly one round) and check the score matches the formula. That stops casual editing,
  not a determined cheater.

### Menu (Esc)

Esc opens the menu. The left side shows what's going on: the mode and its goal, the round clock and score, a
status line ("You're alive — the match is still running", "Dead — respawning in 2", "Round over — next map in
5", "Spectating"), a thumbnail of the current map with its seed and the player count, and the room code with a
**Copy invite link** button. The right side has Resume, Spectate, Switch team, Settings, Leave room (leaves
straight away) and the key list with your own bindings. Clicking the dimmed backdrop resumes; clicking the card
doesn't. The match keeps running while the menu is open. Round results and the MVP replay stay visible
(dimmed) behind it, so a late joiner sees what's happening.

### Feedback and tips

- The first click to play shows the mode's name and goal. One-time tips appear as you meet mechanics: the first
  sprint (slide), each ability you pick up (what it does and its key), the first gun pickup (how to switch),
  the first aim down sights, and the first time your slots are full. They're remembered in the browser
  (`fps-hints`); Settings can reset them.
- Toasts queue up (three deep, no repeats) instead of overwriting each other, and show while spectating and
  during the MVP replay.
- The death screen says who got you, with what and whether it was a headshot ("You took yourself out" for your
  own grenade), and whether your gun and abilities dropped where you fell. Respawning flashes the screen edges.
- **Kill cam.** Killed by another player (or bot), you first watch the last 3.5 s before the kill and 1 s after
  through the killer's eyes: their gun, their aim, your own body going down, with letterbox bars and a card
  saying who and with what. The respawn timer runs underneath; you're back once both are done, so the cam can
  add a little to a short respawn. **Space** (the jump key), a click or the **Skip** button ends it early, back
  to the death screen (or straight in if the timer's already up). It's skipped for your own doing, turret kills,
  the end of a round, and killers there's no recording of (they just joined). Turn it off in Settings → Video
  → Kill cam. It's the MVP replay's machinery (`ReplayDirector`) pointed at your killer, played in real time
  as the recording catches up.
- Pressing an empty ability slot or one on cooldown says so (and shakes the slot). The ammo panel shows
  "R TO RELOAD", "NO AMMO — FIND A BOX" or "LOW AMMO" under the count.
- In CTF, taking, losing, capturing and returning flags get centre-screen banners, and a dropped flag's icon
  counts down to its return.
- A "Waiting for players" banner with a Copy invite button shows while you're alone; "Reconnecting…" shows
  when the connection to the server drops; "Connecting…" offers a way back to the lobby after 10 s.

### Invite links

The pause menu's **Copy invite link** copies `…/?room=CODE` (on phones it opens the share sheet). Opening it
shows "Joining CODE…" with a two-second countdown, **Join now** and **Stay in the lobby**; someone without a
name yet picks one first, then joins. If the room has closed,
the lobby says so and offers to create a new one. `#CODE` links keep working, and Discord's 10-character codes
fit too.

### Spectating

**Spectate** in the pause menu takes you out of the match: your body disappears, you can't be hit, you're
listed as spectating in the summary and left out of the standings and the MVP pick. The camera follows a
player in first person, through their eyes: you see what they see, with their gun in view (raised and zoomed
when they aim, flashing when they fire), and their body hidden. Left click goes to the next player, right click
to the previous. With nobody to follow you get a free camera (move keys to fly, E or jump up, crouch down,
sprint for speed), which hands back to first person as soon as someone is alive. **Back to the fight** respawns you.

These are the defaults. **Settings** (in the lobby, or the pause menu) lets you change mouse sensitivity
(0.1×–4×), invert vertical look and rebind every key except shooting (left click) and Esc. Binding a key
that's already in use swaps the two. Settings are saved in your browser (`src/game/settings.ts`).

## Phones and tablets

On a touch device the game switches to on-screen controls and plays in landscape:

- **Move:** put your left thumb anywhere on the left side; a stick appears under it. Push it all the way
  forward to sprint.
- **Look:** drag anywhere on the right side.
- **Buttons:** ● fire (drag on it to keep aiming while you shoot), ◎ aim down sights (toggle), ⤒ jump,
  ⤓ crouch (toggle; tap while sprinting to slide, and you stand back up when the slide ends), ↻ reload.
  Tap an ability slot to use it. ☰ toggles the scoreboard (it has a Close button), 🎒 opens the inventory and
  ❚❚ opens the menu.
- The first time you play on a touch screen, a guide labels every button in place; the menu's **Controls
  guide** button brings it back.
- Several fingers work at once (move, look and shoot together).
- **Landscape:**
  - Android browsers go fullscreen and lock to landscape when you tap to play.
  - iOS doesn't let web pages lock orientation, so a "rotate your device" screen covers the game in
    portrait.
  - Inside Discord's mobile app, the Activity's Phone and Tablet orientation settings are set to Landscape,
    and iOS and Android are enabled under Supported Platforms.
- On phones the game renders at a slightly lower resolution, pinch / double-tap zoom is disabled, and
  overlays get compact on short screens.
- Add `?touch` to the URL to try the touch layout with a mouse on a desktop.

## Guns

You always carry the **rifle**. Three more guns lie around the map as glowing pickups (up to 3 at a time,
stocked separately from abilities) and go into a second slot when you stand on one and press **E**:

| | Gun | Fire | Damage body / head | Magazine + spare | Notes |
| --- | --- | --- | --- | --- | --- |
| ▸ | Rifle | Automatic, 10/s | 20 / 50 | 30 + 90 | Falls off from 25 m to 60% at 65 m; ammo boxes refill it |
| 💥 | Shotgun | Pump, 9 pellets | 12 / 18 per pellet | 6 + 12 | Falls off from 7 m to 25% at 28 m; ~100+ up close |
| 🎯 | Sniper | Bolt action | 75 / 150 | 5 + 10 | Scope zooms to an 18° view; wild from the hip; falls off from 80 m to 80% at 160 m (a headshot still kills) |
| 🔫 | Deagle | Semi-auto | 40 / 90 | 7 + 21 | Heavy recoil; falls off from 15 m to 50% at 45 m |

**Knife.** Everyone always has one: **V** (rebindable as "Knife"; 🔪 on touch screens) slashes at the nearest
enemy within 2.2 m in front of you for a flat **50 damage**, head or body (it still counts in headshots-only
modes), so two hits kill from full health. The gun drops while the knife cuts across the view (about 0.4 s; a
reload in progress is abandoned), and you can slash again 0.6 s after the last one. Walls block it. Others see
your free hand cut across with the knife, the kill feed shows 🔪, and bots knife back when you get in their face.
Carrying the flag, **V** swings the flag instead. It goes out as a `melee` event with `w: 'knife'`; whoever is hit
caps the damage at 50.

Damage falloff is per bullet (or pellet), from the distance the shot travelled: full damage up close, fading
linearly to a fraction of it at long range, so each gun has a range it's best at (`falloff` in `src/game/guns.ts`).

- Switch with **Q** or the mouse wheel (or the ⇄ button on touch screens). The ammo panel shows both slots,
  the magazine and the spare rounds.
- Guns are never picked up just by walking over them: standing on one shows a prompt, and **E** (rebindable as
  "Pick up / swap gun, drop flag"; on touch screens the prompt is the button) takes it. You carry one picked-up gun at a
  time, so **E** on a different gun swaps them: yours goes down on that spot with the rounds it had left, and
  you won't be offered it back until you step off it. **E** on the same gun adds its ammo. You can still drop
  your gun from the inventory (**I**, or 🎒). Ammo boxes and abilities are still picked up by walking over them. When a picked-up gun runs completely dry you go back to the rifle. When you die it drops next to your body
  with the ammo it had left.
- Molotovs and flashbangs follow the same arc on every client (like grenades and smoke), so everyone sees them land in the
  same place; each client works out for itself whether it's standing in fire or was blinded. Turrets are run by their
  owner's client, which sends their shots like any other (`tur` names the turret, so others see its head swing).
  Land mines too: the owner's client watches for enemies stepping near and sends an ordinary `blast` marked `mine`.
  Barriers and turrets have health. The shot or blast that hits one carries the damage (`dep`, by id), and every
  client applies it, so they darken, flash and break at the same moment everywhere. Only enemies of the owner
  can damage them (not the owner, not teammates); each client caps the damage at what that shot or blast could do.
  None of the effects add lights to the scene, so they can't cause the shader-recompile hitch grenades used to.
- Each gun has its own 3D model (an AK rifle, a pump shotgun, a scoped bolt-action sniper and a big pistol, from
  Quaternius's CC0 [Ultimate Gun Pack](https://opengameart.org/content/low-poly-guns-pack)), iron sights or scope, aimed field of view, spread, recoil and recorded
  report. Other players see the gun you're holding, and the kill feed shows which gun got the kill.
- Shotgun shots are sent as one event carrying every pellet's end point and the damage per player hit;
  each client still caps incoming damage at what that gun can deal in one shot.
- **Ammo:** the rifle has 90 spare rounds. **Ammo boxes** (up to 3 on the map, stocked like guns and
  abilities) refill the rifle's spares and add a magazine to your picked-up gun; walking over one with full
  ammo leaves it there. When your rifle runs dry and your other gun has rounds, you switch to it
  automatically; with nothing left to shoot, a toast points you at the ammo boxes. In Gun Game every gun has
  endless ammo.
- All gun numbers live in `src/game/guns.ts`.

## Aim down sights

Hold right-click (or turn on **Toggle aim** in Settings) to raise the rifle's iron sights:

- The view zooms in from a 75° to a 50° field of view, and the gun slides to the centre so the front post sits in
  the rear notch. The crosshair shrinks to a dot.
- Shots are about 3× tighter, and recoil and weapon bob are smaller.
- You walk at 3.8 m/s and can't sprint or slide while aiming. Reloading lowers the sights.
- Mouse look slows by the same ratio as the zoom, so a hand movement covers the same part of the screen.
  **Aim sensitivity** in Settings scales it further.
- On a Mac, Ctrl+click still fires rather than aiming (Ctrl is crouch).

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

- **Keyboard Lock (Chrome, Edge, Opera):** joining or creating a room goes fullscreen (so does "Click to
  play" if you've left it), and asks the browser for every bound key, plus W, T, N, Q, Tab, 1–9 and Esc
  (`navigator.keyboard.lock`). The game then receives Ctrl+W, Ctrl+T, Ctrl+1 (switch tab), Ctrl+Tab and Cmd+W
  itself and ignores them, so crouching never closes or switches the tab. A tap of Esc opens the menu (the
  game releases the mouse itself), closes a panel, or resumes from the menu, and the game stays fullscreen;
  only holding Esc down leaves fullscreen (browsers always allow that). Firefox and Safari have no Keyboard
  Lock, so there Esc leaves fullscreen and the next click to play goes back in. Turn off
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
itself from the slot. When you die, your abilities (with their uses left) and your picked-up gun are scattered on
the floor around your body, spread apart rather than stacked, for anyone to grab.

Press **I** to open the inventory: it frees the mouse and lists each slot's uses and cooldown with a **Drop**
button. Dropped abilities land in front of you with their remaining uses, and anyone can pick them up.

| | Ability | Effect | Uses | Cooldown |
|---|---|---|---|---|
| 🩹 | Medkit | +50 HP (refused at full health) | 2 | 8 s |
| 🛡️ | Shield | Absorbs the next 50 damage for 8 s; others see a bubble | 2 | 15 s |
| ⚡ | Speed Boost | 1.6× movement for 5 s | 3 | 12 s |
| 💨 | Dash | Burst forward where you look | 4 | 3 s |
| 💣 | Grenade | Thrown arc, up to 90 damage in a 5 m radius, blocked by walls | 3 | 6 s |
| 🌫️ | Smoke | Thrown like a grenade; a thick 3.6 m cloud for 12 s that blocks sight (not bullets) | 2 | 10 s |
| 🧱 | Barrier | A 3.6 × 2.2 m wall (full cover, too tall to jump over) 1.8 m in front of you, square to the way you face, for 20 s; blocks movement and bullets. Enemies can break it: 300 damage (about 15 rifle hits; grenades and mines count). Refused if it would cut into cover or a player | 2 | 14 s |
| 👻 | Cloak | Nearly invisible for 6 s: enemies see a faint grey shimmer (no team colour, gun, name tag or shadow), teammates a see-through ghost. Firing, swinging the flag or throwing ends it early; you can still be shot, and your footsteps are half as loud, not silent. Your screen edges shimmer while it lasts | 2 | 18 s |
| 📡 | Scan Pulse | A ring sweeps out from you: for 3.5 s every enemy within 32 m of that spot shows as a red silhouette through walls. Scanned enemies are told they've been scanned | 2 | 15 s |
| 🔥 | Molotov | Thrown like a grenade; a 3.2 m patch of fire burns for 6 s where it lands. Enemies standing in it take 8 damage every 0.5 s (yours and your team's fire doesn't hurt you) | 2 | 12 s |
| 🔆 | Flashbang | Thrown; when it lands, everyone who can see it is whited out for up to ~3.7 s, worst close up and looking straight at it, milder facing away. It catches you too | 2 | 12 s |
| 🤖 | Turret | Deployed 1.6 m in front of you for 15 s. It sweeps for the nearest enemy it can see within 24 m (cloaked players excepted) and fires 8 damage every 0.4 s, not perfectly accurately. Its kills are yours. It's solid cover; enemies can destroy it with 150 damage (about 8 rifle hits; grenades and mines count). It goes when its owner leaves | 1 | 25 s |
| 💥 | Land Mine | Put down at your feet. It arms after 1.5 s and lasts 90 s; the first enemy within 1.6 m sets it off for a blast of up to 120 damage within 4 m (blocked by walls; stepping right on one nearly kills). You and your team see its blinking light, enemies only a dull disc on the floor. Two out at once: a third clears your oldest | 2 | 12 s |
| 🩸 | Lifesteal | For 8 s, your bullets heal you for 30% of the damage they deal | 2 | 20 s |

All numbers live in `src/game/abilities.ts`.

- **Spawning:** the player with the lowest id keeps the map stocked; if they leave, the next one takes over.
- **Picking up:** claimed with a database transaction, so only one player gets a pickup even if two touch it at once.
- **Grenades:** every client simulates the same arc from the thrower's start position and velocity. The thrower
  decides who the blast hit (with a line-of-sight check) and the victims apply the damage, like rifle hits.
- **Smoke and barriers** (`src/game/deployables.ts`) are sent as events too: smoke uses the grenade arc and
  bursts where it lands; a barrier carries its position, axis and server-time expiry, so every client drops it
  at the same moment. Someone who joins after a barrier was placed won't see it (events live for 3 s).

## Match summary

Hold **Tab** for the room name, match clock and every player's kills, deaths, K/D, damage dealt, accuracy,
headshots, best kill streak and ping, plus a "Your match" panel. Each player reports their own stats with their
position updates; damage dealt doesn't count overkill.

**Ping** is each player's round trip to the Firebase server, which every update between players passes
through. Each client times a small write until the server confirms it every 2 s, smooths it, and publishes it
in its player record. Green is under 80 ms, amber under 150 ms, red above. The delay between two players is
roughly their two pings added together.

## Bots

A room can have AI bots, each at its own level (Easy, Normal, Hard or Expert). When creating a room, **Start
with bots** and **Bot skill** set the first few. While playing, the room owner opens **Bots** in the pause menu
to add more mid-game (at any level and, in team modes, on either team or whichever is short), change a bot's
level or team, or take bots out. Nothing restarts. Bots stay until the owner removes them, however many people
join (at most 12). Their names carry their level, e.g. `Kai [Hard]`, and the scoreboard and kill feed mark them
with a BOT badge.

The list lives in `lobby/{code}/bots/{slot}` (`{base, skill, team?, at}`, written by the owner, validated in
`database.rules.json`; see `game/bot/roster.ts`). The owner's client plays exactly those entries.

**Who plays them.** The room owner's client: each bot is a body in the owner's physics world with an ordinary
player record (`bot: true`, id `b_…`), so everyone else sees, hears and shoots them like any player. Since the
game is client-authoritative, the owner is each bot's client: it decides what a bot's shots hit, applies the
damage others' shots do to it, reports its deaths and takes, returns and captures flags for it. Bots leave with
the owner (`onDisconnect`), and whoever owns the room next brings the same list back. Bots never own a room, never
run the leader's chores and never touch the leaderboard. See `game/bot/botHost.ts`.

**How they think.** Three parts.

- *Where to go* is scripted (`game/bot/objective.ts`). In CTF the flags come first, not kills: the carrier takes
  the flag home, the nearest teammate returns a dropped flag, the two nearest chase whoever has ours, the rest
  escort our carrier; one in three holds a spot in front of our flag and only goes for enemies closing in on it;
  everyone else attacks. Attackers gather briefly at a rally point and push in pairs, race straight for a dropped
  enemy flag, and don't detour to fights off their route or fall back to heal. Close to the enemy flag with a
  guard there, an attacker holds 10 m short and fights until it's clear (or 8 s pass), then grabs it. They only
  stop for pickups practically on the way, and not at all while a flag is on the move. In FFA and TDM: patrol
  between spawns and pickup spots (toward the enemy's half in team modes, keeping near the team). Bots go to
  fights a teammate called out or they heard, and fall back to a teammate when badly hurt. While a bot knows of
  no enemy, this layer also walks it there along the map's walk grid, glancing to the sides now and then and
  getting itself unstuck if it wedges into a gap.
- *Fighting on the move (CTF)*: with an enemy around, a CTF bot doesn't stop to trade shots; its feet follow the
  route to its objective while the policy and the aim model shoot (sprinting unless someone in view is within
  20 m). It only stands and fights someone within 5 m, or once it's where it's going (a defender at its spot).
- *Aiming* is a model of how people aim (`game/bot/aim.ts`): pick a target (whoever is shooting at us, a flag
  carrier first), take a moment to react, put the crosshair roughly on them, settle in, lag behind someone
  strafing, turn no faster than a person can, fight the recoil. The trigger is only pulled with the crosshair on
  them. The skill levels (Easy, Normal, Hard, **Expert**) are just these numbers.
- *Fighting* is a small neural network (75 inputs → 128 → 128 → 15 outputs, about 28k weights) trained with
  reinforcement learning. As soon as a bot knows of an enemy (seen, remembered from the last 4 s, called out by a
  teammate, heard firing, or shooting at it), the network decides how to move (strafe, cover, crouch, jump) and
  when to shoot. Ten times a second it sees what a player could know, all relative to itself: health, speed, ammo,
  gun, walls around it, the way to its goal, the three nearest enemies it knows about (no wallhacks: sight uses the
  map's occlusion grid), its nearest teammate.

Teams share what they know: whatever one bot sees, its teammates learn half a second later, and gunfire within
35 m (60 m for a sniper) gives the shooter away to anyone nearby (`game/bot/team.ts`). Each bot also has a
personality: how aggressive it is (how far it goes to help, when it backs off) and how much being hurt shakes its
aim.

**Pickups and abilities** are the scripted layer's too (`game/bot/gear.ts`, `botHost.ts`). Bots fetch
pickups within 14 m that are worth having (a gun when they have none, ammo for it, abilities while a slot is free;
never a flag carrier, or while their flag is away), and drop everything where they die, like players. They use
abilities the way a sensible player would: a medkit when badly hurt, a shield, barrier or smoke under fire,
lifesteal in a fight, grenades and molotovs at enemies out of easy reach (aimed by simulating the arc), a
flashbang at someone in front of them, turrets and mines to hold a base, speed, cloak and dash on a flag run, a
scan when nobody's been seen for a while. Being the bots' client, the owner also applies other players'
abilities to them (shields soak damage, fire burns, flashbangs blind) and runs their turrets and mines.

Skill levels change only how the network's answers are carried out: reaction time, a shakier aim, slower
turning, less eager trigger fingers.

**Training** happens offline, in TypeScript, on the CPU:

- `game/bot/sim/arena.ts` is the game without a screen: the real map generator, the real Rapier collision and the
  player's own movement code (`game/movement.ts`, shared with `player.ts`), guns from `gunStats.ts`, and the
  FFA / TDM / CTF rules. Abilities, grenades and pickups are left out.
- `game/bot/ppo.ts` is PPO (clipped objective, GAE, Adam) over the dependency-free MLP in `game/bot/nn.ts`.
- `scripts/train-bots.ts` runs it with worker threads: they play matches (self-play against the current policy,
  older snapshots of it and a scripted bot) and compute gradients in parallel; the main thread applies them. It
  works through a curriculum: **aim** (shoot wandering dummies) → **duel** (1v1 / 3-way FFA) → **tdm** (3v3) →
  **ctf** (3v3 on all map sizes) → **mix**, moving on when the rolling score passes each stage's bar.
- Rewards: damage and kills (minus damage taken and deaths), flag takes, returns and captures, winning, plus
  two shaping terms that can't be farmed (they're potentials): getting closer along the path to the objective,
  and closing aim on a visible enemy.

```sh
npm run train:bots                       # resumes from bots/latest.json; --fresh to start over
npm run train:bots -- --steps 80M --workers 9 --stage ctf
npm run eval:bots                        # vs the scripted bot on maps it never trained on
npm run eval:bots -- --tier easy,normal,hard,expert   # one line per skill level
npm run eval:bots -- --vs bots/ckpt-200.json
npm run export:bots                      # bots/best.json -> public/bots/policy.json (what the game loads)
```

Every 25 iterations the trainer also plays the scripted bot on held-out maps, in every mode trained so far, and
keeps the best policy by that test in `bots/best.json`; `export:bots` ships that one. Training's own numbers are
mostly against copies of itself, and can look healthy while the policy forgets how to fight anyone else (it
happened: team-only training wrecked free-for-all play over 25M steps before anyone noticed). Later curriculum
stages also keep some of the earlier modes in their mix for the same reason.

While it trains, **http://localhost:7777** shows it live: one of the matches being played, from above (who's who,
where they look, shots, flags, the score), the held-out evaluations, the learning curves with the curriculum stages
marked (reward, kills, K/D against the scripted bot, captures, policy entropy, speed) and where the reward comes from. `--view-port 0` turns it off.

Checkpoints and the training log (`bots/train-log.jsonl`) stay in `bots/`, which git ignores; only the exported
`public/bots/policy.json` (~150 KB) ships. Changing the observation layout (`game/bot/observe.ts`) means bumping
`OBS_VERSION` and retraining: the game refuses a policy made for another layout and plays without bots.

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
  then publishes a `shot` event (tracer + who was hit). Body shots do 20, headshots 50 (rifle). The shooter
  sees a hit marker on the crosshair right away: a quick white X for a body hit, a bigger red X with a burst ring
  (and a higher-pitched tick) for a headshot.
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

`npm run typecheck` runs `tsc` on the game and the e2e tests; `npm run build` typechecks the game and then builds.

```
src/
  main.tsx           React entry
  types.ts           shared types: PlayerState, GameEvent, RoomSummary, ...
  ui/
    App.tsx          lobby <-> game screen switching
    Lobby.tsx        name, create / join / list rooms
    DiscordLobby.tsx start screen inside Discord (mode pick / join the channel's match)
    GameView.tsx     mounts the Game engine for the current room
    Hud.tsx          health, ammo, ability bar, kill feed, death / pause overlays
    InventoryPanel.tsx  inventory (I) with drop buttons
    TouchControls.tsx   on-screen controls for phones and tablets
    MatchSummary.tsx    match summary (Tab)
    SettingsPanel.tsx   sensitivity + key binding editor
    MapPreview.tsx      3D map preview (lobby and pause menu); 2D fallback without WebGL
  game/
    game.ts          game loop, shooting, damage, respawn, rendering
    hudStore.ts      engine -> React state bridge
    mapgen.ts        seeded map generator: picks the style and theme, checks the map, and the classic map
    levelgen/        the generators: core.ts (placement + mirroring), industrial / town / outdoor.ts,
                     building.ts (enterable buildings), props.ts (models + their collision), check.ts
    props.ts         loads public/models/props.glb (the map models)
    propManifest.ts  GENERATED by scripts/build-props.mjs: each model's size and collision boxes
    textures.ts      procedural textures (surfaces, floors, sky, props) + world-scale box UVs
    world.ts         turns a map layout into meshes, lighting, colliders, spawn points
    player.ts        first-person controller (keys, mouse look, camera) over movement.ts
    movement.ts      walking, sprinting, sliding, jumping and collisions (Rapier), shared with bots
    gunStats.ts      gun numbers only (no models), shared with the bot simulator
    bot/             AI bots: nn.ts (MLP + Adam), policy.ts, observe.ts (what a bot knows), objective.ts (goals), nav.ts (paths),
                     senses.ts, hitscan.ts, brain.ts (skill, steering), botHost.ts (bots in a room),
                     ppo.ts (training), sim/ (headless arena + rollouts for training)
    remotePlayer.ts  other players' avatars + interpolation
    xray.ts          flat team-colour silhouette of teammates behind cover
    ramps.ts         sloped surfaces: height lookup, wedge geometry
    deployables.ts   smoke clouds and deployable barriers
    nameTag.ts       name + health tag revealed to the shooter
    modes.ts         game modes, score + time limits, teams, flag bases
    moments.ts       tracks our highlights (multi-kills, flag runs, ...) for MVP
    replay.ts        records the round and replays the MVP's highlight
    flags.ts         CTF bases and flags (waving, carried, dropped)
    settings.ts      mouse sensitivity + key bindings (saved in localStorage)
    guns.ts          gun stats, damage falloff, and loading / laying out the gun models
    fpArms.ts        your arms in the first-person view (a viewmodel rig's arms, posed with IK)
    abilities.ts     ability definitions, tuning numbers, 3-slot inventory
    pickups.ts       ability pickups on the map
    grenades.ts      deterministic grenade arcs + explosion effects
    weapon.ts        viewmodel, ammo/reload/recoil, tracers & impacts
    audio.ts         sound: plays the recorded clips in public/sounds/ (Web Audio)
    footsteps.ts     turns movement into footfalls and landings
    frameLoop.ts     runs each frame per the V-Sync / Max FPS settings
    canvas.ts        helper for procedural textures
  discord/
    patch.ts         inside Discord: route traffic through Discord's proxy (imported first)
    discord.ts       Discord SDK: ready, sign in, instance id
  net/
    firebase.ts      Firebase init (real project or emulator)
    network.ts       RoomConnection: presence, player sync, events, empty-room cleanup
```

## Assets

The logo lives in `public/brand/`: `logo.svg` (source), PNG exports (`icon-512.png`, `icon-1024.png`), and
`og-image.png` (1200×630 link preview). `public/favicon.svg` is a simplified version for tiny sizes, with
`favicon-32.png` and `apple-touch-icon.png` rendered from it and the logo.

`public/models/props.glb` holds the map models: 65 Kenney CC0 models (shops, houses, factories, chimneys,
tanks, a water tower, street lights, barriers, dumpsters, fences, trees, rocks, logs, tents...), 46k triangles,
1.9 MB (430 KB gzipped). `scripts/build-props.mjs` (`npm run build:props`) makes it from the raw packs in
`assets-src/kenney/` (not committed; `assets-src/README.md` lists the downloads) using the list in
`scripts/props.config.mjs`: it bakes each model's colour texture into its vertices so all of them share one
material, centres its base on the origin, scales it to metres, and writes `src/game/propManifest.ts` with each
model's size and collision boxes for the generator.

`public/models/guns.glb` holds the four guns from Quaternius's
[Ultimate Gun Pack](https://opengameart.org/content/low-poly-guns-pack) (CC0): AssaultRifle_2 (rifle), Shotgun_2,
SniperRifle_3 and Pistol_1 (Deagle). They were converted from OBJ into one GLB, one mesh per gun named after its
`GunKind`, already in metres with the barrel along -Z (about 4,800 triangles, 240 KB). `GUN_LAYOUT` in
`src/game/guns.ts` sets each gun's length, muzzle, sight height and hip / aim positions. The same models are used in
first person, on pickups, and (85 % size) in other players' hands, where the teammate X-ray outline includes them.
The game waits for the file (and the lobby starts downloading it) before joining.

**Your arms in first person** (`src/game/fpArms.ts`, `public/models/fpArms.glb`) are the arms of J-Toastie's "FPS Rig
AKM" viewmodel with its gun removed (3 skinned meshes, 2.4k triangles, flat colours like the guns). The rig's idle
hold of its AKM is what every gun is posed from: with the rig placed as its author's demo places it, each wrist's
offset from the barrel axis and each hand's orientation relative to the barrel were measured, plus the shoulder
positions, elbow directions and the forearm roll. Every frame two-bone IK (`src/game/ik.ts`) brings each wrist to
that offset from a point on the held gun's barrel axis (`grip`, `support` and `mag` in `GUN_LAYOUT`: the grip, the
fore-end or pump, the magazine) and turns the hand to the measured orientation, so the hands grip our guns exactly as
the rig's grip its AKM; the whole arrangement is scaled to life size (×0.625), which keeps the same picture. The
pistol is held one-handed (the left arm is hidden); mid-reload the left hand goes to the magazine; with the flag both hands hold
the pole; spectating in first person shows them too. The weapon camera is 70° like the rig's demo, and at the hip
the gun points straight ahead a little right of the eye and pitched up slightly (`HIP_CANT`), as the rig holds it.

`public/models/Soldier.glb` is the [SWAT](https://poly.pizza/m/Btfn3G5Xv4) character by Quaternius (CC0), low-poly and
flat-coloured to match the guns and the Kenney maps, with Idle / Walk / Run animations. `npm run build:character`
makes it from the raw download in `assets-src/quaternius/Swat.glb` (`scripts/build-character.mjs`): it turns the
model to face -Z, scales it to 1.73 m, keeps only those three clips, names the materials (`Uniform` takes the
player's colour, the `Visor` their colour in full, `Gear` and `Skin` stay as they are), and moves the feet, which
are IK targets in the original rig, under the shins (re-baking their animation) so they follow the legs when the
game bends them. Other players use it; the gun, hitboxes, aim pose, player-color tint and death fall are added in code
(`src/game/remotePlayer.ts`). The aim pose is layered over the animation with two-bone arm IK
(`src/game/ik.ts`): both hands hold the gun pointed exactly where the player is looking, at the ready
normally and raised to the eye while they aim down sights (sent as `aim` with their pose), with the
upper body and head taking the look pitch. Sprinting, sliding and dying drop the pose back to the
animation. On top of that, reloading (sent as `rl`) drops the support hand to the magazine and tilts the
gun, a throw (`th` counts up) swings the free arm over the head, and a gun switch dips the gun.

**Dead bodies are ragdolls** (`src/game/ragdoll.ts`, no physics engine). At the moment of death the main
joints (hips, chest, head, shoulders, elbows, hands, hips, knees, feet) become Verlet particles that keep the
body's momentum. Distance constraints hold the bones at their length and the torso rigid (with minimums so knees
and elbows can't fold flat); joints collide with the floor, cover and ramps, with friction so bodies don't
skate; each bone of the skinned model is then turned to follow its joints. The killing hit shoves the body away
from the killer (harder for the shotgun, sniper and grenades; headshots snap the head back), grenades throw
bodies lying nearby, and MVP replays ragdoll their victims too. A body settles within a couple of seconds and
stops simulating. To swap in another model, keep the clip names, list its bones in `BONES`
(`src/game/character.ts`), and re-measure the rig constants at the top of `remotePlayer.ts` (`HAND_FORWARD` /
`HAND_UP`, `PALM`, `CURL_AXIS` / `FIST` for the fists the hands close into, `HEAD_HIT_OFFSET`, `FOOT_REST`). Leg, spine and head bends turn about the body's
left-right axis, so they don't depend on how the rig's bone axes point.

## Credits

The game's credits page is `public/credits.html` (linked from both lobbies as **Credits**).

- **Music:** “Dark Ambience Loop” by Iwan Gabovitch ([qubodup.net](https://qubodup.net)),
  [OpenGameArt](https://opengameart.org/content/dark-ambience-loop),
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Trimmed and converted to MP3. Keep this credit if you
  keep the file (`public/sounds/tension_loop.mp3`).
- **Gunshots:** [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library)
  by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney, CC0.
- **Reloads:** [Gun Reload Sounds](https://opengameart.org/content/gun-reload-sounds) by SpringySpringo,
  [Handgun Reload](https://opengameart.org/content/handgun-reload-sound-effect) and
  [Shotgun Reload Sound Effects](https://opengameart.org/content/shotgun-reload-sound-effects) by zer0_sol, and
  [Gun Reload Sound Effects](https://opengameart.org/content/gun-reload-sound-effects) by BMacZero, all CC0.
- **Effects, footsteps and jingles:** Kenney's [Impact Sounds](https://kenney.nl/assets/impact-sounds),
  [Interface Sounds](https://kenney.nl/assets/interface-sounds), [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
  and [Music Jingles](https://kenney.nl/assets/music-jingles), CC0.
- **Heartbeat:** [Heartbeat Sounds](https://opengameart.org/content/heartbeat-sounds) by bart, CC0.
- **Map models:** Kenney's [City Kit Commercial](https://kenney.nl/assets/city-kit-commercial),
  [City Kit Suburban](https://kenney.nl/assets/city-kit-suburban), [City Kit Roads](https://kenney.nl/assets/city-kit-roads),
  [City Kit Industrial](https://kenney.nl/assets/city-kit-industrial) and [Nature Kit](https://kenney.nl/assets/nature-kit), CC0.
- **Gun models:** [Ultimate Gun Pack](https://opengameart.org/content/low-poly-guns-pack) by Quaternius, CC0.
- **First-person arms:** "FPS Rig AKM" by J-Toastie, CC-BY, via Poly Pizza (found through the MIT-licensed
  [ThreeJS_FPS_2.0](https://github.com/Footprintarts/ThreeJS_FPS_2.0) template, whose demo placement the hold was
  measured in). Keep this credit if you keep `public/models/fpArms.glb`.
- **Player model:** [SWAT](https://poly.pizza/m/Btfn3G5Xv4) by Quaternius, CC0 (see [Assets](#assets)).
