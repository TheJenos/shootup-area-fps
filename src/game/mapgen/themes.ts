/** The looks a map can have: floor, walls, sky and light. Biomes (biomes.ts) pick from these. */

import type { MapTheme } from './types';

export const THEMES: MapTheme[] = [
  {
    name: 'Training Yard', surface: 'hard',
    floorTexture: 'tiles', wallSurface: 'concrete', pillarSurface: 'metal', sky: 0x9cc6ea, hemiSky: 0xe4f1ff, hemiGround: 0x5a4d3a, sun: 0xfff4e0,
    floor: '#5d6b58', floorLine: '#4d5a49', wall: 0x8a8f99,
    palette: [0x9a6b4f, 0xc28a4a, 0x6f7d8c, 0x4f7a6a, 0x4f6a7a, 0x7d8597],
  },
  {
    name: 'Dust Bowl', surface: 'sand',
    floorTexture: 'sand', wallSurface: 'brick', pillarSurface: 'concrete', sky: 0xe8cfa4, hemiSky: 0xfff0d6, hemiGround: 0x7a5a36, sun: 0xffe2b0,
    floor: '#b8955f', floorLine: '#a3824f', wall: 0xa88a64,
    palette: [0x8c5a3c, 0xc9a26b, 0x6e4f3a, 0xb0703f, 0x998066],
  },
  {
    name: 'Frostbite', surface: 'snow',
    floorTexture: 'snow', wallSurface: 'concrete', pillarSurface: 'metal', sky: 0xcfe6f5, hemiSky: 0xf2fbff, hemiGround: 0x6c7f91, sun: 0xeaf6ff,
    floor: '#d9e4ec', floorLine: '#c3d1dc', wall: 0x9fb3c4,
    palette: [0x5d7f9e, 0x86a7c2, 0x3e5a73, 0xb3c9d9, 0x6f8fa3],
  },
  {
    name: 'Dusk Yard', surface: 'hard',
    floorTexture: 'asphalt', wallSurface: 'brick', pillarSurface: 'metal', sky: 0x3d3b63, hemiSky: 0xffb38a, hemiGround: 0x2a2440, sun: 0xffa36b,
    floor: '#4a4560', floorLine: '#3d3852', wall: 0x5d5778,
    palette: [0x8a4f6b, 0xd07a52, 0x5a6b9a, 0x9c6b9e, 0x4f8a8a],
  },
  {
    name: 'Greenwood', surface: 'sand',
    floorTexture: 'grass', wallSurface: 'planks', pillarSurface: 'rock', sky: 0xa8d0ee, hemiSky: 0xeaf6ff, hemiGround: 0x4a5a32, sun: 0xfff1d0,
    floor: '#5f8a45', floorLine: '#4f7a3a', wall: 0x7a8a6a,
    palette: [0x8a6a45, 0x6f7d5a, 0xa58a5f, 0x5c6b4a, 0x7d6a55],
  },
  {
    name: 'Toxic Works', surface: 'hard',
    floorTexture: 'plate', wallSurface: 'metal', pillarSurface: 'concrete', sky: 0xa9c79b, hemiSky: 0xe6ffd6, hemiGround: 0x3b4a2e, sun: 0xf3ffd0,
    floor: '#4f5a46', floorLine: '#414b39', wall: 0x6b7563,
    palette: [0x8fbf3f, 0x5c6b4a, 0xc9c94a, 0x3f5f5a, 0x7a8a5a],
  },
];

export const themeNamed = (name: string): MapTheme => THEMES.find((t) => t.name === name) ?? (THEMES[0] as MapTheme);
