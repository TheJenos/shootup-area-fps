import { useState } from 'react';
import type { Game } from '../game/game';
import type { HudState } from '../game/hudStore';
import type { ModeRules } from '../game/rules';
import { useMapChoice } from './MapPicker';
import { specForMode } from '../game/mapgen';
import { friendlyError } from './errors';
import { CreateWizard } from './CreateWizard';

interface Props {
  game: Game;
  hud: HudState;
  /** Done (restarted) or backed out of */
  onDone(): void;
}

/**
 * Room owner only, a view of the pause menu: end the round now and start a new one with another mode
 * and / or map, in the same steps as making a room. Starts from what's being played, so changing just
 * one of them is a step or two.
 */
export function MatchSetup({ game, hud, onDone }: Props) {
  const [rules, setRules] = useState<ModeRules>(hud.rules);
  const mapChoice = useMapChoice(hud.map?.spec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await game.restartMatch(rules, specForMode(mapChoice.spec(), rules.base));
      onDone();
    } catch (err) {
      console.error(err);
      setError(`Could not restart: ${friendlyError(err)}`);
      setBusy(false);
    }
  };

  return (
    <CreateWizard
      rules={rules}
      onRules={setRules}
      mapChoice={mapChoice}
      launchStep="Restart"
      showBots={false}
      launchLabel="End round & restart"
      busyLabel="Restarting…"
      busy={busy}
      disabled={busy}
      confirm={{ question: 'End it for everyone?', yes: 'Yes, restart', no: 'Keep playing' }}
      onLaunch={() => void restart()}
      error={error}
      note="Ends the round for everyone. Nobody wins it and it doesn't count on the leaderboard."
      onExit={onDone}
    />
  );
}
