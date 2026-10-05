/**
 * Converts the models listed in props.config.mjs (raw Kenney packs in assets-src/kenney/) into
 *   public/models/props.glb   one node per prop, named by id, base centred on the origin, in metres,
 *                             colours baked into the vertices, all sharing one material
 *   src/game/propManifest.ts  each prop's size, collision boxes and preview colour, for the generator
 * Run with `npm run build:props` after changing the config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';
import { PNG } from 'pngjs';
import { PROPS } from './props.config.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'assets-src/kenney');
const OUT_GLB = path.join(ROOT, 'public/models/props.glb');
const OUT_TS = path.join(ROOT, 'src/game/propManifest.ts');

const io = new NodeIO();

/** sRGB 0..1 → linear */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const pngs = new Map();
function texelAt(image, u, v) {
  const key = image.getURI() || image.getName();
  let png = pngs.get(key);
  if (!png) {
    png = PNG.sync.read(Buffer.from(image.getImage()));
    pngs.set(key, png);
  }
  const x = Math.min(png.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * png.width)));
  const y = Math.min(png.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * png.height)));
  const i = (y * png.width + x) * 4;
  return [toLinear(png.data[i] / 255), toLinear(png.data[i + 1] / 255), toLinear(png.data[i + 2] / 255)];
}

/** Multiply 4x4 column-major matrices */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, [x, y, z], w = 1) => [
  m[0] * x + m[4] * y + m[8] * z + m[12] * w,
  m[1] * x + m[5] * y + m[9] * z + m[13] * w,
  m[2] * x + m[6] * y + m[10] * z + m[14] * w,
];

/** One prop's triangles in metres with per-vertex colours, from every mesh in the model. */
async function loadModel(entry) {
  const doc = await io.read(path.join(SRC, entry.file));
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const visit = (node, parent) => {
    const m = mul(parent, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nor = prim.getAttribute('NORMAL');
        const uv = prim.getAttribute('TEXCOORD_0');
        const mat = prim.getMaterial();
        const factor = mat ? mat.getBaseColorFactor() : [1, 1, 1, 1];
        const tex = mat?.getBaseColorTexture();
        const base = positions.length / 3;
        const p = [0, 0, 0];
        const n = [0, 0, 0];
        const t = [0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, p);
          positions.push(...apply(m, p).map((c) => c * entry.scale));
          if (nor) {
            nor.getElement(i, n);
            const d = apply(m, n, 0);
            const len = Math.hypot(...d) || 1;
            normals.push(d[0] / len, d[1] / len, d[2] / len);
          } else {
            normals.push(0, 1, 0);
          }
          let rgb = [factor[0], factor[1], factor[2]];
          if (tex && uv) {
            uv.getElement(i, t);
            const s = texelAt(tex, t[0], t[1]);
            rgb = [s[0] * factor[0], s[1] * factor[1], s[2] * factor[2]];
          }
          colors.push(...rgb);
        }
        const idx = prim.getIndices();
        if (idx) for (let i = 0; i < idx.getCount(); i++) indices.push(base + idx.getScalar(i));
        else for (let i = 0; i < pos.getCount(); i++) indices.push(base + i);
      }
    }
    for (const child of node.listChildren()) visit(child, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) visit(node, identity);

  // Base centred on the origin.
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= minY;
    positions[i + 2] -= cz;
  }
  // Average colour weighted per vertex, for the preview.
  const avg = [0, 0, 0];
  for (let i = 0; i < colors.length; i += 3) for (let k = 0; k < 3; k++) avg[k] += colors[i + k];
  const count = colors.length / 3 || 1;
  return {
    positions, normals, colors, indices,
    size: { w: maxX - minX, h: maxY - minY, d: maxZ - minZ },
    color: avg.map((c) => Math.round(Math.min(1, (c / count) ** (1 / 2.2)) * 255)),
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Collision boxes (relative to the base centre) for a prop's rule. */
function collidersFor(entry, size) {
  const c = entry.collider;
  if (c === 'none') return [];
  if (c === 'box') return [{ dx: 0, dz: 0, y: 0, w: r2(size.w), d: r2(size.d), h: r2(size.h) }];
  if (c.shrink) return [{ dx: 0, dz: 0, y: 0, w: r2(size.w * c.shrink), d: r2(size.d * c.shrink), h: r2(size.h * 0.9) }];
  if (c.trunk) {
    const boxes = [{ dx: 0, dz: 0, y: 0, w: c.trunk, d: c.trunk, h: r2(Math.min(c.h, size.h)) }];
    if (c.canopy && size.h > c.h + 0.5) {
      boxes.push({ dx: 0, dz: 0, y: r2(c.h * 0.85), w: r2(size.w * 0.7), d: r2(size.d * 0.7), h: r2(size.h - c.h * 0.85), blocks: 'shots' });
    }
    return boxes;
  }
  throw new Error(`${entry.id}: unknown collider rule`);
}

const out = new Document();
const buffer = out.createBuffer();
const material = out.createMaterial('props').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.85).setMetallicFactor(0);
const scene = out.createScene('props');
const manifest = {};
let totalTris = 0;
for (const entry of PROPS) {
  const m = await loadModel(entry);
  const prim = out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(m.positions)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(m.normals)).setBuffer(buffer))
    // Colours as normalized bytes (core glTF); positions and normals stay float, so no extension is needed.
    .setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setNormalized(true)
      .setArray(Uint8Array.from(m.colors, (c) => Math.round(Math.min(1, Math.max(0, c)) * 255))).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(m.indices)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = out.createMesh(entry.id).addPrimitive(prim);
  scene.addChild(out.createNode(entry.id).setMesh(mesh));
  const tris = m.indices.length / 3;
  totalTris += tris;
  manifest[entry.id] = {
    w: r2(m.size.w), d: r2(m.size.d), h: r2(m.size.h), tags: entry.tags,
    colliders: collidersFor(entry, m.size),
    color: (m.color[0] << 16) | (m.color[1] << 8) | m.color[2],
  };
  console.log(`${entry.id.padEnd(18)} ${m.size.w.toFixed(1).padStart(5)} × ${m.size.d.toFixed(1).padStart(5)} × ${m.size.h.toFixed(1).padStart(5)} m  ${String(tris).padStart(5)} tris`);
}
await out.transform(weld(), dedup(), prune());
await io.write(OUT_GLB, out);

const ids = Object.keys(manifest);
fs.writeFileSync(OUT_TS, `// GENERATED by scripts/build-props.mjs from scripts/props.config.mjs — do not edit.
// Sizes are metres; each prop's base is centred on its origin, front facing +z.

export type PropId =
${ids.map((id) => `  | '${id}'`).join('\n')};

export type PropTag = ${[...new Set(Object.values(manifest).flatMap((m) => m.tags))].map((t) => `'${t}'`).join(' | ')};

export interface PropCollider { dx: number; dz: number; y: number; w: number; d: number; h: number; blocks?: 'shots' }

export interface PropInfo {
  w: number;
  d: number;
  h: number;
  tags: readonly PropTag[];
  /** Collision boxes relative to the base centre (before rotation) */
  colliders: readonly PropCollider[];
  /** Average colour, for the map preview */
  color: number;
}

export const PROPS: Record<PropId, PropInfo> = ${JSON.stringify(manifest, null, 2).replace(/"([a-z]+)":/g, '$1:').replace(/"/g, "'")};
`);
console.log(`\n${ids.length} props, ${totalTris} triangles → ${path.relative(ROOT, OUT_GLB)} (${(fs.statSync(OUT_GLB).size / 1024).toFixed(0)} KB)`);
