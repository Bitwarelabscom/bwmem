// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { Logger } from '../../types.js';
import type { ApiTenant } from '../types.js';
import { hashApiKey, isValidKeyFormat } from '../utils/api-keys.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';
import { isIpAllowed } from '../utils/ip.js';

interface CacheEntry {
  tenant: ApiTenant;
  ipAllowlist: string[];
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
        id: '__admin__',
        isAdmin: true,
        name: 'Admin',
        email: 'admin@internal',
        apiKeyHash: '',
        apiKeyPrefix: 'admin',
        tier: 'enterprise',
        maxUsers: 999_999,
        maxEmbeddingsPerMonth: 999_999_999,
        rateLimitPerMinute: 600,
        isActive: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        registrationSource: 'admin',
        prevApiKeyHash: null,
        prevKeyExpiresAt: null,
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
        // IP allowlist check (fast path from cache)
        if (!isIpAllowed(request.ip, cached.ipAllowlist)) {
          throw new ForbiddenError('Request IP not in allowlist');
        }
        request.tenant = cached.tenant;
        return;
      }
      cache.delete(keyHash);
    }

    // DB lookup — includes grace-period key for rotation
    const [row, allowlistRows] = await Promise.all([
      pg.queryOne<{
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
        email_verified: boolean;
        email_verified_at: Date | null;
        registration_source: string;
        prev_api_key_hash: string | null;
        prev_key_expires_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, name, email, api_key_hash, api_key_prefix, tier,
                max_users, max_embeddings_per_month, rate_limit_per_minute,
                is_active, email_verified, email_verified_at,
                registration_source, prev_api_key_hash, prev_key_expires_at,
                created_at, updated_at
         FROM ${tablePrefix}api_tenants
         WHERE is_active = TRUE
           AND (api_key_hash = $1
                OR (prev_api_key_hash = $1 AND prev_key_expires_at > NOW()))`,
        [keyHash],
      ),
      pg.query<{ cidr: string }>(
        `SELECT al.cidr FROM ${tablePrefix}tenant_ip_allowlist al
         INNER JOIN ${tablePrefix}api_tenants t ON al.tenant_id = t.id
         WHERE t.is_active = TRUE
           AND (t.api_key_hash = $1
                OR (t.prev_api_key_hash = $1 AND t.prev_key_expires_at > NOW()))`,
        [keyHash],
      ),
    ]);

    if (!row) {
      throw new UnauthorizedError();
    }

    // Email verification check
    if (!row.email_verified) {
      throw new ForbiddenError('Email not verified. Check your inbox for the verification link.');
    }

    const ipAllowlist = allowlistRows.map(r => r.cidr);

    // IP allowlist check
    if (!isIpAllowed(request.ip, ipAllowlist)) {
      throw new ForbiddenError('Request IP not in allowlist');
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
      emailVerified: row.email_verified,
      emailVerifiedAt: row.email_verified_at,
      registrationSource: row.registration_source as ApiTenant['registrationSource'],
      prevApiKeyHash: row.prev_api_key_hash,
      prevKeyExpiresAt: row.prev_key_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Evict oldest entry if cache is full (#7)
    if (cache.size >= CACHE_MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    cache.set(keyHash, { tenant, ipAllowlist, expiresAt: Date.now() + CACHE_TTL_MS });
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
