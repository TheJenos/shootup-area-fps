import { useEffect, useRef } from 'react';
import { ARENA_HALF, type MapLayout } from '../game/mapgen';
import { FLAG_BASES, TEAM_INFO } from '../game/modes';
import type { GameMode } from '../types';

const SIZE = 168;

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Top-down drawing of a generated map; taller cover is drawn brighter. */
export function MapPreview({ map, mode }: { map: MapLayout; mode: GameMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = SIZE * ratio;
    canvas.height = SIZE * ratio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);

    const scale = SIZE / (ARENA_HALF * 2 + 1);
    const px = (v: number) => (v + ARENA_HALF + 0.5) * scale;

    g.fillStyle = map.theme.floor;
    g.fillRect(0, 0, SIZE, SIZE);
    g.strokeStyle = hex(map.theme.wall);
    g.lineWidth = scale * 1.5;
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, SIZE - g.lineWidth, SIZE - g.lineWidth);

    // Low boxes first so taller ones on top of them stay visible.
    for (const b of [...map.boxes].sort((a, c) => a.y + a.h - (c.y + c.h))) {
      const x0 = px(b.x - b.w / 2);
      const z0 = px(b.z - b.d / 2);
      if (b.ramp) {
        // Ramps shade from dim at the floor to bright at the top.
        const horizontal = b.ramp[0] === 'x';
        const up = b.ramp[1] === '+';
        const grad = horizontal
          ? g.createLinearGradient(x0, 0, x0 + b.w * scale, 0)
          : g.createLinearGradient(0, z0, 0, z0 + b.d * scale);
        const c = hex(b.color);
        grad.addColorStop(up ? 0 : 1, `${c}33`);
        grad.addColorStop(up ? 1 : 0, `${c}ee`);
        g.globalAlpha = 1;
        g.fillStyle = grad;
      } else {
        g.globalAlpha = Math.min(1, 0.55 + (b.y + b.h) / 8);
        g.fillStyle = hex(b.color);
      }
      g.fillRect(x0, z0, b.w * scale, b.d * scale);
    }
    g.globalAlpha = 1;

    g.fillStyle = 'rgba(255, 255, 255, 0.75)';
    for (const [x, z] of map.spawnPoints) {
      g.beginPath();
      g.arc(px(x), px(z), 1.6, 0, Math.PI * 2);
      g.fill();
    }

    if (mode === 'ctf') {
      for (const team of ['red', 'blue'] as const) {
        const base = FLAG_BASES[team];
        g.strokeStyle = TEAM_INFO[team].color;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(px(base.x), px(base.z), 1.5 * scale + 2, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }, [map, mode]);

  return <canvas ref={canvasRef} className="map-preview" style={{ width: SIZE, height: SIZE }} />;
}
