import type { BotMemory } from './observe';
import type { GunKind, Stance } from '../../types';

/*
 * What a team of bots knows together, the way players share it: whoever sees an enemy calls them out
 * (teammates learn where they are, a moment later), and anyone hears gunfire nearby (roughly where it
 * came from). Neither marks the enemy as seen: the bot knows to look there, but the aim model still
 * needs it in view.
 */

/** A callout takes this long to reach teammates (s) */
export const CALLOUT_DELAY = 0.5;
/** Heard gunfire is placed within this of the shooter (m) */
export const HEARING_JITTER = 3;
/** Gunfire carries this far (m) */
export const HEARING_RANGE: Record<GunKind, number> = { rifle: 35, shotgun: 35, deagle: 40, sniper: 60 };

/** Everything `seer` saw at its last look (`now`), passed on to its teammates. */
export function callOut(seer: BotMemory, mates: readonly BotMemory[], now: number): void {
  for (const id of seer.inView(now, 0.05)) {
    const m = seer.seen.get(id)!;
    for (const mate of mates) if (mate !== seer) mate.learn(id, m.x, m.y, m.z, m.stance, now - CALLOUT_DELAY);
  }
}

/**
 * A shot from `shooter` at (x, y, z) with `gun`, heard by a bot standing at (hx, hz): if it's close
 * enough, the bot learns roughly where the shooter is. Returns whether it was heard.
 */
export function hear(
  memory: BotMemory, shooter: string, gun: GunKind, x: number, y: number, z: number, hx: number, hz: number, now: number,
  rand: () => number = Math.random,
): boolean {
  if (Math.hypot(x - hx, z - hz) > HEARING_RANGE[gun]) return false;
  const a = rand() * Math.PI * 2;
  const r = rand() * HEARING_JITTER;
  const stance: Stance = 'stand';
  memory.learn(shooter, x + Math.cos(a) * r, y, z + Math.sin(a) * r, stance, now - 0.2);
  return true;
}
