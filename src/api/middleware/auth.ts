// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { Logger } from '../../types.js';
import type { ApiTenant } from '../types.js';
import { hashApiKey, isValidKeyFormat } from '../utils/api-keys.js';
import { UnauthorizedError } from '../utils/errors.js';

interface CacheEntry {
  tenant: ApiTenant;
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000; // 5 seconds — short to limit deactivation window (#3)
const CACHE_MAX_SIZE = 1_000; // Bounded cache to prevent memory growth (#7)

/** Constant-time string comparison to prevent timing attacks (#1) */
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid leaking length via timing
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function createAuthHook(pg: PgClient, tablePrefix: string, logger: Logger, adminApiKey?: string) {
  const cache = new Map<string, CacheEntry>();

  // Periodic cache sweep to evict expired entries (#7)
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }, 30_000);
  sweepInterval.unref();

  async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    // Skip auth for health endpoint
    if (request.url === '/api/v1/health') return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError();
    }

    const key = authHeader.slice(7);

    // Check for admin key — constant-time comparison (#1)
    if (adminApiKey && constantTimeCompare(key, adminApiKey)) {
      request.tenant = {
        id: 'admin',
        name: 'Admin',
        email: 'admin@internal',
        apiKeyHash: '',
        apiKeyPrefix: 'admin',
        tier: 'enterprise',
        maxUsers: 999_999,
        maxEmbeddingsPerMonth: 999_999_999,
        rateLimitPerMinute: 600,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return;
    }

    if (!isValidKeyFormat(key)) {
      throw new UnauthorizedError();
    }

    const keyHash = hashApiKey(key);

    // Check cache — also evict if expired (#7)
    const cached = cache.get(keyHash);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        request.tenant = cached.tenant;
        return;
      }
      cache.delete(keyHash);
    }

    // DB lookup
    const row = await pg.queryOne<{
      id: string;
      name: string;
      email: string;
      api_key_hash: string;
      api_key_prefix: string;
      tier: string;
      max_users: number;
      max_embeddings_per_month: number;
      rate_limit_per_minute: number;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT * FROM ${tablePrefix}api_tenants WHERE api_key_hash = $1 AND is_active = TRUE`,
      [keyHash],
    );

    if (!row) {
      throw new UnauthorizedError();
    }

    const tenant: ApiTenant = {
      id: row.id,
      name: row.name,
      email: row.email,
      apiKeyHash: row.api_key_hash,
      apiKeyPrefix: row.api_key_prefix,
      tier: row.tier as ApiTenant['tier'],
      maxUsers: row.max_users,
      maxEmbeddingsPerMonth: row.max_embeddings_per_month,
      rateLimitPerMinute: row.rate_limit_per_minute,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Evict oldest entry if cache is full (#7)
    if (cache.size >= CACHE_MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    cache.set(keyHash, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
    request.tenant = tenant;

    logger.debug('Authenticated tenant', { tenantId: tenant.id, tier: tenant.tier });
  }

  /** Invalidate a specific tenant from auth cache (#3) */
  function invalidateTenant(tenantId: string): void {
    for (const [hash, entry] of cache) {
      if (entry.tenant.id === tenantId) cache.delete(hash);
    }
  }

  return { authHook, invalidateTenant };
}
