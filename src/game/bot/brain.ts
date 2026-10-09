import { DECISION_DT, MAX_TURN, MOVE_TABLE, type BotAction, type Policy } from './policy';
import { BotMemory, OBS_LAYOUT } from './observe';
import { pushAction, shouldPush, shouldTravel, travelAction, Unstuck } from './objective';
import { AIM_SKILLS, AimController, BOT_SKILLS, type AimSkill, type BotSkill } from './aim';
import type { MoveInput } from '../movement';

export { BOT_SKILLS, type BotSkill };

/*
 * Turns a policy's decisions into a bot's controls, the same way in training and in a game:
 * a decision every DECISION_DT, the movement keys held until the next one, and the aim either the
 * aim model's (aim.ts: whenever there's an enemy in view) or the turn the decision asked for, spread
 * smoothly over that time (walking somewhere, looking around).
 */

export interface SkillDef {
  label: string;
  aim: AimSkill;
  /** Randomness of its movement choices */
  temperature: number;
}

export const SKILLS: Record<BotSkill, SkillDef> = {
  easy: { label: 'Easy', aim: AIM_SKILLS.easy, temperature: 1.3 },
  normal: { label: 'Normal', aim: AIM_SKILLS.normal, temperature: 1 },
  hard: { label: 'Hard', aim: AIM_SKILLS.hard, temperature: 0.85 },
  expert: { label: 'Expert', aim: AIM_SKILLS.expert, temperature: 0.7 },
};

/** A bot's character, rolled when it joins */
export interface Personality {
  /** 0.6 (cautious) .. 1.4 (reckless): how far it goes to help, how soon it retreats */
  aggression: number;
  /** 0 .. 0.6: how much shakier its aim gets when it's hurt */
  nerves: number;
}

export function rollPersonality(rand: () => number = Math.random): Personality {
  return { aggression: 0.6 + rand() * 0.8, nerves: rand() * 0.6 };
}

export const NO_ACTION: BotAction = { move: 0, sprint: false, jump: false, crouch: false, fire: false, aimYaw: 0, aimPitch: 0 };

/** The turn a decision asked for, handed out over the following DECISION_DT. */
export class Steering {
  private yawLeft = 0;
  private pitchLeft = 0;
  private yawRate = 0;
  private pitchRate = 0;

  set(dYaw: number, dPitch: number): void {
    this.yawLeft = dYaw;
    this.pitchLeft = dPitch;
    this.yawRate = Math.abs(dYaw) / DECISION_DT;
    this.pitchRate = Math.abs(dPitch) / DECISION_DT;
  }

  /** How much to turn this step */
  step(dt: number): [dYaw: number, dPitch: number] {
    const y = Math.sign(this.yawLeft) * Math.min(Math.abs(this.yawLeft), this.yawRate * dt);
    const p = Math.sign(this.pitchLeft) * Math.min(Math.abs(this.pitchLeft), this.pitchRate * dt);
    this.yawLeft -= y;
    this.pitchLeft -= p;
    return [y, p];
  }

  reset(): void {
    this.yawLeft = this.pitchLeft = this.yawRate = this.pitchRate = 0;
  }
}

/** The keys a decision holds down */
export function moveInputOf(a: BotAction, out: MoveInput): MoveInput {
  const [forward, strafe] = MOVE_TABLE[a.move] ?? [0, 0];
  out.forward = forward;
  out.strafe = strafe;
  out.analog = false;
  out.sprint = a.sprint;
  out.crouch = a.crouch;
  out.jump = a.jump;
  return out;
}

/** A bot in a game: its policy, skill, memory and the decision it's acting on. */
export class BotBrain {
  readonly memory = new BotMemory();
  readonly steering = new Steering();
  /** Getting out of tight spots while walking a route */
  readonly unstuck = new Unstuck();
  readonly aim: AimController;
  action: BotAction = NO_ACTION;
  /** Seconds of play so far (decisions × DECISION_DT) */
  private time = 0;
  /** Looking around while walking: a glance to one side until this time */
  private glanceUntil = 0;
  private nextGlance = 2;
  private glanceYaw = 0;
  private readonly input: MoveInput = { forward: 0, strafe: 0, analog: false, sprint: false, crouch: false, jump: false };

  constructor(
    private readonly policy: Policy, private skill: SkillDef, readonly personality: Personality = rollPersonality(),
    private readonly rand: () => number = Math.random,
  ) {
    this.aim = new AimController(skill.aim, rand);
  }

  setSkill(skill: SkillDef): void {
    this.skill = skill;
    this.aim.skill = skill.aim;
  }

  /**
   * Decide on a fresh observation (raw). With nobody to fight, the objective layer walks the bot to its
   * goal (glancing about now and then); otherwise the policy decides how to move and whether to shoot.
   * Aiming at an enemy in view is the aim model's (see BotHost / Arena), so the policy's turn only
   * applies when nobody's in view.
   */
  decide(obs: Float32Array, ctf = false, at?: { x: number; z: number }): BotAction {
    this.time += DECISION_DT;
    if (shouldTravel(obs)) {
      const walk = at ? this.unstuck.act(travelAction(obs), at.x, at.z, this.time) : travelAction(obs);
      this.steering.set(walk.aimYaw * MAX_TURN.yaw + this.glance(obs), walk.aimPitch * MAX_TURN.pitch);
      this.action = walk;
      return walk;
    }
    const sampled = this.policy.sample(this.policy.normalize(obs), { temperature: this.skill.temperature }, this.rand).action;
    const action = ctf && shouldPush(obs) ? pushAction(sampled, obs) : sampled;
    this.steering.set(action.aimYaw * MAX_TURN.yaw, action.aimPitch * MAX_TURN.pitch);
    this.action = action;
    return action;
  }

  /** Every few seconds, a look toward the more open side, and back (radians to add to this decision's turn) */
  private glance(obs: Float32Array): number {
    if (this.time >= this.nextGlance && this.time >= this.glanceUntil) {
      // Probes: 0 ahead, then clockwise; 2 is right, 6 is left.
      const right = obs[OBS_LAYOUT.probes + 2]!;
      const left = obs[OBS_LAYOUT.probes + 6]!;
      this.glanceYaw = (left > right ? 1 : -1) * (0.5 + this.rand() * 0.4);
      this.glanceUntil = this.time + 0.5;
      this.nextGlance = this.time + 2.5 + this.rand() * 3;
      return this.glanceYaw;
    }
    if (this.glanceUntil > 0 && this.time >= this.glanceUntil) {
      // Look back where we were going.
      const back = -this.glanceYaw;
      this.glanceUntil = 0;
      this.glanceYaw = 0;
      return back;
    }
    return 0;
  }

  get moveInput(): MoveInput {
    return moveInputOf(this.action, this.input);
  }

  reset(): void {
    this.memory.reset();
    this.steering.reset();
    this.unstuck.reset();
    this.aim.reset();
    this.glanceUntil = 0;
    this.glanceYaw = 0;
    this.action = NO_ACTION;
  }
}
