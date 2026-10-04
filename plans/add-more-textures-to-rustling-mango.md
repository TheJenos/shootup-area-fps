# Plan: UX pass (onboarding, in-match clarity, menus, lobby, connection states, mobile, accessibility)

## Context
The game has grown a lot of mechanics (crouch-slide, ADS, gun swap, inventory, abilities, four modes, spectating)
but the UX around them hasn't kept up. A code audit found 37 friction points. The user wants all four areas
covered and the pause menu redesigned into a proper menu. The six biggest gaps:
- Pause doesn't stop the match, but the card says "Click to play" and hides the death / round-over screens.
- Feedback goes through one 1.8 s toast slot that is unmounted while spectating and in the MVP cinematic.
- "Connecting…" can hang forever with no way out; a dropped connection mid-match isn't shown.
- Late joiners during the round-end screens land in the pause menu and see nothing.
- On a 667 px wide phone the crouch button sits on ability slot 3; ability slots are probably untappable on
  touch (the look zone paints over them).
- Nothing teaches a new player the mode goal, slide, ADS, Q swap or the inventory.

Reuse: `HudStore.toast/announce/pushInfo/update` (`src/game/hudStore.ts`), `settings` store + `keyLabel`/`keyFor`
(`src/game/settings.ts`), `MODES`/`TEAM_INFO`/`GUN_GAME_LADDER` (`src/game/modes.ts`), `MapPreview`,
`useSettings()` (`src/ui/SettingsPanel.tsx`), `.overlay`/`.panel-box`/`.warning`/`kbd` CSS, `TOUCH`
(`src/game/device.ts`), `errorMessage` (`src/ui/errors.ts`).

---

## Part 1 — Toast queue (do first; everything else emits through it)
`src/game/hudStore.ts`, `src/ui/Hud.tsx`, `src/style.css`
- Keep `HudState.toast` as "the toast on screen". Add private `toastQueue: string[]` (max 3). `toast(text)`:
  dedupe against current + queue; if one is showing, enqueue; else `showToast()` → 1.8 s timer → shift next.
  Add `clearToasts()`; call it from `startRound()`.
- `announce(text, sub = '', ms = 2200)` stores `ms`; `#announce` gets inline `animationDuration`.
- Render an always-mounted `<div id="toasts">` directly under `#hud` (not inside `AbilityBar`); remove the
  `toast` prop from `AbilityBar`. CSS: `#toasts { position:absolute; left:50%; bottom:140px; transform:translateX(-50%);
  z-index:20; pointer-events:none }` (above `#pause-overlay` and `#settings`), touch `bottom:140px; max-width:240px`.
  Do not add it to the `#hud.cinematic` hide list.

## Part 2 — Onboarding and hints
- `src/game/modes.ts`: add `goal: string` to `ModeDef` (ffa "Every kill counts — first to 25 wins"; tdm; ctf
  "...Your own flag must be home to score."; gungame uses `GUN_GAME_LADDER.length`).
- New `src/game/hints.ts`: `hints.once(id): boolean` backed by `localStorage['fps-hints']` (JSON array,
  try/catch), `hints.reset()`. `HintId = 'slide'|'gun-swap'|'ads'|'full-slots'|\`ability:${AbilityType}\``.
- `src/game/game.ts`: `private hint(id, text: () => string)` → toast once. Intro: in `update()` when
  `joined && locked && !introDone` → `announce(MODES[mode].name, MODES[mode].goal, 3800)` (not at end of
  `start()`, where the pause menu hides it). Hooks: slide (sprinting > 0.6 s, text uses
  `keyLabel(keyFor('crouch'))` / "Tap ⤓" on touch), ability pickup (`tryPickup().then`, slot key via
  `ABILITY_ACTIONS[i]`), gun pickup (`takeGun()`: toast drops the hardcoded "Q / wheel"; hint uses
  `keyFor('swap')` / "⇄"), ADS (first `aiming`), full slots (existing "Slots full" branch → inventory key / 🎒).
- Optional "Reset tips" button in Settings footer → `hints.reset()`.

