/**
 * A tiny in-process, per-tenant TTL cache.
 *
 * Several values are read on almost every request but written perhaps once a month:
 * a shop's settings rows and its chart-of-accounts id map. Re-reading them per request
 * is a database round-trip (and, for the chart of accounts, a scan of every account the
 * shop has) bought for nothing.
 *
 * Deliberately in-process rather than Redis: it costs no extra infrastructure, which is
 * the point. The trade-off is that entries are per instance, so a write on instance A is
 * invisible to instance B until the TTL lapses. Everything cached here is therefore both
 * short-lived and non-financial — settings and account ids — never balances or amounts,
 * which are always read fresh.
 *
 * Bounded so a server with many tenants cannot grow this without limit; when full it
 * drops the oldest-inserted entries, which for this access pattern is close enough to
 * LRU without the bookkeeping.
 */
const MAX_ENTRIES = 5_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= MAX_ENTRIES) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Read-through: returns the cached value, otherwise runs `load` and caches it.
   *
   * Concurrent misses are shared — the in-flight promise itself is cached, so N
   * simultaneous requests for a cold key issue one query rather than N. A failed load is
   * evicted so the next caller retries instead of caching the rejection.
   */
  async wrap(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = load();
    this.set(key, pending as unknown as T);
    try {
      const value = await pending;
      this.set(key, value);
      return value;
    } catch (err) {
      this.delete(key);
      throw err;
    }
  }
}
