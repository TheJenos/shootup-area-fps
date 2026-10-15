import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useCountdown } from './useCountdown';
import { LOW_HEALTH, type Game } from '../game/game';
import type { FeedEntry, FlagStatus, HordeView, HudState, InfView, MatchEnd, SndView, WatchedView } from '../game/hudStore';
import { ABILITIES, type SlotView } from '../game/abilities';
import { MVP_TIME, TEAM_INFO, otherTeam, teamInfo } from '../game/modes';
import type { GameMode, Team, WeaponKind } from '../types';
import { MatchSummary } from './MatchSummary';
import { SettingsPanel, useSettings } from './SettingsPanel';
import { keyLabel } from '../game/settings';
import { PERF_DEBUG, perfStats } from '../game/perfStats';
import { InventoryPanel } from './InventoryPanel';
import { TouchControls, TouchTopButtons } from './TouchControls';
import { TouchIntro } from './TouchIntro';
import { PauseMenu, controls } from './PauseMenu';
import { GUNS } from '../game/guns';
import type { GunKind } from '../types';
import { safeColor } from './colors';
import { Crosshair } from './Crosshair';

/** After this long on "Connecting…" we offer a way back to the lobby (ms). */
const SLOW_CONNECT_MS = 10_000;
/** After this long on "Reconnecting…" the banner offers the lobby (ms). */
const SLOW_OFFLINE_MS = 20_000;
const TOUCH_INTRO_KEY = 'fps-touch-intro';

function useHud(game: Game): HudState {
  return useSyncExternalStore(game.hud.subscribe, game.hud.get);
}

/** How long the first-match key list stays up (ms) */
const CONTROLS_CARD_MS = 8_000;

/** The key list, with the player's own bindings, for a few seconds on the first match (Esc shows it again) */
function ControlsCard() {
  const { bindings } = useSettings();
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), CONTROLS_CARD_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <aside id="controls-card" role="note" aria-label="Controls">
      <h3>Controls</h3>
      <ul className="keys">
        {controls(bindings).map(([key, action]) => (
          <li key={action}><kbd>{key}</kbd><span>{action}</span></li>
        ))}
      </ul>
      <p className="muted">Esc shows these again</p>
    </aside>
  );
}

/** The icon the kill feed and death screen use for a weapon. */
export const weaponIcon = (w: WeaponKind): string =>
  (w === 'bomb' ? '🧨' : w === 'grenade' ? '💣' : w === 'knife' ? '🔪' : w === 'flag' ? '⚑' : w === 'molotov' ? '🔥' : w === 'turret' ? '🤖' : w === 'mine' ? '💥'
    : w === 'claw' ? '🧟' : GUNS[w]?.icon ?? '▸');

/** Copy (or, on phones, share) the invite link for this room. */
export function useCopyInvite(game: Game, roomCode: string): { copy(): void; copied: boolean } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = () => {
    const url = `${location.origin}${location.pathname}?room=${roomCode}`;
    if (game.touch && typeof navigator.share === 'function') {
      navigator.share({ title: 'Arena FPS', text: `Join my match, room ${roomCode}`, url }).catch(() => {});
      return;
    }
    // No clipboard (not a secure context, or inside Discord): the code is on screen next to the button.
    if (!navigator.clipboard) {
      game.hud.toast(`Copy the room code: ${roomCode}`);
      return;
    }
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => game.hud.toast(`Couldn't copy — the room code is ${roomCode}`));
  };
  return { copy, copied };
}

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return true; // no storage: don't nag every load
  }
};
const writeFlag = (key: string): void => {
  try {
    localStorage.setItem(key, '1');
  } catch { /* storage unavailable */ }
};

interface Props {
  game: Game;
  roomCode: string;
  onLeave(): void;
}

