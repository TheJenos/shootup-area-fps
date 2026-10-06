/** Builds maps off the main thread (see client.ts). */

import { generate } from './generate';
import type { MapSpec } from './spec';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; spec: MapSpec }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, spec } = e.data;
  try {
    const map = generate(spec);
    // The ground's arrays move to the page instead of being copied.
    const transfer = map.ground ? [map.ground.heights.buffer, map.ground.paint.buffer] : [];
    ctx.postMessage({ id, map }, transfer as Transferable[]);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
