import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { GENERATOR_VERSION, SIZE_LABEL, mapName, specForMode } from '../game/mapgen';
import { goalOf, type ModeRules } from '../game/rules';
import { MapPicker, useMapChoice } from './MapPicker';
import { ModeGrid } from './ModeGrid';
import { BotsField } from './ModePicker';
import { MapThumb } from './MapPreview';
import { ConfirmButton } from './ConfirmButton';
import { StepBar } from './StepBar';

/*
 * Making a match, one decision at a time: the mode, then the map, then the room itself (its name and
 * bots) with everything chosen on one card and the button that starts it. Any step already reached can be
 * gone back to (the step bar, Back, or Esc); what was chosen stays chosen. Used by the lobby (creating a
 * room), the Discord lobby (starting the voice channel's match) and the pause menu (changing the match).
 */

interface Props {
  rules: ModeRules;
  onRules(rules: ModeRules): void;
  mapChoice: ReturnType<typeof useMapChoice>;
  /** The last step's fields above the bots (e.g. the room's name); nothing inside Discord */
  roomFields?: ReactNode;
  /** The button's words and what it does */
  launchLabel: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onLaunch(): void;
  /** Under the button: why it didn't work, and a word about what happens */
  error: string;
  note?: ReactNode;
  /** Esc on the first step (back out of making a match) */
  onExit(): void;
  /** The last step's name (default Launch) */
  launchStep?: string;
  /** Bots on the last step (default yes; the pause menu has its own Bots view) */
  showBots?: boolean;
  /** Ask before launching, in the button's place (e.g. ending a round everyone's playing) */
  confirm?: { question: string; yes: string; no: string };
}

export function CreateWizard({
  rules, onRules, mapChoice, roomFields, launchLabel, busyLabel, busy, disabled, onLaunch, error, note, onExit,
  launchStep = 'Launch', showBots = true, confirm,
}: Props) {
  const steps = [{ id: 'mode', label: 'Mode' }, { id: 'map', label: 'Map' }, { id: 'launch', label: launchStep }];
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const go = (n: number) => {
    setStep(n);
    setReached((r) => Math.max(r, n));
  };
  // Each step starts at its top, with focus on it (for keyboard and screen readers).
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    body.current?.focus({ preventScroll: true });
  }, [step]);
  // Esc goes back a step (out of the overlays first: they handle their own). Taken before the game
  // sees it, which would otherwise read it as "resume".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || document.querySelector('#mode-editor, #settings')) return;
      e.stopPropagation();
      if (step > 0) setStep(step - 1);
      else onExit();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [step, onExit]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onLaunch();
  };
  const seed = mapChoice.seed;

  return (
    <div className="wizard">
      <StepBar steps={steps} step={step} reached={reached} onStep={setStep} />

      <div ref={body} className="wizard-body" tabIndex={-1} aria-label={`Step ${step + 1} of 3: ${steps[step]!.label}`}>
        {step === 0 && <ModeGrid value={rules} onChange={onRules} />}
        {step === 1 && (
          <MapPicker
            choice={mapChoice}
            mode={rules.base}
            variant="large"
            hint={<>Same seed, same map — share one to replay it. <code>classic</code> is the original arena.</>}
          />
        )}
        {step === 2 && (
          <form id="launch-form" className="launch" onSubmit={submit}>
            <div className="launch-summary">
              <button type="button" className="launch-pick mode" onClick={() => setStep(0)} aria-label={`Mode: ${rules.name}. Change`}>
                <span className={`mode-badge ${rules.base}`}>{rules.short}</span>
                <span className="text">
                  <strong>{rules.name}</strong>
                  <small className="muted">{goalOf(rules)}</small>
                </span>
                <span className="change" aria-hidden="true">Change</span>
              </button>
              <button type="button" className="launch-pick map" onClick={() => setStep(1)} aria-label={`Map: ${seed ? mapName(seed) : 'a random one'}. Change`}>
                <LaunchMap seed={seed} size={mapChoice.size} rules={rules} />
                <span className="text">
                  <strong>{seed ? mapName(seed) : 'Random map'}</strong>
                  <small className="muted">{seed ? `${SIZE_LABEL[mapChoice.size]} · seed ${seed}` : 'A fresh one when the room starts'}</small>
                </span>
                <span className="change" aria-hidden="true">Change</span>
              </button>
            </div>
            {roomFields}
            {showBots && <BotsField value={rules} onChange={onRules} />}
          </form>
        )}
      </div>

      <footer className="wizard-foot">
        {step > 0 ? <button type="button" onClick={() => setStep(step - 1)}>◂ Back</button> : <span />}
        <div className="wizard-foot-main">
          {step === 2 && error && <p className="error" role="alert">{error}</p>}
          {step === 2 && note && !error && <p className="muted note">{note}</p>}
          {/* Separate elements (keys): turning the clicked Next into the submit button would submit the form on that same click. */}
          {step < 2 ? (
            <button key="next" type="button" className="primary next" onClick={() => go(step + 1)}>
              Next: {steps[step + 1]!.label} ▸
            </button>
          ) : confirm ? (
            <ConfirmButton key="launch" className="primary create-button" yesClassName="primary" disabled={disabled}
              question={confirm.question} yes={confirm.yes} no={confirm.no} onConfirm={onLaunch}>
              {busy ? <><span className="spinner" aria-hidden="true" />{busyLabel}</> : launchLabel}
            </ConfirmButton>
          ) : (
            <button key="launch" type="submit" form="launch-form" className="primary create-button" disabled={disabled}>
              {busy ? <><span className="spinner" aria-hidden="true" />{busyLabel}</> : launchLabel}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** The chosen map, small and still, on the launch card */
function LaunchMap({ seed, size, rules }: { seed: string; size: ReturnType<typeof useMapChoice>['size']; rules: ModeRules }) {
  return <MapThumb spec={seed ? specForMode({ seed, size, gen: GENERATOR_VERSION }, rules.base) : null} mode={rules.base} />;
}
