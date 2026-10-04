import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ACTIONS, CROSSHAIR_COLORS, CROSSHAIR_SIZE_MAX, CROSSHAIR_SIZE_MIN, FOV_MAX, FOV_MIN, QUALITIES, RESERVED_KEYS,
  SENSITIVITY_MAX, SENSITIVITY_MIN, keyLabel, settings, type Action, type Settings,
} from '../game/settings';
import { Crosshair } from './Crosshair';

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
          <label className="setting">
            <span>Aim sensitivity</span>
            <input
              type="range"
              min={SENSITIVITY_MIN}
              max={SENSITIVITY_MAX}
              step={0.05}
              value={current.aimSensitivity}
              onChange={(e) => settings.update({ aimSensitivity: Number(e.target.value) })}
            />
            <span className="number-readout">{current.aimSensitivity.toFixed(2)}×</span>
          </label>
          <label className="setting check">
            <input
              type="checkbox"
              checked={current.aimToggle}
              onChange={(e) => settings.update({ aimToggle: e.target.checked })}
            />
            <span>Toggle aim (click right mouse button once instead of holding it)</span>
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
          <h4>Video</h4>
          <label className="setting">
            <span>Field of view</span>
            <input
              type="range"
              min={FOV_MIN}
              max={FOV_MAX}
              step={1}
              value={current.fov}
              onChange={(e) => settings.update({ fov: Number(e.target.value) })}
            />
            <span className="number-readout">{current.fov}°</span>
          </label>
          <div className="setting">
            <span>Quality</span>
            <div className="choices" role="radiogroup" aria-label="Graphics quality">
              {QUALITIES.map((q) => (
                <button
                  key={q.value}
                  type="button"
                  role="radio"
                  aria-checked={current.quality === q.value}
                  className={current.quality === q.value ? 'choice selected' : 'choice'}
                  title={q.hint}
                  onClick={() => settings.update({ quality: q.value })}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
          <p className="muted hint">{QUALITIES.find((q) => q.value === current.quality)?.hint}</p>
        </section>

        <section>
          <h4>Crosshair</h4>
          <div className="crosshair-row">
            <div className="crosshair-preview"><Crosshair /></div>
            <div className="crosshair-options">
              <div className="swatches" role="radiogroup" aria-label="Crosshair colour">
                {CROSSHAIR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={current.crosshairColor === c}
                    className={current.crosshairColor === c ? 'swatch selected' : 'swatch'}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => settings.update({ crosshairColor: c })}
                  />
                ))}
                <input
                  type="color"
                  value={current.crosshairColor}
                  aria-label="Custom crosshair colour"
                  onChange={(e) => settings.update({ crosshairColor: e.target.value })}
                />
              </div>
              <label className="setting">
                <span>Size</span>
                <input
                  type="range"
                  min={CROSSHAIR_SIZE_MIN}
                  max={CROSSHAIR_SIZE_MAX}
                  step={0.05}
                  value={current.crosshairSize}
                  onChange={(e) => settings.update({ crosshairSize: Number(e.target.value) })}
                />
                <span className="number-readout">{current.crosshairSize.toFixed(2)}×</span>
              </label>
            </div>
          </div>
        </section>

        <section>
          <h4>Audio &amp; feel</h4>
          <label className="setting">
            <span>Sound effects</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={current.sfxVolume}
              onChange={(e) => settings.update({ sfxVolume: Number(e.target.value) })}
            />
            <span className="number-readout">{Math.round(current.sfxVolume * 100)}%</span>
          </label>
          <label className="setting">
            <span>Music</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={current.musicVolume}
              onChange={(e) => settings.update({ musicVolume: Number(e.target.value) })}
            />
            <span className="number-readout">{Math.round(current.musicVolume * 100)}%</span>
          </label>
          <label className="setting check">
            <input
              type="checkbox"
              checked={current.screenShake}
              onChange={(e) => settings.update({ screenShake: e.target.checked })}
            />
            <span>Screen shake when hit</span>
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
