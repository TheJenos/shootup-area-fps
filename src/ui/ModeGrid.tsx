import { useRef, useState } from 'react';
import { MODES } from '../game/modes';
import { PRESETS, baseRules, deleteCustomMode, goalOf, loadCustomModes, sameMode, saveCustomMode, type ModeRules } from '../game/rules';
import { ConfirmButton } from './ConfirmButton';
import { modeFacts } from './ModePicker';
import { ModeEditor } from './ModeEditor';

/*
 * Choosing the room's mode as cards, a section per kind (Classic, Zombies, Arcade, your own), each card
 * with what the mode is in a line. Above them, the chosen mode: its goal and facts, and Customize (or
 * Edit / Delete for your own), which opens the mode editor.
 */

const CLASSIC_IDS = ['ffa', 'tdm', 'ctf', 'snd'];
/** Survivors and zombies: the two base modes, then their presets */
const isZombie = (r: ModeRules) => r.base === 'inf' || r.base === 'hrd';

const SECTIONS: { id: string; label: string; group: string; presets: typeof PRESETS }[] = [
  { id: 'classic', label: 'Classic', group: 'Classic modes', presets: PRESETS.filter((p) => CLASSIC_IDS.includes(p.id)) },
  { id: 'zombies', label: 'Zombies', group: 'Zombie modes', presets: PRESETS.filter((p) => isZombie(p.rules)) },
  { id: 'arcade', label: 'Arcade', group: 'Arcade modes', presets: PRESETS.filter((p) => !CLASSIC_IDS.includes(p.id) && !isZombie(p.rules)) },
];

interface Props {
  value: ModeRules;
  onChange(rules: ModeRules): void;
}

export function ModeGrid({ value, onChange }: Props) {
  const [mine, setMine] = useState<ModeRules[]>(loadCustomModes);
  const [editing, setEditing] = useState<ModeRules | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const presetOf = PRESETS.find((p) => sameMode(p.rules, value));
  const isMine = !presetOf && mine.some((m) => sameMode(m, value));
  /** Picking another mode keeps the room's bots */
  const pick = (rules: ModeRules) => onChange({ ...rules, bots: value.bots, botSkill: value.botSkill });

  const card = (rules: ModeRules, description: string, key: string) => {
    const selected = sameMode(rules, value);
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={rules.name}
        className={selected ? 'mode-card selected' : 'mode-card'}
        onClick={() => pick(rules)}
      >
        <span className="mode-card-top">
          <span className={`mode-badge ${rules.base}`}>{rules.short}</span>
          {selected && <span className="mode-card-check" aria-hidden="true">✓</span>}
        </span>
        <span className="mode-card-name">{rules.name}</span>
        <span className="mode-card-desc">{description}</span>
      </button>
    );
  };

  const jump = (id: string) => sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="mode-grid">
      <div className="mode-detail" aria-live="polite" aria-label="Selected mode">
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
              <ConfirmButton className="icon" aria-label={`Delete ${value.name}`} title="Delete this mode" question="Delete?" yes="Delete" no="Keep"
                onConfirm={() => { setMine(deleteCustomMode(value.name)); pick(PRESETS[0]!.rules); }}>
                ✕
              </ConfirmButton>
            )}
            <button type="button" onClick={() => setEditing(isMine ? value : { ...value, name: presetOf ? `${value.name} (custom)`.slice(0, 24) : value.name })}>
              {isMine ? 'Edit' : 'Customize'}
            </button>
          </div>
        </div>
        <p className="mode-goal">{goalOf(value)}</p>
        <ul className="mode-rules">
          {modeFacts(value).map((c) => <li key={c}>{c}</li>)}
        </ul>
      </div>

      <div className="mode-jump" aria-label="Jump to">
        {[...SECTIONS, { id: 'yours', label: 'Yours' }].map((s) => (
          <button key={s.id} type="button" className="mode-jump-link" onClick={() => jump(s.id)}>{s.label}</button>
        ))}
      </div>

      <div className="mode-sections">
        {SECTIONS.map((s) => (
          <section key={s.id} ref={(el) => { sectionRefs.current[s.id] = el; }} className="mode-section">
            <h3>{s.label}</h3>
            <div className="mode-cards" role="radiogroup" aria-label={s.group}>
              {s.presets.map((p) => card(p.rules, p.description, p.id))}
            </div>
          </section>
        ))}
        <section ref={(el) => { sectionRefs.current.yours = el; }} className="mode-section">
          <h3>Yours</h3>
          <div className="mode-cards" role="radiogroup" aria-label="Your modes">
            {mine.map((m) => card(m, `${MODES[m.base].name} · your mode`, `mine-${m.name}`))}
          </div>
          <button type="button" className="mode-card create" onClick={() => setEditing({ ...baseRules(value.base), name: 'Custom mode' })}>
            ＋ New mode
          </button>
        </section>
      </div>

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
