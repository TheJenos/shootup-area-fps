/**
 * Trains the bots' policy with PPO and self-play in the headless arena (src/game/bot/sim), all in
 * TypeScript on the CPU. Worker threads play matches and compute gradients; the main thread
 * applies them, keeps checkpoints and moves through the curriculum (aim → duel → tdm → ctf → snd → mix).
 *
 *   npm run train:bots -- [--workers 9] [--steps 50M] [--batch 32768] [--stage auto|aim|duel|tdm|ctf|snd|mix]
 *                         [--fresh] [--dir bots] [--arenas 2] [--lr 3e-4] [--view-port 7777 | 0] [--allow-sleep]
 *
 * While it runs, http://localhost:7777 shows it live: one of the matches being played, seen from above,
 * and the learning curves (--view-port 0 turns that off).
 * Resumes from <dir>/latest.json unless --fresh. Export the result for the game with `npm run export:bots`.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { loadPhysics } from '../src/game/physics';
import { ObsNorm, Policy, type PolicyJson } from '../src/game/bot/policy';
import { Mlp } from '../src/game/bot/nn';
import { OBS_SIZE } from '../src/game/bot/observe';
import { DEFAULT_PPO, PpoTrainer, computeGradients, concatBatches, type Batch, type Gradients, type TrainerJson } from '../src/game/bot/ppo';
import { Rollout, STAGES, stageByName, type RoleKind, type RolloutStats } from '../src/game/bot/sim/rollout';
import type { Arena } from '../src/game/bot/sim/arena';
import { EVAL_SEEDS, evalScore, evaluateMatch, type EvalResult } from '../src/game/bot/sim/evaluate';
import type { GameMode } from '../src/types';

// ---------------------------------------------------------------- messages

interface Weights {
  policy: Float32Array;
  logStd: Float32Array;
  value: Float32Array;
  norm: PolicyJson['norm'];
}

type ToWorker =
  | { type: 'rollout'; steps: number; stage: string; weights: Weights; snapshots: { id: number; json: PolicyJson }[]; pool: number[] }
  | { type: 'batch'; batch: SharedBatch; adv: Float32Array }
  | { type: 'grad'; weights: Omit<Weights, 'norm'>; rows: Int32Array; minibatch: number }
  | { type: 'eval'; policy: PolicyJson; mode: GameMode; seed: string };

/** The watched match, for the training view (worker 0 sends these while it plays) */
type ViewMessage = { type: 'view'; event: 'map' | 'frame'; data: unknown };

type FromWorker =
  | ViewMessage
  | { type: 'ready' }
  | { type: 'rollout'; batch: Batch; stats: RolloutStats }
  | { type: 'grad'; grads: Gradients }
  | { type: 'eval'; result: EvalResult };

/** A batch whose arrays live in shared memory, so every worker reads the same one without copies */
type SharedBatch = Batch;

function sharedBatch(src: Batch): SharedBatch {
  const share = <T extends Float32Array | Uint8Array>(a: T, make: (b: SharedArrayBuffer) => T): T => {
    const out = make(new SharedArrayBuffer(a.byteLength));
    out.set(a);
    return out;
  };
  return {
    n: src.n,
    obs: share(src.obs, (b) => new Float32Array(b)),
    move: share(src.move, (b) => new Uint8Array(b)),
    buttons: share(src.buttons, (b) => new Uint8Array(b)),
    aimRaw: share(src.aimRaw, (b) => new Float32Array(b)),
    logp: share(src.logp, (b) => new Float32Array(b)),
    adv: share(src.adv, (b) => new Float32Array(b)),
    ret: share(src.ret, (b) => new Float32Array(b)),
    aimMask: share(src.aimMask, (b) => new Uint8Array(b)),
  };
}

// ---------------------------------------------------------------- worker

