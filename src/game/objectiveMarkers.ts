import * as THREE from 'three';

/*
 * Where to go: a marker over each objective (the enemy flag, our flag when it's away, the bomb
 * sites, a planted or dropped bomb), with its distance. On screen it floats above the thing;
 * off screen it's pinned to the edge, with an arrow pointing the way. Plain DOM elements moved
 * each frame, so the React HUD never re-renders for them.
 */

export interface Objective {
  id: string;
  /** What's shown in the marker (a letter, a flag sign) */
  icon: string;
  label: string;
  color: string;
  pos: THREE.Vector3;
  /** Pulses: something ticking or on the move */
  live?: boolean;
}

/** Keep markers this far in from the screen's edges (px): about half a pinned marker's height, so none of it is cut off */
const MARGIN = 36;
/** Markers this close to the player are dropped (standing on it) */
const NEAR = 2.5;

const _v = new THREE.Vector3();

export class ObjectiveMarkers {
  readonly root = document.createElement('div');
  private readonly nodes = new Map<string, { el: HTMLElement; arrow: HTMLElement; dist: HTMLElement; key: string }>();
  /** The screen's safe-area insets (notch, rounded corners, home indicator), px: pinned markers stay inside them */
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor() {
    this.root.id = 'objective-markers';
    this.root.setAttribute('aria-hidden', 'true');
  }

  mount(el: HTMLElement | null): void {
    if (el) {
      el.appendChild(this.root);
      this.readInsets();
      window.addEventListener('resize', this.readInsets);
    } else {
      this.root.remove();
      window.removeEventListener('resize', this.readInsets);
    }
  }

  /** The root is padded by env(safe-area-inset-*) in the CSS; reading the padding back is the only way to get them. */
  private readonly readInsets = (): void => {
    const style = getComputedStyle(this.root);
    this.insets = {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  };

  /** Lay the markers out for this frame. `width`/`height`: the screen (CSS px). */
  update(objectives: Objective[], camera: THREE.Camera, eye: THREE.Vector3, width: number, height: number): void {
    const seen = new Set<string>();
    // The box markers stay inside: the screen less the margin and the safe-area insets.
    const left = MARGIN + this.insets.left;
    const right = width - MARGIN - this.insets.right;
    const top = MARGIN + this.insets.top;
    const bottom = height - MARGIN - this.insets.bottom;
    for (const o of objectives) {
      const d = o.pos.distanceTo(eye);
      if (d < NEAR) continue;
      seen.add(o.id);
      let node = this.nodes.get(o.id);
      const key = `${o.icon}|${o.label}|${o.color}|${o.live ? 1 : 0}`;
      if (!node) {
        const el = document.createElement('div');
        el.className = 'objective';
        const icon = document.createElement('span');
        icon.className = 'icon';
        const label = document.createElement('span');
        label.className = 'label';
        const dist = document.createElement('span');
        dist.className = 'dist';
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        el.append(icon, label, dist, arrow);
        this.root.appendChild(el);
        node = { el, arrow, dist, key: '' };
        this.nodes.set(o.id, node);
      }
      if (node.key !== key) {
        node.key = key;
        (node.el.children[0] as HTMLElement).textContent = o.icon;
        (node.el.children[1] as HTMLElement).textContent = o.label;
        node.el.style.setProperty('--objective', o.color);
        node.el.classList.toggle('live', !!o.live);
      }
      node.dist.textContent = `${Math.round(d)} m`;

      // Project: clip space z > 1 means behind the camera.
      _v.copy(o.pos).project(camera);
      const behind = _v.z > 1;
      let x = (_v.x * 0.5 + 0.5) * width;
      let y = (-_v.y * 0.5 + 0.5) * height - 26;
      if (behind) {
        x = width - x;
        y = height - y;
      }
      const onScreen = !behind && x >= left && x <= right && y >= top && y <= bottom;
      let angle = 0;
      if (!onScreen) {
        // Pin to the edge along the line from the box's centre to the point.
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;
        let dx = x - cx;
        let dy = y - cy;
        if (behind) {
          dy = Math.abs(dy) + height; // always toward the bottom edge when it's behind us
        }
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const tx = dx !== 0 ? (cx - left) / Math.abs(dx) : Infinity;
        const ty = dy !== 0 ? (cy - top) / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        x = cx + dx * t;
        y = cy + dy * t;
        angle = Math.atan2(dy, dx);
      }
      node.el.classList.toggle('edge', !onScreen);
      node.el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
      node.arrow.style.transform = `rotate(${angle.toFixed(3)}rad)`;
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      node.el.remove();
      this.nodes.delete(id);
    }
  }

  clear(): void {
    for (const node of this.nodes.values()) node.el.remove();
    this.nodes.clear();
  }
}
