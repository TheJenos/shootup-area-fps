import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** The button before it's pressed */
  children: ReactNode;
  /** Asked in its place once it's pressed, e.g. "Leave the room?" */
  question: ReactNode;
  /** The button that does it */
  yes: string;
  /** The button that backs out */
  no: string;
  onConfirm(): void;
  className?: string;
  /** Class for the yes button (defaults to the solid danger style) */
  yesClassName?: string;
  disabled?: boolean;
  'aria-label'?: string;
  title?: string;
}

/**
 * A button for something that can't be undone (leaving, restarting the round, deleting): the first
 * press swaps it for a question with yes / no in the same spot, so a stray tap on a crowded phone
 * row does nothing yet.
 */
export function ConfirmButton({ children, question, yes, no, onConfirm, className, yesClassName = 'danger solid', disabled, title, ...rest }: Props) {
  const [asking, setAsking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Backing out puts focus back on the button, so the keyboard doesn't lose its place.
  useEffect(() => {
    if (wasAsking.current && !asking) button.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (asking) {
    return (
      <span className="confirm" role="group">
        <span className="confirm-question">{question}</span>
        <button type="button" className={yesClassName} onClick={() => { setAsking(false); onConfirm(); }} autoFocus>{yes}</button>
        <button type="button" onClick={() => setAsking(false)}>{no}</button>
      </span>
    );
  }
  return (
    <button ref={button} type="button" className={className} disabled={disabled} title={title} aria-label={rest['aria-label']} onClick={() => setAsking(true)}>
      {children}
    </button>
  );
}
