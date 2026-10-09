/** Player preferences (mouse + key bindings), saved in this browser. */

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'reload' | 'swap' | 'knife'
  | 'interact' | 'ability1' | 'ability2' | 'ability3' | 'inventory' | 'scoreboard';

export const ACTIONS: { action: Action; label: string }[] = [
  { action: 'forward', label: 'Move forward' },
  { action: 'back', label: 'Move back' },
  { action: 'left', label: 'Strafe left' },
  { action: 'right', label: 'Strafe right' },
  { action: 'jump', label: 'Jump' },
  { action: 'sprint', label: 'Sprint' },
  { action: 'crouch', label: 'Crouch (slide while sprinting)' },
  { action: 'reload', label: 'Reload' },
  { action: 'swap', label: 'Switch gun' },
  { action: 'knife', label: 'Knife' },
  { action: 'interact', label: 'Pick up / swap gun, drop flag' },
  { action: 'ability1', label: 'Ability slot 1' },
  { action: 'ability2', label: 'Ability slot 2' },
  { action: 'ability3', label: 'Ability slot 3' },
  { action: 'inventory', label: 'Inventory' },
  { action: 'scoreboard', label: 'Match summary (hold)' },
];

export type Bindings = Record<Action, string>;

export type Quality = 'low' | 'medium' | 'high';
export type MotionPref = 'system' | 'reduce' | 'full';

export interface Settings {
  /** Multiplier on the base mouse speed */
  sensitivity: number;
  invertY: boolean;
  /**
   * Go fullscreen when play starts. In Chrome / Edge this also lets the game keep Ctrl+W (Cmd+W),
   * which otherwise closes the tab.
   */
  fullscreen: boolean;
  /** Right-click toggles aiming instead of having to hold it */
  aimToggle: boolean;
  /** Extra multiplier on mouse speed while aiming (on top of the zoom) */
  aimSensitivity: number;
  /** Field of view at the hip, degrees */
  fov: number;
  /** Crosshair colour (CSS) and size multiplier */
  crosshairColor: string;
  crosshairSize: number;
  /** Rendering: resolution cap and shadows */
  quality: Quality;
  /** Camera shake when hit */
  screenShake: boolean;
  /** Pulsing / zooming HUD animations: follow the OS, or force on/off */
  reduceMotion: MotionPref;
  /** Size multiplier for the HUD panels */
  hudScale: number;
  /** Frames-per-second counter in the top-right corner */
  showFps: boolean;
  /** After being killed, replay the last moments through the killer's eyes (skippable) */
  killcam: boolean;
  /** 0..1 */
  sfxVolume: number;
  musicVolume: number;
  /** KeyboardEvent.code for each action */
  bindings: Bindings;
}

export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 4;
export const FOV_MIN = 60;
export const FOV_MAX = 110;
export const FOV_DEFAULT = 75;
export const CROSSHAIR_SIZE_MIN = 0.6;
export const CROSSHAIR_SIZE_MAX = 1.8;
export const CROSSHAIR_COLORS = ['#ffffff', '#5ce08a', '#3ff0ff', '#ffe14d', '#ff4dd2', '#ff5a5a'];
export const HUD_SCALE_MIN = 0.8;
export const HUD_SCALE_MAX = 1.4;
export const MOTION_OPTIONS: { value: MotionPref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: "Follow the device's reduce-motion setting" },
  { value: 'reduce', label: 'On', hint: 'No pulsing, zooming or camera shake' },
  { value: 'full', label: 'Off', hint: 'All animations' },
];
export const QUALITIES: { value: Quality; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'No shadows, lower resolution' },
  { value: 'medium', label: 'Medium', hint: 'Shadows, flat surfaces' },
  { value: 'high', label: 'High', hint: 'Sharp shadows, surface detail, smooth edges (next game)' },
];

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
  swap: 'KeyQ',
  knife: 'KeyV',
  interact: 'KeyE',
  ability1: 'Digit1',
  ability2: 'Digit2',
  ability3: 'Digit3',
  inventory: 'KeyI',
  scoreboard: 'Tab',
};

const COARSE = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
const MOTION_QUERY = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

const DEFAULTS: Settings = {
  sensitivity: 1, invertY: false, fullscreen: true, aimToggle: false, aimSensitivity: 1,
  fov: FOV_DEFAULT, crosshairColor: '#ffffff', crosshairSize: 1,
  // Phones start low; they can turn it up.
  quality: COARSE ? 'low' : 'high', screenShake: !MOTION_QUERY?.matches, sfxVolume: 1, musicVolume: 0.7,
  reduceMotion: 'system', hudScale: 1, showFps: true, killcam: true,
  bindings: DEFAULT_BINDINGS,
};

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
    const num = (v: unknown, min: number, max: number, fallback: number) =>
      Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
    return {
      sensitivity: Number.isFinite(sensitivity)
        ? Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, sensitivity))
        : DEFAULTS.sensitivity,
      invertY: saved.invertY === true,
      fullscreen: saved.fullscreen !== false,
      aimToggle: saved.aimToggle === true,
      aimSensitivity: Number.isFinite(Number(saved.aimSensitivity))
        ? Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Number(saved.aimSensitivity)))
        : DEFAULTS.aimSensitivity,
      fov: num(saved.fov, FOV_MIN, FOV_MAX, DEFAULTS.fov),
      crosshairColor: typeof saved.crosshairColor === 'string' && /^#[0-9a-f]{6}$/i.test(saved.crosshairColor)
        ? saved.crosshairColor : DEFAULTS.crosshairColor,
      crosshairSize: num(saved.crosshairSize, CROSSHAIR_SIZE_MIN, CROSSHAIR_SIZE_MAX, DEFAULTS.crosshairSize),
      quality: QUALITIES.some((q) => q.value === saved.quality) ? (saved.quality as Quality) : DEFAULTS.quality,
      screenShake: typeof saved.screenShake === 'boolean' ? saved.screenShake : DEFAULTS.screenShake,
      reduceMotion: MOTION_OPTIONS.some((o) => o.value === saved.reduceMotion) ? (saved.reduceMotion as MotionPref) : DEFAULTS.reduceMotion,
      hudScale: num(saved.hudScale, HUD_SCALE_MIN, HUD_SCALE_MAX, DEFAULTS.hudScale),
      showFps: typeof saved.showFps === 'boolean' ? saved.showFps : DEFAULTS.showFps,
      killcam: typeof saved.killcam === 'boolean' ? saved.killcam : DEFAULTS.killcam,
      sfxVolume: num(saved.sfxVolume, 0, 1, DEFAULTS.sfxVolume),
      musicVolume: num(saved.musicVolume, 0, 1, DEFAULTS.musicVolume),
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

/** Whether animations should be toned down right now: the setting, or the OS when it's 'system'. */
export const reducedMotion = (s: Settings = current): boolean =>
  s.reduceMotion === 'reduce' || (s.reduceMotion === 'system' && !!MOTION_QUERY?.matches);

/** Keep `html.reduce-motion` in step with the setting and the OS, for the CSS. */
export function watchReducedMotion(): void {
  const apply = () => document.documentElement.classList.toggle('reduce-motion', reducedMotion());
  apply();
  settings.subscribe(apply);
  MOTION_QUERY?.addEventListener('change', apply);
}

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