async function workerMain(): Promise<void> {
  const { id, arenas, view } = workerData as { id: number; arenas: number; view: boolean };
  await loadPhysics();
  const port = parentPort!;
  const policy = new Policy();
  const value = new Mlp([OBS_SIZE, 128, 128, 1]);
  const snapshots = new Map<number, Policy>();
  let rollout: Rollout | null = null;
  let batch: SharedBatch | null = null;
  let adv: Float32Array | null = null;

  const load = (w: Omit<Weights, 'norm'>) => {
    policy.net.params.set(w.policy);
    policy.logStd.set(w.logStd);
    value.params.set(w.value);
  };

  port.on('message', (msg: ToWorker) => {
    if (msg.type === 'rollout') {
      load(msg.weights);
      policy.norm = ObsNorm.fromJSON(msg.weights.norm);
      for (const s of msg.snapshots) snapshots.set(s.id, Policy.fromJSON(s.json));
      for (const key of [...snapshots.keys()]) if (!msg.pool.includes(key)) snapshots.delete(key);
      const stage = stageByName(msg.stage);
      if (!rollout) {
        rollout = new Rollout(stage, arenas, id);
        if (view) rollout.watch = (arena, roles, fresh) => sendView(port, arena, roles, fresh);
      }
      rollout.setStage(stage);
      const { batch: b, stats } = rollout.collect(msg.steps, policy, value, [...snapshots.values()], DEFAULT_PPO);
      port.postMessage({ type: 'rollout', batch: b, stats } satisfies FromWorker);
    } else if (msg.type === 'batch') {
      batch = msg.batch;
      adv = msg.adv;
    } else if (msg.type === 'eval') {
      const result = evaluateMatch(Policy.fromJSON(msg.policy), null, msg.mode, msg.seed);
      port.postMessage({ type: 'eval', result } satisfies FromWorker);
    } else if (msg.type === 'grad') {
      load(msg.weights);
      const g = computeGradients(policy, value, batch!, adv!, msg.rows, msg.minibatch, DEFAULT_PPO);
      // The gradient arrays are the networks' own: send copies.
      const grads: Gradients = { ...g, policy: Float32Array.from(g.policy), logStd: Float32Array.from(g.logStd), value: Float32Array.from(g.value) };
      port.postMessage({ type: 'grad', grads } satisfies FromWorker, [grads.policy.buffer, grads.logStd.buffer, grads.value.buffer] as ArrayBuffer[]);
    }
  });
  port.postMessage({ type: 'ready' } satisfies FromWorker);
}

// ---------------------------------------------------------------- the training view

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The watched match: its map when a new one starts, then where everyone is after every decision. */
function sendView(port: NonNullable<typeof parentPort>, arena: Arena, roles: readonly RoleKind[], fresh: boolean): void {
  const post = (event: ViewMessage['event'], data: unknown) => port.postMessage({ type: 'view', event, data } satisfies ViewMessage);
  if (fresh) {
    const m = arena.map;
    post('map', {
      seed: m.spec.seed, size: m.spec.size, name: m.name, mode: arena.mode, half: m.half,
      boxes: m.boxes.filter((b) => b.blocks !== 'move').map((b) => [r1(b.x), r1(b.z), r1(b.w), r1(b.d), r1(b.y + b.h), b.ramp ? 1 : 0]),
      bases: arena.bases, roles, teams: arena.agents.map((a) => a.team),
    });
  }
  const shots = (arena.shotTrace ?? []).splice(0).map((s) => [s.from, r1(s.x0), r1(s.z0), r1(s.x1), r1(s.z1), s.hit ? 1 : 0]);
  post('frame', {
    t: r1(arena.time),
    agents: arena.agents.map((a) => {
      const p = a.mover.position;
      return [r1(p.x), r1(p.z), Math.round(a.yaw * 100) / 100, a.alive ? 1 : 0, Math.round(a.hp), a.kills, a.deaths, a.action.fire ? 1 : 0];
    }),
    shots, score: arena.score, flags: arena.flags,
    ...(arena.snd && arena.sites ? { snd: { atk: arena.snd.atk, sites: arena.sites, bomb: arena.snd.bomb, n: arena.snd.n } } : {}),
  });
}

