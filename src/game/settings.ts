/** Player preferences (mouse + key bindings), saved in this browser. */

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'reload'
  | 'ability1' | 'ability2' | 'ability3' | 'inventory' | 'scoreboard';

export const ACTIONS: { action: Action; label: string }[] = [
  { action: 'forward', label: 'Move forward' },
  { action: 'back', label: 'Move back' },
  { action: 'left', label: 'Strafe left' },
  { action: 'right', label: 'Strafe right' },
  { action: 'jump', label: 'Jump' },
  { action: 'sprint', label: 'Sprint' },
  { action: 'crouch', label: 'Crouch (slide while sprinting)' },
  { action: 'reload', label: 'Reload' },
  { action: 'ability1', label: 'Ability slot 1' },
  { action: 'ability2', label: 'Ability slot 2' },
  { action: 'ability3', label: 'Ability slot 3' },
  { action: 'inventory', label: 'Inventory' },
  { action: 'scoreboard', label: 'Match summary (hold)' },
];

export type Bindings = Record<Action, string>;

export interface Settings {
  /** Multiplier on the base mouse speed */
  sensitivity: number;
  invertY: boolean;
  /**
   * Go fullscreen when play starts. In Chrome / Edge this also lets the game keep Ctrl+W (Cmd+W),
   * which otherwise closes the tab.
   */
  fullscreen: boolean;
  /** KeyboardEvent.code for each action */
  bindings: Bindings;
}

export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 4;

export const DEFAULT_BINDINGS: Bindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  // Ctrl + other keys are browser shortcuts (Ctrl+W closes the tab); the game guards against
  // that while playing, see Game.enterFullscreen and the keydown handler.
  crouch: 'ControlLeft',
  reload: 'KeyR',
  ability1: 'Digit1',
  ability2: 'Digit2',
  ability3: 'Digit3',
  inventory: 'KeyI',
  scoreboard: 'Tab',
};

const DEFAULTS: Settings = { sensitivity: 1, invertY: false, fullscreen: true, bindings: DEFAULT_BINDINGS };

/** Esc always releases the mouse, so it can't be bound. */
export const RESERVED_KEYS = new Set(['Escape']);

const STORAGE_KEY = 'fps-settings';
/**
 * Bumped when a default changes in a way saved settings should pick up.
 * 2: crouch moved from C to Ctrl.
 */
const VERSION = 2;

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Omit<Partial<Settings>, 'bindings'> & {
      version?: number;
      bindings?: Partial<Bindings>;
    };
    // C was only ever saved because it used to be the default; let those players get Ctrl.
    if ((saved.version ?? 1) < 2 && saved.bindings?.crouch === 'KeyC') delete saved.bindings.crouch;
    const sensitivity = Number(saved.sensitivity);
    return {
      sensitivity: Number.isFinite(sensitivity)
        ? Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, sensitivity))
        : DEFAULTS.sensitivity,
      invertY: saved.invertY === true,
      fullscreen: saved.fullscreen !== false,
      // Start from the defaults so actions added later still get a key.
      bindings: { ...DEFAULT_BINDINGS, ...pickStrings(saved.bindings) },
    };
  } catch {
    return DEFAULTS;
  }
}

function pickStrings(value: unknown): Partial<Bindings> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<Bindings> = {};
  for (const { action } of ACTIONS) {
    const code = (value as Record<string, unknown>)[action];
    if (typeof code === 'string' && code && !RESERVED_KEYS.has(code)) out[action] = code;
  }
  return out;
}

let current: Settings = load();
const listeners = new Set<() => void>();

function set(next: Settings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, version: VERSION }));
  } catch { /* storage unavailable: keep the settings for this session */ }
  listeners.forEach((l) => l());
}

export const settings = {
  get: (): Settings => current,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  update(patch: Partial<Omit<Settings, 'bindings'>>): void {
    set({ ...current, ...patch });
  },

  /** Bind `code` to `action`. If another action had that key, it takes this action's old key. */
  bind(action: Action, code: string): void {
    if (RESERVED_KEYS.has(code)) return;
    const bindings = { ...current.bindings };
    const previous = bindings[action];
    const clash = ACTIONS.find((a) => a.action !== action && bindings[a.action] === code);
    if (clash) bindings[clash.action] = previous;
    bindings[action] = code;
    set({ ...current, bindings });
  },

  reset(): void {
    set(DEFAULTS);
  },
};

/** The key currently bound to `action`. */
export const keyFor = (action: Action): string => current.bindings[action];

/** Which action, if any, `code` is bound to. */
export function actionFor(code: string): Action | null {
  const found = ACTIONS.find((a) => current.bindings[a.action] === code);
  return found ? found.action : null;
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'L Alt', AltRight: 'R Alt', MetaLeft: 'L Cmd', MetaRight: 'R Cmd',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** Short label for a KeyboardEvent.code, e.g. KeyW -> W, Digit1 -> 1. */
export function keyLabel(code: string): string {
  if (NAMED_KEYS[code]) return NAMED_KEYS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
