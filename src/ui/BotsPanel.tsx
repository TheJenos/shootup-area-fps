import { useEffect, useState } from 'react';
import type { BotRow, Game } from '../game/game';
import type { HudState } from '../game/hudStore';
import { BOT_SKILL_OPTIONS } from '../game/rules';
import { MAX_BOTS } from '../game/bot/roster';
import { MODES, TEAM_INFO } from '../game/modes';
import type { BotSkill } from '../game/bot/brain';
import type { Team } from '../types';
import { friendlyError } from './errors';

interface Props {
  game: Game;
  hud: HudState;
  onClose(): void;
}

/**
 * Room owner only, from the pause menu: the room's bots. Add one at any level (and, in team modes, on
 * either side), change a bot's level or team, or take it out, all mid-game: nothing restarts.
 * Bots stay until they're removed, however many people join.
 */
export function BotsPanel({ game, hud, onClose }: Props) {
  const [rows, setRows] = useState<BotRow[]>(() => game.botRows());
  const [skill, setSkill] = useState<BotSkill>('normal');
  const [team, setTeam] = useState<Team | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const teams = MODES[hud.rules.base].teams;

  // The list and the bots' scores, kept fresh while the panel is open.
  useEffect(() => {
    const timer = setInterval(() => setRows(game.botRows()), 400);
    return () => clearInterval(timer);
  }, [game]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  const act = async (what: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await what();
      setRows(game.botRows());
    } catch (err) {
      console.error(err);
      setError(`Could not update the bots: ${friendlyError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const full = rows.length >= MAX_BOTS;
  const teamSelect = (value: Team | null, onChange: (t: Team | null) => void, label: string) => (
    <select value={value ?? ''} aria-label={label} onChange={(e) => onChange((e.target.value || null) as Team | null)}>
      <option value="">Auto team</option>
      {(['red', 'blue'] as const).map((t) => <option key={t} value={t}>{TEAM_INFO[t].name}</option>)}
    </select>
  );

  return (
    <div id="bots-panel" className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel-box" role="dialog" aria-modal="true" aria-labelledby="bots-panel-title">
        <header>
          <h3 id="bots-panel-title">Bots <span className="muted count">{rows.length} / {MAX_BOTS}</span></h3>
          <button type="button" onClick={onClose}>Back</button>
        </header>

        <section className="bots-add" aria-label="Add a bot">
          <select value={skill} aria-label="New bot level" onChange={(e) => setSkill(e.target.value as BotSkill)}>
            {BOT_SKILL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {teams && teamSelect(team, setTeam, 'New bot team')}
          <button type="button" className="primary" disabled={busy || full} onClick={() => void act(() => game.addBot(skill, teams ? team : null))}>
            {full ? 'Room is full of bots' : 'Add bot'}
          </button>
        </section>

        {rows.length === 0 ? (
          <p className="muted empty">No bots in this room. Add some to fill it up: they join right away and stay until you take them out.</p>
        ) : (
          <ul className="bots-list">
            {rows.map((r) => (
              <li key={r.slot} className={r.playing ? undefined : 'joining'}>
                <span className="bot-name">
                  {teams && r.actualTeam && <span className={`tag ${r.actualTeam}`} title={`${TEAM_INFO[r.actualTeam].name} team`}>{TEAM_INFO[r.actualTeam].name[0]}</span>}
                  <span className="badge bot">BOT</span>
                  <strong>{r.name}</strong>
                  <span className="muted score">{r.playing ? `${r.kills} – ${r.deaths}` : 'joining…'}</span>
                </span>
                <select value={r.skill} aria-label={`${r.base}'s level`} disabled={busy}
                  onChange={(e) => void act(() => game.editBot(r.slot, { skill: e.target.value as BotSkill }))}>
                  {BOT_SKILL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {teams && teamSelect(r.team, (t) => void act(() => game.editBot(r.slot, { team: t })), `${r.base}'s team`)}
                <button type="button" className="icon" aria-label={`Remove ${r.base}`} title="Remove this bot" disabled={busy}
                  onClick={() => void act(() => game.removeBot(r.slot))}>✕</button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <footer>
          <p className="muted">Changes apply straight away; the round keeps going. You play the bots on this computer, so they leave if you do (whoever owns the room next brings them back).</p>
          <button type="button" disabled={busy || rows.length === 0} onClick={() => void act(() => game.removeAllBots())}>Remove all</button>
        </footer>
      </div>
    </div>
  );
}
