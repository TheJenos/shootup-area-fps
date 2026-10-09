import { type MouseEvent } from 'react';
import type { Game } from '../game/game';
import type { HudState } from '../game/hudStore';
import { TEAM_INFO, otherTeam } from '../game/modes';
import { GUNS } from '../game/guns';
import { SIZE_LABEL, cachedMap, isClassic } from '../game/mapgen';
import { goalOf } from '../game/rules';
import { keyLabel, type Bindings } from '../game/settings';
import { MapPreview } from './MapPreview';
import { FlagIcon, RoundClock, useCopyInvite } from './Hud';
import { useSettings } from './SettingsPanel';

/** What each key does, with the player's own bindings. */
export function controls(b: Bindings): [key: string, action: string][] {
  const k = (...codes: string[]) => codes.map(keyLabel).join(' ');
  return [
    [k(b.forward, b.left, b.back, b.right), 'move'],
    ['Mouse', 'look'],
    ['Click', 'shoot'],
    ['Right-click', 'aim down sights'],
    [k(b.jump), 'jump'],
    [k(b.sprint), 'sprint'],
    [k(b.crouch), 'crouch · while sprinting: slide'],
    [k(b.reload), 'reload'],
    [`${k(b.swap)} / wheel`, 'switch gun'],
    [k(b.interact), 'pick up / swap gun · drop flag'],
    [k(b.ability1, b.ability2, b.ability3), 'abilities'],
    [k(b.inventory), 'inventory'],
    [k(b.scoreboard), 'match summary (hold)'],
    ['Esc', 'this menu'],
  ];
}

interface Props {
  game: Game;
  hud: HudState;
  roomCode: string;
  onLeave(): void;
  onSettings(): void;
  /** Room owner: change the mode / map (restarts the round) */
  onMatchSetup(): void;
  /** Room owner: add, change or remove bots (mid-game) */
  onBots(): void;
  /** Touch devices: reopen the controls guide */
  onIntro?(): void;
}

/**
 * The menu behind Esc: on the left what's going on in the match (mode, score, clock, map, who's
 * here), on the right what you can do. The match keeps running while it's open, and the status
 * line says so. Clicking the dimmed backdrop resumes; clicking the card doesn't.
 */
export function PauseMenu({ game, hud, roomCode, onLeave, onSettings, onMatchSetup, onBots, onIntro }: Props) {
  const { bindings } = useSettings();
  const { copy, copied } = useCopyInvite(game, roomCode);
  // The game built this map already: it's in the cache.
  const layout = hud.map ? cachedMap(hud.map.spec) : null;
  const { rules } = hud;
  const team = hud.team;

  const resume = (e: MouseEvent) => {
    if (e.target === e.currentTarget) game.requestPointerLock();
  };

  let status: string;
  if (hud.spectate) status = 'Spectating — pick Back to the fight to respawn';
  else if (hud.matchEnd) {
    const next = hud.matchEnd.phase === 'results' && hud.matchEnd.mvp ? 'MVP replay' : 'next map';
    status = `Round over — ${hud.matchEnd.title} · ${next} in ${hud.matchEnd.nextIn}`;
  } else if (hud.death) status = `Dead — respawning in ${hud.death.respawnIn}`;
  else if (hud.offline) status = 'Connection lost — reconnecting…';
  else status = "You're alive — the match is still running";

  const score = () => {
    if (team) {
      return (
        <span className="score">
          <strong style={{ color: TEAM_INFO.red.color }}>Red {hud.score.red}</strong>
          {hud.flags && <FlagIcon status={hud.flags.red} />}
          <span className="muted"> – </span>
          <strong style={{ color: TEAM_INFO.blue.color }}>{hud.score.blue} Blue</strong>
          {hud.flags && <FlagIcon status={hud.flags.blue} />}
        </span>
      );
    }
    if (rules.loadout === 'gungame') {
      return <span className="score">Level <strong>{Math.min(hud.score.mine + 1, rules.limit)}</strong>/{rules.limit} · {GUNS[hud.gun].name}</span>;
    }
    return (
      <span className="score">
        You <strong>{hud.score.mine}</strong>
        {hud.score.leader && <span className="muted"> · best other {hud.score.leader.name} {hud.score.leader.kills}</span>}
      </span>
    );
  };

  return (
    <div id="pause-overlay" className="overlay" onClick={resume}>
      <div className="panel-box pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <section className="status">
          <header>
            <span className={`mode-badge ${hud.mode}`}>{rules.short}</span>
            <div>
              <h3 id="pause-title">{rules.name}</h3>
              <p className="muted goal">{goalOf(rules)}</p>
            </div>
          </header>
          <div className="row">
            <RoundClock clock={hud.clock} />
            {score()}
          </div>
          <p className="state">{status}</p>
          {/* Toasts can't float over the menu, so the latest one ("Click again to resume"...) shows here. */}
          {hud.toast && <p key={`toast-${hud.toast.n}`} className="menu-toast" role="status">{hud.toast.text}</p>}
          {team && (
            <p className="muted">
              You're on <strong style={{ color: TEAM_INFO[team].color }}>{TEAM_INFO[team].name}</strong>
            </p>
          )}
          {hud.map && (
            <div className="map">
              {layout && <MapPreview map={layout} mode={hud.mode} />}
              <div>
                <strong>{hud.map.name}</strong>
                <span className="muted">seed {hud.map.seed}{isClassic(hud.map.spec) ? '' : ` · ${SIZE_LABEL[hud.map.size]}`}</span>
                <span className="muted">{hud.playerCount} {hud.playerCount === 1 ? 'player' : 'players'} in the match</span>
              </div>
            </div>
          )}
          <p className="room">
            Room <strong>{roomCode}</strong>
            <button type="button" onClick={copy}>{copied ? 'Copied!' : game.touch ? 'Share invite' : 'Copy invite link'}</button>
          </p>
          {hud.owner && (
            <p className="muted owner">
              {hud.owner.me ? 'You own this room' : <>Owner <strong>{hud.owner.name}</strong></>}
              {hud.owner.me && <button type="button" onClick={onMatchSetup}>Change match</button>}
              {hud.owner.me && <button type="button" onClick={onBots}>Bots</button>}
            </p>
          )}
        </section>

        <section className="help">
          {game.touch ? (
            <>
              <p className="muted touch-help">
                Left thumb moves (push fully to sprint), right side looks. ● fire · ◎ aim · ⤒ jump · ⤓ crouch, or slide
                while sprinting · tap an ability to use it.
              </p>
              {onIntro && <button type="button" onClick={onIntro}>Controls guide</button>}
            </>
          ) : (
            <ul className="keys">
              {controls(bindings).map(([key, action]) => (
                <li key={action}><kbd>{key}</kbd><span>{action}</span></li>
              ))}
            </ul>
          )}
        </section>

        {/* One row along the bottom: leaving on the left, everything else, then Resume on the right. */}
        <footer className="actions">
          <button type="button" className="danger" onClick={onLeave}>Leave room</button>
          <span className="spacer" />
          <button type="button" onClick={onSettings}>Settings</button>
          <button type="button" onClick={() => (game.isSpectating ? game.stopSpectating() : game.startSpectating())}>
            {game.isSpectating ? 'Back to the fight' : 'Spectate'}
          </button>
          {team && (
            <button type="button" onClick={() => game.switchTeam()}>Switch to {TEAM_INFO[otherTeam(team)].name}</button>
          )}
          <button type="button" className="primary" onClick={() => game.requestPointerLock()} autoFocus>
            {game.touch ? 'Tap to play' : 'Resume'}
          </button>
        </footer>
      </div>
    </div>
  );
}
