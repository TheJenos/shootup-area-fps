import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LOW_HEALTH, type Game } from '../game/game';
import type { FeedEntry, FlagStatus, HudState, MatchEnd } from '../game/hudStore';
import { ABILITIES, type SlotView } from '../game/abilities';
import { MVP_TIME, TEAM_INFO, otherTeam } from '../game/modes';
import type { Team, WeaponKind } from '../types';
import { MatchSummary } from './MatchSummary';
import { SettingsPanel, useSettings } from './SettingsPanel';
import { keyLabel } from '../game/settings';
import { PERF_DEBUG, perfStats } from '../game/perfStats';
import { InventoryPanel } from './InventoryPanel';
import { TouchControls } from './TouchControls';
import { TouchIntro } from './TouchIntro';
import { PauseMenu } from './PauseMenu';
import { GUNS } from '../game/guns';
import type { GunKind } from '../types';
import { safeColor } from './colors';
import { Crosshair } from './Crosshair';

/** After this long on "Connecting…" we offer a way back to the lobby (ms). */
const SLOW_CONNECT_MS = 10_000;
const TOUCH_INTRO_KEY = 'fps-touch-intro';

function useHud(game: Game): HudState {
  return useSyncExternalStore(game.hud.subscribe, game.hud.get);
}

/** The icon the kill feed and death screen use for a weapon. */
export const weaponIcon = (w: WeaponKind): string =>
  (w === 'grenade' ? '💣' : w === 'flag' ? '⚑' : w === 'molotov' ? '🔥' : w === 'turret' ? '🤖' : w === 'mine' ? '💥' : GUNS[w]?.icon ?? '▸');

/** Copy (or, on phones, share) the invite link for this room. */
export function useCopyInvite(game: Game, roomCode: string): { copy(): void; copied: boolean } {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const url = `${location.origin}${location.pathname}?room=${roomCode}`;
    if (game.touch && typeof navigator.share === 'function') {
      navigator.share({ title: 'Arena FPS', text: `Join my match, room ${roomCode}`, url }).catch(() => {});
      return;
    }
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
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
  const { hudScale, showFps } = useSettings();
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

  const classes = [
    hud.matchEnd?.phase === 'mvp' && 'cinematic', // the MVP replay hides the crosshair, panels and abilities
    game.touch && 'touch',
    hud.paused && 'paused',
    hud.cloaked && 'cloaked',
    intro && 'intro',
    showFps && 'fps',
  ].filter(Boolean).join(' ');
  const inMatch = !hud.connecting && !hud.spectate;
  const waitingAlone = hud.playerCount === 1 && inMatch && !hud.paused && !hud.matchEnd && !hud.offline;

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
        <div key={`hit-${hud.hitmarker.n}`} id="hitmarker" className={hud.hitmarker.head ? 'show head' : 'show'} aria-hidden="true" />
      )}
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
      {hud.gunPrompt && !hud.death && !hud.spectate && !hud.paused && (
        <GunPrompt text={hud.gunPrompt} touch={game.touch} onTap={() => game.interact()} />
      )}
      <div id="toasts" aria-hidden="true">
        {/* While the menu is open its card shows the toast instead (nothing draws over the menu). */}
        {hud.toast && !(hud.paused && !intro) && <div key={`toast-${hud.toast.n}`} className="toast">{hud.toast.text}</div>}
      </div>
      {hud.damageIndicators.length > 0 && !hud.death && <DamageDirections indicators={hud.damageIndicators} />}

      <div id="room-tag">Room <strong>{roomCode}</strong></div>
      <ScoreBar hud={hud} />
      {(showFps || PERF_DEBUG) && <FpsCounter />}
      <KillFeed entries={hud.feed} />
      {hud.offline && !hud.connecting && (
        <div id="offline-banner" className="hud-banner danger" role="status">
          <span className="spinner" aria-hidden="true" />Reconnecting…
        </div>
      )}
      {waitingAlone && (
        <div id="waiting-banner" className="hud-banner" role="status">
          Waiting for players — share room <strong>{roomCode}</strong>
          <button type="button" onClick={copy}>{copied ? 'Copied!' : game.touch ? 'Share' : 'Copy invite'}</button>
        </div>
      )}
      {!hud.spectate && (
        <>
          <HealthPanel hp={hud.hp} max={hud.maxHp} heal={hud.heal} />
          <AmmoPanel hud={hud} touch={game.touch} />
          <AbilityBar
            slots={hud.slots}
            buffs={hud.buffs}
            denied={hud.slotDenied}
            onUse={game.touch ? (i) => game.touchAbility(i) : undefined}
          />
        </>
      )}
      {hud.spectate && !hud.paused && hud.matchEnd?.phase !== 'mvp' && <SpectateBanner spectate={hud.spectate} touch={game.touch} />}
      {game.touch && (!hud.paused || intro) && !hud.connecting && !hud.death && !hud.inventoryOpen && !hud.spectate
        && hud.matchEnd?.phase !== 'mvp' && (
        <TouchControls game={game} aiming={hud.aiming} hasSpecial={!!hud.special} scoreboardOpen={hud.scoreboardOpen} />
      )}
      {game.touch && (
        <div id="rotate-hint" className="overlay">
          <div className="phone" />
          <h2>Rotate your device</h2>
          <p className="muted">Arena FPS plays in landscape.</p>
        </div>
      )}

      {hud.inventoryOpen && <InventoryPanel game={game} slots={hud.slots} gun={hud.special} gunRounds={hud.specialRounds} />}

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

      {hud.death && !hud.paused && !hud.matchEnd && !hud.spectate && <DeathOverlay death={hud.death} />}

      {intro && !hud.connecting && (
        <TouchIntro hasSpecial={!!hud.special} onDone={() => { writeFlag(TOUCH_INTRO_KEY); setIntro(false); }} />
      )}

      {hud.paused && !intro && (settingsOpen
        ? <SettingsPanel onClose={() => setSettingsOpen(false)} />
        : (
          <PauseMenu
            game={game}
            hud={hud}
            roomCode={roomCode}
            onLeave={onLeave}
            onSettings={() => setSettingsOpen(true)}
            onIntro={game.touch ? () => setIntro(true) : undefined}
          />
        ))}

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
  return (
    <div id="death-overlay" className="overlay" role="status">
      <h2>{death.self ? 'You took yourself out' : 'You were eliminated'}</h2>
      {!death.self && (
        <p>
          by <strong>{death.killerName}</strong>
          <span className="weapon" title={death.weapon}>{weaponIcon(death.weapon)}</span>
          {death.head && death.weapon !== 'grenade' && <span className="head">⌖ headshot</span>}
        </p>
      )}
      {death.dropped && <p className="muted">Your gun and abilities dropped where you fell</p>}
      <p className="muted">Respawning in {death.respawnIn}…</p>
    </div>
  );
}

