/**
 * The steps of a flow along the top (making a room, building a mode): a numbered button each, joined by
 * a line. Steps up to `reached` can be gone to; the ones behind the current step show a tick, and the
 * line up to the furthest step `visited` is lit.
 */
export function StepBar({ steps, step, reached, visited = reached, onStep, label = 'Steps' }: {
  steps: readonly { id: string; label: string }[];
  step: number;
  reached: number;
  visited?: number;
  onStep(i: number): void;
  label?: string;
}) {
  return (
    <ol className="wizard-steps" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.id} className={i === step ? 'current' : i < step || i <= visited ? 'done' : undefined}>
          <button type="button" disabled={i > reached} aria-current={i === step ? 'step' : undefined} onClick={() => onStep(i)}>
            <span className="num" aria-hidden="true">{i < step ? '✓' : i + 1}</span>
            <span className="step-label">{s.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
