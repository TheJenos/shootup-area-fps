/**
 * The generator's only source of randomness: mulberry32 seeded from an FNV-1a hash of a text seed.
 * Integer arithmetic only, so every engine (V8, JavaScriptCore, SpiderMonkey) rolls the same numbers.
 *
 * Each stage of the generator forks its own stream (`rng.fork('terrain')`), so changing how many
 * numbers one stage uses never reshuffles another.
 */

export class Rng {
  private a: number;

  constructor(readonly seed: string) {
    let a = 2166136261;
    for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
    this.a = a;
  }

  /** 0 (inclusive) to 1 (exclusive) */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An independent stream for one stage or one thing */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** An integer from min to max, both included */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick by weight: [[item, weight], ...] */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return (items[items.length - 1] as readonly [T, number])[0];
  }

  /** Fisher-Yates, in place (never sort with a random comparator: engines sort differently). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = items[i] as T;
      items[i] = items[j] as T;
      items[j] = t;
    }
    return items;
  }
}
