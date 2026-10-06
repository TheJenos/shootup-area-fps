import { useEffect, useState } from 'react';
import { cachedMap, specKey, type MapData, type MapSpec } from '../game/mapgen';
import { requestMap } from '../game/mapgen/client';

/**
 * The map for `spec`, built in the worker once the spec has stopped changing for a moment (typing
 * a seed shouldn't build a map per keystroke). `pending` while it's being built.
 */
export function useMapData(spec: MapSpec | null, delay = 250): { map: MapData | null; pending: boolean } {
  const key = spec ? specKey(spec) : '';
  const [state, setState] = useState<{ key: string; map: MapData | null }>(() => ({ key, map: spec ? cachedMap(spec) : null }));
  useEffect(() => {
    if (!spec) {
      setState({ key: '', map: null });
      return;
    }
    const hit = cachedMap(spec);
    if (hit) {
      setState({ key, map: hit });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      requestMap(spec)
        .then((map) => { if (!cancelled) setState({ key, map }); })
        .catch((err: unknown) => console.warn('Could not build the map preview', err));
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);
  const current = state.key === key ? state.map : null;
  return { map: current, pending: !!spec && !current };
}
