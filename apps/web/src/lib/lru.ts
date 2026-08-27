export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('LRU cache limit must be positive');
    this.limit = limit;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }

  snapshot(): Record<string, V> {
    return Object.fromEntries(this.entries) as Record<string, V>;
  }
}
