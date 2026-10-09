import { Arena, REWARD, type SimAgent } from './arena';
import { Policy, type BotAction } from '../policy';
import { OBS_SIZE } from '../observe';
import { Mlp } from '../nn';
import { Trajectory, emptyBatch, concatBatches, type Batch, type PpoConfig } from '../ppo';
import { scriptedAction, Wanderer } from '../scripted';
import { pushAction, shouldPush, shouldTravel } from '../objective';
import { AIM_SKILLS, AimController, BOT_SKILLS } from '../aim';
import type { GameMode, GunKind } from '../../../types';
import type { MapSize } from '../../mapgen';

/*
 * Gathering experience: run arenas with the current policy on some agents ("learners") and other
 * players on the rest (the same policy, an older snapshot of it, a scripted bot or a dummy), and
 * keep the learners' decisions as training rows. Runs inside a training worker.
 */

/** One step of the curriculum */
export interface Stage {
  name: string;
  modes: GameMode[];
  sizes: MapSize[];
  /** Per team (TDM, CTF) or in total (FFA) */
  players: number;
  /** Dummies per arena (FFA only): they wander and never shoot */
  dummies: number;
  seconds: number;
  guns: GunKind[];
  /** Share of opponents played by: an old snapshot, the scripted bot (the rest: the current policy) */
  snapshotShare: number;
  scriptedShare: number;
}

/**
 * Later stages keep some of the earlier modes in the mix: trained on one mode alone, the policy forgets how
 * to fight the moment a new mode's inputs show up (it happened at both TDM and CTF).
 */
export const STAGES: Stage[] = [
  { name: 'aim', modes: ['ffa'], sizes: ['s'], players: 4, dummies: 3, seconds: 45, guns: ['rifle'], snapshotShare: 0, scriptedShare: 0 },
  { name: 'duel', modes: ['ffa'], sizes: ['s', 'm'], players: 3, dummies: 0, seconds: 90, guns: ['rifle', 'rifle', 'rifle', 'deagle', 'shotgun', 'sniper'], snapshotShare: 0.2, scriptedShare: 0.35 },
  { name: 'tdm', modes: ['tdm', 'tdm', 'ffa'], sizes: ['s', 'm'], players: 3, dummies: 0, seconds: 120, guns: ['rifle', 'rifle', 'rifle', 'deagle', 'sniper'], snapshotShare: 0.25, scriptedShare: 0.35 },
  { name: 'ctf', modes: ['ctf', 'ctf', 'ctf', 'tdm', 'ffa'], sizes: ['s', 'm', 'l'], players: 3, dummies: 0, seconds: 180, guns: ['rifle', 'rifle', 'rifle', 'sniper'], snapshotShare: 0.25, scriptedShare: 0.35 },
  { name: 'mix', modes: ['ffa', 'tdm', 'ctf', 'ctf'], sizes: ['s', 'm', 'l'], players: 3, dummies: 0, seconds: 150, guns: ['rifle', 'rifle', 'rifle', 'deagle', 'shotgun', 'sniper'], snapshotShare: 0.25, scriptedShare: 0.3 },
];

export const stageByName = (name: string): Stage => {
  const s = STAGES.find((x) => x.name === name);
  if (!s) throw new Error(`No stage "${name}" (${STAGES.map((x) => x.name).join(', ')})`);
  return s;
};

/** Who plays each agent, for the training view */
export type RoleKind = 'learner' | 'snapshot' | 'scripted' | 'dummy';

type Role = { kind: 'learner' } | { kind: 'snapshot'; policy: Policy } | { kind: 'scripted' } | { kind: 'dummy'; wanderer: Wanderer };

/** Results of a rollout, besides the experience itself */
export interface RolloutStats {
  steps: number;
  episodes: number;
  /** Sum of learners' rewards over finished episodes, and how many learner-episodes */
  reward: number;
  learnerEpisodes: number;
  kills: number;
  deaths: number;
  captures: number;
  /** Learners against scripted bots: kills of them, deaths to them */
  vsScripted: { kills: number; deaths: number };
  /** Learners' reward over finished episodes, by where it came from */
  parts: Record<string, number>;
  /** Raw observation moments of the learners (for the normaliser) */
  obsCount: number;
  obsMean: Float64Array;
  obsM2: Float64Array;
}

const emptyStats = (): RolloutStats => ({
  steps: 0, episodes: 0, reward: 0, learnerEpisodes: 0, kills: 0, deaths: 0, captures: 0,
  vsScripted: { kills: 0, deaths: 0 }, parts: {}, obsCount: 0, obsMean: new Float64Array(OBS_SIZE), obsM2: new Float64Array(OBS_SIZE),
});

interface Slot {
  arena: Arena;
  roles: Role[];
  trajectories: (Trajectory | null)[];
  episodeReward: number[];
  /** Whether each agent's last decision was the objective layer's (walking to its goal) rather than the policy's */
  traveling: boolean[];
}

const pick = <T>(list: readonly T[], rand: () => number): T => list[Math.floor(rand() * list.length)]!;