export function Hud({ game, roomCode, onLeave }: Props) {
  const hud = useHud(game);
  const { hudScale, showFps, minimap: showMinimap } = useSettings();
  // Stable, or React would take the radar and the markers out and put them back on every render.
  const mountMinimap = useCallback((el: HTMLElement | null) => game.minimap.mount(el), [game]);
  const mountMarkers = useCallback((el: HTMLElement | null) => game.markers.mount(el), [game]);
  const touchAbility = useCallback((i: number) => game.touchAbility(i), [game]);
  const useTouchAbility = game.touch ? touchAbility : undefined;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Phones: the controls guide, once.
  const [intro, setIntro] = useState(() => game.touch && !readFlag(TOUCH_INTRO_KEY));
  // "Connecting…" that drags on gets a way out.
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (!hud.connecting) {
      setSlowConnect(false);
      return;
    }
    const timer = setTimeout(() => setSlowConnect(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [hud.connecting]);
  const { copy, copied } = useCopyInvite(game, roomCode);
  // "Reconnecting…" that drags on gets a way out too.
  const [slowOffline, setSlowOffline] = useState(false);
  useEffect(() => {
    if (!hud.offline) {
      setSlowOffline(false);
      return;
    }
    const timer = setTimeout(() => setSlowOffline(true), SLOW_OFFLINE_MS);
    return () => clearTimeout(timer);
  }, [hud.offline]);

  const classes = [
    hud.matchEnd?.phase === 'mvp' && 'cinematic', // the MVP replay hides the crosshair, panels and abilities
    hud.killcam && 'killcam', // the kill cam: the killer's view
    hud.watched && 'watching', // someone else's panels are up: the spectate banner moves out of their way
    game.touch && 'touch',
    hud.paused && 'paused',
    hud.cloaked && 'cloaked',
    intro && 'intro',
    showFps && 'fps',
  ].filter(Boolean).join(' ');
  const inMatch = !hud.connecting && !hud.spectate;
  // (Horde is fine to play alone.)
  const waitingAlone = hud.playerCount === 1 && inMatch && !hud.paused && !hud.matchEnd && !hud.offline && !hud.horde;

  return (
    <div id="hud" className={classes || undefined} style={{ '--hud-scale': Math.min(hudScale, game.touch ? 1.2 : 1.4) } as React.CSSProperties}>
      {/* What the visual banners say, for screen readers */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{hud.toast?.text ?? ''}</div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {hud.announce ? `${hud.announce.text} ${hud.announce.sub}`.trim() : ''}
      </div>

      {/* First, so every HUD panel draws on top of the scope's black surround. */}
      {hud.scoped && !hud.death && <ScopeOverlay />}
      {!hud.death && !hud.spectate && <Crosshair ads={hud.aiming} />}
      {hud.hitmarker.n > 0 && (
        // A new key remounts the element, which restarts the CSS animation.
        <div key={`hit-${hud.hitmarker.n}`} id="hitmarker" className={`show${hud.hitmarker.head ? ' head' : ''}${hud.hitmarker.kill ? ' kill' : ''}`} aria-hidden="true" />
      )}
      {hud.killConfirm && !hud.death && (
        <div key={`kc-${hud.killConfirm.n}`} id="kill-confirm" aria-hidden="true">ELIMINATED <strong>{hud.killConfirm.name}</strong></div>
      )}
      {hud.controlsCard > 0 && !hud.paused && <ControlsCard key={`cc-${hud.controlsCard}`} />}
      {hud.damageFlash > 0 && <div key={`dmg-${hud.damageFlash}`} id="damage-overlay" aria-hidden="true" />}
      {hud.respawnFlash > 0 && <div key={`rs-${hud.respawnFlash}`} id="respawn-flash" aria-hidden="true" />}
      {hud.cloaked && !hud.death && <div id="cloak-tint" aria-hidden="true" />}
      {hud.flash && (
        <div
          key={`flash-${hud.flash.n}`}
          id="flashbang"
          aria-hidden="true"
          style={{ '--flash': hud.flash.strength, animationDuration: `${hud.flash.seconds}s` } as React.CSSProperties}
        />
      )}
      {!hud.death && hud.hp <= hud.maxHp * LOW_HEALTH && inMatch && (
        <div id="low-health" aria-hidden="true" style={{ '--lh': 1 - Math.max(0, hud.hp) / (hud.maxHp * LOW_HEALTH) } as React.CSSProperties} />
      )}
      {hud.announce && (
        <div key={`ann-${hud.announce.n}`} id="announce" aria-hidden="true" style={{ animationDuration: `${hud.announce.ms}ms` }}>
          <strong>{hud.announce.text}</strong>
          {hud.announce.sub && <span>{hud.announce.sub}</span>}
        </div>
      )}
      {/* Always mounted, so toasts show while spectating and during the MVP replay too. */}
      {/* Not while planting or defusing: the progress bar is the prompt then (and a gun nearby would cover it). */}
      {(hud.snd?.prompt ?? hud.gunPrompt) && !hud.death && !hud.spectate && !hud.paused && !hud.snd?.channel && (
        <GunPrompt text={(hud.snd?.prompt ?? hud.gunPrompt)!} touch={game.touch} onTap={() => game.interact()} />
      )}
      {hud.snd?.channel && !hud.death && !hud.paused && (
        <BombProgress channel={hud.snd.channel} touch={game.touch} onCancel={() => game.interact()} />
      )}
      <div id="toasts" aria-hidden="true">
        {/* While the menu is open its card shows the toast instead (nothing draws over the menu). */}
        {hud.toast && !(hud.paused && !intro) && <div key={`toast-${hud.toast.n}`} className="toast">{hud.toast.text}</div>}
      </div>
      {hud.damageIndicators.length > 0 && !hud.death && <DamageDirections indicators={hud.damageIndicators} />}

      {/* The radar and the objective markers draw themselves (game/minimap.ts, game/objectiveMarkers.ts); these are their places. */}
      {showMinimap && (hud.watched || (!hud.death && !hud.spectate && !hud.matchEnd)) && <div id="minimap" ref={mountMinimap} />}
      {!hud.death && !hud.spectate && !hud.killcam && !hud.matchEnd && !hud.paused && <div id="objective-layer" ref={mountMarkers} />}
      {/* Status banners hang under the score bar, in its column, so the two never overlap. */}
      <ScoreBar hud={hud}>
        {hud.offline && !hud.connecting && (
          <div id="offline-banner" className="hud-banner danger" role="status">
            <span className="spinner" aria-hidden="true" />{slowOffline ? 'Still reconnecting…' : 'Reconnecting…'}
            {slowOffline && <button type="button" onClick={onLeave}>Back to lobby</button>}
          </div>
        )}
        {waitingAlone && (
          <div id="waiting-banner" className="hud-banner" role="status">
            Waiting for players — share room <strong>{roomCode}</strong>
            <button type="button" onClick={copy}>{copied ? 'Copied!' : game.touch ? 'Share' : 'Copy invite'}</button>
          </div>
        )}
      </ScoreBar>
      {(showFps || PERF_DEBUG) && <FpsCounter />}
      <KillFeed entries={hud.feed} mode={hud.mode} />
      {hud.watched ? (
        <WatchedPanels watched={hud.watched} />
      ) : !hud.spectate && (
        <>
          <HealthPanel hp={hud.hp} max={hud.maxHp} heal={hud.heal} />
          <AmmoPanel hud={hud} touch={game.touch} />
          <AbilityBar
            slots={hud.slots}
            buffs={hud.buffs}
            denied={hud.slotDenied}
            onUse={useTouchAbility}
          />
        </>
      )}
      {hud.spectate && !hud.paused && !hud.matchEnd && (
        <SpectateBanner spectate={hud.spectate} touch={game.touch}
          label={hud.snd?.watching ? 'Out until next round' : hud.horde?.out ? 'Out until the wave is cleared' : 'Spectating'} />
      )}
      {game.touch && (!hud.paused || intro) && !hud.connecting && !hud.death && !hud.inventoryOpen && !hud.spectate
        && hud.matchEnd?.phase !== 'mvp' && (
        <TouchControls game={game} aiming={hud.aiming} hasSpecial={!!hud.special} />
      )}
      {/* The menu and scoreboard stay reachable while dead or spectating (the rest of the controls don't). */}
      {game.touch && (!hud.paused || intro) && !hud.connecting && !hud.inventoryOpen && hud.matchEnd?.phase !== 'mvp' && (
        <TouchTopButtons game={game} scoreboardOpen={hud.scoreboardOpen} alive={!hud.death && !hud.spectate} />
      )}
      {game.touch && (
        <div id="rotate-hint" className="overlay">
          <div className="phone" />
          <h2>Rotate your device</h2>
          <p className="muted">Arena FPS plays in landscape.</p>
        </div>
      )}

      {hud.inventoryOpen && <InventoryPanel game={game} slots={hud.slots} gun={hud.special} gunRounds={hud.specialRounds} kit={hud.kit ? [hud.primary, hud.special!] : null} />}

      {hud.scoreboardOpen && !hud.paused && (
        <MatchSummary
          roomCode={roomCode}
          match={hud.match}
          rows={hud.scoreboard}
          myMatch={hud.myMatch}
          map={hud.map}
          clockLeft={hud.clock?.left ?? null}
          mode={hud.mode}
          rules={hud.rules}
          score={hud.score}
          onClose={game.touch ? () => game.setTouchScoreboard(false) : undefined}
        />
      )}

      {/* Round screens stay up behind the menu (dimmed) so a late joiner or a paused player still sees them. */}
      {hud.matchEnd?.phase === 'results' && !hud.scoreboardOpen && <RoundResults end={hud.matchEnd} touch={game.touch} />}
      {hud.matchEnd?.phase === 'mvp' && <MvpShowcase end={hud.matchEnd} />}

      {hud.death && !hud.paused && !hud.matchEnd && !hud.spectate && (hud.killcam
        ? <KillcamBanner killcam={hud.killcam} respawnIn={hud.death.respawnIn} touch={game.touch} onSkip={() => game.skipKillcam()} />
        : <DeathOverlay death={hud.death} />)}

      {intro && !hud.connecting && (
        <TouchIntro hasSpecial={!!hud.special} onDone={() => { writeFlag(TOUCH_INTRO_KEY); setIntro(false); }} />
      )}

      {/* Settings opens over the menu, as it does over the lobby. */}
      {hud.paused && !intro && (
        <>
          <PauseMenu
            game={game}
            hud={hud}
            roomCode={roomCode}
            onLeave={onLeave}
            onSettings={() => setSettingsOpen(true)}
            covered={settingsOpen}
            onIntro={game.touch ? () => setIntro(true) : undefined}
          />
          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
        </>
      )}

      {hud.connecting && (
        <div id="connecting-overlay" className="overlay" role="status">
          <img className="loading-logo" src="/brand/logo.svg" alt="" width={96} height={96} />
          <h2>{slowConnect ? 'Still connecting…' : 'Connecting…'}</h2>
          {slowConnect && (
            <>
              <p className="muted">The server isn't answering. Check your connection, or go back and try again.</p>
              <button type="button" onClick={onLeave}>Back to lobby</button>
            </>
          )}
        </div>
      )}

      {hud.mapError && !hud.connecting && (
        // Another version of the game made this room's map: playing on would mean a different map.
        <div id="map-error-overlay" className="overlay" role="alert">
          <h2>Can't load this map</h2>
          <p className="muted">{hud.mapError}</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => location.reload()}>Reload</button>
            <button type="button" onClick={onLeave}>Back to lobby</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DeathOverlay({ death }: { death: NonNullable<HudState['death']> }) {
  const title = death.late ? (death.untilWave ? 'Wave in progress' : 'Round in progress')
    : death.untilWave ? 'You went down'
    : death.infected ? 'You were infected'
      : death.weapon === 'bomb' ? 'Caught in the blast' : death.self ? 'You took yourself out' : 'You were eliminated';
  return (
    <div id="death-overlay" className={death.infected ? 'overlay infected' : 'overlay'} role="status">
      <h2>{title}</h2>
      {!death.self && !death.late && (
        <p>
          by <strong>{death.killerName}</strong>
          <span className="weapon" title={death.weapon}>{weaponIcon(death.weapon)}</span>
          {death.head && death.weapon !== 'grenade' && <span className="head">⌖ headshot</span>}
        </p>
      )}
      {death.dropped && <p className="muted">Your gun and abilities dropped where you fell</p>}
      <p className="muted">
        {death.untilWave ? "You're back when your team clears this wave"
          : death.respawnIn < 0 ? "You're in from the next round" : death.infected ? `Rising as a zombie in ${death.respawnIn}…` : `Respawning in ${death.respawnIn}…`}
      </p>
    </div>
  );
}

/** Watching how we died, through the killer's eyes: who, with what, and how to skip it. */
function KillcamBanner({ killcam, respawnIn, touch, onSkip }: {
  killcam: NonNullable<HudState['killcam']>; respawnIn: number; touch: boolean; onSkip(): void;
}) {
  const { bindings } = useSettings();
  return (
    <>
      <div id="killcam-frame" aria-hidden="true" />
      <div id="killcam" role="status">
        <span className="label">Kill cam</span>
        <strong style={{ color: killcam.color }}>{killcam.killerName}</strong>
        <span className="how">
          <span className="weapon" title={killcam.weapon}>{weaponIcon(killcam.weapon)}</span>
          {killcam.head && killcam.weapon !== 'grenade' && <span className="head">⌖ headshot</span>}
        </span>
        <span className="muted">{respawnIn < 0 ? 'Back next round' : respawnIn > 0 ? `Respawning in ${respawnIn}…` : 'Ready to respawn'}</span>
        <button type="button" className="skip" onPointerDown={(e) => { e.stopPropagation(); onSkip(); }}>
          Skip{touch ? '' : ` · ${keyLabel(bindings.jump)} / click`}
        </button>
      </div>
    </>
  );
}

function SpectateBanner({ spectate, touch, label }: { spectate: NonNullable<HudState['spectate']>; touch: boolean; label: string }) {
  const { bindings } = useSettings();
  const free = spectate.target === null;
  return (
    <div id="spectate">
      <span className="label">{label}</span>
      <strong>{spectate.target ?? 'Free camera'}</strong>
      <span className="muted">
        {touch ? (
          spectate.count > 0 ? 'tap: next player · ❚❚: menu' : 'nobody to follow · ❚❚: menu'
        ) : (
          <>
            {free
              ? `nobody to follow — free camera · ${keyLabel(bindings.forward)}${keyLabel(bindings.left)}${keyLabel(bindings.back)}${keyLabel(bindings.right)} fly · E / ${keyLabel(bindings.jump)} up · ${keyLabel(bindings.crouch)} down · ${keyLabel(bindings.sprint)} fast`
              : 'click: next player · right-click: previous'}
            {' · Esc: menu'}
          </>
        )}
      </span>
    </div>
  );
}

/** The score bar, top-centre; `children` (status banners) stack under it. */
function ScoreBar({ hud, children }: { hud: HudState; children?: React.ReactNode }) {
  const { team, score, flags, rules } = hud;
  if (hud.snd) return <SndScoreBar hud={hud} snd={hud.snd}>{children}</SndScoreBar>;
  if (hud.inf) return <InfScoreBar hud={hud} inf={hud.inf}>{children}</InfScoreBar>;
  if (hud.horde) return <HordeScoreBar hud={hud} horde={hud.horde}>{children}</HordeScoreBar>;
  const { limit, short } = rules;
  /** Free-for-all: outright ahead of everyone else */
  const leading = score.mine > 0 && score.mine > (score.leader?.kills ?? 0);
  if (rules.loadout === 'gungame') {
    return (
      <div id="scorebar-wrap">
        <div id="scorebar" className="ffa">
          <span className="mode">{short}</span>
          <RoundClock clock={hud.clock} />
          <span className={leading ? 'you leading' : 'you'}>{leading && '👑 '}Level <strong>{Math.min(score.mine + 1, limit)}</strong><span className="muted">/{limit}</span> · {GUNS[hud.gun].name}</span>
          {score.leader && (
            <span className="muted">Best other: {score.leader.name} <strong>lvl {Math.min(score.leader.kills + 1, limit)}</strong></span>
          )}
        </div>
        {children}
      </div>
    );
  }
  if (!team) {
    return (
      <div id="scorebar-wrap">
        <div id="scorebar" className="ffa">
          <span className="mode">{short}</span>
          <RoundClock clock={hud.clock} />
          <span className={leading ? 'you leading' : 'you'} title={leading ? "You're in the lead" : undefined}>
            {leading && '👑 '}You <strong>{score.mine}</strong>
          </span>
          {score.leader && (
            <span className="muted">Best other: {score.leader.name} <strong>{score.leader.kills}</strong></span>
          )}
          <span className="muted">First to {limit}</span>
        </div>
        {children}
      </div>
    );
  }
  const carrying = flags && flags[otherTeam(team)];
  const teamBox = (t: Team) => (
    <div className={`team ${t}${t === team ? ' mine' : ''}`}>
      <span className="name">{TEAM_INFO[t].name}{t === team && ' (you)'}</span>
      <strong>{score[t]}</strong>
      {flags && <FlagIcon status={flags[t]} />}
    </div>
  );
  return (
    <div id="scorebar-wrap">
      <div id="scorebar">
        {teamBox('red')}
        <div className="center">
          <span className="mode">{short}</span>
          <RoundClock clock={hud.clock} />
          <span className="muted">to {limit}</span>
        </div>
        {teamBox('blue')}
      </div>
      {carrying?.state === 'carried' && carrying.mine && (
        <div className="flag-banner carrying">You have the flag — bring it to your base!</div>
      )}
      {flags?.[team].state === 'carried' && (
        <div className="flag-banner alert">Your flag was taken — get it back!</div>
      )}
      {children}
    </div>
  );
}

/** Search & Destroy: rounds won, who's still standing on each side, the round's clock and the bomb. */
function SndScoreBar({ hud, snd, children }: { hud: HudState; snd: SndView; children?: React.ReactNode }) {
  const { team, score, rules } = hud;
  const teamBox = (t: Team) => (
    <div className={`team ${t}${t === team ? ' mine' : ''}`}>
      <span className="name">{TEAM_INFO[t].name}{t === team && ' (you)'} · {t === snd.attackers ? 'ATK' : 'DEF'}</span>
      <strong>{score[t]}</strong>
      <span className="alive-pips" aria-label={`${snd.alive[t].alive} of ${snd.alive[t].size} alive`}>
        {Array.from({ length: Math.min(snd.alive[t].size, 8) }, (_, i) => <i key={i} className={i < snd.alive[t].alive ? 'up' : 'down'} />)}
      </span>
    </div>
  );
  const status = snd.phase === 'freeze' ? 'Get ready'
    : snd.phase === 'planted' ? `💣 Planted at ${snd.site}`
      : snd.phase === 'over' ? `${TEAM_INFO[snd.over!.winner].name} take round ${snd.round}`
        : `Round ${snd.round}`;
  // Out of the round, the spectate banner says enough; planting or defusing, the progress bar does.
  let banner: { text: string; tone: 'carrying' | 'alert' } | null = null;
  if (snd.watching || snd.channel) banner = null;
  else if (snd.phase === 'planted') {
    banner = snd.attacking
      ? { text: `Bomb planted at ${snd.site} — hold the site until it blows`, tone: 'carrying' }
      : { text: `Bomb planted at ${snd.site} — defuse it!`, tone: 'alert' };
  } else if (snd.bomb === 'mine' && snd.phase !== 'over') {
    banner = { text: 'You have the bomb — plant it at site A or B', tone: 'carrying' };
  } else if (snd.attacking && snd.bomb === 'ground' && snd.phase === 'live') {
    banner = { text: 'The bomb was dropped — pick it up!', tone: 'alert' };
  }
  return (
    <div id="scorebar-wrap" className="snd">
      <div id="scorebar">
        {teamBox('red')}
        <div className="center">
          <span className="mode">{rules.short}</span>
          <RoundClock clock={hud.clock} />
          <span className={snd.phase === 'planted' ? 'phase planted' : 'phase muted'}>{status}</span>
          <span className="muted">to {rules.limit}</span>
        </div>
        {teamBox('blue')}
      </div>
      {banner && <div className={`flag-banner ${banner.tone}`}>{banner.text}</div>}
      {!banner && !snd.channel && snd.attacking && snd.carrier && snd.phase === 'live' && (
        <div className="flag-banner subtle">{snd.carrier} has the bomb</div>
      )}
      {children}
    </div>
  );
}

/** Infection: who's left on each side, the round's clock, and the head start before the outbreak. */
function InfScoreBar({ hud, inf, children }: { hud: HudState; inf: InfView; children?: React.ReactNode }) {
  const { team, rules } = hud;
  const side = (t: Team, count: number, label: string) => (
    <div className={`team ${t}${t === team ? ' mine' : ''}`}>
      <span className="name">{teamInfo(t, 'inf').name}{t === team && ' (you)'}</span>
      <strong>{count}</strong>
      <span className="muted">{label}</span>
    </div>
  );
  const status = inf.phase === 'countdown' ? `Outbreak in ${inf.turnIn}`
    : inf.phase === 'waiting' ? 'Waiting for another player'
      : inf.zombie ? 'Infect them all' : 'Survive';
  let banner: { text: string; tone: 'carrying' | 'alert' | 'subtle' } | null = null;
  if (inf.phase === 'countdown') {
    banner = { text: `Head start — find a spot to hold. Someone turns in ${inf.turnIn}…`, tone: 'subtle' };
  } else if (inf.last === 'You') {
    banner = { text: "You're the last survivor — hold out until the clock runs out!", tone: 'alert' };
  } else if (inf.last) {
    banner = inf.zombie
      ? { text: `${inf.last} is the last survivor — hunt them down`, tone: 'carrying' }
      : { text: `${inf.last} is the last survivor`, tone: 'subtle' };
  }
  return (
    <div id="scorebar-wrap" className="inf">
      <div id="scorebar">
        {side('blue', inf.survivors, 'left')}
        <div className="center">
          <span className="mode">{rules.short}</span>
          <RoundClock clock={hud.clock} />
          <span className={inf.phase === 'countdown' ? 'phase planted' : 'phase muted'}>{status}</span>
        </div>
        {side('red', inf.zombies, inf.zombies === 1 ? 'zombie' : 'zombies')}
      </div>
      {banner && <div className={`flag-banner ${banner.tone}`}>{banner.text}</div>}
      {children}
    </div>
  );
}

/** Horde: the wave, the survivors still standing, the zombies left in it, and the break before the next. */
function HordeScoreBar({ hud, horde, children }: { hud: HudState; horde: HordeView; children?: React.ReactNode }) {
  const { rules } = hud;
  const status = horde.phase === 'break' ? `Wave ${horde.wave} in ${horde.startsIn}` : horde.phase === 'cleared' ? 'Wave cleared' : 'Hold them off';
  let banner: { text: string; tone: 'carrying' | 'alert' | 'subtle' } | null = null;
  if (horde.phase === 'break') {
    banner = { text: horde.wave === 1 ? 'They\'re coming — find a spot you can hold together' : 'Regroup and restock: the next wave is bigger', tone: 'subtle' };
  } else if (horde.phase === 'live' && horde.players > 1 && horde.standing === 1 && !horde.out) {
    banner = { text: "You're the last one standing — clear the wave to bring everyone back", tone: 'alert' };
  } else if (horde.phase === 'live' && horde.left > 0 && horde.left <= 3) {
    banner = { text: `${horde.left} left — they're on your radar`, tone: 'carrying' };
  }
  return (
    <div id="scorebar-wrap" className="horde">
      <div id="scorebar">
        <div className="team blue mine">
          <span className="name">Survivors</span>
          <strong>{horde.standing}<span className="muted">/{horde.players}</span></strong>
          <span className="muted">standing</span>
        </div>
        <div className="center">
          <span className="mode">{rules.short}</span>
          <strong className="wave">Wave {horde.wave}<span className="muted">/{horde.waves}</span></strong>
          <RoundClock clock={hud.clock} />
          <span className={horde.phase === 'break' ? 'phase planted' : 'phase muted'}>{status}</span>
        </div>
        <div className="team red">
          <span className="name">Zombies</span>
          <strong>{horde.phase === 'break' ? '—' : horde.left}</strong>
          <span className="muted">{horde.best > 0 ? `best: wave ${horde.best}` : 'left'}</span>
        </div>
      </div>
      {banner && <div className={`flag-banner ${banner.tone}`}>{banner.text}</div>}
      {children}
    </div>
  );
}

/** Planting or defusing: a bar that fills while the key is held. */
function BombProgress({ channel, touch, onCancel }: { channel: NonNullable<SndView['channel']>; touch: boolean; onCancel(): void }) {
  const label = channel.kind === 'plant' ? 'Planting the bomb' : 'Defusing the bomb';
  return (
    <div
      id="bomb-progress"
      className={channel.kind}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(channel.progress * 100)}
      onPointerDown={touch ? (e) => { e.preventDefault(); e.stopPropagation(); onCancel(); } : undefined}
    >
      <span>{label}…{touch ? ' (tap to stop)' : ''}</span>
      <div className="bar"><div style={{ width: `${channel.progress * 100}%` }} /></div>
    </div>
  );
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function RoundClock({ clock }: { clock: HudState['clock'] }) {
  if (!clock) return null;
  return (
    <span className={`clock${clock.urgent ? ' urgent' : ''}${clock.overtime ? ' overtime' : ''}`} title={clock.overtime ? 'Overtime: next point wins' : undefined}>
      {clock.overtime && <small>OT </small>}{formatClock(clock.left)}
    </span>
  );
}

/** First screen after a round: who won, why, and the top three. */
function RoundResults({ end, touch }: { end: MatchEnd; touch: boolean }) {
  const { bindings } = useSettings();
  const outcome = end.draw ? 'draw' : end.won ? 'won' : 'lost';
  return (
    <div id="round-over" className={`overlay ${outcome}`}>
      <p className="muted">{end.headline ?? (end.reason === 'time' ? "Time's up" : 'Score limit reached')}</p>
      <h2>{end.title}</h2>
      {end.top.length > 0 && (
        <ol className="podium">
          {end.top.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              <span className="place">{i + 1}</span>
              <span className="dot" style={{ background: safeColor(p.color) }} />
              <strong>{p.name}</strong>
              <span className="muted">{p.score}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted">
        {end.mvp ? `MVP in ${end.nextIn}…` : `Next map in ${end.nextIn}…`} ·{' '}
        {touch ? 'tap ☰ for the scoreboard' : <>hold <kbd>{keyLabel(bindings.scoreboard)}</kbd> for the scoreboard</>}
      </p>
    </div>
  );
}

/** Second screen: letterboxed replay of the MVP's highlight, with their card. */
function MvpShowcase({ end }: { end: MatchEnd }) {
  const mvp = end.mvp;
  if (!mvp) return null;
  return (
    <div id="mvp">
      <div className="bar top" />
      <div className="bar bottom" />
      <div className="card">
        <span className="label">MVP</span>
        <h2 style={{ color: safeColor(mvp.color) }}>{mvp.me ? `${mvp.name} (you)` : mvp.name}</h2>
        <p className="title">{mvp.title}</p>
        <div className="chips">
          <span><strong>{mvp.kills}</strong> kills</span>
          <span><strong>{mvp.deaths}</strong> deaths</span>
          {mvp.captures > 0 && <span><strong>{mvp.captures}</strong> captures</span>}
          <span><strong>{mvp.damage}</strong> damage</span>
        </div>
        {/* Restarts per round; runs for the length of the MVP screen. */}
        <div className="progress"><i style={{ animationDuration: `${MVP_TIME}s` }} /></div>
      </div>
      {end.nextMap && (
        <div className="next-map">
          <span className="muted">Next map in {end.nextIn}</span>
          <strong>{end.nextMap.name}</strong>
          <span className="muted">seed {end.nextMap.seed}</span>
        </div>
      )}
    </div>
  );
}

export function FlagIcon({ status }: { status: FlagStatus }) {
  if (status.state === 'home') return <span className="flag home" title="At base">⚑ base</span>;
  if (status.state === 'dropped') {
    return <span className="flag dropped" title={`Returns in ${status.returnIn}s`}>⚑ dropped · {status.returnIn}s</span>;
  }
  return <span className="flag carried" title={`Carried by ${status.carrier}`}>⚑ {status.carrier}</span>;
}

/** Arc length of each indicator, in degrees */
const ARC = 44;
const ARC_RADIUS = 118;
const arcPoint = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return `${(Math.sin(rad) * r).toFixed(1)} ${(-Math.cos(rad) * r).toFixed(1)}`;
};
const ARC_PATH = `M ${arcPoint(-ARC / 2, ARC_RADIUS)} A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${arcPoint(ARC / 2, ARC_RADIUS)}`;
// A small arrowhead just outside the middle of the arc.
const TIP_PATH = `M ${arcPoint(-5, ARC_RADIUS + 8)} L ${arcPoint(0, ARC_RADIUS + 20)} L ${arcPoint(5, ARC_RADIUS + 8)} Z`;

/**
 * Red arcs around the crosshair, each pointing toward someone who just hit us. Each sits on a dark underlay and has
 * a bright core, so it still stands out against the red of the damage flash and the low-health vignette.
 */
function DamageDirections({ indicators }: { indicators: HudState['damageIndicators'] }) {
  return (
    <svg id="damage-directions" viewBox="-160 -160 320 320" aria-hidden="true">
      {indicators.map((d) => {
        const width = 6 + d.strength * 8;
        return (
          <g key={d.id} transform={`rotate(${d.angle})`} opacity={d.opacity}>
            <path d={ARC_PATH} className="arc-under" strokeWidth={width + 4} />
            <path d={ARC_PATH} className="arc" strokeWidth={width} />
            <path d={ARC_PATH} className="arc-core" strokeWidth={Math.max(2, width * 0.3)} />
            <path d={TIP_PATH} className="tip" />
          </g>
        );
      })}
    </svg>
  );
}

const HealthPanel = memo(function HealthPanel({ hp, max, heal }: { hp: number; max: number; heal: HudState['heal'] }) {
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));
  const color = pct > 60 ? 'var(--good)' : pct > 30 ? 'var(--accent)' : 'var(--danger)';
  return (
    <div id="health" className="panel">
      {/* A new key per kill restarts the pop and the panel glow. */}
      {heal && <span key={`heal-${heal.n}`} className="heal-pop" aria-hidden="true">+{heal.amount} HP</span>}
      {heal && <span key={`glow-${heal.n}`} className="heal-glow" aria-hidden="true" />}
      <span className="label">HP</span>
      <span>{Math.max(0, Math.ceil(hp))}</span>
      <div className="bar" aria-hidden="true">
        <div id="health-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
});

function AmmoPanel({ hud, touch }: { hud: HudState; touch: boolean }) {
  const { ammo, magSize: max, reloading, gun, reserve, special, primary } = hud;
  const { bindings } = useSettings();
  if (hud.claws) {
    return (
      <div id="ammo" className="panel melee claws">
        <div className="gun-slots"><span className="gun-slot on">🧟 Claws</span></div>
        <span id="ammo-value">ZOMBIE</span>
        <div id="reload-hint" className="show">{touch ? '● TO SWIPE' : 'CLICK TO SWIPE'} · ONE HIT INFECTS</div>
      </div>
    );
  }
  if (hud.melee) {
    return (
      <div id="ammo" className="panel melee">
        <div className="gun-slots"><span className="gun-slot on">⚑ Flag</span></div>
        <span id="ammo-value">MELEE</span>
        <div id="reload-hint" className="show">{touch ? '● TO SWING' : 'CLICK TO SWING'} · GUNS STOWED</div>
      </div>
    );
  }
  const low = ammo <= max * 0.2;
  const dry = ammo === 0 && reserve === 0;
  const classes = [low && 'low', reloading && 'reloading', dry && 'dry'].filter(Boolean).join(' ');
  // One line under the count, most urgent first.
  const hint = reloading ? 'RELOADING'
    : ammo === 0 && (reserve === null || reserve > 0) ? `${touch ? '↻' : keyLabel(bindings.reload)} TO RELOAD`
      : dry ? 'NO AMMO — FIND A BOX'
        : low ? 'LOW AMMO' : '';
  const slot = (kind: GunKind) => (
    <span className={kind === gun ? 'gun-slot on' : 'gun-slot'}>{GUNS[kind].name}</span>
  );
  return (
    <div id="ammo" className={`panel ${classes}`}>
      <div className="gun-slots">
        {/* First slot: the gun you always carry (the rifle, or the mode's gun in Sniper Only / Gun Game / a two-gun loadout). */}
        {slot(primary)}
        {special ? slot(special) : <span className="gun-slot empty">—</span>}
      </div>
      <span id="ammo-value">{ammo}</span>
      <span className="label"> / {reserve === null ? '∞' : reserve}</span>
      <div id="reload-hint" className={hint ? 'show' : undefined}>{hint || 'RELOADING'}</div>
    </div>
  );
}

/** Looking through the sniper scope: black around a round lens with a fine reticle. */
function ScopeOverlay() {
  return (
    <div id="scope" aria-hidden="true">
      <div className="lens">
        <i className="h" /><i className="v" /><i className="dot" />
      </div>
    </div>
  );
}

/** How often the FPS readout refreshes (ms) */
const FPS_SAMPLE_MS = 500;

/**
 * Frames per second, top right. Counts animation frames itself (the game renders once per frame)
 * and writes straight to the DOM twice a second, so it never re-renders the HUD.
 */
function FpsCounter() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      frames++;
      const elapsed = now - since;
      if (elapsed >= FPS_SAMPLE_MS && ref.current) {
        const fps = Math.round((frames * 1000) / elapsed);
        ref.current.textContent = PERF_DEBUG ? `${fps} FPS\n${perfLine(elapsed)}` : `${fps} FPS`;
        ref.current.className = fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
        frames = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div id="fps" ref={ref} aria-hidden="true">— FPS</div>;
}

/** `?debug` readout: CPU ms per frame (average/worst), draw calls, GPU resources, Firebase KB/s. */
function perfLine(elapsedMs: number): string {
  const p = perfStats;
  const avg = p.frames ? p.frameSum / p.frames : 0;
  const perSec = 1000 / elapsedMs / 1024;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const line = [
    `cpu ${avg.toFixed(1)}/${p.frameMax.toFixed(1)}ms`,
    `calls ${p.calls}  tris ${(p.triangles / 1000).toFixed(0)}k`,
    `prog ${p.programs}  geo ${p.geometries}  tex ${p.textures}`,
    `pixel ratio ${p.pixelRatio.toFixed(2)}`,
    `net ↑${(p.netUp * perSec).toFixed(1)} ↓${(p.netDown * perSec).toFixed(1)} KB/s`,
    heap ? `heap ${(heap.usedJSHeapSize / 1048576).toFixed(0)}MB` : '',
  ].filter(Boolean).join('\n');
  p.frameSum = p.frameMax = p.frames = p.netUp = p.netDown = 0;
  return line;
}

/** Standing on a gun: the key that takes it (on touch screens the prompt itself is the button). */
function GunPrompt({ text, touch, onTap }: { text: string; touch: boolean; onTap(): void }) {
  const { bindings } = useSettings();
  if (touch) {
    return (
      <button
        type="button"
        id="gun-prompt"
        className="touch"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onTap(); }}
      >
        ✋ {text}
      </button>
    );
  }
  return <div id="gun-prompt" role="status"><kbd>{keyLabel(bindings.interact)}</kbd> {text}</div>;
}

const KillFeed = memo(function KillFeed({ entries, mode }: { entries: FeedEntry[]; mode: GameMode }) {
  const tag = (team: Team | null) => team && (
    <span className={`tag ${team} ${mode}`} title={`${teamInfo(team, mode).name}`}>{teamInfo(team, mode).name[0]}</span>
  );
  return (
    <ul id="killfeed">
      {entries.map((e) =>
        e.kind === 'info' ? (
          <li key={e.id}><span className="muted">{e.text}</span></li>
        ) : (
          <li key={e.id} className={e.mine ? 'me' : undefined}>
            <span style={{ color: safeColor(e.killer.color) }}>
              {tag(e.killerTeam)}{e.killer.bot && !e.killer.npc && <span className="badge bot">BOT</span>}{e.killer.name}{e.me === 'killer' && <span className="you"> (you)</span>}
            </span>
            <span className="weapon">
              {weaponIcon(e.weapon)}
              {e.weapon !== 'grenade' && e.head && <span className="head"> ⌖ headshot</span>}
            </span>
            <span style={{ color: safeColor(e.victim.color) }}>
              {tag(e.victimTeam)}{e.victim.bot && !e.victim.npc && <span className="badge bot">BOT</span>}{e.victim.name}{e.me === 'victim' && <span className="you"> (you)</span>}
            </span>
          </li>
        ),
      )}
    </ul>
  );
});

/**
 * Through someone else's eyes (spectating, the kill cam, the MVP replay): their health, gun and items
 * in place of ours, from what their record tells everyone (no ammo or cooldowns: those aren't shared).
 */
const WatchedPanels = memo(function WatchedPanels({ watched }: { watched: WatchedView }) {
  const gun = GUNS[watched.gun];
  const slots: (SlotView | null)[] = watched.slots.map((s) => (s ? { type: s.type, usesLeft: s.usesLeft, readyAt: 0 } : null));
  return (
    <>
      <div id="watched-tag" style={{ '--who': safeColor(watched.color) } as React.CSSProperties}>
        <span className="label">Watching</span> <strong>{watched.name}</strong>
      </div>
      <HealthPanel hp={watched.hp} max={watched.maxHp} heal={null} />
      <div id="ammo" className={`panel watched${watched.reloading ? ' reloading' : ''}`}>
        <div className="gun-slots"><span className="gun-slot on">{gun.icon} {gun.name}</span></div>
        <span id="ammo-value">{watched.ammo ?? '—'}</span>
        <span className="label"> / {watched.reserve === null ? '∞' : watched.reserve}</span>
        <div id="reload-hint" className={watched.reloading ? 'show' : undefined}>RELOADING</div>
      </div>
      <AbilityBar slots={slots} buffs={NO_BUFFS} denied={null} showKeys={false} />
    </>
  );
});

const NO_BUFFS: HudState['buffs'] = { speed: null, shield: null, cloak: null, lifesteal: null, scan: null };

/** A running buff's chip, counting down on its own (see useCountdown) */
function Buff({ kind, icon, until }: { kind: string; icon: string; until: number }) {
  const left = useCountdown(until);
  return <span className={`buff ${kind}`}>{icon} {left.toFixed(1)}s</span>;
}

const AbilityBar = memo(function AbilityBar(
  { slots, buffs, denied, onUse, showKeys = true }: Pick<HudState, 'slots' | 'buffs'> & { denied: HudState['slotDenied']; onUse?: (slot: number) => void; showKeys?: boolean },
) {
  return (
    <div id="abilities">
      <div className="buffs">
        {buffs.speed !== null && <Buff kind="speed" icon="⚡" until={buffs.speed} />}
        {buffs.shield !== null && <span className="buff shield">🛡️ {buffs.shield}</span>}
        {buffs.cloak !== null && <Buff kind="cloak" icon="👻" until={buffs.cloak} />}
        {buffs.lifesteal !== null && <Buff kind="lifesteal" icon="🩸" until={buffs.lifesteal} />}
        {buffs.scan !== null && <Buff kind="scan" icon="📡" until={buffs.scan} />}
      </div>
      <div className="slots">
        {slots.map((slot, i) => (
          // A denial remounts the slot so the shake restarts.
          <AbilitySlot key={denied?.slot === i ? `${i}-${denied.n}` : i} index={i} slot={slot} shake={denied?.slot === i} onUse={onUse} showKeys={showKeys} />
        ))}
      </div>
    </div>
  );
});

function AbilitySlot(
  { index, slot, shake, onUse, showKeys }: { index: number; slot: SlotView | null; shake: boolean; onUse?: (slot: number) => void; showKeys: boolean },
) {
  const { bindings } = useSettings();
  const key = keyLabel([bindings.ability1, bindings.ability2, bindings.ability3][index] ?? '');
  // Someone else's slots carry no key of ours to press.
  const kbd = showKeys && !onUse ? <kbd>{key}</kbd> : null;
  // Counts down here, in this slot alone, rather than the engine re-sending the slots ten times a second.
  const cooldown = useCountdown(slot?.readyAt ?? 0);
  if (!slot) {
    return (
      <div className="slot empty">
        {kbd}
      </div>
    );
  }
  const def = ABILITIES[slot.type];
  const coolingDown = cooldown > 0;
  return (
    <div
      className={`slot ${coolingDown ? 'cooling' : 'ready'}${shake ? ' shake' : ''}`}
      title={`${def.name}: ${def.description}`}
      onPointerDown={onUse ? (e) => { e.stopPropagation(); onUse(index); } : undefined}
    >
      {kbd}
      <span className="icon">{def.icon}</span>
      <span className="name">{def.name}</span>
      <span className="uses">
        {Array.from({ length: def.uses }, (_, u) => (
          <i key={u} className={u < slot.usesLeft ? 'left' : undefined} />
        ))}
      </span>
      {coolingDown && (
        <div className="cooldown" style={{ height: `${(cooldown / def.cooldown) * 100}%` }}>
          <span>{Math.ceil(cooldown)}</span>
        </div>
      )}
    </div>
  );
}
