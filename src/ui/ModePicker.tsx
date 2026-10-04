import { useEffect, useState } from 'react';
import { GAME_MODES, MODES } from '../game/modes';
import {
  LIMITS, LOADOUTS, PRESETS, baseRules, deleteCustomMode, goalOf, loadCustomModes, normalizeRules, sameRules,
  saveCustomMode, tweaks, type Loadout, type ModeRules,
} from '../game/rules';

interface PickerProps {
  value: ModeRules;
  onChange(rules: ModeRules): void;
}

/**
 * Choose the room's mode: a prebuilt one, one of your saved custom modes, or build a new one.
 * Used by the lobby and the Discord lobby.
 */
export function ModePicker({ value, onChange }: PickerProps) {
  const [mine, setMine] = useState<ModeRules[]>(loadCustomModes);
  const [editing, setEditing] = useState<ModeRules | null>(null);
  const extras = tweaks(value);

  return (
    <div className="mode-picker">
      <div className="modes" role="radiogroup" aria-label="Game mode">
        {PRESETS.map((p) => (
          <ModeCard key={p.id} rules={p.rules} description={p.description} selected={sameRules(p.rules, value)} onPick={onChange} />
        ))}
        {mine.map((m) => (
          <ModeCard
            key={`mine-${m.name}`}
            rules={m}
            description={`Your mode · ${MODES[m.base].short}${tweaks(m).length ? ` · ${tweaks(m).slice(0, 2).join(' · ')}` : ''}`}
            selected={sameRules(m, value)}
            onPick={onChange}
            onEdit={() => setEditing(m)}
            onDelete={() => setMine(deleteCustomMode(m.name))}
          />
        ))}
        <button type="button" className="mode create" onClick={() => setEditing({ ...value, name: value.name.startsWith('Custom') ? value.name : 'Custom mode' })}>
          <strong>＋ Create custom mode</strong>
          <small>Pick FFA, TDM or CTF, then mix guns, health, speed, gravity…</small>
        </button>
      </div>
      <p className="mode-summary muted">
        <span className={`mode-badge ${value.base}`}>{value.short}</span>
        <strong>{value.name}</strong> — {MODES[value.base].name}
        {extras.length > 0 && <> · {extras.join(' · ')}</>}
      </p>
      {editing && (
        <ModeEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onUse={(rules, save) => {
            if (save) setMine(saveCustomMode(rules));
            onChange(rules);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ModeCard({ rules, description, selected, onPick, onEdit, onDelete }: {
  rules: ModeRules; description: string; selected: boolean; onPick(r: ModeRules): void; onEdit?(): void; onDelete?(): void;
}) {
  return (
    <div className={selected ? 'mode selected' : 'mode'}>
      <button type="button" role="radio" aria-checked={selected} className="mode-pick" onClick={() => onPick(rules)}>
        <strong><span className={`mode-badge ${rules.base}`}>{rules.short}</span>{rules.name}</strong>
        <small>{description}</small>
      </button>
      {(onEdit || onDelete) && (
        <span className="mode-tools">
          {onEdit && <button type="button" aria-label={`Edit ${rules.name}`} title="Edit" onClick={onEdit}>✎</button>}
          {onDelete && <button type="button" aria-label={`Delete ${rules.name}`} title="Delete" onClick={onDelete}>✕</button>}
        </span>
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
