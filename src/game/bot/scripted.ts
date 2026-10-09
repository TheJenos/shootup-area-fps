import { MAX_TURN, type BotAction } from './policy';
import { OBS_LAYOUT } from './observe';

/*
 * Hand-written bots from the same observations a policy gets: a yardstick for training (a trained
 * policy should beat it) and the moving targets of the first training stage.
 */

const E = OBS_LAYOUT.enemies;

/** Turn toward a direction given as (right, forward) in the bot's frame, as an aim action (-1..1) */
function turnToward(right: number, forward: number): number {
  const angle = Math.atan2(right, forward); // + = to the right
  // Turning right is a negative yaw change.
  return Math.max(-1, Math.min(1, -angle / MAX_TURN.yaw));
}

/** The 8-way move closest to a direction (right, forward) in the bot's frame */
function moveToward(right: number, forward: number): number {
  if (Math.hypot(right, forward) < 1e-3) return 0;
  const a = Math.atan2(right, forward); // 0 = ahead, + = right
  const i = Math.round(a / (Math.PI / 4));
  return (((i % 8) + 8) % 8) + 1;
}

/** Walks the objective's path; shoots whoever it can see. `aimError` adds a human-ish wobble. */
export function scriptedAction(obs: Float32Array, rand: () => number = Math.random, aimError = 0.15): BotAction {
  const seen = obs[E]! > 0.5;
  if (seen) {
    const yawErr = obs[E + 5]! * Math.PI;
    const pitchErr = obs[E + 6]! * (Math.PI / 2);
    const aimYaw = Math.max(-1, Math.min(1, yawErr / MAX_TURN.yaw + (rand() - 0.5) * aimError));
    const aimPitch = Math.max(-1, Math.min(1, pitchErr / MAX_TURN.pitch + (rand() - 0.5) * aimError));
    // Strafe while shooting, close in from far away.
    const far = obs[E + 4]! > 0.4;
    const move = far ? 1 : rand() < 0.5 ? 3 : 7;
    return { move, sprint: false, jump: false, crouch: false, fire: Math.abs(yawErr) < 0.15, aimYaw, aimPitch };
  }
  const nav = OBS_LAYOUT.attack;
  const right = obs[nav]!;
  const forward = obs[nav + 1]!;
  const hasGoal = Math.hypot(right, forward) > 0.1;
  return {
    move: hasGoal ? moveToward(right, forward) : 1,
    sprint: true,
    jump: obs[OBS_LAYOUT.probes]! < 0.04 && rand() < 0.3,
    crouch: false,
    fire: false,
    aimYaw: hasGoal ? turnToward(right, forward) * 0.5 : 0.3,
    aimPitch: -obs[OBS_LAYOUT.self + 7]! * 0.5,
  };
}

/** Wanders about and never shoots: something to practise aiming on. */
export class Wanderer {
  private move = 1;
  private turn = 0;
  private until = 0;

  act(now: number, rand: () => number = Math.random): BotAction {
    if (now >= this.until) {
      this.move = Math.floor(rand() * 9);
      this.turn = (rand() - 0.5) * 0.6;
      this.until = now + 0.8 + rand() * 1.6;
    }
    return { move: this.move, sprint: rand() < 0.3, jump: rand() < 0.02, crouch: rand() < 0.05, fire: false, aimYaw: this.turn, aimPitch: 0 };
  }
}
