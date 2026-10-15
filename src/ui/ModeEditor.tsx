import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GAME_MODES, MODES } from '../game/modes';
import { GUNS } from '../game/gunStats';
import { LIMITS, LOADOUTS, baseRules, goalOf, normalizeRules, type LoadoutDef, type ModeRules } from '../game/rules';
import { TOUCH } from '../game/device';
import { useDialogFocus } from './useDialogFocus';
import { StepBar } from './StepBar';
import { modeFacts } from './ModePicker';

export interface EditorProps {
  initial: ModeRules;
  onCancel(): void;
  /** `save`: also keep it in "your modes" */
  onUse(rules: ModeRules, save: boolean): void;
}

const STEPS = [
  { id: 'mode', label: 'Mode' },
  { id: 'loadout', label: 'Loadout' },
  { id: 'rules', label: 'Rules' },
  { id: 'players', label: 'Players' },
] as const;
const LAST = STEPS.length - 1;
const GROUPS: LoadoutDef['group'][] = ['Standard', 'One gun', 'Two guns', 'Wild'];

/** A loadout's picture: its guns (the rifle and the map's pickups for Standard, a die for Roulette, a trophy for Gun Game) */
const loadoutIcons = (l: LoadoutDef): string[] =>
  l.guns.length ? l.guns.map((g) => GUNS[g].icon) : l.value === 'standard' ? [GUNS.rifle.icon, '＋'] : l.value === 'random' ? ['🎲'] : ['🏆'];

/**
 * Build a custom mode a step at a time, as a room is made (CreateWizard), in the menus' look: its type,
 * name and badge; its loadout as cards (one gun, two, Roulette…) and the pickups; its rules; its
 * players' health and movement. The finished mode is summed up beside the steps as it changes, and
 * saved from the last. Every step has its defaults, so any of them can be gone to straight away (editing
 * a saved mode's gravity is one click), and Back / Next / Esc walk them in order.
 */