function SpectateBanner({ spectate, touch }: { spectate: NonNullable<HudState['spectate']>; touch: boolean }) {
  const { bindings } = useSettings();
  const free = spectate.target === null;
  return (
    <div id="spectate">
      <span className="label">Spectating</span>
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

function ScoreBar({ hud }: { hud: HudState }) {
  const { team, score, flags, rules } = hud;
  const { limit, short } = rules;
  /** Free-for-all: outright ahead of everyone else */
  const leading = score.mine > 0 && score.mine > (score.leader?.kills ?? 0);
  if (rules.loadout === 'gungame') {
    return (
      <div id="scorebar" className="ffa">
        <span className="mode">{short}</span>
        <RoundClock clock={hud.clock} />
        <span className={leading ? 'you leading' : 'you'}>{leading && '👑 '}Level <strong>{Math.min(score.mine + 1, limit)}</strong><span className="muted">/{limit}</span> · {GUNS[hud.gun].name}</span>
        {score.leader && (
          <span className="muted">Best other: {score.leader.name} <strong>lvl {Math.min(score.leader.kills + 1, limit)}</strong></span>
        )}
      </div>
    );
  }
  if (!team) {
    return (
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
    </div>
  );
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function RoundClock({ clock }: { clock: HudState['clock'] }) {
  if (!clock) return null;
  return <span className={clock.urgent ? 'clock urgent' : 'clock'}>{formatClock(clock.left)}</span>;
}

/** First screen after a round: who won, why, and the top three. */
function RoundResults({ end, touch }: { end: MatchEnd; touch: boolean }) {
  const { bindings } = useSettings();
  const outcome = end.draw ? 'draw' : end.won ? 'won' : 'lost';
  return (
    <div id="round-over" className={`overlay ${outcome}`}>
      <p className="muted">{end.reason === 'time' ? "Time's up" : 'Score limit reached'}</p>
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

/** Red arcs around the crosshair, each pointing toward someone who just hit us. */
function DamageDirections({ indicators }: { indicators: HudState['damageIndicators'] }) {
  return (
    <svg id="damage-directions" viewBox="-160 -160 320 320" aria-hidden="true">
      {indicators.map((d) => (
        <g key={d.id} transform={`rotate(${d.angle})`} opacity={d.opacity}>
          <path d={ARC_PATH} className="arc" strokeWidth={6 + d.strength * 8} />
          <path d={TIP_PATH} className="tip" />
        </g>
      ))}
    </svg>
  );
}

function HealthPanel({ hp, max, heal }: { hp: number; max: number; heal: HudState['heal'] }) {
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
}

function AmmoPanel({ hud, touch }: { hud: HudState; touch: boolean }) {
  const { ammo, magSize: max, reloading, gun, reserve, special } = hud;
  const { bindings } = useSettings();
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
        {/* First slot: the gun you always carry (the rifle, or the mode's gun in Sniper Only / Gun Game). */}
        {slot(special && gun === special ? 'rifle' : gun)}
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

function KillFeed({ entries }: { entries: FeedEntry[] }) {
  const tag = (team: Team | null) => team && (
    <span className={`tag ${team}`} title={`${TEAM_INFO[team].name} team`}>{TEAM_INFO[team].name[0]}</span>
  );
  return (
    <ul id="killfeed">
      {entries.map((e) =>
        e.kind === 'info' ? (
          <li key={e.id}><span className="muted">{e.text}</span></li>
        ) : (
          <li key={e.id} className={e.mine ? 'me' : undefined}>
            <span style={{ color: safeColor(e.killer.color) }}>
              {tag(e.killerTeam)}{e.killer.name}{e.me === 'killer' && <span className="you"> (you)</span>}
            </span>
            <span className="weapon">
              {weaponIcon(e.weapon)}
              {e.weapon !== 'grenade' && e.head && <span className="head"> ⌖ headshot</span>}
            </span>
            <span style={{ color: safeColor(e.victim.color) }}>
              {tag(e.victimTeam)}{e.victim.name}{e.me === 'victim' && <span className="you"> (you)</span>}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

function AbilityBar(
  { slots, buffs, denied, onUse }: Pick<HudState, 'slots' | 'buffs'> & { denied: HudState['slotDenied']; onUse?: (slot: number) => void },
) {
  return (
    <div id="abilities">
      <div className="buffs">
        {buffs.speed !== null && <span className="buff speed">⚡ {buffs.speed.toFixed(1)}s</span>}
        {buffs.shield !== null && <span className="buff shield">🛡️ {buffs.shield}</span>}
        {buffs.cloak !== null && <span className="buff cloak">👻 {buffs.cloak.toFixed(1)}s</span>}
        {buffs.lifesteal !== null && <span className="buff lifesteal">🩸 {buffs.lifesteal.toFixed(1)}s</span>}
        {buffs.scan !== null && <span className="buff scan">📡 {buffs.scan.toFixed(1)}s</span>}
      </div>
      <div className="slots">
        {slots.map((slot, i) => (
          // A denial remounts the slot so the shake restarts.
          <AbilitySlot key={denied?.slot === i ? `${i}-${denied.n}` : i} index={i} slot={slot} shake={denied?.slot === i} onUse={onUse} />
        ))}
      </div>
    </div>
  );
}

function AbilitySlot(
  { index, slot, shake, onUse }: { index: number; slot: SlotView | null; shake: boolean; onUse?: (slot: number) => void },
) {
  const { bindings } = useSettings();
  const key = keyLabel([bindings.ability1, bindings.ability2, bindings.ability3][index] ?? '');
  if (!slot) {
    return (
      <div className="slot empty">
        <kbd>{key}</kbd>
      </div>
    );
  }
  const def = ABILITIES[slot.type];
  const coolingDown = slot.cooldown > 0;
  return (
    <div
      className={`slot ${coolingDown ? 'cooling' : 'ready'}${shake ? ' shake' : ''}`}
      title={`${def.name}: ${def.description}`}
      onPointerDown={onUse ? (e) => { e.stopPropagation(); onUse(index); } : undefined}
    >
      {!onUse && <kbd>{key}</kbd>}
      <span className="icon">{def.icon}</span>
      <span className="name">{def.name}</span>
      <span className="uses">
        {Array.from({ length: def.uses }, (_, u) => (
          <i key={u} className={u < slot.usesLeft ? 'left' : undefined} />
        ))}
      </span>
      {coolingDown && (
        <div className="cooldown" style={{ height: `${(slot.cooldown / def.cooldown) * 100}%` }}>
          <span>{Math.ceil(slot.cooldown)}</span>
        </div>
      )}
    </div>
  );
}