/** Serves the training view (scripts/train-view.html) and streams to it over server-sent events. */
function startViewServer(port: number, logFile: string) {
  const clients = new Set<ServerResponse>();
  let lastMap: unknown = null;
  let status: unknown = null;
  const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      // The story so far: the whole training log, the current match and what the trainer is doing.
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];
      send(res, 'history', log);
      if (lastMap) send(res, 'map', lastMap);
      if (status) send(res, 'status', status);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join('scripts', 'train-view.html'), 'utf8'));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () => console.log(`Training view: http://localhost:${port}`));
  server.on('error', (err) => console.warn(`Training view unavailable (${err.message})`));
  return {
    broadcast(event: string, data: unknown) {
      if (event === 'map') lastMap = data;
      if (event === 'status') status = data;
      for (const c of clients) send(c, event, data);
    },
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);
/** "50M", "200k" or a plain number */
const count = (s: string) => Number(s.replace(/k$/i, 'e3').replace(/m$/i, 'e6'));

interface Checkpoint {
  trainer: TrainerJson;
  steps: number;
  iteration: number;
  stage: string;
  /** Steps spent in the current stage */
  stageSteps: number;
  snapshots: PolicyJson[];
  /** Best held-out evaluation score so far (its policy is in best.json), and the modes it was scored on */
  bestScore?: number;
  bestModes?: string;
  /** The last few evaluation scores (one swings by ±0.4 from the next: the best is judged on their average) */
  recentScores?: number[];
}

/** Evaluate every this many iterations, on held-out maps against the scripted bot */
const EVAL_EVERY = 25;
/** Evaluations averaged to judge the best policy */
const SCORE_WINDOW = 3;
/** Matches per mode in an evaluation (3 swung by ±0.3 K/D from one to the next) */
const EVAL_MATCHES = 6;

/** When to move on from each stage: a rolling score must pass `pass` after at least `min` steps (or `max` steps pass). */
const PROMOTION: Record<string, { min: number; max: number; pass: (s: Rolling) => boolean }> = {
  aim: { min: 1e6, max: 8e6, pass: (s) => s.killsPerEpisode >= 5 },
  duel: { min: 6e6, max: 30e6, pass: (s) => s.kdVsScripted >= 1.5 },
  tdm: { min: 6e6, max: 30e6, pass: (s) => s.kdVsScripted >= 2 },
  ctf: { min: 15e6, max: 60e6, pass: (s) => s.capturesPerEpisode >= 0.6 },
  // Plants and defuses per learner per match, without forgetting how to fight.
  snd: { min: 10e6, max: 40e6, pass: (s) => s.capturesPerEpisode >= 0.5 && s.kdVsScripted >= 1.5 },
};

interface Rolling {
  killsPerEpisode: number;
  kdVsScripted: number;
  capturesPerEpisode: number;
  rewardPerEpisode: number;
}

/**
 * On a Mac, hold off idle sleep for as long as training runs (caffeinate, tied to this process, so it lets
 * go when training stops, however it stops). Asleep, a run just stalls: one iteration once took 15 minutes
 * instead of 10 seconds. The display may still sleep. --allow-sleep turns this off.
 */
