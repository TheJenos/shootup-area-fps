import * as THREE from 'three';
import { canvas2d } from './canvas';

const WIDTH = 256;
const HEIGHT = 176;
/**
 * Size on screen (the sprite ignores distance): this much of the view's height, at the normal
 * field of view. Aiming down sights narrows the view, which enlarges it a little; that's fine.
 */
const SCREEN_HEIGHT = 0.16;

export type MarkerPose = 'stand' | 'run' | 'crouch';

type Pt = [number, number];
/** Head (centre, radius) and limbs (polylines) of the little figure, per pose, in canvas pixels. */
const FIGURES: Record<MarkerPose, { head: [number, number, number]; limbs: Pt[][] }> = {
  stand: {
    head: [128, 50, 10],
    limbs: [
      [[128, 64], [128, 98]],
      [[128, 70], [118, 84], [116, 98]],
      [[128, 70], [138, 84], [140, 98]],
      [[128, 98], [121, 112], [119, 128]],
      [[128, 98], [135, 112], [137, 128]],
    ],
  },
  run: {
    head: [139, 51, 10],
    limbs: [
      [[134, 65], [124, 97]],
      [[132, 71], [147, 81], [157, 72]],
      [[132, 71], [117, 79], [109, 91]],
      [[124, 97], [141, 108], [137, 127]],
      [[124, 97], [112, 112], [97, 113]],
    ],
  },
  crouch: {
    head: [133, 72, 10],
    limbs: [
      [[130, 85], [121, 107]],
      [[129, 90], [143, 99], [152, 94]],
      [[121, 107], [139, 114], [136, 128]],
      [[121, 107], [108, 118], [113, 128]],
    ],
  },
};

/**
 * What a teammate looks like while hidden behind cover: a flat icon drawn over the walls,
 * a dot, a small figure in their team colour (standing, running or crouched) and their name.
 * Same size on screen at any distance, so far-away teammates are still easy to spot.
 */
export class AllyMarker {
  readonly sprite: THREE.Sprite;

  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private name: string;
  private color = '#ffffff';
  private pose: MarkerPose = 'stand';

  constructor(name: string) {
    const { canvas, g } = canvas2d(WIDTH, HEIGHT);
    this.g = g;
    this.name = name;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
      fog: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set((SCREEN_HEIGHT * WIDTH) / HEIGHT, SCREEN_HEIGHT, 1);
    // Drawn after the world, so it sits on top of the walls hiding them.
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
    this.draw();
  }

  set(changes: { name?: string; color?: string; pose?: MarkerPose }): void {
    const name = changes.name ?? this.name;
    const color = changes.color ?? this.color;
    const pose = changes.pose ?? this.pose;
    if (name === this.name && color === this.color && pose === this.pose) return;
    this.name = name;
    this.color = color;
    this.pose = pose;
    this.draw();
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }

  private draw(): void {
    const g = this.g;
    g.clearRect(0, 0, WIDTH, HEIGHT);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Dot above the head
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.arc(128, 20, 7.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(128, 20, 5, 0, Math.PI * 2);
    g.fill();

    // The figure: a dark outline pass, then the team colour on top.
    const figure = FIGURES[this.pose];
    const [hx, hy, hr] = figure.head;
    for (const [style, extra] of [['rgba(0,0,0,0.6)', 5], [this.color, 0]] as const) {
      g.strokeStyle = style;
      g.fillStyle = style;
      g.lineWidth = 9 + extra;
      for (const limb of figure.limbs) {
        g.beginPath();
        limb.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
      g.beginPath();
      g.arc(hx, hy, hr + extra / 2, 0, Math.PI * 2);
      g.fill();
    }

    g.font = 'bold 24px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(this.name, WIDTH / 2, 156);
    g.fillStyle = '#ffffff';
    g.fillText(this.name, WIDTH / 2, 156);

    this.texture.needsUpdate = true;
  }
}
