import { useState, useSyncExternalStore, type MouseEvent } from 'react';
import type { Game } from '../game/game';
import type { FeedEntry, FlagStatus, HudState, MatchEnd } from '../game/hudStore';
import { ABILITIES, type SlotView } from '../game/abilities';
import { MODES, MVP_TIME, TEAM_INFO, otherTeam } from '../game/modes';
import type { Team } from '../types';
import { MatchSummary } from './MatchSummary';
import { SettingsPanel, useSettings } from './SettingsPanel';
import { keyLabel, type Bindings } from '../game/settings';
import { InventoryPanel } from './InventoryPanel';
import { safeColor } from './colors';

function controls(b: Bindings): [key: string, action: string][] {
  const k = (...codes: string[]) => codes.map(keyLabel).join(' ');
  return [
    [k(b.forward, b.left, b.back, b.right), 'move'], ['Mouse', 'aim'], ['Click', 'shoot'], [k(b.jump), 'jump'],
    [k(b.sprint), 'sprint'], [k(b.crouch), 'crouch / slide'], [k(b.reload), 'reload'], [k(b.ability1, b.ability2, b.ability3), 'abilities'],
    [k(b.inventory), 'inventory'], [k(b.scoreboard), 'match summary'],
  ];
}

function useHud(game: Game): HudState {
  return useSyncExternalStore(game.hud.subscribe, game.hud.get);
}

interface Props {
  game: Game;
  roomCode: string;
  onLeave(): void;
}

export function Hud({ game, roomCode, onLeave }: Props) {
  const hud = useHud(game);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    // The MVP replay is a cinematic: hide the crosshair, health, ammo and abilities.
    <div id="hud" className={hud.matchEnd?.phase === 'mvp' ? 'cinematic' : undefined}>
      {!hud.death && <div id="crosshair" />}
      {hud.hitmarker.n > 0 && (
        // A new key remounts the element, which restarts the CSS animation.
        <div key={`hit-${hud.hitmarker.n}`} id="hitmarker" className={hud.hitmarker.head ? 'show head' : 'show'} />
      )}
      {hud.damageFlash > 0 && <div key={`dmg-${hud.damageFlash}`} id="damage-overlay" />}
      {hud.damageIndicators.length > 0 && !hud.death && <DamageDirections indicators={hud.damageIndicators} />}

      <div id="room-tag">Room <strong>{roomCode}</strong></div>
      <ScoreBar hud={hud} />
      <KillFeed entries={hud.feed} />
      <HealthPanel hp={hud.hp} />
      <AmmoPanel ammo={hud.ammo} max={hud.magSize} reloading={hud.reloading} />
      <AbilityBar slots={hud.slots} buffs={hud.buffs} toast={hud.toast} />

      {hud.inventoryOpen && <InventoryPanel game={game} slots={hud.slots} />}

      {hud.scoreboardOpen && !hud.paused && (
        <MatchSummary
          roomCode={roomCode}
          match={hud.match}
          rows={hud.scoreboard}
          myMatch={hud.myMatch}
          map={hud.map}
          clockLeft={hud.clock?.left ?? null}
          mode={hud.mode}
          score={hud.score}
        />
      )}

      {hud.matchEnd?.phase === 'results' && !hud.paused && !hud.scoreboardOpen && <RoundResults end={hud.matchEnd} />}
      {hud.matchEnd?.phase === 'mvp' && !hud.paused && <MvpShowcase end={hud.matchEnd} />}

      {hud.death && !hud.paused && !hud.matchEnd && (
        <div id="death-overlay" className="overlay">
          <h2>You were eliminated</h2>
          <p>by <strong>{hud.death.killerName}</strong></p>
          <p className="muted">Respawning in {hud.death.respawnIn}…</p>
        </div>
      )}

      {hud.paused && (settingsOpen
        ? <SettingsPanel onClose={() => setSettingsOpen(false)} />
        : (
          <PauseMenu
            game={game}
            roomCode={roomCode}
            onLeave={onLeave}
            team={hud.team}
            map={hud.map}
            onSettings={() => setSettingsOpen(true)}
          />
        ))}

      {hud.connecting && (
        <div id="connecting-overlay" className="overlay">
          <h2>Connecting…</h2>
        </div>
      )}
    </div>
  );
}

