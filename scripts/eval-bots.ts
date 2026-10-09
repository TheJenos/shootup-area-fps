/**
 * Plays the trained policy against the scripted bot (or another checkpoint) on maps it never
 * trained on, and reports wins, kills and captures per mode.
 *
 *   npm run eval:bots -- [--policy bots/best.json | bots/latest.json | public/bots/policy.json] [--vs scripted | <checkpoint>]
 *                        [--episodes 6] [--modes ffa,tdm,ctf] [--size m] [--tier hard | easy,normal,hard,expert]
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadPhysics } from '../src/game/physics';
import { Policy, type PolicyJson } from '../src/game/bot/policy';
import { EVAL_SEEDS, evaluateMatch } from '../src/game/bot/sim/evaluate';
import type { BotSkill } from '../src/game/bot/aim';
import type { GameMode } from '../src/types';
import type { MapSize } from '../src/game/mapgen';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

function loadPolicy(path: string): Policy {
  const json = JSON.parse(readFileSync(path, 'utf8')) as { trainer?: { policy: PolicyJson }; policy?: PolicyJson } & Partial<PolicyJson>;
  return Policy.fromJSON(json.trainer?.policy ?? json.policy ?? (json as PolicyJson));
}

async function main(): Promise<void> {
  await loadPhysics();
  const policy = loadPolicy(opt('policy', existsSync('bots/best.json') ? 'bots/best.json' : 'bots/latest.json'));
  const vs = opt('vs', 'scripted');
  const opponent = vs === 'scripted' ? null : loadPolicy(vs);
  const episodes = Number(opt('episodes', '6'));
  const modes = opt('modes', 'ffa,tdm,ctf').split(',') as GameMode[];
  const size = opt('size', 'm') as MapSize;
  const tiers = opt('tier', 'hard').split(',') as BotSkill[];

  for (const tier of tiers) {
  console.log(`Policy (${tier} aim) vs ${opponent ? vs : 'the scripted bot'}, ${episodes} episodes per mode on ${size} maps`);
  for (const mode of modes) {
    const results = Array.from({ length: episodes }, (_, ep) => evaluateMatch(policy, opponent, mode, EVAL_SEEDS[ep % EVAL_SEEDS.length]!, size, tier));
    const t = (k: 'kills' | 'deaths' | 'captures' | 'against') => results.reduce((n, r) => n + r[k], 0);
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    console.log(`${mode.toUpperCase()}: won ${count('won')}, lost ${count('lost')}, drew ${count('draw')} · K/D ${t('kills')}/${t('deaths')} (${(t('kills') / Math.max(1, t('deaths'))).toFixed(2)})${mode === 'ctf' ? ` · captures ${t('captures')} vs ${t('against')}` : ''}`);
  }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