export function ModeEditor({ initial, onCancel, onUse }: EditorProps) {
  const [draft, setDraft] = useState<ModeRules>(initial);
  const [step, setStep] = useState(0);
  /** The furthest step looked at (the step bar lights the way there) */
  const [visited, setVisited] = useState(0);
  const go = (n: number) => {
    setStep(n);
    setVisited((v) => Math.max(v, n));
  };
  const tab = STEPS[step]!.id;
  const body = useRef<HTMLDivElement>(null);
  const rules = normalizeRules(draft);
  const set = (patch: Partial<ModeRules>) => setDraft((d) => ({ ...d, ...patch }));
  const standard = rules.loadout === 'standard';
  const [lo, hi] = LIMITS.limit[rules.base];
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  // Over the whole screen, not inside the panel that opened it (its blur would make that the frame
  // `position: fixed` measures from): the menu's root, the pause menu in a match or the lobby outside.
  const [host] = useState(() => document.getElementById('pause-overlay') ?? document.getElementById('lobby') ?? document.body);

  // Esc goes back a step, and out of the editor from the first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.stopPropagation();
      if (step > 0) setStep(step - 1);
      else onCancel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [step, onCancel]);
  // Each step starts at its top, with focus on it (for keyboard and screen readers).
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    body.current?.focus({ preventScroll: true });
  }, [step]);

  /** Switching base keeps the rules but resets the limit to that base's usual one. */
  const pickBase = (base: ModeRules['base']) => set({ base, limit: baseRules(base).limit, short: draft.short === MODES[draft.base].short ? MODES[base].short : draft.short });

  type RangeKey = 'limit' | 'minutes' | 'health' | 'respawn' | 'speed' | 'gravity' | 'pickupRate' | 'recoil' | 'headSize';
  const range = (label: string, key: RangeKey, min: number, max: number, step: number, show: (v: number) => string, disabled = false) => (
    <label className={disabled ? 'setting disabled' : 'setting'}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={rules[key]} disabled={disabled} onChange={(e) => set({ [key]: Number(e.target.value) })} />
      <span className="number-readout">{show(rules[key])}</span>
    </label>
  );
  const check = (label: string, key: 'guns' | 'abilities' | 'ammo' | 'headshotsOnly', disabled = false) => (
    <label className={disabled ? 'setting check disabled' : 'setting check'}>
      <input type="checkbox" checked={rules[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  const loadoutCard = (l: LoadoutDef) => {
    const selected = rules.loadout === l.value;
    return (
      <button key={l.value} type="button" role="radio" aria-checked={selected} aria-label={l.label} aria-describedby={`loadout-${l.value}-desc`}
        className={selected ? 'loadout-card selected' : 'loadout-card'} onClick={() => set({ loadout: l.value })}>
        <span className="loadout-icons" aria-hidden="true">{loadoutIcons(l).map((icon, i) => <span key={i}>{icon}</span>)}</span>
        {selected && <span className="mode-card-check" aria-hidden="true">✓</span>}
        <strong>{l.label}</strong>
        <small id={`loadout-${l.value}-desc`}>{l.description}</small>
      </button>
    );
  };

  return createPortal(
    <div id="mode-editor" className="overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={box} className="panel-box menu-dialog" role="dialog" aria-modal="true" aria-labelledby="mode-editor-title">
        <header className="menu-dialog-head">
          <h3 id="mode-editor-title">Custom mode</h3>
          {!TOUCH && <span className="muted esc-hint"><kbd>Esc</kbd> goes back</span>}
        </header>

        <StepBar steps={STEPS} step={step} reached={LAST} visited={visited} onStep={go} label="Custom mode steps" />

        <div className="editor-main">
          <div ref={body} className="menu-dialog-body" tabIndex={-1} aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]!.label}`}>
            {tab === 'mode' && (
              <>
                <section>
                  <h4>Type</h4>
                  <div className="mode-cards" role="radiogroup" aria-label="Base mode">
                    {GAME_MODES.map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={rules.base === m} aria-label={MODES[m].name}
                        className={rules.base === m ? 'mode-card selected' : 'mode-card'} onClick={() => pickBase(m)}>
                        <span className="mode-card-top">
                          <span className={`mode-badge ${m}`}>{MODES[m].short}</span>
                          {rules.base === m && <span className="mode-card-check" aria-hidden="true">✓</span>}
                        </span>
                        <span className="mode-card-name">{MODES[m].name}</span>
                        <span className="mode-card-desc">{MODES[m].description}</span>
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <h4>Name and badge</h4>
                  <div className="name-row">
                    <input value={draft.name} maxLength={24} placeholder="Mode name" aria-label="Mode name" onChange={(e) => set({ name: e.target.value })} />
                    <input value={draft.short} maxLength={4} placeholder="TAG" aria-label="Badge (up to 4 letters)" className="tag-input"
                      onChange={(e) => set({ short: e.target.value.toUpperCase() })} />
                  </div>
                  <p className="muted hint">The badge marks the mode in the room list and on the score bar: up to 4 letters.</p>
                </section>
              </>
            )}

            {tab === 'loadout' && (
              <>
                {GROUPS.map((g) => {
                  const items = LOADOUTS.filter((l) => l.group === g && (l.value !== 'gungame' || rules.base === 'ffa'));
                  return (
                    <section key={g}>
                      <h4>{g}</h4>
                      <div className="loadout-cards" role="radiogroup" aria-label={`${g} loadouts`}>{items.map(loadoutCard)}</div>
                    </section>
                  );
                })}
                <section>
                  <h4>Guns</h4>
                  {range('Recoil', 'recoil', LIMITS.recoil[0], LIMITS.recoil[1], 0.25, (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`))}
                  {check('Headshots only (body hits do nothing)', 'headshotsOnly')}
                  <p className="muted hint">Recoil is how far each shot kicks your aim: none makes every gun a laser.</p>
                </section>
                <section>
                  <h4>Pickups</h4>
                  {check('Gun pickups', 'guns', !standard)}
                  {check('Ammo boxes', 'ammo', !standard)}
                  {check('Abilities (medkit, shield, grenades…)', 'abilities')}
                  {range('Pickup spawn rate', 'pickupRate', LIMITS.pickupRate[0], LIMITS.pickupRate[1], 0.25, (v) => `${v}×`, !rules.guns && !rules.ammo && !rules.abilities)}
                  {!standard && <p className="muted hint">The mode hands out the guns, so ammo is endless and other guns don't spawn.</p>}
                  <p className="muted hint">How quickly taken pickups come back; above 1× there are more of them about, too (up to twice as many).</p>
                </section>
              </>
            )}

            {tab === 'rules' && (
              <section>
                <h4>Winning and the clock</h4>
                {rules.loadout === 'gungame'
                  ? <p className="muted hint">Gun Game ends when someone clears all {rules.limit} guns.</p>
                  : range(
                    rules.base === 'ctf' ? 'Captures to win' : rules.base === 'snd' ? 'Rounds to win' : rules.base === 'tdm' ? 'Team kills to win'
                      : rules.base === 'inf' ? 'Starting zombies' : rules.base === 'hrd' ? 'Waves to win' : 'Kills to win',
                    'limit', lo, hi, 1, (v) => String(v),
                  )}
                {rules.base !== 'hrd' && range('Time limit', 'minutes', LIMITS.minutes[0], LIMITS.minutes[1], 1, (v) => `${v} min`)}
                {rules.base === 'hrd' ? (
                  <p className="muted hint">No clock and no respawns mid-wave: whoever goes down is back, healed and restocked, once the wave is cleared. Everyone down at once ends it. Bots in the room fight on your side; the zombies are the game's own. Bot skill sets how quickly they strike.</p>
                ) : rules.base === 'snd'
                  ? <p className="muted hint">No respawns: whoever dies sits out the rest of the round. Teams swap sides at halftime.</p>
                  : range(rules.base === 'inf' ? 'Zombie respawn' : 'Respawn', 'respawn', LIMITS.respawn[0], LIMITS.respawn[1], 1, (v) => `${v} s`)}
                {rules.base === 'inf' && (
                  <p className="muted hint">Everyone starts as a survivor; after a 15 s head start the first zombies turn. Survivors who die come back as zombies. The loadout and pickups are the survivors': zombies only have claws.</p>
                )}
              </section>
            )}

            {tab === 'players' && (
              <>
                <section>
                  <h4>Health and movement</h4>
                  {range('Health', 'health', LIMITS.health[0], LIMITS.health[1], 25, (v) => `${v} HP`)}
                  {range('Speed', 'speed', LIMITS.speed[0], LIMITS.speed[1], 0.05, (v) => `${Math.round(v * 100)}%`)}
                  {range('Gravity', 'gravity', LIMITS.gravity[0], LIMITS.gravity[1], 0.05, (v) => `${Math.round(v * 100)}%`)}
                </section>
                <section>
                  <h4>Heads</h4>
                  {range('Head size', 'headSize', LIMITS.headSize[0], LIMITS.headSize[1], 0.25, (v) => (v === 1 ? 'Normal' : `${Math.round(v * 100)}%`))}
                  <p className="muted hint">Big heads: everyone's head (and the bit that counts as a headshot) grows, bots' included. Easier headshots, and sillier fights.</p>
                </section>
              </>
            )}
          </div>

          <aside className="editor-summary" aria-label="Your mode">
            <div className="mode-preview" aria-live="polite">
              <span className="mode-preview-head"><span className={`mode-badge ${rules.base}`}>{rules.short}</span><strong>{rules.name}</strong></span>
              <p>{goalOf(rules)}</p>
              <ul className="mode-rules">
                {modeFacts(rules).map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          </aside>
        </div>

        <footer className="menu-dialog-foot">
          <button type="button" onClick={onCancel}>Cancel</button>
          <span className="push" />
          {step > 0 && <button type="button" onClick={() => setStep(step - 1)}>◂ Back</button>}
          {/* Separate elements (keys), as in CreateWizard: the Next that was clicked never becomes what's clicked next. */}
          {step < LAST ? (
            <button key="next" type="button" className="primary next" onClick={() => go(step + 1)}>Next: {STEPS[step + 1]!.label} ▸</button>
          ) : (
            <>
              <button key="once" type="button" onClick={() => onUse(rules, false)}>Use once</button>
              <button key="save" type="button" className="primary" onClick={() => onUse(rules, true)}>Save &amp; use</button>
            </>
          )}
        </footer>
      </div>
    </div>,
    host,
  );
}
