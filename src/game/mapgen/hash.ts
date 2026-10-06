/** A fingerprint of a map's content: two clients with the same spec must get the same one. */

import type { MapData } from './types';

export function mapHash(m: Omit<MapData, 'hash'>): number {
  let h = 2166136261;
  const num = (n: number) => {
    // Centimetres as an integer, so float noise below that doesn't count.
    let v = Math.round(n * 100) | 0;
    for (let i = 0; i < 4; i++) {
      h = Math.imul(h ^ (v & 0xff), 16777619) >>> 0;
      v >>= 8;
    }
  };
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  };
  str(m.name);
  str(m.theme.name);
  num(m.half);
  for (const b of m.boxes) {
    num(b.x); num(b.z); num(b.w); num(b.h); num(b.d); num(b.y);
    str(b.surface);
    str(b.ramp ?? '');
    str(b.blocks ?? '');
  }
  for (const p of m.props) {
    str(p.id); num(p.x); num(p.z); num(p.y); num(p.rot);
  }
  if (m.ground) for (let i = 0; i < m.ground.heights.length; i++) num(m.ground.heights[i]!);
  for (const s of m.spawns) {
    num(s.x); num(s.y); num(s.z);
  }
  for (const v of [...m.flags.red, ...m.flags.blue]) num(v);
  return h >>> 0;
}
