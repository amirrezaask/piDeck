import { describe, expect, it } from 'vitest';

import { decodeJson, encodeJson } from '../src/json';

describe('JSON contracts', () => {
  it('round-trips validated JSON values', () => {
    const value = { answer: 42, nested: ['ok', true, null] };

    expect(decodeJson(encodeJson(value))).toEqual(value);
  });

  it('rejects non-JSON values', () => {
    expect(() => encodeJson({ value: Number.NaN })).toThrow();
  });
});