function keepAwake(): void {
  if (process.platform !== 'darwin' || flag('allow-sleep')) return;
  try {
    // -i: no idle sleep; -s: no system sleep at all while on mains power (-i alone let the Mac drop back to
    // sleep after its brief maintenance wakes).
    const child = spawn('caffeinate', ['-s', '-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => console.warn('Could not keep the computer awake (caffeinate): it may sleep and pause training'));
    child.unref();
    console.log('Keeping the computer awake while training runs (--allow-sleep to let it sleep)');
  } catch { /* not available: carry on */ }
}

async function main(): Promise<void> {
  const workers = Number(opt('workers', String(Math.max(1, cpus().length - 1))));
  const totalSteps = count(opt('steps', '50M'));
  const batchSize = count(opt('batch', '32768'));
  const arenas = Number(opt('arenas', '2'));
  const dir = opt('dir', 'bots');
  const stageArg = opt('stage', 'auto');
  const viewPort = Number(opt('view-port', '7777'));
  keepAwake();
  const baseLr = Number(opt('lr', String(DEFAULT_PPO.lr)));
  mkdirSync(dir, { recursive: true });
  const latest = join(dir, 'latest.json');
  const bestFile = join(dir, 'best.json');
  const logFile = join(dir, 'train-log.jsonl');

  let trainer: PpoTrainer;
  let ckpt: Checkpoint;
  if (!flag('fresh') && existsSync(latest)) {
    const saved = JSON.parse(readFileSync(latest, 'utf8')) as Checkpoint;
    trainer = PpoTrainer.fromJSON(saved.trainer);
    ckpt = saved;
    console.log(`Resuming at ${fmt(saved.steps)} steps, stage ${saved.stage}`);
  } else {
    trainer = new PpoTrainer();
    ckpt = { trainer: trainer.toJSON(), steps: 0, iteration: 0, stage: 'aim', stageSteps: 0, snapshots: [] };
  }
  if (stageArg !== 'auto') {
    stageByName(stageArg);
    if (ckpt.stage !== stageArg) ckpt.stageSteps = 0;
    ckpt.stage = stageArg;
  }

  const view = viewPort > 0 ? startViewServer(viewPort, logFile) : null;

  // Workers: this same file. Worker 0 also streams its first match to the view.
  const pool: Worker[] = [];
  /** Each worker's reply to the request it's working on (view messages go to the view instead) */
  const waiting = new Map<Worker, (m: FromWorker) => void>();
  await Promise.all(Array.from({ length: workers }, (_, id) => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { id, arenas, view: !!view && id === 0 } });
    w.on('message', (m: FromWorker) => {
      if (m.type === 'view') {
        view?.broadcast(m.event, m.data);
      } else if (m.type === 'ready') {
        resolve();
      } else {
        const reply = waiting.get(w);
        waiting.delete(w);
        reply?.(m);
      }
    });
    w.on('error', (err) => {
      console.error(`Worker ${id} failed:`, err);
      reject(err);
      process.exit(1);
    });
    pool.push(w);
  })));
  const ask = <T extends FromWorker>(w: Worker, msg: ToWorker, transfer: ArrayBuffer[] = []): Promise<T> =>
    new Promise((resolve) => {
      waiting.set(w, resolve as (m: FromWorker) => void);
      w.postMessage(msg, transfer);
    });

  const sent = new Set<number>();
  let snapshotIds = ckpt.snapshots.map((_, i) => i);
  let nextSnapshotId = ckpt.snapshots.length;
  const snapshotJson = new Map<number, PolicyJson>(ckpt.snapshots.map((s, i) => [i, s]));
  const history: Rolling[] = [];
  console.log(`Training with ${workers} workers × ${arenas} arenas, ${fmt(batchSize)} steps per update, up to ${fmt(totalSteps)} steps`);

  while (ckpt.steps < totalSteps) {
    const started = Date.now();
    const { policy, value } = trainer;
    const weights: Weights = { policy: policy.net.params, logStd: policy.logStd, value: value.params, norm: policy.norm.toJSON() };
    const fresh = snapshotIds.filter((id) => !sent.has(id)).map((id) => ({ id, json: snapshotJson.get(id)! }));
    fresh.forEach((s) => sent.add(s.id));

    // 1. Play.
    view?.broadcast('status', { phase: 'playing', iteration: ckpt.iteration + 1, steps: ckpt.steps, stage: ckpt.stage, workers, batch: batchSize });
    const results = await Promise.all(pool.map((w) => ask<Extract<FromWorker, { type: 'rollout' }>>(w, {
      type: 'rollout', steps: Math.ceil(batchSize / workers), stage: ckpt.stage, weights, snapshots: fresh, pool: snapshotIds,
    })));
    const rolled = Date.now();
    const batch = concatBatches(results.map((r) => r.batch));
    const stats = mergeStats(results.map((r) => r.stats));

    // 2. Learn: every worker computes its share of each minibatch's gradient.
    view?.broadcast('status', { phase: 'learning', iteration: ckpt.iteration + 1, steps: ckpt.steps, stage: ckpt.stage, workers, batch: batchSize });
    const shared = sharedBatch(batch);
    const advShared = new Float32Array(new SharedArrayBuffer(batch.n * 4));
    advShared.set(PpoTrainer.normalizedAdvantages(batch));
    await Promise.all(pool.map((w) => { w.postMessage({ type: 'batch', batch: shared, adv: advShared } satisfies ToWorker); return Promise.resolve(); }));
    const progress = ckpt.steps / totalSteps;
    const lr = baseLr * (1 - 0.7 * progress);
    const update = await trainer.update(shared, lr, Math.random, async (rows, minibatch) => {
      const per = Math.ceil(rows.length / pool.length);
      const parts = await Promise.all(pool.map((w, i) => {
        const shard = rows.slice(i * per, (i + 1) * per);
        if (!shard.length) return null;
        return ask<Extract<FromWorker, { type: 'grad' }>>(w, {
          type: 'grad', weights: { policy: policy.net.params, logStd: policy.logStd, value: value.params }, rows: shard, minibatch,
        });
      }));
      return sumGradients(parts.filter((p) => p !== null).map((p) => p.grads));
    });
    // Obs normaliser: fold in what the learners saw (the batch was normalised with the old one).
    policy.norm.merge(stats.obsCount, stats.obsMean, stats.obsM2);

    ckpt.steps += stats.steps;
    ckpt.stageSteps += stats.steps;
    ckpt.iteration++;

    // 3. Report.
    const rolling: Rolling = {
      killsPerEpisode: stats.learnerEpisodes ? stats.kills / stats.learnerEpisodes : 0,
      kdVsScripted: stats.vsScripted.kills / Math.max(1, stats.vsScripted.deaths),
      capturesPerEpisode: stats.learnerEpisodes ? stats.captures / stats.learnerEpisodes : 0,
      rewardPerEpisode: stats.learnerEpisodes ? stats.reward / stats.learnerEpisodes : 0,
    };
    history.push(rolling);
    if (history.length > 8) history.shift();
    const avg = averageRolling(history);
    const secs = (Date.now() - started) / 1000;
    console.log([
      `#${ckpt.iteration}`, ckpt.stage, `${fmt(ckpt.steps)} steps`,
      `R/ep ${avg.rewardPerEpisode.toFixed(2)}`, `K/ep ${avg.killsPerEpisode.toFixed(2)}`, `KD vs bot ${avg.kdVsScripted.toFixed(2)}`,
      `cap/ep ${avg.capturesPerEpisode.toFixed(2)}`, `H ${update.entropy.toFixed(2)}`, `kl ${update.approxKl.toFixed(3)}`,
      `vl ${update.valueLoss.toFixed(3)}`, `${(stats.steps / secs).toFixed(0)} st/s (play ${((rolled - started) / 1000).toFixed(1)}s)`,
    ].join(' · '));
    const parts = Object.fromEntries(Object.entries(stats.parts).map(([k, v]) => [k, Math.round((v / Math.max(1, stats.learnerEpisodes)) * 100) / 100]));
    const row = { t: Date.now(), iteration: ckpt.iteration, steps: ckpt.steps, stage: ckpt.stage, sps: Math.round(stats.steps / secs), ...rolling, ...update, parts };
    appendFileSync(logFile, `${JSON.stringify(row)}\n`);
    view?.broadcast('iteration', row);

    // 4. Curriculum.
    const rule = PROMOTION[ckpt.stage];
    if (stageArg === 'auto' && rule && history.length >= 4 && ckpt.stageSteps >= rule.min && (rule.pass(avg) || ckpt.stageSteps >= rule.max)) {
      const next = STAGES[STAGES.findIndex((s) => s.name === ckpt.stage) + 1];
      if (next) {
        console.log(`→ Stage ${next.name}`);
        view?.broadcast('stage', { stage: next.name, steps: ckpt.steps });
        ckpt.stage = next.name;
        ckpt.stageSteps = 0;
        history.length = 0;
      }
    }

    // 5. Snapshots for self-play, and the checkpoint.
    if (ckpt.iteration % 10 === 0) {
      const id = nextSnapshotId++;
      snapshotJson.set(id, policy.toJSON());
      snapshotIds = [...snapshotIds, id].slice(-10);
      for (const key of [...snapshotJson.keys()]) if (!snapshotIds.includes(key)) snapshotJson.delete(key);
    }
    if (ckpt.iteration % 5 === 0 || ckpt.steps >= totalSteps) {
      ckpt.trainer = trainer.toJSON();
      ckpt.snapshots = snapshotIds.map((id) => snapshotJson.get(id)!);
      const tmp = `${latest}.tmp`;
      writeFileSync(tmp, JSON.stringify(ckpt));
      renameSync(tmp, latest);
      if (ckpt.iteration % 50 === 0) writeFileSync(join(dir, `ckpt-${ckpt.iteration}.json`), JSON.stringify({ policy: ckpt.trainer.policy, steps: ckpt.steps, stage: ckpt.stage }));
    }

    // 6. How good is it really? Matches against the scripted bot on maps training never uses, in every
    // mode trained so far. The best policy by that is kept (and is what export:bots ships).
    if (ckpt.iteration % EVAL_EVERY === 0) {
      const stageAt = STAGES.findIndex((st) => st.name === ckpt.stage);
      const from = (name: string) => stageAt >= STAGES.findIndex((st) => st.name === name);
      const modes: GameMode[] = from('snd') ? ['ffa', 'tdm', 'ctf', 'snd'] : from('ctf') ? ['ffa', 'tdm', 'ctf'] : from('tdm') ? ['ffa', 'tdm'] : ['ffa'];
      const jobs = modes.flatMap((mode) => Array.from({ length: EVAL_MATCHES }, (_, i) => ({ mode, seed: EVAL_SEEDS[i]! })));
      const policyJson = policy.toJSON();
      const results: EvalResult[] = [];
      const queue = [...jobs];
      view?.broadcast('status', { phase: 'evaluating', iteration: ckpt.iteration, steps: ckpt.steps, stage: ckpt.stage, workers, batch: batchSize });
      await Promise.all(pool.map(async (w) => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const r = await ask<Extract<FromWorker, { type: 'eval' }>>(w, { type: 'eval', policy: policyJson, ...job });
          results.push(r.result);
        }
      }));
      const { score, byMode } = evalScore(results);
      // Scores over different modes don't compare: when a stage adds a mode, the old best is kept aside
      // and the new set starts its own.
      // (The version: scores from before the bounded margins and averaging don't compare either.)
      const modeKey = `${modes.join('-')}-v2`;
      if (ckpt.bestModes !== modeKey) {
        if (ckpt.bestModes && existsSync(bestFile)) writeFileSync(join(dir, `best-${ckpt.bestModes}.json`), readFileSync(bestFile));
        ckpt.bestModes = modeKey;
        ckpt.bestScore = undefined;
        ckpt.recentScores = [];
      }
      // Judged on the average of the last few evaluations, so a lucky one doesn't become the shipped policy.
      ckpt.recentScores = [...(ckpt.recentScores ?? []), score].slice(-SCORE_WINDOW);
      const smoothed = ckpt.recentScores.reduce((a, b) => a + b, 0) / ckpt.recentScores.length;
      const best = ckpt.bestScore ?? -Infinity;
      const improved = ckpt.recentScores.length >= SCORE_WINDOW && smoothed > best;
      if (improved) {
        ckpt.bestScore = smoothed;
        writeFileSync(bestFile, JSON.stringify({ policy: policyJson, steps: ckpt.steps, stage: ckpt.stage, eval: { score, smoothed, byMode } }));
      }
      const summary = Object.entries(byMode).map(([m, r]) => `${m} K/D ${r.kd.toFixed(2)}${m === 'ctf' ? ` caps ${r.captures}-${r.against}` : m === 'snd' ? ` rounds ${r.captures}-${r.against}` : ''}`).join(' · ');
      console.log(`  eval: ${summary} · score ${score.toFixed(2)}, last ${ckpt.recentScores.length} ${smoothed.toFixed(2)}${improved ? ' (best so far: saved)' : Number.isFinite(best) ? ` (best ${best.toFixed(2)})` : ''}`);
      const evalRow = { t: Date.now(), type: 'eval', iteration: ckpt.iteration, steps: ckpt.steps, stage: ckpt.stage, score, smoothed, best: improved ? smoothed : Number.isFinite(best) ? best : null, byMode };
      appendFileSync(logFile, `${JSON.stringify(evalRow)}\n`);
      view?.broadcast('eval', evalRow);
      if (improved) {
        ckpt.trainer = trainer.toJSON();
        writeFileSync(`${latest}.tmp`, JSON.stringify({ ...ckpt, snapshots: snapshotIds.map((id) => snapshotJson.get(id)!) }));
        renameSync(`${latest}.tmp`, latest);
      }
    }
  }
  console.log('Done. Export with: npm run export:bots');
  view?.broadcast('status', { phase: 'done', iteration: ckpt.iteration, steps: ckpt.steps, stage: ckpt.stage, workers, batch: batchSize });
  view?.close();
  await Promise.all(pool.map((w) => w.terminate()));
}

