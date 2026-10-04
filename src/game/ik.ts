import * as THREE from 'three';

/*
 * Two-bone inverse kinematics for arms, used to pose other players' characters holding their gun
 * where they're looking. Works in world space on a skeleton whose world matrices are up to date.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** Turn `bone` (in world space) so that direction `from` becomes `to`, then refresh its children. */
function swing(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  bone.getWorldQuaternion(_wq).premultiply(_q);
  setWorldQuaternion(bone, _wq);
}

/** Give `bone` this world orientation (by setting its local one), then refresh its children. */
export function setWorldQuaternion(bone: THREE.Object3D, world: THREE.Quaternion): void {
  if (bone.parent) bone.parent.getWorldQuaternion(_pq).invert();
  else _pq.identity();
  bone.quaternion.copy(_pq.multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * Bend upper arm and forearm so the hand reaches `target` (world space), with the elbow
 * pointing toward `pole` (a world direction). Out-of-reach targets get the arm straight toward them.
 */
export function reach(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  hand: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): void {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  hand.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  _dir.subVectors(target, _a);
  const d = THREE.MathUtils.clamp(_dir.length(), Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.999);
  _dir.normalize();

  // Law of cosines: the angle at the shoulder between the reach line and the upper arm.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _pole.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0).addScaledVector(_dir, _dir.y);
  _pole.normalize();
  _elbow.copy(_a).addScaledVector(_dir, l1 * cosA).addScaledVector(_pole, l1 * sinA);

  swing(upper, _from.subVectors(_b, _a), _to.subVectors(_elbow, _a));
  lower.getWorldPosition(_b);
  hand.getWorldPosition(_c);
  swing(lower, _from.subVectors(_c, _b), _to.subVectors(target, _b));
}
