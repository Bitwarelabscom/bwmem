import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { factRoutes } from '../../../src/api/routes/facts.js';
import { MockPgClient } from '../../fixtures/mock-providers.js';

describe('factRoutes tombstones API', () => {
  let app: ReturnType<typeof Fastify>;
  let pg: MockPgClient;
  let mockBwmem: any;

  beforeEach(async () => {
    pg = new MockPgClient();
    app = Fastify();

    // Mock tenant decoration from auth hook
    app.addHook('onRequest', async (req: any) => {
      req.tenant = { id: 'tenant1', isAdmin: false, tier: 'free' };
    });

    mockBwmem = {
      facts: {
        tombstone: async (userId: string, key: string, value: string, reason?: string) => ({
          id: 'tomb-123',
          userId,
          factKey: key,
          factValue: value,
          valueHash: 'hash123',
          reason,
          createdAt: new Date('2026-09-20T12:00:00Z'),
        }),
        getTombstones: async (userId: string, opts?: any) => [
          {
            id: 'tomb-123',
            userId,
            factKey: 'city',
            factValue: 'Berlin',
            valueHash: 'hash123',
            reason: 'User moved away',
            createdAt: new Date('2026-09-20T12:00:00Z'),
          },
        ],
        removeTombstone: async (userId: string, id: string) => true,
        remove: async () => {},
        store: async () => {},
        get: async () => [],
        getAsOf: async () => [],
        search: async () => [],
      },
    };

    await factRoutes(app, {
      bwmem: mockBwmem,
      pg: pg as any,
      tablePrefix: 'bwmem_',
    });
  });

  it('POST /facts/:userId/tombstones creates a tombstone and strips tenant prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/facts/alice/tombstones',
      payload: {
        key: 'city',
        value: 'Berlin',
        reason: 'Moved away',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.tombstone.userId).toBe('alice');
    expect(json.data.tombstone.factKey).toBe('city');
    expect(json.data.tombstone.factValue).toBe('Berlin');
    expect(json.data.tombstone.reason).toBe('Moved away');
  });

  it('GET /facts/:userId/tombstones lists tombstones for user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/facts/alice/tombstones?key=city',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.tombstones).toHaveLength(1);
    expect(json.data.tombstones[0].userId).toBe('alice');
    expect(json.data.tombstones[0].factKey).toBe('city');
  });

  it('DELETE /facts/:userId/tombstones/:tombstoneId removes a tombstone', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/facts/alice/tombstones/a0000000-0000-0000-0000-000000000123',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { deleted: true } });
  });

  it('DELETE /facts/:factId calls remove with tombstone default true', async () => {
    let capturedOpts: any;
    mockBwmem.facts.remove = async (id: string, reason?: string, opts?: any) => {
      capturedOpts = opts;
    };
    pg.willReturnOne({ user_id: 't_tenant1:alice' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/facts/550e8400-e29b-41d4-a716-446655440000',
      payload: { reason: 'No longer accurate' },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedOpts).toEqual({ tombstone: true });
  });
});
