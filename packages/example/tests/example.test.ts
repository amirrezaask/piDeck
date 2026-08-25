import { describe, expect, it } from 'vitest';

import { exampleMessage } from '../index';

describe('example package', () => {
  it('exposes behaviour through its entry point', () => {
    expect(exampleMessage('deep module')).toBe('Hello, deep module!');
  });
});
