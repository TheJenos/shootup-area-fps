/**
 * A uniform grid over the map for finding the boxes near a point without scanning them all (the
 * ground under a footstep, whether a deployable fits). Items spanning several cells are in each.
 */
export class SpatialGrid<T> {
  private readonly n: number;
  private readonly cells: T[][];
  private readonly seen = new Set<T>();

  constructor(private readonly half: number, private readonly cell = 4) {
    this.n = Math.max(1, Math.ceil((half * 2) / cell));
    this.cells = Array.from({ length: this.n * this.n }, () => []);
  }

  private index(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v + this.half) / this.cell)));
  }

  insert(minX: number, maxX: number, minZ: number, maxZ: number, item: T): void {
    const i1 = this.index(maxX);
    const k1 = this.index(maxZ);
    for (let k = this.index(minZ); k <= k1; k++) for (let i = this.index(minX); i <= i1; i++) this.cells[k * this.n + i]!.push(item);
  }

  /** Items whose cells include (x, z) (a superset of those over it) */
  at(x: number, z: number): readonly T[] {
    return this.cells[this.index(z) * this.n + this.index(x)]!;
  }

  /** Each item in the cells a rectangle touches, once; stops early when `fn` returns true. */
  some(minX: number, maxX: number, minZ: number, maxZ: number, fn: (item: T) => boolean): boolean {
    const seen = this.seen;
    seen.clear();
    const i1 = this.index(maxX);
    const k1 = this.index(maxZ);
    for (let k = this.index(minZ); k <= k1; k++) {
      for (let i = this.index(minX); i <= i1; i++) {
        for (const item of this.cells[k * this.n + i]!) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (fn(item)) return true;
        }
      }
    }
    return false;
  }
}
