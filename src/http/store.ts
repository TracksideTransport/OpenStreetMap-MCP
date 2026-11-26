/** A bounded in-memory map whose entries expire. Used for registrations, pending flows, codes and tokens. */
export class TtlMap<V> {
  private m = new Map<string, { v: V; exp: number }>();
  private lastSweep = 0;

  constructor(private ttlMs: number, private max: number, private now: () => number = Date.now) {}

  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    this.sweep();
    if (this.m.size >= this.max && !this.m.has(key)) this.m.delete(this.m.keys().next().value as string); // evict oldest
    this.m.set(key, { v: value, exp: this.now() + ttlMs });
  }

  get(key: string): V | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e.v;
  }

  /** Get and remove in one step: single-use semantics. */
  take(key: string): V | undefined {
    const v = this.get(key);
    this.m.delete(key);
    return v;
  }

  delete(key: string): void {
    this.m.delete(key);
  }

  get size(): number {
    this.sweep(true);
    return this.m.size;
  }

  private sweep(force = false): void {
    const t = this.now();
    if (!force && t - this.lastSweep < 30_000) return;
    this.lastSweep = t;
    for (const [k, e] of this.m) if (e.exp <= t) this.m.delete(k);
  }
}
