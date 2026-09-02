import { describe, expect, it } from 'vitest';
import { LruCache } from './lru';

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('first', 1);
    cache.set('second', 2);
    expect(cache.get('first')).toBe(1);
    cache.set('third', 3);

    expect(cache.has('first')).toBe(true);
    expect(cache.has('second')).toBe(false);
    expect(cache.snapshot()).toEqual({ first: 1, third: 3 });
  });
});
