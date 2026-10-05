/**
 * The models that go into public/models/props.glb (see build-props.mjs). Everything is Kenney CC0.
 *
 * - `scale` turns the kit's units into metres (the city kits are ~1/8 scale).
 * - `collider` is how the map generator blocks the model:
 *     'box'                 its whole footprint (optionally shrunk, for rough shapes like rocks)
 *     { trunk, h, canopy }  a thin trunk you can't walk through and a canopy that only stops bullets
 *     'none'                decoration you walk through (cones, small plants)
 * - `tags` say what the generator may use it for.
 */

const C = 'kenney_city-kit-commercial_2.1/Models/GLB format';
const S = 'kenney_city-kit-suburban_20/Models/GLB format';
const R = 'kenney_city-kit-roads/Models/GLB format';
const I = 'kenney_city-kit-industrial_2.0/Models/GLB format';
const N = 'kenney_nature-kit/Models/GLTF format';

const city = 8;
const nature = 5;

export const PROPS = [
  // Town: shops and offices (closed buildings), houses
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'k', 'l'].map((v) => ({ id: `shop-${v}`, file: `${C}/building-${v}.glb`, scale: city, collider: 'box', tags: ['building'] })),
  ...['a', 'b', 'c', 'd', 'e', 'f', 'h', 'k'].map((v) => ({ id: `house-${v}`, file: `${S}/building-type-${v}.glb`, scale: city * 0.85, collider: 'box', tags: ['building', 'house'] })),
  // Street furniture
  { id: 'lamp', file: `${R}/light-square.glb`, scale: city, collider: { trunk: 0.3, h: 4.5 }, tags: ['street'] },
  { id: 'lamp-curved', file: `${R}/light-curved.glb`, scale: city, collider: { trunk: 0.3, h: 4.5 }, tags: ['street'] },
  { id: 'traffic-light', file: `${R}/traffic-light.glb`, scale: city, collider: { trunk: 0.35, h: 4 }, tags: ['street'] },
  { id: 'barrier', file: `${R}/construction-barrier.glb`, scale: city, collider: 'box', tags: ['street', 'cover'] },
  { id: 'cone', file: `${R}/construction-cone.glb`, scale: city, collider: 'none', tags: ['street', 'small'] },
  { id: 'dumpster', file: `${R}/dumpster.glb`, scale: city, collider: 'box', tags: ['street', 'cover'] },
  { id: 'sign-stop', file: `${R}/road-sign-stop.glb`, scale: city, collider: { trunk: 0.2, h: 2.5 }, tags: ['street'] },
  { id: 'fence', file: `${S}/fence-1x3.glb`, scale: city * 0.85, collider: 'box', tags: ['fence'] },
  { id: 'fence-low', file: `${S}/fence-low.glb`, scale: city * 0.85, collider: 'box', tags: ['fence'] },
  { id: 'planter', file: `${S}/planter.glb`, scale: city * 0.85, collider: 'box', tags: ['cover'] },
  { id: 'tree-street', file: `${S}/tree-large.glb`, scale: city * 0.85, collider: { trunk: 0.45, h: 2.6, canopy: true }, tags: ['tree'] },
  // Industrial
  ...['a', 'b', 'c', 'd', 'e', 'f'].map((v) => ({ id: `factory-${v}`, file: `${I}/building-${v}.glb`, scale: city * 0.9, collider: 'box', tags: ['building', 'factory'] })),
  { id: 'chimney', file: `${I}/chimney-large.glb`, scale: city, collider: 'box', tags: ['industrial'] },
  { id: 'chimney-medium', file: `${I}/chimney-medium.glb`, scale: city, collider: 'box', tags: ['industrial'] },
  { id: 'tank-large', file: `${I}/detail-tank-large.glb`, scale: city, collider: 'box', tags: ['industrial'] },
  { id: 'tank', file: `${I}/detail-tank.glb`, scale: city, collider: 'box', tags: ['industrial'] },
  { id: 'water-tower', file: `${I}/water-tower.glb`, scale: city, collider: 'box', tags: ['industrial'] },
  // Outdoor
  ...['tree_oak', 'tree_default', 'tree_detailed', 'tree_fat', 'tree_tall', 'tree_pineTallA', 'tree_pineRoundC', 'tree_cone'].map((f) => ({
    id: f.replace('tree_', 'tree-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), file: `${N}/${f}.glb`, scale: nature * 1.15,
    collider: { trunk: 0.5, h: 3, canopy: true }, tags: ['tree'],
  })),
  ...['A', 'B', 'C', 'D', 'E', 'F'].map((v) => ({ id: `rock-${v.toLowerCase()}`, file: `${N}/rock_large${v}.glb`, scale: nature * 1.3, collider: { shrink: 0.8 }, tags: ['rock'] })),
  ...['A', 'C', 'E'].map((v) => ({ id: `rock-tall-${v.toLowerCase()}`, file: `${N}/rock_tall${v}.glb`, scale: nature * 1.3, collider: { shrink: 0.75 }, tags: ['rock'] })),
  { id: 'log-stack', file: `${N}/log_stackLarge.glb`, scale: nature, collider: 'box', tags: ['cover', 'nature'] },
  { id: 'log', file: `${N}/log_large.glb`, scale: nature, collider: 'box', tags: ['cover', 'nature'] },
  { id: 'stump', file: `${N}/stump_round.glb`, scale: nature, collider: 'box', tags: ['nature', 'small'] },
  { id: 'bush', file: `${N}/plant_bushLarge.glb`, scale: nature, collider: 'none', tags: ['nature', 'small'] },
  { id: 'bush-small', file: `${N}/plant_bush.glb`, scale: nature, collider: 'none', tags: ['nature', 'small'] },
  { id: 'tent', file: `${N}/tent_detailedClosed.glb`, scale: nature, collider: 'box', tags: ['nature', 'cover'] },
  { id: 'campfire', file: `${N}/campfire_stones.glb`, scale: nature, collider: 'none', tags: ['nature', 'small'] },
  { id: 'fence-wood', file: `${N}/fence_planks.glb`, scale: nature, collider: 'box', tags: ['fence', 'nature'] },
];
