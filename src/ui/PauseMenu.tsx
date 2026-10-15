import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Game } from '../game/game';
import type { HudState } from '../game/hudStore';
import { MODES, otherTeam, teamInfo, zombieMode } from '../game/modes';
import { GUNS } from '../game/guns';
import { SIZE_LABEL, cachedMap, isClassic } from '../game/mapgen';
import { goalOf } from '../game/rules';
import { MAX_BOTS } from '../game/bot/roster';
import { keyLabel, type Bindings } from '../game/settings';
import { MapPreview } from './MapPreview';
import { FlagIcon, RoundClock, useCopyInvite } from './Hud';
import { useSettings } from './SettingsPanel';
import { useDialogFocus } from './useDialogFocus';
import { MenuPanel, MenuRail, type MenuTab } from './MenuShell';
import { MatchSetup } from './MatchSetup';
import { BotsPanel } from './BotsPanel';

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
  /** Settings is open over the menu: it takes the keyboard until it closes */
  covered?: boolean;
  /** Touch devices: reopen the controls guide */
  onIntro?(): void;
}

type View = 'match' | 'controls' | 'setup' | 'bots';

/**
 * The menu behind Esc, laid out like the lobby: Resume first on a rail down the left, then its views
 * (what's going on in the match, the controls, and for the room's owner changing the match and the
 * bots), then spectating and switching sides, with Settings and leaving (straight away) at the foot. The chosen view
 * fills the panel on the right. The match keeps running while it's open, and the status line says so.
 * Clicking the dimmed game around the menu resumes; Esc goes back to the match view, then resumes.
 */
