import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { reach, setWorldQuaternion } from './ik';

/*
 * Your arms in the first-person view: the arms of "FPS Rig AKM" by J-Toastie (CC-BY, Poly Pizza), a
 * first-person viewmodel rig, with the gun taken out (public/models/fpArms.glb). Its idle animation
 * holds an AKM, and that hold is what every gun here is posed from: the rig was placed exactly as its
 * author's demo does, and for each hand the wrist's offset from the barrel and the hand's orientation
 * relative to the barrel were measured, along with the shoulder positions and elbow directions. Each
 * frame two-bone IK brings each wrist to that offset from a point on the held gun's barrel axis (the
 * grip, the fore-end...) and turns the hand to the measured orientation, so the hands grip our guns the
 * way the rig's grip its AKM. Everything here is in the weapon camera's space (the weapon scene's
 * world space), at life size: the rig is 1.6× life size, so its measurements are scaled by 0.625,
 * which keeps the same picture on screen.
 */

const ARMS_URL = `${import.meta.env.BASE_URL}models/fpArms.glb`;
/** The rig's demo scale, times 0.625 to bring it to life size */
const ARMS_SCALE = 0.05;

/** A hand's hold, measured from the rig: where the wrist sits relative to a point on the barrel axis
 *  (gun space: x right, y up, -z forward) and how the hand is turned relative to the gun. */
interface Hold {
  offset: THREE.Vector3;
  turn: THREE.Quaternion;
}
const RIGHT_HOLD: Hold = { offset: new THREE.Vector3(0.0292, -0.0697, 0), turn: new THREE.Quaternion(-0.00559, 0.73143, -0.68169, -0.0165) };
const LEFT_HOLD: Hold = { offset: new THREE.Vector3(-0.0565, -0.0448, 0), turn: new THREE.Quaternion(0.60246, 0.74296, -0.21411, -0.198) };

/** Shoulder joints relative to the camera (the rig's, at life size); aiming brings them in under the gun. */
const SHOULDER = {
  right: { hip: new THREE.Vector3(0.2, -0.084, 0.198), ads: new THREE.Vector3(0.12, -0.12, 0.15) },
  left: { hip: new THREE.Vector3(-0.136, -0.125, -0.008), ads: new THREE.Vector3(-0.1, -0.16, -0.05) },
};
/** Shoulders when holding the flag pole upright in front: a little further forward than for a gun,
 *  so the right hand can reach high up the pole */
const POLE_SHOULDER = {
  right: new THREE.Vector3(0.25, -0.22, -0.03),
  left: new THREE.Vector3(-0.03, -0.27, -0.04),
};
/** Elbows hang below the arm, as in the rig */
const RIGHT_POLE = new THREE.Vector3(0.2, -1, 0.1);
const LEFT_POLE = new THREE.Vector3(-0.3, -1, 0);
/** How far the forearm is rolled relative to the hand in the rig's idle (about the forearm's axis) */
const FOREARM_ROLL = { right: 0.6051, left: -0.1631 };

const _at = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hold = new THREE.Quaternion();
const _flipped = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

type Arm = [THREE.Object3D, THREE.Object3D, THREE.Object3D];

let pending: Promise<THREE.Object3D> | null = null;

/** Loads the arms once; later calls share the same promise. */
export function loadFpArms(): Promise<THREE.Object3D> {
  pending ??= new GLTFLoader()
    .loadAsync(ARMS_URL)
    .then((gltf) => gltf.scene)
    .catch((err: unknown) => {
      pending = null; // allow a retry on the next join
      throw err;
    });
  return pending;
}

export class FpArms {
  readonly root: THREE.Object3D;
  private readonly right: Arm;
  private readonly left: Arm;

