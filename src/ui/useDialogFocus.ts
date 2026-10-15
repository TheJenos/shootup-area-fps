import { useEffect, useState, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `root`, in order (hidden ones left out). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Keyboard focus for a modal panel: moves into it when it opens, keeps Tab and Shift+Tab inside it,
 * and goes back to whatever opened it when it closes. Without this, Tab walks off into the lobby
 * (or the game) hidden behind the backdrop. `restore: false` skips the last part, for the pause menu:
 * resuming hands the keys back to the game, and a focused button there would catch Space or Enter.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, restore = true): void {
  // Read while rendering: by the time effects run, an autoFocus inside the panel has already moved focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (!root.contains(document.activeElement)) focusables(root)[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      // A panel opened on top of this one (inside it in the page) has handled the key already.
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const items = focusables(root);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      // The opener may be gone (the pause menu swaps itself for the panel it opens).
      if (restore && opener?.isConnected && opener !== document.body) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
