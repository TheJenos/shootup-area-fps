/**
 * Converts Quaternius's SWAT character (CC0, raw file in assets-src/quaternius/Swat.glb) into
 *   public/models/Soldier.glb   turned to face -Z (the way players look at yaw 0) and scaled to the
 *                               player's height, with only the Idle / Walk / Run clips (named without
 *                               the "CharacterArmature|" prefix) and its materials named for the
 *                               tinting in remotePlayer.ts: Uniform (takes the player's colour), Gear,
 *                               Skin, Visor
 * The rig's feet are IK targets parented to the root, so they wouldn't follow the legs when the game
 * bends them (crouch, slide, ragdoll). Each foot is moved under its shin, and its animation is
 * re-baked into the shin's space by sampling the clips with three.js.
 * Run with `npm run build:character`.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune } from '@gltf-transform/functions';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'assets-src/quaternius/Swat.glb');
const OUT = path.join(ROOT, 'public/models/Soldier.glb');

const CLIPS = { 'CharacterArmature|Idle': 'Idle', 'CharacterArmature|Walk': 'Walk', 'CharacterArmature|Run': 'Run' };
/** New name, and base colour (linear RGB; null keeps the original) */
const MATERIALS = {
  // Light grey so the player's colour reads clearly when it's multiplied in.
  Swat: { name: 'Uniform', color: [0.42, 0.43, 0.45] },
  Swat_Black: { name: 'Gear', color: [0.035, 0.037, 0.04] },
  Skin: { name: 'Skin', color: null },
  Visor: { name: 'Visor', color: [0.6, 0.6, 0.6] },
};
/** Foot → the shin it goes under */
const FEET = { 'Foot.L': 'LowerLeg.L', 'Foot.R': 'LowerLeg.R' };
/** The model is 1.81 m to the top of the helmet; bring it to the old soldier's 1.73 m (eyes at the camera's 1.6 m) */
const SCALE = 0.955;
/** Foot animation sample rate (frames per second) */
const FPS = 30;

// ---------------------------------------------------------------- feet, sampled with three.js

/** The feet's transforms relative to their shins through each clip: clip → foot → { times, t, r } */
async function sampleFeet() {
  globalThis.self ??= globalThis; // GLTFLoader looks for `self`
  const buf = fs.readFileSync(SRC);
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  // three.js drops the dots from node names.
  const node = (name) => gltf.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
  const out = {};
  const m = new THREE.Matrix4();
  for (const [source, name] of Object.entries(CLIPS)) {
    const clip = gltf.animations.find((a) => a.name === source);
    const mixer = new THREE.AnimationMixer(gltf.scene);
    mixer.clipAction(clip).play();
    const frames = Math.max(1, Math.round(clip.duration * FPS));
    out[name] = {};
    for (const foot of Object.keys(FEET)) out[name][foot] = { times: [], t: [], r: [] };
    for (let i = 0; i <= frames; i++) {
      const time = (clip.duration * i) / frames;
      mixer.setTime(time);
      gltf.scene.updateMatrixWorld(true);
      for (const [foot, shin] of Object.entries(FEET)) {
        m.copy(node(shin).matrixWorld).invert().multiply(node(foot).matrixWorld);
        const t = new THREE.Vector3();
        const r = new THREE.Quaternion();
        m.decompose(t, r, new THREE.Vector3());
        const s = out[name][foot];
        s.times.push(time);
        s.t.push(...t.toArray());
        s.r.push(...r.toArray());
      }
    }
    mixer.stopAllAction();
  }
  return out;
}

const feet = await sampleFeet();

// ---------------------------------------------------------------- the file

const io = new NodeIO();
const doc = await io.read(SRC);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];
const byName = (name) => {
  const found = root.listNodes().find((n) => n.getName() === name);
  if (!found) throw new Error(`Swat.glb is missing node ${name}`);
  return found;
};

for (const anim of root.listAnimations()) {
  const name = CLIPS[anim.getName()];
  if (name) anim.setName(name);
  else anim.dispose();
}
const missing = Object.values(CLIPS).filter((n) => !root.listAnimations().some((a) => a.getName() === n));
if (missing.length) throw new Error(`Swat.glb is missing clips: ${missing.join(', ')}`);

// Feet under the shins, keeping where they sit in the bind pose (so the skin's inverse bind matrices still hold).
for (const [footName, shinName] of Object.entries(FEET)) {
  const foot = byName(footName);
  const shin = byName(shinName);
  const local = new THREE.Matrix4().fromArray(shin.getWorldMatrix()).invert().multiply(new THREE.Matrix4().fromArray(foot.getWorldMatrix()));
  const t = new THREE.Vector3();
  const r = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local.decompose(t, r, s);
  shin.addChild(foot);
  foot.setTranslation(t.toArray()).setRotation(r.toArray()).setScale(s.toArray());

  for (const anim of root.listAnimations()) {
    for (const channel of anim.listChannels()) {
      if (channel.getTargetNode() === foot) {
        channel.getSampler()?.dispose();
        channel.dispose();
      }
    }
    const sampled = feet[anim.getName()][footName];
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(sampled.times)).setBuffer(buffer);
    for (const [path, type, values] of [['translation', 'VEC3', sampled.t], ['rotation', 'VEC4', sampled.r]]) {
      const output = doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(foot).setTargetPath(path).setSampler(sampler));
    }
  }
}

for (const mat of root.listMaterials()) {
  const spec = MATERIALS[mat.getName()];
  if (!spec) throw new Error(`Unexpected material ${mat.getName()}`);
  mat.setName(spec.name);
  if (spec.color) mat.setBaseColorFactor([...spec.color, 1]);
  mat.setMetallicFactor(0).setRoughnessFactor(0.8);
}

// The model faces +Z: turn it round (a half turn about Y) to face -Z, and scale it.
for (const node of root.listScenes()[0].listChildren()) {
  const [x, y, z, w] = node.getRotation();
  // (0, 1, 0, 0) * node rotation
  node.setRotation([z, w, -x, -y]);
  const [tx, ty, tz] = node.getTranslation();
  node.setTranslation([-tx * SCALE, ty * SCALE, -tz * SCALE]);
  node.setScale(node.getScale().map((v) => v * SCALE));
}

await doc.transform(prune(), dedup());
await io.write(OUT, doc);

const kb = fs.statSync(OUT).size / 1024;
console.log(`Wrote ${path.relative(ROOT, OUT)} (${kb.toFixed(0)} KB): ${root.listAnimations().map((a) => a.getName()).join(', ')}`);
