// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { TenantTier } from '../types.js';
import { TIER_DEFAULTS } from '../types.js';
import { createTenantSchema, updateTenantSchema, tenantIdParamsSchema } from '../utils/schemas.js';
import { generateApiKey } from '../utils/api-keys.js';
import { ForbiddenError } from '../utils/errors.js';

export async function adminRoutes(
  app: FastifyInstance,
  opts: { pg: PgClient; tablePrefix: string; invalidateTenant?: (tenantId: string) => void },
): Promise<void> {
  const { pg, tablePrefix, invalidateTenant } = opts;

  // Admin-only guard
  app.addHook('preHandler', async (request) => {
    if (request.tenant?.id !== 'admin') {
      throw new ForbiddenError('Admin access required');
    }
  });

  // POST /admin/tenants — create a new tenant
  app.post('/tenants', async (request: FastifyRequest, _reply) => {
    const body = createTenantSchema.parse(request.body);
    const tier = body.tier as TenantTier;
    const defaults = TIER_DEFAULTS[tier];
    const { key, hash, prefix } = generateApiKey();

    await pg.query(
      `INSERT INTO ${tablePrefix}api_tenants
        (name, email, api_key_hash, api_key_prefix, tier, max_users, max_embeddings_per_month, rate_limit_per_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [body.name, body.email, hash, prefix, tier, defaults.maxUsers, defaults.maxEmbeddingsPerMonth, defaults.rateLimitPerMinute],
    );

    return {
      success: true,
      data: {
        name: body.name,
        email: body.email,
        tier,
        apiKey: key, // Shown only once
        apiKeyPrefix: prefix,
      },
    };
  });

  // GET /admin/tenants — list all tenants
  app.get('/tenants', async (_request, _reply) => {
    const rows = await pg.query<{
      id: string; name: string; email: string; api_key_prefix: string;
      tier: string; max_users: number; max_embeddings_per_month: number;
      rate_limit_per_minute: number; is_active: boolean;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id, name, email, api_key_prefix, tier, max_users,
              max_embeddings_per_month, rate_limit_per_minute,
              is_active, created_at, updated_at
       FROM ${tablePrefix}api_tenants ORDER BY created_at DESC`,
    );

    return {
      success: true,
      data: { tenants: rows.map(rowToTenantSummary) },
    };
  });

  // PATCH /admin/tenants/:id — update a tenant
  app.patch('/tenants/:id', async (request: FastifyRequest, _reply) => {
    const { id } = tenantIdParamsSchema.parse(request.params);
    const body = updateTenantSchema.parse(request.body);

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) { sets.push(`name = $${idx++}`); params.push(body.name); }
    if (body.tier !== undefined) {
      sets.push(`tier = $${idx++}`); params.push(body.tier);
      // Apply tier defaults unless overridden
      const defaults = TIER_DEFAULTS[body.tier as TenantTier];
      if (body.maxUsers === undefined) { sets.push(`max_users = $${idx++}`); params.push(defaults.maxUsers); }
      if (body.maxEmbeddingsPerMonth === undefined) { sets.push(`max_embeddings_per_month = $${idx++}`); params.push(defaults.maxEmbeddingsPerMonth); }
      if (body.rateLimitPerMinute === undefined) { sets.push(`rate_limit_per_minute = $${idx++}`); params.push(defaults.rateLimitPerMinute); }
    }
    if (body.maxUsers !== undefined) { sets.push(`max_users = $${idx++}`); params.push(body.maxUsers); }
    if (body.maxEmbeddingsPerMonth !== undefined) { sets.push(`max_embeddings_per_month = $${idx++}`); params.push(body.maxEmbeddingsPerMonth); }
    if (body.rateLimitPerMinute !== undefined) { sets.push(`rate_limit_per_minute = $${idx++}`); params.push(body.rateLimitPerMinute); }
    if (body.isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(body.isActive); }

    if (sets.length === 0) {
      return { success: true, data: { updated: false } };
    }

    sets.push(`updated_at = NOW()`);
    params.push(id);

    await pg.query(
      `UPDATE ${tablePrefix}api_tenants SET ${sets.join(', ')} WHERE id = $${idx}`,
      params,
    );

    // Invalidate auth cache so changes take effect immediately (#3)
    if (invalidateTenant) invalidateTenant(id);

    return { success: true, data: { updated: true } };
  });
}

function rowToTenantSummary(row: {
  id: string; name: string; email: string; api_key_prefix: string;
  tier: string; max_users: number; max_embeddings_per_month: number;
  rate_limit_per_minute: number; is_active: boolean;
  created_at: Date; updated_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    apiKeyPrefix: row.api_key_prefix,
    tier: row.tier,
    maxUsers: row.max_users,
    maxEmbeddingsPerMonth: row.max_embeddings_per_month,
    rateLimitPerMinute: row.rate_limit_per_minute,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