function ScoreBar({ hud }: { hud: HudState }) {
  const { mode, team, score, flags } = hud;
  const limit = MODES[mode].limit;
  if (!team) {
    return (
      <div id="scorebar" className="ffa">
        <span className="mode">{MODES[mode].short}</span>
        <RoundClock clock={hud.clock} />
        <span>You <strong>{score.mine}</strong></span>
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
          <span className="mode">{MODES[mode].short}</span>
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

function RoundClock({ clock }: { clock: HudState['clock'] }) {
  if (!clock) return null;
  return <span className={clock.urgent ? 'clock urgent' : 'clock'}>{formatClock(clock.left)}</span>;
}

/** First screen after a round: who won, why, and the top three. */
function RoundResults({ end }: { end: MatchEnd }) {
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
        {end.mvp ? `MVP in ${end.nextIn}…` : `Next map in ${end.nextIn}…`} · hold <kbd>Tab</kbd> for the scoreboard
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

function FlagIcon({ status }: { status: FlagStatus }) {
  if (status.state === 'home') return <span className="flag home" title="At base">⚑ base</span>;
  if (status.state === 'dropped') return <span className="flag dropped" title="Dropped">⚑ dropped</span>;
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

function HealthPanel({ hp }: { hp: number }) {
  const color = hp > 60 ? 'var(--good)' : hp > 30 ? 'var(--accent)' : 'var(--danger)';
  return (
    <div id="health" className="panel">
      <span className="label">HP</span>
      <span>{Math.max(0, Math.ceil(hp))}</span>
      <div className="bar">
        <div id="health-bar" style={{ width: `${Math.max(0, hp)}%`, background: color }} />
      </div>
    </div>
  );
}

function AmmoPanel({ ammo, max, reloading }: { ammo: number; max: number; reloading: boolean }) {
  const classes = [ammo <= max * 0.2 && 'low', reloading && 'reloading'].filter(Boolean).join(' ');
  return (
    <div id="ammo" className={`panel ${classes}`}>
      <span id="ammo-value">{ammo}</span>
      <span className="label"> / {max}</span>
      <div id="reload-hint">RELOADING</div>
    </div>
  );
}

function KillFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <ul id="killfeed">
      {entries.map((e) =>
        e.kind === 'info' ? (
          <li key={e.id}><span className="muted">{e.text}</span></li>
        ) : (
          <li key={e.id} className={e.mine ? 'me' : undefined}>
            <span style={{ color: safeColor(e.killer.color) }}>{e.killer.name}</span>
            <span className="weapon">
              {e.weapon === 'grenade' ? '💣' : e.head ? <span className="head">⌖ headshot</span> : '▸'}
            </span>
            <span style={{ color: safeColor(e.victim.color) }}>{e.victim.name}</span>
          </li>
        ),
      )}
    </ul>
  );
}

function AbilityBar({ slots, buffs, toast }: Pick<HudState, 'slots' | 'buffs' | 'toast'>) {
  return (
    <div id="abilities">
      {toast && <div key={`toast-${toast.n}`} id="ability-toast">{toast.text}</div>}
      <div className="buffs">
        {buffs.speed !== null && <span className="buff speed">⚡ {buffs.speed.toFixed(1)}s</span>}
        {buffs.shield !== null && <span className="buff shield">🛡️ {buffs.shield}</span>}
      </div>
      <div className="slots">
        {slots.map((slot, i) => <AbilitySlot key={i} index={i} slot={slot} />)}
      </div>
    </div>
  );
}

function AbilitySlot({ index, slot }: { index: number; slot: SlotView | null }) {
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
    <div className={`slot ${coolingDown ? 'cooling' : 'ready'}`} title={`${def.name}: ${def.description}`}>
      <kbd>{key}</kbd>
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

function PauseMenu(
  { game, roomCode, onLeave, team, map, onSettings }: Props & Pick<HudState, 'team' | 'map'> & { onSettings(): void },
) {
  const [copied, setCopied] = useState(false);
  const { bindings } = useSettings();

  const resume = (e: MouseEvent) => {
    if (!(e.target as Element).closest('button')) game.requestPointerLock();
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}#${roomCode}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div id="pause-overlay" className="overlay" onClick={resume}>
      <h2>Click to play</h2>
      <div className="controls">
        {controls(bindings).map(([key, action]) => (
          <span key={key}><kbd>{key}</kbd> {action}</span>
        ))}
      </div>
      {team && (
        <p>
          You're on <strong style={{ color: TEAM_INFO[team].color }}>{TEAM_INFO[team].name} team</strong>{' '}
          <button onClick={() => game.switchTeam()}>Switch to {TEAM_INFO[otherTeam(team)].name}</button>
        </p>
      )}
      <p className="muted">Room code <strong>{roomCode}</strong> — share it with friends</p>
      {map && <p className="muted">Map <strong>{map.name}</strong> · seed <strong>{map.seed}</strong></p>}
      <button onClick={onSettings}>Settings (sensitivity, keys)</button>
      <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy invite link'}</button>
      <button className="danger" onClick={onLeave}>Leave room</button>
    </div>
  );
}
