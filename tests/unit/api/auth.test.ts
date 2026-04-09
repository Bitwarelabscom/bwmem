import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthHook } from '../../../src/api/middleware/auth.js';
import { generateApiKey } from '../../../src/api/utils/api-keys.js';
import { MockPgClient, mockLogger } from '../../fixtures/mock-providers.js';
import { UnauthorizedError } from '../../../src/api/utils/errors.js';

function mockRequest(opts: { url?: string; authorization?: string; ip?: string } = {}) {
  return {
    url: opts.url ?? '/api/v1/sessions',
    ip: opts.ip ?? '127.0.0.1',
    headers: {
      authorization: opts.authorization,
    },
    tenant: undefined as any,
  } as any;
}

const mockReply = {} as any;

describe('auth middleware', () => {
  let pg: MockPgClient;
  let authHook: ReturnType<typeof createAuthHook>['authHook'];

  beforeEach(() => {
    pg = new MockPgClient();
    ({ authHook } = createAuthHook(pg as any, 'bwmem_', mockLogger, 'admin_secret_key_that_is_at_least_32_chars_long'));
  });

  it('skips auth for health endpoint', async () => {
    const req = mockRequest({ url: '/api/v1/health' });
    await authHook(req, mockReply);
    expect(req.tenant).toBeUndefined();
  });

  it('rejects missing Authorization header', async () => {
    const req = mockRequest();
    await expect(authHook(req, mockReply)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects malformed Bearer token', async () => {
    const req = mockRequest({ authorization: 'Basic abc' });
    await expect(authHook(req, mockReply)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects invalid key format', async () => {
    const req = mockRequest({ authorization: 'Bearer notavalidkey' });
    await expect(authHook(req, mockReply)).rejects.toThrow(UnauthorizedError);
  });

  it('authenticates with admin key', async () => {
    const req = mockRequest({ authorization: 'Bearer admin_secret_key_that_is_at_least_32_chars_long' });
    await authHook(req, mockReply);
    expect(req.tenant.isAdmin).toBe(true);
    expect(req.tenant.tier).toBe('enterprise');
  });

  it('authenticates with valid tenant key', async () => {
    const { key, hash } = generateApiKey();
    pg.willReturnOne({
      id: 'tenant-1',
      name: 'Test',
      email: 'test@test.com',
      api_key_hash: hash,
      api_key_prefix: key.slice(0, 12),
      tier: 'hobby',
      max_users: 1,
      max_embeddings_per_month: 30000,
      rate_limit_per_minute: 30,
      is_active: true,
      email_verified: true,
      email_verified_at: new Date(),
      registration_source: 'admin',
      prev_api_key_hash: null,
      prev_key_expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    pg.willReturn([]); // empty IP allowlist

    const req = mockRequest({ authorization: `Bearer ${key}`, ip: '127.0.0.1' });
    await authHook(req, mockReply);
    expect(req.tenant.id).toBe('tenant-1');
    expect(req.tenant.tier).toBe('hobby');
  });

  it('rejects unknown key', async () => {
    const { key } = generateApiKey();
    pg.willReturnOne(null);
    pg.willReturn([]); // allowlist query still runs in parallel

    const req = mockRequest({ authorization: `Bearer ${key}` });
    await expect(authHook(req, mockReply)).rejects.toThrow(UnauthorizedError);
  });

  it('caches tenant lookup', async () => {
    const { key, hash } = generateApiKey();
    const tenantRow = {
      id: 'tenant-1', name: 'Test', email: 'test@test.com',
      api_key_hash: hash, api_key_prefix: key.slice(0, 12),
      tier: 'builder', max_users: 10, max_embeddings_per_month: 300000,
      rate_limit_per_minute: 60, is_active: true,
      email_verified: true, email_verified_at: new Date(),
      registration_source: 'admin',
      prev_api_key_hash: null, prev_key_expires_at: null,
      created_at: new Date(), updated_at: new Date(),
    };
    pg.willReturnOne(tenantRow);
    pg.willReturn([]); // empty IP allowlist

    // First call - hits DB (2 parallel queries: tenant + allowlist)
    const req1 = mockRequest({ authorization: `Bearer ${key}`, ip: '127.0.0.1' });
    await authHook(req1, mockReply);
    expect(pg.queries).toHaveLength(2);

    // Second call - hits cache
    const req2 = mockRequest({ authorization: `Bearer ${key}`, ip: '127.0.0.1' });
    await authHook(req2, mockReply);
    expect(pg.queries).toHaveLength(2); // No additional queries
    expect(req2.tenant.id).toBe('tenant-1');
  });
});
