import { describe, expect, it } from 'vitest';

import { createLogger } from '../index';

describe('observability', () => {
  it('creates a structured logger', () => {
    const logger = createLogger({ enabled: false });

    expect(logger).toBeDefined();
  });
});
