/** Fullscreen while playing, and the keys the game takes from the browser while it is. */

import { IN_DISCORD } from '../discord/patch';
import { settings } from './settings';

/** Keyboard Lock API (Chrome / Edge, fullscreen only); not in TypeScript's DOM types yet. */
interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}
export const keyboardLock = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

/**
 * Keys to take from the browser while playing fullscreen: every bound key (crouch is Ctrl, and
 * Ctrl+1 / Ctrl+Tab would switch tabs), the letters of tab / window shortcuts, and Esc, so a tap of
 * Esc opens the menu (the game releases the mouse itself) instead of leaving fullscreen. Browsers
 * still leave fullscreen when Esc is held down, and only Chrome / Edge support taking keys at all.
 */
export function keysToLock(): string[] {
  const keys = new Set<string>(Object.values(settings.get().bindings));
  for (const code of ['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'Tab', 'Escape']) keys.add(code);
  for (let d = 1; d <= 9; d++) keys.add(`Digit${d}`);
  return [...keys];
}

/**
 * Go fullscreen for playing (from a click: browsers only allow it then). The lobby calls this when
 * you join or create a room, before the room loads; the game calls it again when you click to play.
 * Not inside Discord, which manages its own window.
 */
export function enterFullscreen(): Promise<void> {
  if (IN_DISCORD || !settings.get().fullscreen || document.fullscreenElement || !document.documentElement.requestFullscreen) {
    return Promise.resolve();
  }
  return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
    // Take Esc and the shortcut keys straight away (see keysToLock).
    keyboardLock()?.lock(keysToLock()).catch(() => {});
  });
}