export class Rollout {
  /** Called after every step of the first arena (the one the training view shows) */
  watch: ((arena: Arena, roles: readonly RoleKind[], fresh: boolean) => void) | null = null;
  private watchedArena: Arena | null = null;
  private slots: Slot[] = [];
  private readonly raw = new Float32Array(OBS_SIZE);
  private readonly normed = new Float32Array(OBS_SIZE);
  private stage: Stage;
  private seedCounter = 0;

  constructor(
    stage: Stage, private readonly arenas: number, private readonly workerId: number,
    private readonly rand: () => number = Math.random,
  ) {
    this.stage = stage;
  }

  setStage(stage: Stage): void {
    if (stage.name === this.stage.name) return;
    this.stage = stage;
    // Start over in the new stage's arenas (unfinished experience is dropped).
    for (const s of this.slots) s.arena.dispose();
    this.slots = [];
  }

  private newSlot(snapshots: readonly Policy[]): Slot {
    const { stage, rand } = this;
    const mode = pick(stage.modes, rand);
    const arena = new Arena({
      seed: `W${this.workerId}X${(this.seedCounter++).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`.toUpperCase().slice(0, 16),
      size: pick(stage.sizes, rand),
      mode,
      players: mode === 'ffa' ? stage.players : Math.max(1, Math.round(stage.players * (0.67 + rand() * 0.66))),
      dummies: mode === 'ffa' ? stage.dummies : 0,
      gun: pick(stage.guns, rand),
      seconds: stage.seconds,
    }, rand);
    const opponentRole = (): Role => {
      const r = rand();
      if (r < stage.scriptedShare) return { kind: 'scripted' };
      if (r < stage.scriptedShare + stage.snapshotShare && snapshots.length) return { kind: 'snapshot', policy: pick(snapshots, rand) };
      return { kind: 'learner' };
    };
    let roles: Role[];
    if (mode === 'ffa') {
      // The first agent always learns; the others are opponents of some kind (or dummies).
      roles = arena.agents.map((a, i): Role => (a.dummy ? { kind: 'dummy', wanderer: new Wanderer() } : i === 0 ? { kind: 'learner' } : opponentRole()));
    } else {
      // Red learns; blue is one kind of opponent for the whole team.
      const blue = opponentRole();
      roles = arena.agents.map((a): Role => (a.team === 'red' ? { kind: 'learner' } : blue));
    }
    // Policies aim with the aim model, at a skill drawn for the match (so the policy learns to win at every level).
    for (const a of arena.agents) {
      const kind = roles[a.index]!.kind;
      if (kind === 'learner' || kind === 'snapshot') a.aim = new AimController(AIM_SKILLS[pick(BOT_SKILLS, rand)], rand);
    }
    return {
      arena, roles,
      trajectories: roles.map((r) => (r.kind === 'learner' ? new Trajectory() : null)),
      episodeReward: roles.map(() => 0),
      traveling: roles.map(() => false),
    };
  }

  /**
   * Play until the learners have made `steps` decisions. Returns their experience (with advantages
   * worked out) and what happened.
   */
  collect(steps: number, policy: Policy, value: Mlp, snapshots: readonly Policy[], cfg: Pick<PpoConfig, 'gamma' | 'lambda'>): { batch: Batch; stats: RolloutStats } {
    const stats = emptyStats();
    while (this.slots.length < this.arenas) this.slots.push(this.newSlot(snapshots));
    const parts: Batch[] = [];
    const flush = (t: Trajectory, bootstrap: number) => {
      if (!t.length) return;
      const b = emptyBatch(t.length);
      t.flush(b, 0, bootstrap, cfg);
      parts.push(b);
    };

    while (stats.steps < steps) {
      for (let si = 0; si < this.slots.length; si++) {
        const slot = this.slots[si]!;
        const { arena, roles, trajectories } = slot;
        const actions: BotAction[] = [];
        for (const a of arena.agents) {
          const role = roles[a.index]!;
          const traj = trajectories[a.index] ?? null;
          arena.observe(a, this.raw);
          arena.shape(a, this.raw);
          // Rewards since the last decision belong to it, if the policy made it (walking to the goal is the
          // objective layer's; the policy is only judged on what it chose).
          if (traj && !slot.traveling[a.index]) traj.reward(a.reward);
          slot.episodeReward[a.index]! += a.reward;
          a.reward = 0;
          // Nobody to fight: the objective layer walks it to its goal. That ends the policy's stretch of
          // decisions, valued from here.
          const travel = role.kind !== 'dummy' && role.kind !== 'scripted' && shouldTravel(this.raw);
          if (travel) {
            if (traj && traj.length && !slot.traveling[a.index]) {
              policy.norm.normalize(this.raw, this.normed);
              flush(traj, value.run(this.normed)[0]!);
            }
            slot.traveling[a.index] = true;
            actions.push(arena.travel(a, this.raw));
            continue;
          }
          if (arena.mode === 'ctf' && shouldPush(this.raw) && (role.kind === 'learner' || role.kind === 'snapshot')) {
            // Pushing on to the objective while shooting: the feet aren't the policy's, so it isn't experience.
            if (traj && traj.length && !slot.traveling[a.index]) {
              policy.norm.normalize(this.raw, this.normed);
              flush(traj, value.run(this.normed)[0]!);
            }
            slot.traveling[a.index] = true;
            const fighter = role.kind === 'snapshot' ? role.policy : policy;
            actions.push(pushAction(fighter.sample(fighter.normalize(this.raw), {}, this.rand).action, this.raw));
            continue;
          }
          slot.traveling[a.index] = false;
          actions.push(this.act(arena, a, role, traj, policy, value, stats));
        }
        arena.step(actions);
        if (si === 0 && this.watch) {
          const fresh = this.watchedArena !== arena;
          if (fresh) arena.shotTrace = [];
          this.watchedArena = arena;
          this.watch(arena, roles.map((r) => r.kind), fresh);
        }
        if (arena.done) {
          this.finish(slot, stats, flush);
          arena.dispose();
          this.slots[si] = this.newSlot(snapshots);
        }
      }
    }
    // Cut the unfinished episodes off here, valuing where they got to.
    for (const slot of this.slots) {
      for (const a of slot.arena.agents) {
        const t = slot.trajectories[a.index];
        if (!t || !t.length) continue;
        t.reward(a.reward);
        slot.episodeReward[a.index]! += a.reward;
        a.reward = 0;
        policy.norm.normalize(slot.arena.observe(a, this.raw), this.normed);
        flush(t, value.run(this.normed)[0]!);
      }
    }
    return { batch: concatBatches(parts), stats };
  }

