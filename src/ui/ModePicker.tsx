import { useEffect, useState } from 'react';
import { GAME_MODES, MODES } from '../game/modes';
import {
  BOT_SKILL_OPTIONS, LIMITS, LOADOUTS, PRESETS, baseRules, deleteCustomMode, goalOf, loadCustomModes, normalizeRules, sameMode,
  saveCustomMode, tweaks, type Loadout, type ModeRules,
} from '../game/rules';

interface PickerProps {
  value: ModeRules;
  onChange(rules: ModeRules): void;
  /** The "start with bots" setting (new rooms; a running room's bots are managed from the pause menu) */
  showBots?: boolean;
}

/** The plain base modes come first; everything else is an arcade preset. */
const CLASSIC = PRESETS.filter((p) => p.id === 'ffa' || p.id === 'tdm' || p.id === 'ctf');
const ARCADE = PRESETS.filter((p) => !CLASSIC.includes(p));

/**
 * Choose the room's mode as compact chips (Classic · Arcade · Your modes), with one card below
 * describing the selected mode and a Customize button that starts the editor from it.
 * Used by the lobby and the Discord lobby.
 */
export function ModePicker({ value, onChange, showBots = true }: PickerProps) {
  const [mine, setMine] = useState<ModeRules[]>(loadCustomModes);
  const [editing, setEditing] = useState<ModeRules | null>(null);
  const presetOf = PRESETS.find((p) => sameMode(p.rules, value));
  const isMine = !presetOf && mine.some((m) => sameMode(m, value));
  const chips = [`${value.limit} ${value.base === 'ctf' ? 'captures' : value.loadout === 'gungame' ? 'guns' : 'kills'} to win`, `${value.minutes} min`, ...tweaks(value)];
  /** Picking another mode keeps the room's bots */
  const pick = (rules: ModeRules) => onChange({ ...rules, bots: value.bots, botSkill: value.botSkill });

  const chip = (rules: ModeRules, key: string) => {
    const selected = sameMode(rules, value);
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={selected}
        className={selected ? 'mode-chip selected' : 'mode-chip'}
        title={rules.name}
        onClick={() => pick(rules)}
      >
        <span className={`mode-badge ${rules.base}`}>{rules.short}</span>{rules.name}
      </button>
    );
  };

  return (
    <div className="mode-picker">
      <div className="mode-group" role="radiogroup" aria-label="Classic modes">
        <span className="mode-group-label">Classic</span>
        <div className="mode-chips">{CLASSIC.map((p) => chip(p.rules, p.id))}</div>
      </div>
      <div className="mode-group" role="radiogroup" aria-label="Arcade modes">
        <span className="mode-group-label">Arcade</span>
        <div className="mode-chips">{ARCADE.map((p) => chip(p.rules, p.id))}</div>
      </div>
      <div className="mode-group" role="radiogroup" aria-label="Your modes">
        <span className="mode-group-label">Yours</span>
        <div className="mode-chips">
          {mine.map((m) => chip(m, `mine-${m.name}`))}
          <button type="button" className="mode-chip create" onClick={() => setEditing({ ...baseRules(value.base), name: 'Custom mode' })}>
            ＋ New mode
          </button>
        </div>
      </div>

      <div className="mode-detail" aria-live="polite">
        <div className="mode-detail-head">
          <span className={`mode-badge ${value.base}`}>{value.short}</span>
          <div className="mode-detail-title">
            <strong>{value.name}</strong>
            <small className="muted">
              {MODES[value.base].name}{presetOf ? ` · ${presetOf.description}` : isMine ? ' · your mode' : ' · custom (not saved)'}
            </small>
          </div>
          <div className="mode-detail-tools">
            {isMine && (
              <button type="button" className="icon" aria-label={`Delete ${value.name}`} title="Delete this mode"
                onClick={() => { setMine(deleteCustomMode(value.name)); pick(PRESETS[0]!.rules); }}>
                ✕
              </button>
            )}
            <button type="button" onClick={() => setEditing(isMine ? value : { ...value, name: presetOf ? `${value.name} (custom)`.slice(0, 24) : value.name })}>
              {isMine ? 'Edit' : 'Customize'}
            </button>
          </div>
        </div>
        <ul className="mode-rules">
          {chips.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </div>

      {showBots && <div className="mode-bots" role="group" aria-label="Bots">
        <label className="setting">
          <span>Bots</span>
          <input type="range" min={LIMITS.bots[0]} max={LIMITS.bots[1]} step={1} value={value.bots} aria-label="Start with bots"
            onChange={(e) => onChange({ ...value, bots: Number(e.target.value) })} />
          <span className="number-readout">{value.bots ? `${value.bots} bot${value.bots === 1 ? '' : 's'}` : 'None'}</span>
        </label>
        {value.bots > 0 && (
          <label className="setting">
            <span>Bot skill</span>
            <select value={value.botSkill} aria-label="Bot skill" onChange={(e) => onChange({ ...value, botSkill: e.target.value as ModeRules['botSkill'] })}>
              {BOT_SKILL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        <p className="muted hint">Add more, at any level, from the pause menu while you play.</p>
      </div>}

      {editing && (
        <ModeEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onUse={(rules, save) => {
            if (save) setMine(saveCustomMode({ ...rules, bots: 0, botSkill: 'normal' }));
            pick(rules);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

interface EditorProps {
  initial: ModeRules;
  onCancel(): void;
  /** `save`: also keep it in "your modes" */
  onUse(rules: ModeRules, save: boolean): void;
}

/** Build a custom mode: a base type plus every rule, with a live description. */
function ModeEditor({ initial, onCancel, onUse }: EditorProps) {
  const [draft, setDraft] = useState<ModeRules>(initial);
  const rules = normalizeRules(draft);
  const set = (patch: Partial<ModeRules>) => setDraft((d) => ({ ...d, ...patch }));
  const standard = rules.loadout === 'standard';
  const [lo, hi] = LIMITS.limit[rules.base];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onCancel]);

  /** Switching base keeps the rules but resets the limit to that base's usual one. */
  const pickBase = (base: ModeRules['base']) => set({ base, limit: baseRules(base).limit, short: draft.short === MODES[draft.base].short ? MODES[base].short : draft.short });

  const range = (label: string, key: 'limit' | 'minutes' | 'health' | 'respawn' | 'speed' | 'gravity', min: number, max: number, step: number, show: (v: number) => string) => (
    <label className="setting">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={rules[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} />
      <span className="number-readout">{show(rules[key])}</span>
    </label>
  );
  const check = (label: string, key: 'guns' | 'abilities' | 'ammo' | 'headshotsOnly', disabled = false) => (
    <label className={disabled ? 'setting check disabled' : 'setting check'}>
      <input type="checkbox" checked={rules[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );

  return (
    <div id="mode-editor" className="overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="panel-box" role="dialog" aria-modal="true" aria-labelledby="mode-editor-title">
        <header>
          <h3 id="mode-editor-title">Custom mode</h3>
          <button type="button" onClick={onCancel}>Cancel</button>
        </header>

        <section>
          <h4>Base</h4>
          <div className="choices" role="radiogroup" aria-label="Base mode">
            {GAME_MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={rules.base === m}
                className={rules.base === m ? 'choice selected' : 'choice'} onClick={() => pickBase(m)}>
                {MODES[m].name}
              </button>
            ))}
          </div>
          <div className="row name-row">
            <input value={draft.name} maxLength={24} placeholder="Mode name" aria-label="Mode name" onChange={(e) => set({ name: e.target.value })} />
            <input value={draft.short} maxLength={4} placeholder="TAG" aria-label="Badge (up to 4 letters)" className="tag-input"
              onChange={(e) => set({ short: e.target.value.toUpperCase() })} />
          </div>
        </section>

        <section>
          <h4>Weapons &amp; pickups</h4>
          <label className="setting">
            <span>Loadout</span>
            <select value={rules.loadout} onChange={(e) => set({ loadout: e.target.value as Loadout })}>
              {LOADOUTS.filter((l) => l.value !== 'gungame' || rules.base === 'ffa').map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>
          {check('Gun pickups', 'guns', !standard)}
          {check('Ammo boxes', 'ammo', !standard)}
          {check('Abilities (medkit, shield, grenades…)', 'abilities')}
          {check('Headshots only (body hits do nothing)', 'headshotsOnly')}
          {!standard && <p className="muted hint">With one gun for everyone, ammo is endless and other guns don't spawn.</p>}
        </section>

        <section>
          <h4>Round</h4>
          {rules.loadout === 'gungame'
            ? <p className="muted hint">Gun Game ends when someone clears all {rules.limit} guns.</p>
            : range(rules.base === 'ctf' ? 'Captures to win' : rules.base === 'tdm' ? 'Team kills to win' : 'Kills to win', 'limit', lo, hi, 1, (v) => String(v))}
          {range('Time limit', 'minutes', LIMITS.minutes[0], LIMITS.minutes[1], 1, (v) => `${v} min`)}
          {range('Respawn', 'respawn', LIMITS.respawn[0], LIMITS.respawn[1], 1, (v) => `${v} s`)}
        </section>

        <section>
          <h4>Players</h4>
          {range('Health', 'health', LIMITS.health[0], LIMITS.health[1], 25, (v) => `${v} HP`)}
          {range('Speed', 'speed', LIMITS.speed[0], LIMITS.speed[1], 0.05, (v) => `${Math.round(v * 100)}%`)}
          {range('Gravity', 'gravity', LIMITS.gravity[0], LIMITS.gravity[1], 0.05, (v) => `${Math.round(v * 100)}%`)}
        </section>

        <p className="mode-preview"><span className={`mode-badge ${rules.base}`}>{rules.short}</span> {goalOf(rules)}</p>

        <footer>
          <button type="button" onClick={() => onUse(rules, false)}>Use once</button>
          <button type="button" className="primary" onClick={() => onUse(rules, true)}>Save &amp; use</button>
        </footer>
      </div>
    </div>
  );
}
