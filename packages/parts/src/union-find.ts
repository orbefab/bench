/** Disjoint sets of string ids. The lexicographically smaller id is the root. */
export class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  has(id: string): boolean {
    return this.parent.has(id);
  }

  ids(): string[] {
    return [...this.parent.keys()];
  }

  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) throw new Error(`unknown port ${id}`);
    if (p !== id) {
      const root = this.find(p);
      this.parent.set(id, root);
      return root;
    }
    return id;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const pa = this.find(a);
    const pb = this.find(b);
    if (pa === pb) return;
    if (pa < pb) this.parent.set(pb, pa);
    else this.parent.set(pa, pb);
  }
}