## Part 3 — Labels and bindings everywhere
- Controls list (moves into `PauseMenu.tsx`): "Mouse — look", "Right-click — aim down sights",
  "<crouch> — crouch · while sprinting: slide", "<swap> / wheel — switch gun", add "Esc — menu".
- `RoundResults`: `keyLabel(bindings.scoreboard)`; on touch "tap ☰ for the scoreboard".
- Spectate hint + `startSpectating()` toast: use `keyLabel(keyFor('jump'))`, add fly keys (E up, crouch down,
  sprint fast); touch "tap: next player".

## Part 4 — Death screen, ability feedback, reload prompt, flags
`hudStore.ts`, `game.ts`, `Hud.tsx`, `style.css`
- `HudState.death: { killerName; self; weapon: WeaponKind; head; dropped; respawnIn }`, `respawnFlash: number`,
  `slotDenied: { n; slot } | null`; `FlagStatus` dropped → `{ state:'dropped'; returnIn }`.
- `die()`: `dropLoot()` returns boolean; `self = !killerId || killerId === playerId`. Overlay: "You took
  yourself out" / "You were eliminated by NAME <weapon icon> ⌖ headshot", "Your gun and abilities dropped where
  you fell" when `dropped`. Extract `weaponIcon(w)` from `KillFeed`.
- `respawn()`: bump `respawnFlash` when coming from death → `#respawn-flash` white edge flash (reuse
  `@keyframes damage`).
- `useAbility()` denied: empty → toast "Empty slot — pick up an ability"; cooldown → toast
  "<name> ready in N s" + `slotDenied` → `.slot.shake` (remount via key); throttle 700 ms.
- `AmmoPanel` hint line (one element, precedence): RELOADING › "<reload key> TO RELOAD" (mag 0, reserve > 0;
  ↻ on touch) › "NO AMMO — FIND A BOX" (dry) › "LOW AMMO" (`.low`). `#reload-hint.show { visibility: visible }`.
