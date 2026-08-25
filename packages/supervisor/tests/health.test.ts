import { describe, expect, it } from 'vitest';

import { buildSupervisorApp } from '../app';

describe('Supervisor shell', () => {
  it('exposes a health endpoint without owning workflow tables', async () => {
    const { server } = buildSupervisorApp({ databasePath: ':memory:', startService: false });
    try {
      const response = await server.inject({ method: 'GET', url: '/v1/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', service: 'supervisor' });
    } finally {
      await server.close();
    }
  });
});
