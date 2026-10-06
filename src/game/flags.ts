import * as THREE from 'three';
import { FLAG_BASES, TEAMS, TEAM_INFO } from './modes';
import { boxTexture, hazardTexture, wornMetalTexture } from './textures';
import type { FlagRecord, Team } from '../types';

const POLE_HEIGHT = 2.4;
const CLOTH_W = 1.1;
const CLOTH_H = 0.7;
/** Carried flags are held upright in the carrier's right hand, a bit smaller */
const CARRIED_SCALE = 0.75;
/** How far up the (scaled) pole the hand grips it */
const CARRIED_GRIP = POLE_HEIGHT * CARRIED_SCALE * 0.32;
/** Forward lean of a carried flag (radians), so it reads as held out in front */
export const CARRIED_LEAN = 0.18;
/** Fallback when the hand isn't known: held at about hand height beside them */
const CARRIED_HAND_HEIGHT = 1.0;

/** Who is carrying a flag, as FlagField needs to draw it */
export interface FlagCarrier {
  position: THREE.Vector3;
  yaw: number;
  /** Their right hand in world space, if known */
  hand?: THREE.Vector3;
  /** Extra forward tip while they swing it (radians) */
  swing?: number;
}

const _grip = new THREE.Vector3();

const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, POLE_HEIGHT, 8).translate(0, POLE_HEIGHT / 2, 0);
const padGeo = new THREE.CylinderGeometry(1.5, 1.6, 0.08, 32);
const ringGeo = new THREE.RingGeometry(1.35, 1.55, 40).rotateX(-Math.PI / 2);
/** Painted hazard stripes on the floor around each base pad */
const hazardGeo = new THREE.RingGeometry(1.7, 2.1, 48).rotateX(-Math.PI / 2);
const beamGeo = new THREE.CylinderGeometry(0.08, 0.08, 14, 8, 1, true).translate(0, 7, 0);

/** Where a flag is drawn right now; `carrier` is a player id. */
export type FlagPlacement =
  | { at: 'base' }
  | { at: 'ground'; x: number; y: number; z: number }
  | { at: 'carried'; carrier: string };

export function placementOf(flag: FlagRecord | undefined): FlagPlacement {
  if (flag?.by) return { at: 'carried', carrier: flag.by };
  if (flag && typeof flag.x === 'number' && typeof flag.z === 'number') return { at: 'ground', x: flag.x, y: flag.y ?? 0, z: flag.z };
  return { at: 'base' };
}

interface FlagView {
  flag: THREE.Group;
  cloth: THREE.Mesh<THREE.PlaneGeometry>;
  positions: THREE.BufferAttribute;
  /** Cloth vertex positions before waving */
  rest: Float32Array;
  beam: THREE.Mesh;
  ring: THREE.Mesh;
  /** The pad and the hazard stripes around it */
  pad: THREE.Mesh;
  hazard: THREE.Mesh;
  placement: FlagPlacement;
}

