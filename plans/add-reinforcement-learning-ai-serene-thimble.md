# Better bots: human-aim model, teamwork, personality, Expert tier

## Context
The bots work end to end: they fill rooms, fight with the trained policy, follow scripted objectives, use pickups and abilities, and collide with players. They feel too weak, though.

- **Where they stand.** On held-out maps the shipped policy trades about 0.5 K/D with the scripted aimbot. After the reaction-time fix, in-game accuracy is 13–21%.
- **Why.** The network has to learn aim through noisy relative turns. That is the weakest, least tunable part of the system.
- **Teamwork is missing.** Each bot plays alone: nobody shares sightings, regroups or helps a teammate.
- **What you chose.** Focus on stronger fighters, smarter objectives and teamwork, and more human and fun play. Bots should aim with a **human-aim model**, and there should be an **Expert** tier above Hard.

**Goal.** Bots are clearly stronger and believable. Difficulty runs cleanly from Easy to Expert. Teams act like teams.

## Approach

### 1. Human-aim model (new `src/game/bot/aim.ts`)
A per-bot `AimController`, used the same way in the game, the simulator and evaluation:

- **Target choice.**
  - Prefers whoever is shooting the bot (from the hurt memory), then the nearest visible enemy.
  - Sticky: it only switches when the current target is lost, or a much better one appears.
  - CTF: a nearby flag carrier is always the priority.
- **Human aim error.**
  - **Reaction:** a new target isn't engaged for `reaction` seconds.
  - **First aim:** offset by `initialError`, scaled up with distance and the bot's own speed.
  - **Settling:** the error decays toward a residual `trackError` with time constant `settle`.
  - **Moving targets:** the error grows with the target's angular speed, so strafing works against bots.
  - **Turning:** turn rate capped at `maxTurn`; recoil adds pitch and the controller pulls it back.
  - **Aim point:** chest, with a `headChance` per engagement on harder tiers.
- **Trigger.** It fires only when the policy wants to fire **and** the aim error is inside the gun's effective cone. That cone comes from `gunStats` spread: wider for shotguns, tighter for snipers at range.
- **Division of labour.** The policy keeps movement (strafe, cover, crouch, jump) and the intent to shoot. Its aim outputs are ignored while the aim layer has a target. With no target, today's travel and look behaviour stays.
- **Difficulty presets.** These replace today's `SkillDef` in `brain.ts`; the values below are starting points, tuned with the calibration in Verification.

  | Tier | reaction (s) | initialError (rad) | settle (s) | trackError (rad) | maxTurn (rad/s) | headChance |
  |---|---|---|---|---|---|---|
  | easy | 0.55 | 0.25 | 0.6 | 0.06 | 4 | 0 |
  | normal | 0.35 | 0.15 | 0.4 | 0.035 | 6 | 0.05 |
  | hard | 0.22 | 0.09 | 0.25 | 0.02 | 9 | 0.15 |
  | **expert** | 0.14 | 0.05 | 0.15 | 0.01 | 14 | 0.3 |

- **Expert tier.** Add `'expert'` to:
  - `BotSkill` and `BOT_SKILLS` (`brain.ts`);
  - `BOT_SKILL_OPTIONS` (`rules.ts`), which feeds the ModePicker select automatically;
  - the `database.rules.json` `botSkill` validation, with a case in `scripts/test-rules.mjs`.

### 2. Retrain the policy with the aim layer (sim + PPO)
- **Simulator.** In `sim/arena.ts` and `sim/rollout.ts`, learners and snapshot opponents fight with the aim layer. Each episode draws a random tier (domain randomisation), so the movement policy learns to survive and win at every level.
- **PPO.** `ppo.ts` and `policy.ts` get a per-row `aimMasked` flag in `Batch`. When it's set, `logProb` and `ppoGradient` skip the aim Gaussian terms, so unused aim outputs add no noise to learning.
- **Starting point.** Continue from `bots/best.json` (the movement and fire heads are already useful). Use the mixed stage (FFA/TDM/CTF), with the eval and best-tracking already in `train-bots.ts`.
- **Reward.** Unchanged. The progress, aim and potential shaping stays, but aim shaping is dropped when the aim layer aims.