export function PauseMenu({ game, hud, roomCode, onLeave, onSettings, covered = false, onIntro }: Props) {
  const { bindings } = useSettings();
  const { copy, copied } = useCopyInvite(game, roomCode);
  const [view, setView] = useState<View>('match');
  const owner = !!hud.owner?.me;
  // Ownership can move on while the menu's open: the owner's views go with it.
  const shown: View = (view === 'setup' || view === 'bots') && !owner ? 'match' : view;
  // The game built this map already: it's in the cache.
  const layout = hud.map ? cachedMap(hud.map.spec) : null;
  const { rules } = hud;
  const team = hud.team;
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root, false);
  const botCount = owner ? game.botRows().length : 0;
  // The owner's computer plays the room's bots, so they go when the owner does.
  const takesBots = owner && botCount > 0;

  // Esc on another view goes back to the match view, before the game reads it as "resume" (the
  // change-match steps step back themselves; Settings and the mode editor close themselves).
  useEffect(() => {
    if (shown === 'match' || shown === 'setup') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || document.querySelector('#settings, #mode-editor')) return;
      e.stopPropagation();
      setView('match');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [shown]);

  /** Clicks on the dimmed game around the menu (not on the menu itself) resume */
  const resume = (e: MouseEvent) => {
    if ((e.target as HTMLElement).hasAttribute('data-backdrop')) game.requestPointerLock();
  };

  let status: string;
  if (hud.spectate) status = 'Spectating — pick Back to the fight to respawn';
  else if (hud.matchEnd) {
    const next = hud.matchEnd.phase === 'results' && hud.matchEnd.mvp ? 'MVP replay' : 'next map';
    status = `Round over — ${hud.matchEnd.title} · ${next} in ${hud.matchEnd.nextIn}`;
  } else if (hud.death) {
    status = hud.death.untilWave ? 'Down — back when your team clears the wave'
      : hud.death.infected ? `Infected — rising as a zombie in ${hud.death.respawnIn}` : `Dead — respawning in ${hud.death.respawnIn}`;
  }
  else if (hud.offline) status = 'Connection lost — reconnecting…';
  else status = "You're alive — the match is still running";

  const info = (t: 'red' | 'blue') => teamInfo(t, hud.mode);
  const score = () => {
    if (hud.horde) {
      const h = hud.horde;
      return (
        <span className="score">
          <strong>Wave {h.wave}</strong><span className="muted">/{h.waves}</span>
          <span className="muted"> · </span>
          {h.phase === 'break' ? <span className="muted">starts in {h.startsIn}</span> : <strong style={{ color: info('red').color }}>{h.left} zombies left</strong>}
          <span className="muted"> · {h.standing}/{h.players} standing</span>
        </span>
      );
    }
    if (hud.inf) {
      return (
        <span className="score">
          <strong style={{ color: info('blue').color }}>{hud.inf.survivors} {info('blue').name.toLowerCase()}</strong>
          <span className="muted"> · </span>
          <strong style={{ color: info('red').color }}>{hud.inf.zombies} {info('red').name.toLowerCase()}</strong>
        </span>
      );
    }
    if (team) {
      return (
        <span className="score">
          <strong style={{ color: info('red').color }}>{info('red').name} {hud.score.red}</strong>
          {hud.flags && <FlagIcon status={hud.flags.red} />}
          <span className="muted"> – </span>
          <strong style={{ color: info('blue').color }}>{hud.score.blue} {info('blue').name}</strong>
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

  const tabs: MenuTab[] = [
    { id: 'match', label: 'Match', short: 'Match', icon: '◎', sub: 'Score, clock and map' },
    { id: 'controls', label: 'Controls', short: 'Keys', icon: '▤', sub: game.touch ? 'Playing by touch' : 'What every key does' },
    ...(owner ? [
      { id: 'setup', label: 'Change match', short: 'Change', icon: '↻', sub: 'New mode or map' },
      { id: 'bots', label: 'Bots', short: 'Bots', icon: '◈', sub: botCount === 1 ? '1 in the room' : `${botCount} in the room` },
    ] : []),
  ];

  const titles: Record<View, string> = { match: 'This match', controls: 'Controls', setup: 'Change match', bots: 'Bots' };

  return (
    <div
      id="pause-overlay"
      ref={root}
      className="overlay pause-menu"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-title"
      inert={covered}
      onClick={resume}
      data-backdrop
    >
      <div className="pause-frame" data-backdrop>
        <header className="menu-top pause-top" data-backdrop>
          <div className="pause-heading">
            <span className="pause-kicker">Paused</span>
            <h2 id="pause-title"><span className={`mode-badge ${hud.mode}`}>{rules.short}</span>{rules.name}</h2>
          </div>
          <p className="room pause-room">
            <span className="muted">Room</span>
            <strong>{roomCode}</strong>
            <button type="button" onClick={copy}>{copied ? 'Copied!' : game.touch ? 'Share invite' : 'Copy invite link'}</button>
          </p>
        </header>

        <div className="menu-body" data-backdrop>
          <MenuRail
            label="Pause menu"
            tabsLabel="Pause menu"
            idPrefix="pause-"
            hero={
              <button type="button" className="menu-play" onClick={() => game.requestPointerLock()} aria-describedby="pause-resume-sub" autoFocus>
                <span className="label"><span aria-hidden="true">▶</span> {game.touch ? 'Tap to play' : 'Resume'}</span>
                <span className="sub" id="pause-resume-sub">{game.isSpectating ? 'Back to watching' : 'Back into the match'}</span>
              </button>
            }
            tabs={tabs}
            active={shown}
            onSelect={(id) => setView(id as View)}
            extra={
              <div className="pause-actions">
                <button type="button" className="menu-action" onClick={() => (game.isSpectating ? game.stopSpectating() : game.startSpectating())}>
                  <span className="icon" aria-hidden="true">{game.isSpectating ? '⚔\uFE0E' : '◉'}</span>
                  {game.isSpectating ? 'Back to the fight' : 'Spectate'}
                </button>
                {team && MODES[hud.mode].chooseTeams && (
                  <button type="button" className="menu-action" onClick={() => game.switchTeam()}>
                    <span className="icon" aria-hidden="true">⇄</span>Switch to {info(otherTeam(team)).name}
                  </button>
                )}
              </div>
            }
          />

          <footer className="menu-foot pause-foot">
            <button type="button" className="menu-settings" onClick={onSettings}>
              <span className="icon" aria-hidden="true">⚙</span>Settings
            </button>
            <button type="button" className="danger menu-leave" onClick={onLeave} aria-describedby={takesBots ? 'pause-leave-note' : undefined}>
              <span className="icon" aria-hidden="true">↩</span>Leave room
            </button>
            {takesBots && <p className="muted leave-note" id="pause-leave-note">Your bots leave with you.</p>}
          </footer>

          <MenuPanel
            id={shown}
            idPrefix="pause-"
            title={titles[shown]}
            aside={shown === 'bots' ? <span className="muted count">{botCount} / {MAX_BOTS}</span> : undefined}
          >
            {shown === 'match' && (
              <div className="pause-match">
                <div className="pause-score">
                  <RoundClock clock={hud.clock} />
                  {score()}
                </div>
                <p className="state">{status}</p>
                {/* Toasts can't float over the menu, so the latest one ("Click again to resume"...) shows here. */}
                {hud.toast && <p key={`toast-${hud.toast.n}`} className="menu-toast" role="status">{hud.toast.text}</p>}
                <p className="muted goal">{goalOf(rules)}</p>
                {team && (
                  <p className="team">
                    {zombieMode(hud.mode) ? "You're one of the " : "You're on "}
                    <strong style={{ color: info(team).color }}>{zombieMode(hud.mode) ? info(team).name.toLowerCase() : info(team).name}</strong>
                  </p>
                )}
                {hud.map && (
                  <div className="map">
                    {/* Still (redrawn only when dragged): the game is rendering behind the menu. */}
                    {layout && <MapPreview map={layout} mode={hud.mode} spin={false} />}
                    <div>
                      <strong>{hud.map.name}</strong>
                      <span className="muted">seed {hud.map.seed}{isClassic(hud.map.spec) ? '' : ` · ${SIZE_LABEL[hud.map.size]}`}</span>
                      <span className="muted">{hud.playerCount} {hud.playerCount === 1 ? 'player' : 'players'} in the match</span>
                    </div>
                  </div>
                )}
                {hud.owner && (
                  <p className="muted owner">
                    {hud.owner.me ? 'You own this room: change the match or its bots from the menu' : <>Owner <strong>{hud.owner.name}</strong></>}
                  </p>
                )}
              </div>
            )}
            {shown === 'controls' && (game.touch ? (
              <div className="pause-touch">
                <p className="muted touch-help">
                  Left thumb moves (push fully to sprint), right side looks. ● fire · ◎ aim · ⤒ jump · ⤓ crouch, or slide
                  while sprinting · tap an ability to use it.
                </p>
                {onIntro && <button type="button" onClick={onIntro}>Controls guide</button>}
              </div>
            ) : (
              <>
                <ul className="keys">
                  {controls(bindings).map(([key, action]) => (
                    <li key={action}><kbd>{key}</kbd><span>{action}</span></li>
                  ))}
                </ul>
                <p className="muted hint">Change any of them in Settings → Controls.</p>
              </>
            ))}
            {shown === 'setup' && <MatchSetup game={game} hud={hud} onDone={() => setView('match')} />}
            {shown === 'bots' && <BotsPanel game={game} hud={hud} />}
          </MenuPanel>
        </div>
      </div>
    </div>
  );
}
