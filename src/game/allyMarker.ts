import * as THREE from 'three';
import { canvas2d } from './canvas';

const WIDTH = 256;
const HEIGHT = 64;
/**
 * Size on screen (the sprite ignores distance): this much of the view's height, at the normal
 * field of view, so the name stays readable however far away the teammate is.
 */
const SCREEN_HEIGHT = 0.06;

/**
 * The label over a teammate who is behind cover: a dot and their name, drawn over the walls
 * above their silhouette (see xray.ts). Same size on screen at any distance.
 */
export class AllyMarker {
  readonly sprite: THREE.Sprite;

  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private name: string;

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
    // Anchored at the bottom, so the label sits just above the head at any size.
    this.sprite.center.set(0.5, 0);
    // Drawn after the world, so it sits on top of the walls hiding them.
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
    this.draw();
  }

  setName(name: string): void {
    if (name === this.name) return;
    this.name = name;
    this.draw();
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }

  private draw(): void {
    const g = this.g;
    g.clearRect(0, 0, WIDTH, HEIGHT);

    g.font = 'bold 24px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(this.name, WIDTH / 2, 16);
    g.fillStyle = '#ffffff';
    g.fillText(this.name, WIDTH / 2, 16);

    // Dot under the name, just above the head
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.arc(WIDTH / 2, 46, 7.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(WIDTH / 2, 46, 5, 0, Math.PI * 2);
    g.fill();

    this.texture.needsUpdate = true;
  }
}
