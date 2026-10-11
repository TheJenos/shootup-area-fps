/*
 * The player's display name: kept in this browser (`fps-name`), chosen on the first visit and
 * changeable from Settings → Profile in the lobby. (Inside Discord the Discord name is used instead.)
 */

const NAME_KEY = 'fps-name';

/** Names are 2–16 letters, digits, spaces, - or _ (no leading / trailing spaces). */
export const NAME_PATTERN = /^[\p{L}\p{N} _-]{2,16}$/u;

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // No storage: the name lasts this visit only.
  }
}
