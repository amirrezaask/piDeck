import { describe, expect, it } from 'vitest';

import { decodeJson, encodeJson } from '../index';

describe('JSON contracts', () => {
  it('round-trips validated JSON values', () => {
    const value = { answer: 42, nested: ['ok', true, null] };

    expect(decodeJson(encodeJson(value))).toEqual(value);
  });

  it('rejects non-JSON values', () => {
    expect(() => encodeJson({ value: Number.NaN })).toThrow();
  });
});
