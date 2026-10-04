import type { AbilityType } from '../types';

/*
 * One-time tips. Each is shown once per browser (remembered in localStorage), so returning
 * players aren't nagged and new ones learn the mechanics as they meet them.
 */

export type HintId = 'slide' | 'gun-swap' | 'ads' | 'full-slots' | `ability:${AbilityType}`;

const STORAGE_KEY = 'fps-hints';

function load(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

const seen = load();

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch { /* storage unavailable: tips repeat next visit */ }
}

export const hints = {
  /** True the first time `id` is asked about; false ever after. */
  once(id: HintId): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    save();
    return true;
  },

  reset(): void {
    seen.clear();
    save();
  },
};