  private act(arena: Arena, a: SimAgent, role: Role, traj: Trajectory | null, policy: Policy, value: Mlp, stats: RolloutStats): BotAction {
    const raw = this.raw;
    switch (role.kind) {
      case 'dummy':
        return role.wanderer.act(arena.time, this.rand);
      case 'scripted':
        return scriptedAction(raw, this.rand);
      case 'snapshot':
        return role.policy.sample(role.policy.normalize(raw), {}, this.rand).action;
      case 'learner': {
        policy.norm.normalize(raw, this.normed);
        // Aiming at someone is the aim model's job: then the policy's aim outputs aren't part of the decision.
        const maskAim = !!a.aim?.engaged;
        const s = policy.sample(this.normed, { maskAim }, this.rand);
        // Only living decisions are experience (a dead bot's choices change nothing).
        if (a.alive && traj) {
          traj.push(this.normed, s.action, s.aimRaw, s.logp, value.run(this.normed)[0]!, maskAim);
          stats.steps++;
          // Welford, for the normaliser.
          stats.obsCount++;
          for (let i = 0; i < OBS_SIZE; i++) {
            const d = raw[i]! - stats.obsMean[i]!;
            stats.obsMean[i]! += d / stats.obsCount;
            stats.obsM2[i]! += d * (raw[i]! - stats.obsMean[i]!);
          }
        }
        return s.action;
      }
    }
  }

  /** The episode ended: win / loss bonus, tallies, and close the learners' trajectories. */
  private finish(slot: Slot, stats: RolloutStats, flush: (t: Trajectory, bootstrap: number) => void): void {
    const { arena, roles, trajectories } = slot;
    stats.episodes++;
    // Who won: the team (or player) with the most.
    const scoreOf = (a: SimAgent) => (arena.mode === 'ffa' ? a.kills : arena.score[a.team!] ?? 0);
    const best = Math.max(...arena.agents.map(scoreOf));
    const winners = arena.agents.filter((a) => scoreOf(a) === best);
    const outright = best > 0 && (arena.mode === 'ffa' ? winners.length === 1 : new Set(winners.map((w) => w.team)).size === 1);
    for (const a of arena.agents) {
      if (outright) {
        const bonus = scoreOf(a) === best ? REWARD.capture * 0.5 : -REWARD.capture * 0.3;
        a.reward += bonus;
        a.rewardParts.win = (a.rewardParts.win ?? 0) + bonus;
      }
      const t = trajectories[a.index];
      slot.episodeReward[a.index]! += a.reward;
      if (!t) continue;
      t.reward(a.reward);
      a.reward = 0;
      flush(t, 0);
      stats.reward += slot.episodeReward[a.index]!;
      stats.learnerEpisodes++;
      stats.kills += a.kills;
      stats.deaths += a.deaths;
      stats.captures += a.captures;
      for (const [k, v] of Object.entries(a.rewardParts)) stats.parts[k] = (stats.parts[k] ?? 0) + v;
    }
    for (const k of arena.killLog) {
      const killer = roles[k.killer]?.kind;
      const victim = roles[k.victim]?.kind;
      if (killer === 'learner' && victim === 'scripted') stats.vsScripted.kills++;
      if (killer === 'scripted' && victim === 'learner') stats.vsScripted.deaths++;
    }
  }
}