/** Both teams' bases and flags (CTF only). */
export class FlagField {
  private readonly scene: THREE.Scene;
  private readonly views = {} as Record<Team, FlagView>;
  private readonly objects: THREE.Object3D[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const poleMat = this.track(new THREE.MeshStandardMaterial({
      map: wornMetalTexture(), color: 0xe8ecf2, metalness: 0.6, roughness: 0.35,
    }));
    const hazardMat = this.track(new THREE.MeshStandardMaterial({
      map: hazardTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    for (const team of TEAMS) {
      const color = new THREE.Color(TEAM_INFO[team].color);
      const base = FLAG_BASES[team];

      const concrete = boxTexture('concrete');
      const padMat = this.track(new THREE.MeshStandardMaterial({
        color: 0x6a7280, map: concrete, bumpMap: concrete, bumpScale: 0.8, roughness: 0.8,
      }));
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(base.x, 0.04, base.z);
      pad.receiveShadow = true;
      const hazard = new THREE.Mesh(hazardGeo, hazardMat);
      hazard.position.set(base.x, 0.01, base.z);
      hazard.receiveShadow = true;
      const glowMat = this.track(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      const ring = new THREE.Mesh(ringGeo, glowMat);
      ring.position.set(base.x, 0.1, base.z);

      const clothGeo = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, 12, 4).translate(CLOTH_W / 2, POLE_HEIGHT - CLOTH_H / 2, 0);
      const clothMat = this.track(new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.8,
      }));
      const cloth = new THREE.Mesh(clothGeo, clothMat);
      cloth.castShadow = true;
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.castShadow = true;
      const beam = new THREE.Mesh(beamGeo, glowMat);
      const flag = new THREE.Group();
      flag.add(pole, cloth, beam);

      this.add(pad, hazard, ring, flag);
      const positions = clothGeo.getAttribute('position') as THREE.BufferAttribute;
      const rest = Float32Array.from(positions.array);
      this.views[team] = { flag, cloth, positions, rest, beam, ring, pad, hazard, placement: { at: 'base' } };
      this.place(team, { at: 'base' });
    }
  }

  /** The map changed (and FLAG_BASES with it): move the bases, and flags standing on them. */
  moveBases(): void {
    for (const team of TEAMS) {
      const base = FLAG_BASES[team];
      const view = this.views[team];
      view.pad.position.set(base.x, 0.04, base.z);
      view.hazard.position.set(base.x, 0.01, base.z);
      view.ring.position.set(base.x, 0.1, base.z);
      this.place(team, view.placement);
    }
  }

  set(team: Team, placement: FlagPlacement): void {
    this.views[team].placement = placement;
    this.place(team, placement);
  }

  /**
   * @param carrierPosition where a remote carrier is drawn; null for ourselves
   *   (our own flag would only block the view) or unknown players
   */
  update(time: number, carrierPosition: (id: string) => FlagCarrier | null): void {
    for (const team of TEAMS) {
      const view = this.views[team];
      const { placement } = view;
      if (placement.at === 'carried') {
        const carrier = carrierPosition(placement.carrier);
        view.flag.visible = !!carrier;
        if (carrier) {
          // Gripped in the right hand a third of the way up the pole, leaning forward a little.
          if (carrier.hand) _grip.copy(carrier.hand);
          else {
            // No hand to go by (shouldn't happen): beside them on the right, at hand height.
            _grip.set(Math.cos(carrier.yaw) * 0.3, CARRIED_HAND_HEIGHT, -Math.sin(carrier.yaw) * 0.3).add(carrier.position);
          }
          // Cloth trails behind them (it extends along the group's +x); z tilts the top forward.
          view.flag.rotation.set(0, carrier.yaw - Math.PI / 2, CARRIED_LEAN + (carrier.swing ?? 0), 'YXZ');
          // Slide the flag down its own (leaning) axis so the grip point lands in the hand.
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(view.flag.quaternion);
          view.flag.position.copy(_grip).addScaledVector(up, -CARRIED_GRIP);
        }
      }
      this.wave(view, time + (team === 'red' ? 0 : 1.7));
      view.ring.visible = placement.at === 'base';
    }
  }

  dispose(): void {
    this.objects.forEach((o) => this.scene.remove(o));
    this.materials.forEach((m) => m.dispose());
    for (const team of TEAMS) this.views[team].cloth.geometry.dispose();
  }

  private place(team: Team, placement: FlagPlacement): void {
    const view = this.views[team];
    const carried = placement.at === 'carried';
    view.flag.scale.setScalar(carried ? CARRIED_SCALE : 1);
    view.beam.visible = !carried;
    view.flag.visible = true;
    view.flag.rotation.set(0, 0, 0);
    if (placement.at === 'base') view.flag.position.copy(FLAG_BASES[team]);
    else if (placement.at === 'ground') view.flag.position.set(placement.x, placement.y, placement.z);
  }

  /** Ripple the cloth: more movement the further from the pole. */
  private wave(view: FlagView, time: number): void {
    if (!view.flag.visible) return;
    const pos = view.positions;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = view.rest[i] ?? 0;
      arr[i + 2] = Math.sin(x * 4 - time * 5) * 0.12 * (x / CLOTH_W);
    }
    pos.needsUpdate = true;
    view.cloth.geometry.computeVertexNormals();
  }

  private add(...objects: THREE.Object3D[]): void {
    this.scene.add(...objects);
    this.objects.push(...objects);
  }

  private track<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}
