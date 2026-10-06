/**
 * Maps built in a worker, so the page doesn't stall while the lobby previews a seed or the game
 * gets the next round's map ready. Falls back to building on the page if workers aren't allowed.
 */

import { cachedMap, generateMap, remember } from './index';
import { specKey, type MapSpec } from './spec';
import type { MapData } from './types';

type Reply = { id: number; map?: MapData; error?: string };

/** undefined: not started yet; null: unavailable (build on the page) */
let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, { spec: MapSpec; resolve(map: MapData): void; reject(err: Error): void }>();
const inFlight = new Map<string, Promise<MapData>>();

/** Build on the page, after letting the current frame finish. */
const onPage = (spec: MapSpec) => new Promise<MapData>((resolve, reject) => {
  setTimeout(() => {
    try {
      resolve(generateMap(spec));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }, 0);
});

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<Reply>) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.map) {
        remember(specKey(job.spec), e.data.map);
        job.resolve(e.data.map);
      } else {
        job.reject(new Error(e.data.error ?? 'Map generation failed'));
      }
    };
    w.onerror = (e) => {
      // The worker couldn't load (blocked by the page's policy, say): build everything on the page.
      e.preventDefault();
      console.warn('Map worker unavailable, building maps on the page', e.message);
      worker = null;
      w.terminate();
      for (const job of waiting.values()) onPage(job.spec).then(job.resolve, job.reject);
      waiting.clear();
    };
    worker = w;
  } catch (err) {
    console.warn('Map worker unavailable, building maps on the page', err);
    worker = null;
  }
  return worker;
}

/** The map for `spec`, from the cache or built in the worker. */
export function requestMap(spec: MapSpec): Promise<MapData> {
  const hit = cachedMap(spec);
  if (hit) return Promise.resolve(hit);
  const key = specKey(spec);
  let job = inFlight.get(key);
  if (!job) {
    const w = startWorker();
    job = w
      ? new Promise<MapData>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { spec, resolve, reject });
        w.postMessage({ id, spec });
      })
      : onPage(spec);
    const done = job;
    inFlight.set(key, done);
    done.finally(() => { if (inFlight.get(key) === done) inFlight.delete(key); }).catch(() => {});
  }
  return job;
}

/** Start building a map we'll want soon (the next round's), ignoring failures. */
export function prefetchMap(spec: MapSpec): void {
  requestMap(spec).catch(() => {});
}
