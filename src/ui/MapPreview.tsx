import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildWorld } from '../game/world';
import { PAINT, type MapData } from '../game/mapgen';
import { TEAM_INFO } from '../game/modes';
import { bombSites, SITE_IDS } from '../game/snd';
import type { GameMode } from '../types';

const SIZE = 168;
/** Seconds per full turn when nobody is dragging */
const ORBIT_PERIOD = 40;

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const SITE_COLOR = '#ffb020';
/** S&D: the sites blue defends in the first half (red attacks first); the second half mirrors them */
const firstSites = (map: MapData) => bombSites(map, 'blue');

/** Ground patch colors in the preview */
const GROUND_COLORS: Record<MapData['patches'][number]['kind'], string> = {
  road: '#3e4046', sidewalk: '#8f8d88', grass: '#567e3e', dirt: '#78603f', concrete: '#8a8a86', hazard: '#b8962a',
};

/** Top-down drawing of a generated map; taller cover is drawn brighter. The fallback when WebGL isn't available. */
function draw2D(canvas: HTMLCanvasElement, map: MapData, mode: GameMode): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = SIZE * ratio;
  canvas.height = SIZE * ratio;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);

  const scale = SIZE / (map.half * 2 + 1);
  const px = (v: number) => (v + map.half + 0.5) * scale;

  g.fillStyle = map.theme.floor;
  g.fillRect(0, 0, SIZE, SIZE);

  // The land: higher is lighter, lanes painted, slopes lit from the north-west so they read as relief.
  const t = map.ground;
  if (t) {
    const side = t.n + 1;
    const h = (c: number, r: number) => t.heights[Math.min(t.n, r) * side + Math.min(t.n, c)]!;
    for (let r = 0; r < t.n; r++) {
      for (let c = 0; c < t.n; c++) {
        const shade = (h(c, r) - h(c + 1, r + 1)) * 0.5 + (h(c, r) - 1) * 0.04;
        g.fillStyle = shade >= 0 ? `rgba(255, 255, 255, ${Math.min(0.4, shade)})` : `rgba(0, 0, 0, ${Math.min(0.4, -shade)})`;
        g.fillRect(px(-map.half + c * t.cell), px(-map.half + r * t.cell), t.cell * scale + 0.5, t.cell * scale + 0.5);
        if (t.paint[r * side + c] === PAINT.path) {
          g.fillStyle = 'rgba(120, 96, 70, 0.35)';
          g.fillRect(px(-map.half + c * t.cell), px(-map.half + r * t.cell), t.cell * scale + 0.5, t.cell * scale + 0.5);
        }
      }
    }
  }
  g.strokeStyle = hex(map.theme.wall);
  g.lineWidth = scale * 1.5;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, SIZE - g.lineWidth, SIZE - g.lineWidth);

  // Yards and plazas under everything; roads get a dashed centre line.
  for (const p of map.patches) {
    g.fillStyle = GROUND_COLORS[p.kind];
    g.fillRect(px(p.x - p.w / 2), px(p.z - p.d / 2), p.w * scale, p.d * scale);
    if (p.kind === 'road') {
      g.strokeStyle = 'rgba(230, 210, 130, 0.6)';
      g.lineWidth = 0.6;
      g.setLineDash([2, 2]);
      g.beginPath();
      if (p.d >= p.w) { g.moveTo(px(p.x), px(p.z - p.d / 2)); g.lineTo(px(p.x), px(p.z + p.d / 2)); }
      else { g.moveTo(px(p.x - p.w / 2), px(p.z)); g.lineTo(px(p.x + p.w / 2), px(p.z)); }
      g.stroke();
      g.setLineDash([]);
    }
  }

  // Low boxes first so taller ones on top of them stay visible. Tree canopies (shots only) are skipped.
  for (const b of [...map.boxes].filter((b) => b.blocks !== 'shots').sort((a, c) => a.y + a.h - (c.y + c.h))) {
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
    if (b.shape === 'cylinder') {
      g.beginPath();
      g.ellipse(px(b.x), px(b.z), (b.w / 2) * scale, (b.d / 2) * scale, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillRect(x0, z0, b.w * scale, b.d * scale);
    }
  }
  g.globalAlpha = 1;

  for (const s of map.spawns) {
    g.fillStyle = mode === 'ffa' || !s.team ? 'rgba(255, 255, 255, 0.75)' : TEAM_INFO[s.team].color;
    g.beginPath();
    g.arc(px(s.x), px(s.z), 1.6, 0, Math.PI * 2);
    g.fill();
  }

  if (mode === 'ctf') {
    for (const team of ['red', 'blue'] as const) {
      const [x, , z] = map.flags[team];
      g.strokeStyle = TEAM_INFO[team].color;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px(x), px(z), 1.5 * scale + 2, 0, Math.PI * 2);
      g.stroke();
    }
  }
  if (mode === 'snd') {
    const sites = firstSites(map);
    g.fillStyle = SITE_COLOR;
    g.strokeStyle = SITE_COLOR;
    g.lineWidth = 2;
    g.font = 'bold 10px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const id of SITE_IDS) {
      const { x, z } = sites[id];
      g.beginPath();
      g.arc(px(x), px(z), 3.5 * scale, 0, Math.PI * 2);
      g.stroke();
      g.fillText(id.toUpperCase(), px(x), px(z));
    }
  }
}

