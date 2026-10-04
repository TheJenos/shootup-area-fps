import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ACTIONS, RESERVED_KEYS, SENSITIVITY_MAX, SENSITIVITY_MIN, keyLabel, settings, type Action, type Settings,
} from '../game/settings';

export function useSettings(): Settings {
  return useSyncExternalStore(settings.subscribe, settings.get);
}

interface Props {
  onClose(): void;
}

/** Mouse sensitivity and key bindings. Opened from the lobby or the pause menu. */
export function SettingsPanel({ onClose }: Props) {
  const current = useSettings();
  const [listening, setListening] = useState<Action | null>(null);

  // While waiting for a key, swallow it before the game (or the browser) sees it.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!RESERVED_KEYS.has(e.code)) settings.bind(listening, e.code);
      setListening(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [listening]);

  return (
    <div id="settings" className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel-box">
        <header>
          <h3>Settings</h3>
          <button onClick={onClose}>Done</button>
        </header>

        <section>
          <h4>Mouse</h4>
          <label className="setting">
            <span>Sensitivity</span>
            <input
              type="range"
              min={SENSITIVITY_MIN}
              max={SENSITIVITY_MAX}
              step={0.05}
              value={current.sensitivity}
              onChange={(e) => settings.update({ sensitivity: Number(e.target.value) })}
            />
            <input
              type="number"
              className="number"
              min={SENSITIVITY_MIN}
              max={SENSITIVITY_MAX}
              step={0.05}
              value={current.sensitivity}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= SENSITIVITY_MIN && v <= SENSITIVITY_MAX) settings.update({ sensitivity: v });
              }}
            />
          </label>
          <label className="setting check">
            <input
              type="checkbox"
              checked={current.invertY}
              onChange={(e) => settings.update({ invertY: e.target.checked })}
            />
            <span>Invert vertical look</span>
          </label>
          <label className="setting check">
            <input
              type="checkbox"
              checked={current.fullscreen}
              onChange={(e) => settings.update({ fullscreen: e.target.checked })}
            />
            <span>Fullscreen while playing (in Chrome / Edge this stops Ctrl+W from closing the tab)</span>
          </label>
        </section>

        <section>
          <h4>Key bindings</h4>
          <p className="muted hint">
            Click a key, then press the new one. Taking a key used elsewhere swaps the two. <kbd>Esc</kbd> cancels.
          </p>
          <div className="bindings">
            {ACTIONS.map(({ action, label }) => (
              <div key={action} className="binding">
                <span>{label}</span>
                <button
                  className={listening === action ? 'key listening' : 'key'}
                  onClick={() => setListening(listening === action ? null : action)}
                >
                  {listening === action ? 'Press a key…' : keyLabel(current.bindings[action])}
                </button>
              </div>
            ))}
          </div>
          <p className="muted hint">Shooting is always left click; <kbd>Esc</kbd> always pauses.</p>
        </section>

        <footer>
          <button className="danger" onClick={() => settings.reset()}>Reset to defaults</button>
        </footer>
      </div>
    </div>
  );
}
