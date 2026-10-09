import * as THREE from 'three';
import { hazardTexture, wornMetalTexture } from './textures';
import { BOMB_TIME, SITE_IDS, SITE_NAME, SITE_RADIUS, type BombPlacement, type Point } from './snd';
import type { SiteId } from '../types';

const SITE_COLOR = 0xffb020;
const BOMB_LIGHT = 0xff3030;
/** The letter floats this high above its site (m) */
const LETTER_HEIGHT = 3.2;

const ringGeo = new THREE.RingGeometry(SITE_RADIUS - 0.25, SITE_RADIUS, 48).rotateX(-Math.PI / 2);
const hazardGeo = new THREE.RingGeometry(SITE_RADIUS, SITE_RADIUS + 0.45, 64).rotateX(-Math.PI / 2);
const caseGeo = new THREE.BoxGeometry(0.5, 0.22, 0.34).translate(0, 0.11, 0);
const panelGeo = new THREE.BoxGeometry(0.26, 0.02, 0.18).translate(0, 0.23, 0);
const lightGeo = new THREE.SphereGeometry(0.05, 10, 8).translate(0.17, 0.25, 0.1);
const beamGeo = new THREE.CylinderGeometry(0.06, 0.06, 10, 8, 1, true).translate(0, 5, 0);

/** A big letter on a transparent canvas, for a sprite that faces the camera */
function letterTexture(letter: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20, 16, 6, 0.55)';
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#ffb020';
  g.stroke();
  g.fillStyle = '#ffd27a';
  g.font = 'bold 76px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface SiteView {
  ring: THREE.Mesh;
  hazard: THREE.Mesh;
  letter: THREE.Sprite;
}

/** Search & Destroy: the two bomb sites and the bomb when it's lying around or planted. */
export class BombField {
  private readonly scene: THREE.Scene;
  private readonly sites = {} as Record<SiteId, SiteView>;
  private readonly bomb = new THREE.Group();
  private readonly light: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly beam: THREE.Mesh;
  private readonly objects: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private placement: BombPlacement | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const glow = this.track(new THREE.MeshBasicMaterial({
      color: SITE_COLOR, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    const hazardMat = this.track(new THREE.MeshStandardMaterial({
      map: hazardTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    for (const id of SITE_IDS) {
      const ring = new THREE.Mesh(ringGeo, glow);
      const hazard = new THREE.Mesh(hazardGeo, hazardMat);
      hazard.receiveShadow = true;
      const map = this.track(letterTexture(SITE_NAME[id]));
      // Seen through walls, so attackers can find the sites and defenders know where to hold.
      const letter = new THREE.Sprite(this.track(new THREE.SpriteMaterial({ map, depthTest: false, transparent: true, opacity: 0.85 })));
      letter.scale.setScalar(1.6);
      letter.renderOrder = 10;
      this.add(ring, hazard, letter);
      this.sites[id] = { ring, hazard, letter };
    }

    const caseMat = this.track(new THREE.MeshStandardMaterial({ map: wornMetalTexture(), color: 0x3a3f36, metalness: 0.5, roughness: 0.6 }));
    const panelMat = this.track(new THREE.MeshStandardMaterial({ color: 0x14181c, emissive: 0x0b3a10, roughness: 0.4 }));
    const body = new THREE.Mesh(caseGeo, caseMat);
    body.castShadow = true;
    const panel = new THREE.Mesh(panelGeo, panelMat);
    this.light = new THREE.Mesh(lightGeo, this.track(new THREE.MeshBasicMaterial({ color: BOMB_LIGHT })));
    this.beam = new THREE.Mesh(beamGeo, this.track(new THREE.MeshBasicMaterial({
      color: BOMB_LIGHT, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    this.bomb.add(body, panel, this.light, this.beam);
    this.bomb.visible = false;
    this.add(this.bomb);
  }

  /** The defenders' sites this round (they move when the teams swap sides). */
  setSites(sites: Record<SiteId, Point>): void {
    for (const id of SITE_IDS) {
      const { x, y, z } = sites[id];
      const view = this.sites[id];
      view.ring.position.set(x, y + 0.06, z);
      view.hazard.position.set(x, y + 0.03, z);
      view.letter.position.set(x, y + LETTER_HEIGHT, z);
    }
  }

  setBomb(placement: BombPlacement | null): void {
    this.placement = placement;
    const shown = placement && placement.at !== 'carried';
    this.bomb.visible = !!shown;
    if (!shown) return;
    this.bomb.position.set(placement.x, placement.y, placement.z);
    this.beam.visible = placement.at === 'ground';
  }

  /** @param now server ms, for the planted bomb's blinking, which speeds up as the fuse burns down */
  update(time: number, now: number): void {
    for (const id of SITE_IDS) this.sites[id].letter.material.opacity = 0.7 + Math.sin(time * 2) * 0.15;
    const p = this.placement;
    if (!p || p.at === 'carried') return;
    let rate = 1.2;
    if (p.at === 'planted') {
      const left = Math.max(0, 1 - (now - p.plantedAt) / (BOMB_TIME * 1000));
      rate = 2 + (1 - left) * 10;
    }
    this.light.material.color.setHex(Math.sin(time * Math.PI * rate) > 0 ? BOMB_LIGHT : 0x2a0505);
  }

  dispose(): void {
    this.objects.forEach((o) => this.scene.remove(o));
    this.disposables.forEach((d) => d.dispose());
  }

  private add(...objects: THREE.Object3D[]): void {
    this.scene.add(...objects);
    this.objects.push(...objects);
  }

  private track<T extends { dispose(): void }>(thing: T): T {
    this.disposables.push(thing);
    return thing;
  }
}