/**
 * One renderer for every preview: its canvas moves into whichever preview is showing, so changing
 * the seed in the lobby doesn't make (and leak) a new WebGL context each time.
 */
let shared: THREE.WebGLRenderer | null | undefined;
function previewRenderer(): THREE.WebGLRenderer | null {
  if (shared !== undefined) return shared;
  try {
    shared = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    shared.shadowMap.enabled = true;
    shared.shadowMap.type = THREE.PCFShadowMap;
    shared.domElement.className = 'map-preview-gl';
  } catch {
    shared = null;
  }
  return shared;
}

/** A team-coloured ring and pole where each CTF flag stands. */
function flagMarkers(map: MapData): THREE.Group {
  const g = new THREE.Group();
  for (const team of ['red', 'blue'] as const) {
    const [x, y, z] = map.flags[team];
    const base = { x, y, z };
    const mat = new THREE.MeshBasicMaterial({ color: TEAM_INFO[team].color, fog: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 32).rotateX(-Math.PI / 2), mat);
    ring.position.set(base.x, base.y + 0.05, base.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4, 8), mat);
    pole.position.set(base.x, base.y + 2, base.z);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 0.08), mat);
    flag.position.set(base.x + 0.7, base.y + 3.5, base.z);
    g.add(ring, pole, flag);
  }
  return g;
}

/** S&D: an amber ring and post at each of the first half's bomb sites (the second post on B is taller). */
function siteMarkers(map: MapData): THREE.Group {
  const g = new THREE.Group();
  const sites = firstSites(map);
  SITE_IDS.forEach((id, i) => {
    const { x, y, z } = sites[id];
    const mat = new THREE.MeshBasicMaterial({ color: SITE_COLOR, fog: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.6, 40).rotateX(-Math.PI / 2), mat);
    ring.position.set(x, y + 0.05, z);
    const height = 3 + i * 1.5;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, height, 8), mat);
    post.position.set(x, y + height / 2, z);
    g.add(ring, post);
  });
  return g;
}

/** A small 3D view of a generated map, slowly orbiting; drag to turn it. */
export function MapPreview({ map, mode }: { map: MapData; mode: GameMode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    if (flat) {
      if (canvasRef.current) draw2D(canvasRef.current, map, mode);
      return;
    }
    const host = hostRef.current;
    const renderer = previewRenderer();
    if (!host || !renderer) {
      setFlat(true);
      return;
    }
    const scene = new THREE.Scene();
    const world = buildWorld(scene, map, { colliders: [], solids: [], ramps: [], obstacles: [] });
    world.setQuality('low');
    // Seen from outside, so push the fog back to just soften the far edge.
    scene.fog = new THREE.Fog(map.theme.sky, map.half * 2.75, map.half * 5.5);
    const markers = mode === 'ctf' ? flagMarkers(map) : mode === 'snd' ? siteMarkers(map) : null;
    if (markers) scene.add(markers);

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 400);
    const size = () => {
      const w = host.clientWidth || SIZE;
      const h = host.clientHeight || SIZE;
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    host.appendChild(renderer.domElement);
    size();

    let yaw = Math.PI / 4;
    let pitch = 0.85;
    let dragging: { x: number; y: number } | null = null;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Another preview took the canvas: this one stops drawing.
      if (renderer.domElement.parentElement !== host) return;
      if (!dragging) yaw += (dt * Math.PI * 2) / ORBIT_PERIOD;
      const dist = map.half * 3.05;
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(tick);

    const el = renderer.domElement;
    const down = (e: PointerEvent) => {
      dragging = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - dragging.x) * 0.01;
      pitch = Math.max(0.25, Math.min(1.45, pitch + (e.clientY - dragging.y) * 0.01));
      dragging = { x: e.clientX, y: e.clientY };
    };
    const up = () => { dragging = null; };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    const resize = new ResizeObserver(size);
    resize.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.parentElement === host) host.removeChild(el);
      world.dispose();
      markers?.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    };
  }, [map, mode, flat]);

  const label = `Map preview: ${map.name}${mode === 'ctf' ? ', flag bases marked' : mode === 'snd' ? ', bomb sites A and B marked' : ''}`;
  if (flat) {
    return <canvas ref={canvasRef} className="map-preview" role="img" aria-label={label} style={{ width: SIZE, height: SIZE }} />;
  }
  return <div ref={hostRef} className="map-preview gl" role="img" aria-label={`${label}. Drag to turn it.`} style={{ width: SIZE, height: SIZE }} />;
}
