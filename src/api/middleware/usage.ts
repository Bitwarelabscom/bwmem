// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { Logger } from '../../types.js';
import { QuotaExceededError } from '../utils/errors.js';

interface UsageBuffer {
  tenantId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

// Monthly usage cache: tenantId -> { tokens, checkedAt }
interface UsageCache {
  tokens: number;
  checkedAt: number;
}

const USAGE_CACHE_TTL_MS = 60_000; // 1 minute

export function createUsageMiddleware(pg: PgClient, tablePrefix: string, logger: Logger) {
  const buffer: UsageBuffer[] = [];
  const usageCache = new Map<string, UsageCache>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  // Start periodic flush
  flushTimer = setInterval(() => void flushBuffer(), 30_000);

  async function getMonthlyEmbeddingTokens(tenantId: string): Promise<number> {
    const cached = usageCache.get(tenantId);
    if (cached && Date.now() - cached.checkedAt < USAGE_CACHE_TTL_MS) {
      return cached.tokens;
    }

    const row = await pg.queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(embedding_tokens), 0) AS total
       FROM ${tablePrefix}api_usage
       WHERE tenant_id = $1
         AND created_at >= DATE_TRUNC('month', NOW())`,
      [tenantId],
    );

    const tokens = parseInt(row?.total ?? '0', 10);
    usageCache.set(tenantId, { tokens, checkedAt: Date.now() });
    return tokens;
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;
    const records = buffer.splice(0);

    try {
      const values: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      for (const r of records) {
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
        params.push(r.tenantId, r.endpoint, r.method, r.statusCode, r.durationMs);
        idx += 5;
      }

      await pg.query(
        `INSERT INTO ${tablePrefix}api_usage (tenant_id, endpoint, method, status_code, duration_ms)
         VALUES ${values.join(', ')}`,
        params,
      );
    } catch (err) {
      logger.error('Failed to flush usage buffer', { error: (err as Error).message });
    }
  }

  /** preHandler: check embedding quota and set response headers */
  async function quotaCheck(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant || tenant.isAdmin) return;

    const used = await getMonthlyEmbeddingTokens(tenant.id);
    const remaining = Math.max(0, tenant.maxEmbeddingsPerMonth - used);

    reply.header('X-Embedding-Limit', tenant.maxEmbeddingsPerMonth);
    reply.header('X-Embedding-Remaining', remaining);

    if (remaining <= 0) {
      throw new QuotaExceededError();
    }
  }

  /** onResponse: record usage */
  async function recordUsage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant || tenant.isAdmin) return;

    buffer.push({
      tenantId: tenant.id,
      endpoint: request.routeOptions?.url ?? request.url,
      method: request.method,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });

    if (buffer.length >= 100) {
      void flushBuffer();
    }
  }

  async function shutdown(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer);
    await flushBuffer();
  }

  return { quotaCheck, recordUsage, shutdown };
}
