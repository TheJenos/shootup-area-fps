import { useEffect, useState } from 'react';
import type { Game } from '../game/game';
import type { HudState } from '../game/hudStore';
import type { ModeRules } from '../game/rules';
import { MapPicker, useMapChoice } from './MapPicker';
import { ModePicker } from './ModePicker';
import { friendlyError } from './errors';

interface Props {
  game: Game;
  hud: HudState;
  onClose(): void;
}

/**
 * Room owner only, from the pause menu: end the round now and start a new one with another mode
 * and / or map. Starts from what's being played, so changing just one of them is one click.
 */
export function MatchSetup({ game, hud, onClose }: Props) {
  const [rules, setRules] = useState<ModeRules>(hud.rules);
  const mapChoice = useMapChoice(hud.map?.spec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The mode editor on top closes itself first (its listener runs after ours).
      if (e.code !== 'Escape' || document.getElementById('mode-editor')) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await game.restartMatch(rules, mapChoice.spec());
      onClose();
    } catch (err) {
      console.error(err);
      setError(`Could not restart: ${friendlyError(err)}`);
      setBusy(false);
    }
  };

  return (
    <div id="match-setup" className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel-box" role="dialog" aria-modal="true" aria-labelledby="match-setup-title">
        <header>
          <h3 id="match-setup-title">Change match</h3>
          <button type="button" onClick={onClose}>Back</button>
        </header>

        <section>
          <h4>Mode</h4>
          <ModePicker value={rules} onChange={setRules} showBots={false} />
        </section>

        <section>
          <h4>Map</h4>
          <MapPicker choice={mapChoice} mode={rules.base} hint="Keep the seed to replay this map, or roll a new one." />
        </section>

        {error && <p className="error" role="alert">{error}</p>}

        <footer>
          <p className="muted">Ends the current round for everyone. Nobody wins it and it doesn't count on the leaderboard.</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void restart()}>
            {busy ? 'Restarting…' : 'End round & restart'}
          </button>
        </footer>
      </div>
    </div>
  );
}
