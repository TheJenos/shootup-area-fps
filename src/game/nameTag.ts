import * as THREE from 'three';
import { canvas2d } from './canvas';

const WIDTH = 256;
const HEIGHT = 80;
/** How long the tag stays up after the last hit (ms, wall-clock so slow frames don't stretch it). */
const SHOW_FOR = 3_000;
const FADE_FOR = 500;

/**
 * Name + health bar above an enemy. Hidden until the local player hits them,
 * so you only learn who someone is (and how hurt they are) by shooting them.
 * It's drawn on this client only and respects depth, so it never shows through walls.
 */
export class NameTag {
  readonly sprite: THREE.Sprite;

  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private name: string;
  private hp = 100;
  private visibleUntil = 0;
  /** Teammates' tags stay up the whole time */
  private pinned = false;

  constructor(name: string) {
    const { canvas, g } = canvas2d(WIDTH, HEIGHT);
    this.g = g;
    this.name = name;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(1.6, 0.5, 1);
    this.sprite.visible = false;
    this.draw();
  }

  /** Show the tag (or keep it up) with the given health. */
  reveal(hp: number): void {
    this.visibleUntil = performance.now() + SHOW_FOR;
    this.setHp(hp);
    this.update();
  }

  hide(): void {
    this.visibleUntil = 0;
    this.sprite.visible = false;
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
  }

  setHp(hp: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(hp), 0, 100);
    if (clamped === this.hp) return;
    this.hp = clamped;
    this.draw();
  }

  setName(name: string): void {
    if (name === this.name) return;
    this.name = name;
    this.draw();
  }

  /** @param alive dead players' tags are never shown, pinned or not */
  update(alive = true): void {
    if (this.pinned) {
      this.sprite.visible = alive;
      this.material.opacity = 1;
      return;
    }
    const left = this.visibleUntil - performance.now();
    this.sprite.visible = left > 0;
    if (left > 0) this.material.opacity = Math.min(1, left / FADE_FOR);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }

  private draw(): void {
    const g = this.g;
    g.clearRect(0, 0, WIDTH, HEIGHT);

    g.font = 'bold 32px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(this.name, WIDTH / 2, 24);
    g.fillStyle = '#ffffff';
    g.fillText(this.name, WIDTH / 2, 24);

    const barW = 180;
    const barH = 14;
    const x = (WIDTH - barW) / 2;
    const y = 52;
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(x - 3, y - 3, barW + 6, barH + 6);
    g.fillStyle = this.hp > 60 ? '#5ce08a' : this.hp > 30 ? '#ffb547' : '#ff5a5a';
    g.fillRect(x, y, (barW * this.hp) / 100, barH);

    this.texture.needsUpdate = true;
  }
}
