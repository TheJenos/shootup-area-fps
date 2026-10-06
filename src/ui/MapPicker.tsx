import { useState, type ReactNode } from 'react';
import {
  CLASSIC_SEED, GENERATOR_VERSION, MAP_SIZES, SEED_MAX_LENGTH, SIZE_LABEL, isMapSize, mapName, normalizeSeed, randomSeed,
  type MapSize, type MapSpec,
} from '../game/mapgen';
import type { GameMode } from '../types';
import { MapPreview } from './MapPreview';
import { useMapData } from './useMapData';

const SIZE_KEY = 'fps-map-size';

function loadSize(): MapSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return isMapSize(v) ? v : 'm';
  } catch {
    return 'm';
  }
}

function saveSize(size: MapSize): void {
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch { /* storage unavailable */ }
}

/** The map being chosen: a seed (blank means a random one when the room is made) and a size. */
export function useMapChoice(): {
  seed: string;
  setSeed(seed: string): void;
  size: MapSize;
  setSize(size: MapSize): void;
  /** The spec to create the room with (a fresh random seed if none was given) */
  spec(): MapSpec;
} {
  const [seed, setSeed] = useState(randomSeed);
  const [size, setSizeState] = useState(loadSize);
  const setSize = (s: MapSize) => {
    setSizeState(s);
    saveSize(s);
  };
  return { seed, setSeed, size, setSize, spec: () => ({ seed: seed || randomSeed(), size, gen: GENERATOR_VERSION }) };
}

interface Props {
  choice: ReturnType<typeof useMapChoice>;
  mode: GameMode;
  /** Line under the seed box */
  hint: ReactNode;
}

/** Map seed, size and a live preview, for creating a room. */
export function MapPicker({ choice, mode, hint }: Props) {
  const { seed, setSeed, size, setSize } = choice;
  const classic = seed === CLASSIC_SEED;
  const { map, pending } = useMapData(seed ? { seed, size, gen: GENERATOR_VERSION } : null);
  return (
    <div className="map-picker stacked">
      {map ? <MapPreview map={map} mode={mode} /> : <div className="map-preview empty">{seed ? <><span className="spinner" aria-hidden="true" />Building map…</> : 'Random map'}</div>}
      <div className="map-controls">
        <strong aria-live="polite">{seed ? mapName(seed) : 'Surprise me'}{pending && map ? '…' : ''}</strong>
        <div className="row">
          <input
            className="seed-input"
            value={seed}
            onChange={(e) => setSeed(normalizeSeed(e.target.value))}
            maxLength={SEED_MAX_LENGTH}
            placeholder="Seed"
            aria-label="Map seed"
            autoComplete="off"
          />
          <button type="button" title="New random map" aria-label="New random map" onClick={() => setSeed(randomSeed())}>🎲</button>
        </div>
        <div className="choices map-size" role="radiogroup" aria-label="Map size">
          {MAP_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={size === s}
              className={size === s ? 'choice selected' : 'choice'}
              disabled={classic}
              title={classic ? 'The classic arena has one size' : undefined}
              onClick={() => setSize(s)}
            >
              {SIZE_LABEL[s]}
            </button>
          ))}
        </div>
        <small className="muted">{hint}</small>
      </div>
    </div>
  );
}