### 3. Team knowledge: callouts and hearing (`observe.ts` `BotMemory`, `botHost.ts`, `arena.ts`)
- **Callouts.** When a bot sees an enemy, its teammates get a "remembered" entry with the position: not marked seen, aged about 0.5 s, as if called out. A per-team `TeamIntel` keeps these, and they reach each bot through the existing memory slots in `observe()`.
- **Hearing.** Enemy gunfire within 35 m (60 m for snipers) gives the bot an approximate position (±3 m) as a remembered entry.
  - In-game: from `shot` events in `BotHost.onEvent`.
  - Simulator: `Arena.fire()` notifies agents in range.
- **Why it matters.** Bots turn toward threats and the objective layer can send help.

### 4. Smarter objectives and teamwork (`objective.ts` `goalFor`)
- **Help a teammate.** While travelling, if a teammate within 30 m is in a fight (team intel or recent damage), the goal becomes that fight. This applies in TDM, and in CTF to non-carriers.
- **CTF regroup.** An attacker waits at a rally point about 40% of the way to the enemy base until a second attacker is within 12 m, for at most 8 s, then they push together. The carrier gets escorts, as today.
- **Defenders hold a covering spot.** Instead of standing on the flag, a defender holds a spot near its own base facing the main approach: a base offset toward the map centre along the lane graph (`map.graph`).
- **Low health.** Below 35% HP with no medkit, a bot retreats toward the nearest teammate. In-game, a medkit pickup within 25 m becomes a detour target first (reusing `detourFor` in `botHost.ts`).
- **Patrol cohesion (TDM).** Teammates bias their patrol points toward the same half of the map, so they move as loose groups.

### 5. More human: personality and look-around (`brain.ts`, `botHost.ts`)
- **Personality** per bot, rolled when it joins: `aggression` (push and help thresholds), `preferredRange` (pushes in or hangs back via goal offsets), `nerves` (small extra aim error when low on health).
- **Looking around.** While travelling, the bot glances toward side openings every few seconds (the wall probes in `obs` show where), so it doesn't stare down a corridor.
- **Names.** A longer `NAMES` list in `botHost.ts`, so rooms of 12 don't repeat.

## Files
- **New:** `src/game/bot/aim.ts`, `src/game/bot/team.ts` (TeamIntel), and tests `__tests__/aim.test.ts` and `__tests__/team.test.ts`.
- **Modified:**
  - Bot core: `bot/brain.ts` (skills to aim presets, personality), `bot/objective.ts` (help, regroup, defend spot, retreat), `bot/observe.ts` (memory entries from intel and hearing), `bot/botHost.ts` (aim controller, hearing, medkit detour, names).
  - Training: `bot/sim/arena.ts`, `bot/sim/rollout.ts`, `bot/sim/evaluate.ts`, `bot/ppo.ts`, `bot/policy.ts`.
  - Rules: `rules.ts`, `database.rules.json`, `scripts/test-rules.mjs`.
  - Docs: `README.md` (Bots section).
- **Retrain, then re-export** `public/bots/policy.json`.

## Verification
- **Unit tests:**
  - **Aim model:** error settles over time; reaction delay holds fire; error grows with target angular speed; a higher tier settles faster with less error; no fire outside the gun's cone.
  - **Team intel:** a teammate's sighting appears in another bot's memory; hearing gives an approximate position; enemies never get our intel.
  - **Objectives:** the help goal, the regroup rally then release, the defender spot, and the low-health retreat.
  - **PPO:** the aim mask leaves aim parameters untouched; the existing gradient tests still pass.
- **Calibration in the simulator (`eval-bots` extended with `--tier`):**
  - Each tier against the scripted aimbot on held-out maps.
  - Expected K/D roughly easy ≈ 0.4, normal ≈ 0.8, hard ≈ 1.2, expert ≥ 1.8, and strictly increasing; tune the preset numbers until it is.
  - Team modes should also show more kills per bot per minute than today.
- **In-game (Playwright, as in the last session):**
  - A 90 s 3v3 bot match per tier: bot kills and accuracy increase monotonically from Easy to Expert.
  - The scoreboard and the stats fields are filled in.
  - A CTF match shows regrouping attackers and defenders holding a spot off the flag (positions logged from the bot host).
- **Regression:** `npm run typecheck`, `npm test`, `npm run test:rules`, and the e2e `bots`, `movement`, `combat`, `ctf`, `abilities` and `pickups` suites.