function sumGradients(parts: Gradients[]): Gradients {
  const [first, ...rest] = parts;
  if (!first) throw new Error('No gradients');
  for (const g of rest) {
    for (let i = 0; i < first.policy.length; i++) first.policy[i]! += g.policy[i]!;
    for (let i = 0; i < first.logStd.length; i++) first.logStd[i]! += g.logStd[i]!;
    for (let i = 0; i < first.value.length; i++) first.value[i]! += g.value[i]!;
    first.policyLoss += g.policyLoss;
    first.valueLoss += g.valueLoss;
    first.entropy += g.entropy;
    first.clipped += g.clipped;
    first.kl += g.kl;
    first.rows += g.rows;
  }
  return first;
}

function mergeStats(list: RolloutStats[]): RolloutStats {
  const out = list[0]!;
  for (const s of list.slice(1)) {
    out.steps += s.steps;
    out.episodes += s.episodes;
    out.reward += s.reward;
    out.learnerEpisodes += s.learnerEpisodes;
    out.kills += s.kills;
    out.deaths += s.deaths;
    out.captures += s.captures;
    out.vsScripted.kills += s.vsScripted.kills;
    out.vsScripted.deaths += s.vsScripted.deaths;
    for (const [k, v] of Object.entries(s.parts)) out.parts[k] = (out.parts[k] ?? 0) + v;
    // Combine the observation moments (parallel Welford).
    const total = out.obsCount + s.obsCount;
    if (total > 0) {
      for (let i = 0; i < OBS_SIZE; i++) {
        const delta = s.obsMean[i]! - out.obsMean[i]!;
        out.obsM2[i] = out.obsM2[i]! + s.obsM2[i]! + (delta * delta * out.obsCount * s.obsCount) / total;
        out.obsMean[i] = out.obsMean[i]! + (delta * s.obsCount) / total;
      }
    }
    out.obsCount = total;
  }
  return out;
}

function averageRolling(list: Rolling[]): Rolling {
  const n = list.length || 1;
  const sum = (k: keyof Rolling) => list.reduce((s, r) => s + r[k], 0) / n;
  return { killsPerEpisode: sum('killsPerEpisode'), kdVsScripted: sum('kdVsScripted'), capturesPerEpisode: sum('capturesPerEpisode'), rewardPerEpisode: sum('rewardPerEpisode') };
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

if (isMainThread) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
} else {
  void workerMain();
}