  constructor(asset: THREE.Object3D) {
    this.root = SkeletonUtils.clone(asset);
    this.root.scale.setScalar(ARMS_SCALE);
    this.root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
    });
    this.right = [bone(this.root, 'UpperArmR001'), bone(this.root, 'LowerArmR001'), bone(this.root, 'HandR001')];
    this.left = [bone(this.root, 'UpperArmL'), bone(this.root, 'LowerArmL'), bone(this.root, 'HandL')];
    this.root.updateMatrixWorld(true);
  }

  set visible(on: boolean) {
    this.root.visible = on;
  }

  /**
   * Hold a gun: the right hand at `grip` and the left at `support`, points on the gun's barrel axis
   * (gun space), each wrist at its measured offset and the hand turned as measured.
   * @param aim 0 at the hip, 1 aiming down the sights
   * @param pistol held in the right hand only: the left arm is hidden
   */
  holdGun(gun: THREE.Object3D, grip: THREE.Vector3, support: THREE.Vector3, aim: number, pistol: boolean): void {
    this.showLeft(!pistol);
    this.root.updateMatrixWorld(true);
    placeJoint(this.right[0], _at.lerpVectors(SHOULDER.right.hip, SHOULDER.right.ads, aim));
    placeJoint(this.left[0], _at.lerpVectors(SHOULDER.left.hip, SHOULDER.left.ads, aim));
    gun.getWorldQuaternion(_hold);
    this.hand(this.right, gun, grip, RIGHT_HOLD, _hold, RIGHT_POLE, FOREARM_ROLL.right);
    if (!pistol) this.hand(this.left, gun, support, LEFT_HOLD, _hold, LEFT_POLE, FOREARM_ROLL.left);
  }

  /** Show or hide the left arm (collapsing its upper-arm bone takes the whole arm with it). */
  private showLeft(on: boolean): void {
    this.left[0].scale.setScalar(on ? 1 : 1e-4);
  }

  /** Hold a vertical pole (the flag): the right hand above the left, from opposite sides. */
  holdPole(pole: THREE.Object3D, upper: THREE.Vector3, lower: THREE.Vector3): void {
    this.showLeft(true);
    this.root.updateMatrixWorld(true);
    placeJoint(this.right[0], POLE_SHOULDER.right);
    placeJoint(this.left[0], POLE_SHOULDER.left);
    // The pole stands along the group's +Y; the rifle grip the right hand was measured on is close to
    // vertical too, so the same hold works, and the left comes round from the other side.
    pole.getWorldQuaternion(_hold);
    _flipped.copy(_hold).multiply(FLIP);
    this.hand(this.right, pole, upper, RIGHT_HOLD, _hold, RIGHT_POLE, FOREARM_ROLL.right);
    this.hand(this.left, pole, lower, RIGHT_HOLD, _flipped, LEFT_POLE, FOREARM_ROLL.right);
  }

  /** Put a wrist at `anchor` (in `held`'s space) plus the hold's offset, the hand turned per the hold in `frame`. */
  private hand([upper, fore, hand]: Arm, held: THREE.Object3D, anchor: THREE.Vector3, hold: Hold, frame: THREE.Quaternion, pole: THREE.Vector3, foreRoll: number): void {
    _wrist.copy(hold.offset).applyQuaternion(frame).add(held.localToWorld(_at.copy(anchor)));
    _q.copy(frame).multiply(hold.turn);
    reach(upper, fore, hand, _wrist, pole);
    // Roll the forearm about its own axis so the wrist is twisted as in the rig, not more.
    fore.getWorldPosition(_at);
    hand.getWorldPosition(_axis).sub(_at).normalize();
    _x.set(1, 0, 0).applyQuaternion(fore.getWorldQuaternion(_fq)).addScaledVector(_axis, -_x.dot(_axis)).normalize();
    _y.set(1, 0, 0).applyQuaternion(_q).addScaledVector(_axis, -_y.dot(_axis)).normalize();
    const roll = Math.atan2(_z.crossVectors(_x, _y).dot(_axis), _x.dot(_y)) - foreRoll;
    setWorldQuaternion(fore, _fq.premultiply(_roll.setFromAxisAngle(_axis, roll)));
    setWorldQuaternion(hand, _q);
  }
}

/** Move a joint to a world position (its parent stays put). */
function placeJoint(joint: THREE.Object3D, world: THREE.Vector3): void {
  joint.position.copy(joint.parent!.worldToLocal(_wrist.copy(world)));
  joint.updateMatrixWorld(true);
}

function bone(root: THREE.Object3D, name: string): THREE.Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`Arms model is missing bone ${name}`);
  return found;
}
