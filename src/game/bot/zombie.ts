import type { Point, Unstuck } from './objective';
import type { BotAction } from './policy';
import type { BotSkill } from './brain';

/*
 * How a zombie bot hunts (Infection's zombie bots and Horde's zombies alike). No policy: zombies don't aim
 * or take cover, they run. Every so often it picks its prey, the nearest survivor (zombies can smell the
 * living: they always know where the survivors are), and finds its way to them along the map's routes;
 * once its prey is close and in plain sight it leaves the route and charges straight at them, clawing
 * when they're in reach (BotHost does the steering, the charge and the claws).
 *
 * Routes are followed to an anchor rather than to the prey themselves: their position as of when it was
 * last more than ANCHOR_SLACK away. The way to a spot is searched once and kept (see BotNav), so every
 * zombie after the same survivor shares one search until they've really moved, however many there are.
 */

/** Zombie bots pick their prey and their way this often (s); steering toward it is every frame */
export const ZOMBIE_DECISION = 0.25;
/** A survivor's anchor is moved to where they are once they've gone this far from it (m) */
export const ANCHOR_SLACK = 2.5;
/** A zombie in sight of its prey charges straight at them from this close (m) */
export const CHARGE_RANGE = 14;
/** How fast a zombie turns toward where it's going (1/s: the share of the way it turns, per second) */
export const CHARGE_TURN = 9;
/** Its prey stays its prey unless someone else is this much nearer (a share of the distance): no dithering */
const STICKY = 0.75;
/** Seconds between swipes, as a multiple of the claws' cooldown: easier zombies are slower to strike */
export const CLAW_PACE: Record<BotSkill, number> = { easy: 1.7, normal: 1.25, hard: 1, expert: 0.9 };
/** Horde's zombies: walkers shamble at this share of walking speed (no sprinting); runners sprint, a little slower than a sprinting player */
export const WALKER_SPEED = 0.75;
export const RUNNER_SPEED = 0.9;

export interface Prey extends Point {
  id: string;
}

/** Who to go for: the nearest of `prey`, sticking with `current` unless someone else is clearly nearer */
export function pickPrey<T extends Prey>(self: Point, prey: readonly T[], current: string | null): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  let kept: { p: T; d: number } | null = null;
  for (const p of prey) {
    const d = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
    if (p.id === current) kept = { p, d };
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (kept && bestD >= kept.d * STICKY) return kept.p;
  return best;
}

/** Where to aim the route at for `prey`: their anchor, moved to them once they've gone far enough from it */
export function anchorFor(anchors: Map<string, Point>, prey: Prey): Point {
  const a = anchors.get(prey.id);
  if (a && Math.hypot(a.x - prey.x, a.y - prey.y, a.z - prey.z) < ANCHOR_SLACK) return a;
  const fresh = { x: prey.x, y: prey.y, z: prey.z };
  anchors.set(prey.id, fresh);
  return fresh;
}

/**
 * One decision's feet: straight on (the heading is steered separately), sprinting or not, through Unstuck,
 * which sidesteps and hops when the zombie is caught on something. Never fires: claws are struck in reach.
 */
export function zombieAction(sprint: boolean, unstuck: Unstuck, at: { x: number; z: number }, now: number): BotAction {
  return unstuck.act({ move: 1, sprint, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 }, at.x, at.z, now);
}

/** Turn `from` toward `to` (radians) by `share` of the way, the short way round */
export function turnToward(from: number, to: number, share: number): number {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + d * Math.min(1, Math.max(0, share));
}
