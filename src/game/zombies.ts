/*
 * Zombies: how they look, move and fight, whoever plays them. Infection turns players into them; a horde
 * mode would bring them on as bots. Kept apart from either mode, so both share the same zombie.
 *
 * A zombie has no guns, grenades or pickups: only its claws, a quick swipe at arm's length that takes a
 * fresh survivor down in one hit. It's tougher and faster than a survivor to make up for it.
 */

/** A zombie's colour: its skin and uniform take it, and others recognise a zombie by it (replays included) */
export const ZOMBIE_COLOR = '#7fd650';

/** The most health a player record may hold (database.rules.json): zombies stay within it */
export const MAX_RECORD_HP = 200;
/** A zombie's health, as a multiple of the mode's; the first zombies of a round get more */
const ZOMBIE_HEALTH = 1.5;
const ALPHA_HEALTH = 2;

/** Full health for a zombie in a mode where players have `health` (`alpha`: one of the round's first) */
export function zombieHealth(health: number, alpha: boolean): number {
  return Math.min(MAX_RECORD_HP, Math.round(health * (alpha ? ALPHA_HEALTH : ZOMBIE_HEALTH)));
}

/** Zombies run this much faster than survivors */
export const ZOMBIE_SPEED = 1.12;

/** A swipe of the claws: damage (head or body), reach from the eyes (m) and seconds from one to the next */
export const CLAW_DAMAGE = 100;
export const CLAW_RANGE = 2.3;
export const CLAW_COOLDOWN = 0.55;

/** Zombies groan now and then: every this many seconds, give or take half */
export const GROWL_INTERVAL = 6;
