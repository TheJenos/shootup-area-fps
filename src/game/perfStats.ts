/**
 * Debug performance numbers, shown under the FPS counter when the page is opened with `?debug`.
 * The game loop and the network layer write here; the HUD reads it twice a second.
 * Everything is a no-op unless debug is on, so it costs nothing in normal play.
 */
export const PERF_DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

export const perfStats = {
  /** Frame times (ms) since the HUD last sampled */
  frameSum: 0,
  frameMax: 0,
  frames: 0,
  /** From renderer.info after the last frame */
  calls: 0,
  triangles: 0,
  programs: 0,
  geometries: 0,
  textures: 0,
  /** Approximate JSON bytes to and from Firebase since the HUD last sampled */
  netUp: 0,
  netDown: 0,
};

/** Count the JSON size of a value going to (`up`) or coming from Firebase. */
export function countNet(dir: 'up' | 'down', value: unknown): void {
  if (!PERF_DEBUG) return;
  const bytes = JSON.stringify(value)?.length ?? 0;
  if (dir === 'up') perfStats.netUp += bytes;
  else perfStats.netDown += bytes;
}
