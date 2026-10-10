import { Arena } from './arena';
import { OBS_SIZE } from '../observe';
import { scriptedAction } from '../scripted';
import { pushAction, shouldPush, shouldTravel } from '../objective';
import { AIM_SKILLS, AimController, type BotSkill } from '../aim';
import type { Policy } from '../policy';
import type { GameMode, GunKind } from '../../../types';
import type { MapSize } from '../../mapgen';

/*
 * How good a policy really is: matches against the scripted bot (or another policy) on maps no
 * training match is played on. Training's own numbers are mostly against copies of itself, which
 * can look fine while it forgets how to fight anyone else.
 */

/** Training seeds start with W; these never come up there. */
export const EVAL_SEEDS = ['EVALA1', 'EVALB2', 'EVALC3', 'EVALD4', 'EVALE5', 'EVALF6', 'EVALG7', 'EVALH8', 'EVALI9', 'EVALJ0'];

export interface EvalResult {
  mode: GameMode;
  /** The policy's side: kills, deaths, captures */
  kills: number;
  deaths: number;
  captures: number;
  /** Captures by the other side (CTF). In S&D, both are rounds won: the policy's side's, the other side's */
  against: number;
  outcome: 'won' | 'lost' | 'draw';
}

/**
 * One match: in team modes the red team is `policy`, in FFA the first player is (the other two are
 * opponents). `opponent` null: the scripted bot.
 */
export function evaluateMatch(
  policy: Policy, opponent: Policy | null, mode: GameMode, seed: string, size: MapSize = 's', tier: BotSkill = 'hard', gun: GunKind = 'rifle',
): EvalResult {
  const arena = new Arena({ seed, size, mode, players: 3, gun, seconds: mode === 'snd' ? 360 : mode === 'ctf' ? 240 : 150 });
  const obs = new Float32Array(OBS_SIZE);
  const mine = (i: number) => (mode === 'ffa' ? i === 0 : arena.agents[i]!.team === 'red');
  // Policies aim with the aim model at `tier` (the scripted bot aims its own way).
  for (const a of arena.agents) if (mine(a.index) || opponent) a.aim = new AimController(AIM_SKILLS[tier]);
  while (!arena.done) {
    arena.step(arena.agents.map((a, i) => {
      arena.observe(a, obs);
      // Policies play hybrid: the objective layer walks them to their goal until there's someone to fight.
      const play = (p: Policy) => {
        if (shouldTravel(obs)) return arena.travel(a, obs);
        const fight = p.sample(p.normalize(obs)).action;
        return (mode === 'ctf' || mode === 'snd') && shouldPush(obs) ? pushAction(fight, obs) : fight;
      };
      if (mine(i)) return play(policy);
      return opponent ? play(opponent) : scriptedAction(obs);
    }));
  }
  const result: EvalResult = { mode, kills: 0, deaths: 0, captures: 0, against: 0, outcome: 'draw' };
  for (const a of arena.agents) {
    if (mine(a.index)) {
      result.kills += a.kills;
      result.deaths += a.deaths;
      result.captures += a.captures;
    } else {
      result.against += a.captures;
    }
  }
  if (mode === 'snd') {
    result.captures = arena.score.red ?? 0;
    result.against = arena.score.blue ?? 0;
  }
  const score = (i: number) => (mode === 'ffa' ? arena.agents[i]!.kills : arena.score[arena.agents[i]!.team!] ?? 0);
  const ours = score(0);
  const theirs = Math.max(...arena.agents.filter((a) => !mine(a.index)).map((a) => score(a.index)));
  result.outcome = ours > theirs ? 'won' : ours < theirs ? 'lost' : 'draw';
  arena.dispose();
  return result;
}

/**
 * Per-mode K/D (capped at 3) averaged over the modes played, plus up to ±0.5 for the CTF capture and S&D
 * round margins (as a share of everything scored, so one lopsided set of matches can't swing it by more):
 * one number to rank policies by.
 */
export function evalScore(results: readonly EvalResult[]): { score: number; byMode: Record<string, { kd: number; kills: number; deaths: number; captures: number; against: number }> } {
  const byMode: Record<string, { kd: number; kills: number; deaths: number; captures: number; against: number }> = {};
  for (const r of results) {
    const m = (byMode[r.mode] ??= { kd: 0, kills: 0, deaths: 0, captures: 0, against: 0 });
    m.kills += r.kills;
    m.deaths += r.deaths;
    m.captures += r.captures;
    m.against += r.against;
  }
  let sum = 0;
  const modes = Object.keys(byMode);
  for (const mode of modes) {
    const m = byMode[mode]!;
    m.kd = m.kills / Math.max(1, m.deaths);
    const margin = (m.captures - m.against) / Math.max(1, m.captures + m.against);
    sum += Math.min(3, m.kd) + (mode === 'ctf' || mode === 'snd' ? 0.5 * margin : 0);
  }
  return { score: modes.length ? sum / modes.length : 0, byMode };
}
