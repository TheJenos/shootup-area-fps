import type { MapData } from './mapgen';
import type { Team } from '../types';

/*
 * A radar in the corner of the HUD: the map from above, turned so up is where we're facing, with
 * us in the middle, teammates, the enemies we know about (scanned, or shooting just now), flags,
 * bomb sites and pickups. The map itself is drawn once per map to an offscreen canvas; each frame
 * only copies a window of it and dots the markers on. It writes straight to its own canvas, so
 * the React HUD never re-renders for it.
 */

/** Metres from us to the radar's edge */
const RADIUS = 42;
/** Canvas size in CSS px */
export const MINIMAP_SIZE = 150;
/** Offscreen map resolution, px per metre */
const PPM = 2.5;

export interface MinimapMarker {
  x: number;
  z: number;
  kind: 'ally' | 'enemy' | 'flag' | 'site' | 'bomb' | 'pickup';
  color?: string;
  /** Flags: whose; sites: its letter */
  label?: string;
  /** Pulses, for things on the move or ticking (a carried flag, a planted bomb) */
  live?: boolean;
}

export interface MinimapView {
  x: number;
  z: number;
  yaw: number;
  team: Team | null;
  markers: MinimapMarker[];
}

const TEAM_COLOR: Record<Team, string> = { red: '#ff4d4d', blue: '#3d8bff' };

export class Minimap {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private half = 1;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor() {
    const size = MINIMAP_SIZE * this.dpr;
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.width = `${MINIMAP_SIZE}px`;
    this.canvas.style.height = `${MINIMAP_SIZE}px`;
    this.canvas.setAttribute('aria-hidden', 'true');
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not supported');
    this.g = g;
  }

  /** Put the radar in `el` (null takes it out) */
  mount(el: HTMLElement | null): void {
    if (el) el.appendChild(this.canvas);
    else this.canvas.remove();
  }

  /** Draw the map from above, once: the floor, then every box that stands in the way, by height. */
  setMap(map: MapData): void {
    this.half = map.half;
    const px = Math.ceil(map.half * 2 * PPM);
    const base = document.createElement('canvas');
    base.width = base.height = px;
    const g = base.getContext('2d');
    if (!g) return;
    g.fillStyle = '#1a2130';
    g.fillRect(0, 0, px, px);
    g.translate(px / 2, px / 2);
    g.scale(PPM, PPM);
    // Low cover is a lighter grey, walls and buildings lighter still, so routes read at a glance.
    const sorted = [...map.boxes].filter((b) => b.visible !== false || b.pivot).sort((a, b) => a.y + a.h - (b.y + b.h));
    for (const b of sorted) {
      const top = b.y + b.h;
      if (top < 0.4) continue;
      const shade = Math.min(1, 0.35 + top / 6);
      g.fillStyle = `rgba(${Math.round(120 * shade + 60)}, ${Math.round(130 * shade + 70)}, ${Math.round(150 * shade + 80)}, ${b.ramp ? 0.5 : 0.9})`;
      if (b.shape === 'cylinder') {
        g.beginPath();
        g.ellipse(b.x, b.z, b.w / 2, b.d / 2, 0, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillRect(b.x - b.w / 2, b.z - b.d / 2, b.w, b.d);
      }
    }
    this.base = base;
  }

  /** What was last drawn (the e2e tests read where the radar is centred) */
  lastView: MinimapView | null = null;

  draw(view: MinimapView): void {
    this.lastView = view;
    const { g, dpr } = this;
    const size = MINIMAP_SIZE * dpr;
    const c = size / 2;
    const scale = c / RADIUS;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    // A round window
    g.save();
    g.beginPath();
    g.arc(c, c, c - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#10151e';
    g.fillRect(0, 0, size, size);
    // World to radar: centre on us, turn so that where we face is up, then scale metres to px.
    g.translate(c, c);
    g.rotate(view.yaw);
    g.scale(scale, scale);
    g.translate(-view.x, -view.z);
    if (this.base) {
      const h = this.half;
      g.drawImage(this.base, -h, -h, h * 2, h * 2);
    }
    // Map edge
    g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    g.lineWidth = 0.6;
    g.strokeRect(-this.half, -this.half, this.half * 2, this.half * 2);
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 160);
    for (const m of view.markers) {
      const dx = m.x - view.x;
      const dz = m.z - view.z;
      // Off the radar: pinned to its edge in the right direction.
      const d = Math.hypot(dx, dz);
      const k = d > RADIUS - 2 ? (RADIUS - 2) / d : 1;
      const x = view.x + dx * k;
      const z = view.z + dz * k;
      g.save();
      g.translate(x, z);
      g.rotate(-view.yaw);
      const r = m.kind === 'pickup' ? 0.9 : 1.4;
      g.fillStyle = m.color ?? (m.kind === 'enemy' ? '#ff4d4d' : m.kind === 'pickup' ? '#ffd166' : '#fff');
      g.globalAlpha = m.live ? pulse : 1;
      if (m.kind === 'flag' || m.kind === 'site' || m.kind === 'bomb') {
        g.beginPath();
        g.moveTo(-1.6, 1.6);
        g.lineTo(0, -1.8);
        g.lineTo(1.6, 1.6);
        g.closePath();
        g.fill();
        if (m.label) {
          g.fillStyle = '#000';
          g.font = `bold ${2.2}px system-ui, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(m.label, 0, 0.4);
        }
      } else {
        g.beginPath();
        if (m.kind === 'enemy') {
          // Enemies are diamonds, allies circles: the two differ by more than colour (team colours, colour blindness).
          const e = r * 1.3;
          g.moveTo(0, -e);
          g.lineTo(e, 0);
          g.lineTo(0, e);
          g.lineTo(-e, 0);
          g.closePath();
        } else {
          g.arc(0, 0, r, 0, Math.PI * 2);
        }
        g.fill();
        if (m.kind === 'ally' || m.kind === 'enemy') {
          g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
          g.lineWidth = 0.35;
          g.stroke();
        }
      }
      g.restore();
    }
    g.restore();
    // Us: an arrow in the middle, pointing up (the way we face)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cc = MINIMAP_SIZE / 2;
    g.fillStyle = view.team ? TEAM_COLOR[view.team] : '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cc, cc - 7);
    g.lineTo(cc + 5, cc + 5);
    g.lineTo(cc, cc + 2);
    g.lineTo(cc - 5, cc + 5);
    g.closePath();
    g.fill();
    g.stroke();
    // Rim
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cc, cc, cc - 1, 0, Math.PI * 2);
    g.stroke();
  }
}