- `refreshScore()`: `returnIn = ceil(FLAG_RETURN_TIME − (now − flagDroppedAt[team])/1000)`; `FlagIcon` shows
  "⚑ dropped · Ns". `announceFlag()`: keep `pushInfo`, add `announce` for: I took it ("FLAG TAKEN / Run it to
  your base"), our flag taken ("YOUR FLAG IS GONE / who has it"), our capture ("CAPTURED"), enemy capture
  ("ENEMY SCORED"), ours returned ("FLAG RETURNED").

## Part 5 — Pause menu redesign
New `src/ui/PauseMenu.tsx`; `Hud.tsx`, `hudStore.ts`, `game.ts`, `style.css`
- `HudState.playerCount` (non-spectators incl. us) computed in `refreshScore()` and in its JSON key.
  `MatchEnd.nextMapIn` (seconds to the next round across both phases) from `matchEndView()`.
- Two-column `.panel-box.pause-card` (`grid-template-columns: 1fr 240px`, `width: min(780px,100%)`, left-aligned):
  - Left (status): mode badge + name + `goal`; `RoundClock` + score (team: red–blue with `FlagIcon`; ffa: You N ·
    best other; gungame: Level n/limit · gun); status line: "Spectating" / "Round over — <title> · MVP|next map in
    N" / "Dead — respawning in N" / "You're alive — the match is still running"; `MapPreview` of
    `generateMap(hud.map.seed)` (useMemo) + name, seed, `playerCount` players; Room CODE + Copy invite.
  - Right (actions): **Resume** (primary), Spectate / Back to the fight, Switch team (team modes), Settings,
    Leave room → inline confirm (Leave / Stay), then the `keyLabel`-driven keys list (touch: one sentence +
    "Controls guide" button → TouchIntro).
- Backdrop click (`e.target === e.currentTarget`) resumes; clicks inside the card don't. Export `RoundClock` and
  `FlagIcon` from `Hud.tsx`; move `copyLink` into a `useCopyInvite(game, roomCode)` hook (also used by the
  waiting banner). Touch: `navigator.share` path stays.
- Gating: `RoundResults`/`MvpShowcase` no longer hidden by `paused` (dim them: `#hud.paused #round-over, #hud.paused
  #mvp .card { opacity: .4 }`); `#death-overlay` and `MatchSummary` stay hidden while paused (status line covers it).
  Add `paused` class to `#hud`. Touch: single column, 44 px buttons. `@media (max-width: 640px)` single column.
- Pointer-lock retry: `pointerlockerror` (non-Discord, non-touch) and `lockPointer().catch` → toast "Click again
  to resume" (dedupe collapses the double fire).

## Part 6 — Lobby and joining
`src/ui/Lobby.tsx`, `src/ui/DiscordLobby.tsx`, `src/ui/App.tsx`, `src/ui/GameView.tsx`, `src/ui/errors.ts`,
`src/discord/discord.ts`, `src/net/network.ts`, `src/style.css`
- `errors.ts`: `friendlyError(err)` — map permission denied / network-offline / timeout / Firebase-shaped
  messages to plain sentences; pass our own messages through; append `(raw)` only in `import.meta.env.DEV`.
  Use it in Lobby, DiscordLobby, GameView.
- `App.tsx`: `inviteCode()` allows 10 chars (Discord `DC…` codes); export `ROOM_CODE_MAX = 10`; `Session.notice?`.
- Spinner: `.spinner` CSS (12 px ring, `@keyframes spin`).
- Lobby: `busy: 'join'|'create'|null` + `joiningCode`; buttons read "Joining…"/"Creating…" with spinner, only the
  clicked row spins. Name input `autoFocus` (unless invite card showing), `hasName` gates Join/Create with a hint
  under the field; Enter in name → join if code present else focus code; on the "Enter a name first" path focus +
  scrollIntoView. Code input `maxLength={ROOM_CODE_MAX}`, strip non-alphanumerics.
- Invite card replaces the silent auto-join: state `'auto'|'manual'|'closed'|null`; `'auto'` shows "Joining CODE
  as NAME…" with [Join now] [Change name] and a 2 s progress bar then joins; `'manual'` = current banner;
  `'closed'` (room gone, detected in `join` when `normalized === initialCode`) → `.warning` "That room has closed —
  create a new one below", clear code and hash.
- Room list: `watchRooms(cb, onError)` (pass `onValue`'s cancel callback); `useRooms()` returns
  `{ rooms, failed, retry }` with an 8 s timeout → "Couldn't reach the server [Retry]".
- Optional, last: coarse round info in rows via the existing lobby listener — `setLobbySeed` →
  `setLobbyRound(seed, startedAt)` + `markLobbyEnded()` written by the leader; `LobbyRecord.startedAt/ended`;
  rows show "~N min left" / "Round ending". Add `.validate` for the two fields in `database.rules.json`
  (deploy rules with the site).
- DiscordLobby: ⚙ settings link + `SettingsPanel`; Retry on connect failure (fix `discord.ts`: don't cache a
  rejected `session` — `connect().catch(e => { session = null; throw e })`); busy labels; if the picked mode was
  dropped because someone started first → `Session.notice` → `GameView` calls `hud.pushInfo` after `start()`.

## Part 7 — Connection and edge states
- Connecting timeout (`Hud.tsx`): after 10 s of `connecting` → "Still connecting…", explanation, [Back to lobby]
  (`onLeave`; dispose path already safe).
- Disconnect banner: `RoomHandlers.onConnection?(connected)` fired from the existing `.info/connected` listener in
  `join()`; `HudState.offline`; game: feed "Connection lost"/"Back online", skip pose sends while offline;
  `#offline-banner.hud-banner.danger` "Reconnecting…" (shared `.hud-banner` style at top: 64px).
- Waiting alone: `playerCount === 1 && !connecting && !paused && !matchEnd && !offline` → `.hud-banner`
  "Waiting for players — share room CODE [Copy invite]".
- Late joiner during round end: covered by `MatchEnd.nextMapIn` + the pause status line; results/MVP show as soon
  as they click to play; `ReplayDirector` already falls back to a fly-around.

## Part 8 — Mobile layout and touch
`src/style.css`, `src/ui/TouchControls.tsx`, `src/ui/MatchSummary.tsx`, new `src/ui/TouchIntro.tsx`, `Hud.tsx`,
`SettingsPanel.tsx`, `game.ts`
- Right cluster: nothing left of `W−202`. `crouch: right 50px, bottom 24px` (under fire, right of jump);
  `reload: right 54px, bottom 204px`; `swap: right 148px, bottom 220px`; `#hud.touch #ammo { top: 52px; font-size:
  22px; padding: 4px 10px }`. Centre column rungs: `#hud.touch #abilities { bottom: 8px; gap: 6px; z-index: 1 }`
  (z-index fixes slots being under the look zone), `#abilities .buffs:empty { display: none }`, hide `kbd` in
  empty slots on touch, `#hud.touch #health { bottom: 98px; transform: translateX(-50%) scale(calc(0.75 *
  var(--hud-scale,1))) }`, toasts at `bottom: 140px`. Verified clearances at 667/740/812/896 × 375.
- Scoreboard ☰ becomes a toggle (`aria-pressed`); `MatchSummary` gets `onClose` + Close button on touch;
  `#hud.touch #match-summary { pointer-events: auto; top: 60px; max-height: calc(100% − 68px) }`;
  `pauseTouchPlay()` also closes it.
- `TouchIntro`: first-time overlay (local React state, `localStorage['fps-touch-intro']`), CSS-only callout pills
  anchored at each button's centre (values in the audit plan), `role="dialog"`, sr-only text list, "Got it"
  (autoFocus). Rendered before the pause menu on first touch load; pause menu "Controls guide" reopens it;
  `#hud.intro #touch-controls { pointer-events: none }`.
- Settings on touch (`TOUCH`): heading "Look", "Look sensitivity", hide Toggle aim and Key bindings, fullscreen
  label "(also locks landscape on Android)". Pause button label just "Settings" on touch.

## Part 9 — Accessibility
`src/game/settings.ts`, `src/main.tsx`, `src/style.css`, `Hud.tsx`, `SettingsPanel.tsx`, `InventoryPanel.tsx`,
`MapPreview.tsx`, `Lobby.tsx`, `hudStore.ts`
- Settings: `reduceMotion: 'system'|'reduce'|'full'` (default system), `hudScale` 0.8–1.4 (default 1),
  `screenShake` default `!prefers-reduced-motion`; validate with the existing `num()` pattern; choosing "On" also
  unchecks screen shake. `reducedMotion()` helper. `main.tsx` toggles `html.reduce-motion` from the setting + OS
  (`matchMedia` change listener). New "Accessibility" section in Settings (Reduce motion choices, HUD size slider).
- Reduced-motion CSS keyed on `html.reduce-motion` (single source of truth): hitmarker/damage flash become
  opacity-only keyframes (never `animation: none` — they stay mounted and rely on ending at opacity 0); hit ring
  `display:none`; low-health static vignette; announce fade-only; flag banner, urgent clock, loading logo, MVP
  bars/card, rotate hint static; toasts opacity-only.
- 12 px minimum: `.slot kbd/.name` (+ellipsis), `#match-summary th/.stat span`, `.mode-badge`, `#spectate .label`,
  `#scorebar .mode/.center/.team .name/.flag`, `#ammo .gun-slot`.
- HUD scale: per-panel `transform: scale(var(--hud-scale))` from each panel's anchored corner (`#health` bottom
  left, `#ammo` bottom right / top right on touch, `#abilities` bottom centre, scorebar top centre, `#killfeed` top
  right, `#room-tag` top left, `#spectate` bottom centre). Not the whole `#hud` (breaks touch coordinates). Touch
  caps at 1.2.
- Colour-only cues: "LOW AMMO" text (Part 4); kill feed entries get `killerTeam/victimTeam/me` → team tag pill and
  "(you)"; health bar `aria-hidden` (number already shown).
- Screen reader: `.sr-only` live regions for toast and announce; `aria-hidden` on hitmarker/damage/low-health/
  crosshair/announce visuals; `role="dialog" aria-modal aria-labelledby` + initial focus on Settings, Inventory,
  PauseMenu, MatchSummary (modal only on touch); `MapPreview` canvas `role="img" aria-label`; 🎲 `aria-label`.

---

## Sequencing
1. Part 1 (toast queue) → 2. Parts 2–3 → 3. Part 4 → 4. Part 5 → 5. Part 9 settings fields + motion class +
CSS (12 px, reduced motion, scale) → 6. Part 8 CSS layout, TouchIntro, scoreboard toggle, touch settings →
7. Parts 6–7 (errors, lobby, Discord lobby, connection banners) → 8. optional lobby round info + rules →
9. README: Controls/Settings/Phones sections. `npm run typecheck` after every step (strict TS; new `HudState`
fields go into `initialState`).

## Verification
Run `npm run emulator` + `npm run dev:emu`, two tabs (second with `?touch` for the phone layout); `window.game`
for pokes.
- Toasts: fire 5 toasts incl. a duplicate from the console → play in order, duplicate skipped, 5th dropped;
  visible while spectating and during the MVP letterbox.
- Onboarding: clear `fps-hints`; first click to play → mode + goal banner ~3.8 s; sprint → slide hint once (and
  with the rebound key after rebinding); each ability type, gun pickup, ADS, full slots → one hint each.
- Labels: pause keys list reads look / aim down sights / crouch · slide; rebind scoreboard → results say the new key.
- Death/abilities/ammo/flags: shotgun headshot from tab 2 → weapon + headshot + dropped line; own grenade → "You
  took yourself out"; respawn flash; empty slot toast; cooling slot shakes + "ready in N s"; empty mag → "R TO
  RELOAD", dry → "NO AMMO — FIND A BOX"; CTF take/capture banners; dropped flag counts 20→0 then returns.
- Pause menu: Esc → two columns, map thumbnail, status line changes when dead / round over / spectating;
  backdrop click resumes, card click doesn't; Leave needs confirm; results visible dimmed while paused; `?touch`
  single column with 44 px buttons. Esc then immediate click → "Click again to resume".
- Lobby: name autofocused; Join/Create disabled until a name; Enter flows; Creating…/Joining… spinners; `/#CODE`
  with saved name → 2 s invite card (Join now / Change name); `/#BOGUS` → closed-room banner, code and hash
  cleared; 10-char `DC…` code accepted; emulator stopped → room list "Couldn't reach the server" + Retry works;
  errors read as plain sentences (raw suffix only in dev). Discord lobby (`VITE_DISCORD_CLIENT_ID` unset): Retry
  and ⚙ work.
- Connection: DevTools Offline mid-match → "Reconnecting…" banner + feed line, back online clears it, no duplicate
  player in tab 2; offline before joining → "Still connecting…" + Back to lobby after 10 s with no console errors;
  alone → waiting banner with working Copy invite, gone when tab 2 joins; join during round-over → `nextMapIn`
  counts down and results/MVP appear on click to play.
- Mobile: device toolbar landscape 667×375, 740×360, 812×375, 896×414 → no overlap between crouch/jump and slot 3,
  health between slots and aim, two-line toast clears the aim button, ammo clears reload/swap at 375 tall;
  tapping a filled slot fires it; ☰ toggles the summary with a working Close; TouchIntro shows once, "Controls
  guide" reopens it; Settings shows Look/no key bindings.
- Accessibility: Rendering → emulate reduced motion with setting System → `html.reduce-motion` toggles live,
  hitmarker still appears and disappears, vignette static, banner fades without zoom; Off overrides; On unchecks
  shake. HUD size 0.8/1.4 → panels grow inward from their corners; touch clamps at 1.2. VoiceOver reads a toast
  and an announce; Settings opens focused on Done as a dialog; map preview and dice have names.
- `npm run typecheck` and `npm run build` pass; deploy rules if Part 6's optional item is done.
