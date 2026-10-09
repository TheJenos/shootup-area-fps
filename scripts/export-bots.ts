/**
 * Copies the trained policy out of a training checkpoint into the game (public/bots/policy.json):
 * just the policy network and its observation normaliser, not the value network or the snapshots.
 *
 *   npm run export:bots -- [--from bots/best.json] [--to public/bots/policy.json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Policy, type PolicyJson } from '../src/game/bot/policy';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

// The best policy on held-out matches (train-bots keeps it), or else the latest.
const from = opt('from', existsSync('bots/best.json') ? 'bots/best.json' : 'bots/latest.json');
const to = opt('to', 'public/bots/policy.json');
const ckpt = JSON.parse(readFileSync(from, 'utf8')) as { trainer?: { policy: PolicyJson }; policy?: PolicyJson; steps?: number; stage?: string };
const json = ckpt.trainer?.policy ?? ckpt.policy;
if (!json) throw new Error(`${from} has no policy`);
// Loading it checks it matches this build's observations.
const policy = Policy.fromJSON(json);
mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, JSON.stringify({ ...policy.toJSON(), trainedSteps: ckpt.steps ?? null, stage: ckpt.stage ?? null }));
console.log(`Wrote ${to} (${policy.net.params.length} weights${ckpt.steps ? `, ${ckpt.steps} steps of training` : ''})`);
