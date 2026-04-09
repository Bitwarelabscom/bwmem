// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { TenantTier } from '../types.js';
import { TIER_DEFAULTS } from '../types.js';
import { createTenantSchema, updateTenantSchema, tenantIdParamsSchema, auditLogQuerySchema } from '../utils/schemas.js';
import { generateApiKey } from '../utils/api-keys.js';
import { ForbiddenError } from '../utils/errors.js';
import type { AuditService } from '../services/audit.js';

export async function adminRoutes(
  app: FastifyInstance,
  opts: { pg: PgClient; tablePrefix: string; invalidateTenant?: (tenantId: string) => void; audit?: AuditService },
): Promise<void> {
  const { pg, tablePrefix, invalidateTenant, audit } = opts;

  // Admin-only guard
  app.addHook('preHandler', async (request) => {
    if (!request.tenant?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }
  });

  // POST /admin/tenants — create a new tenant
  app.post('/tenants', async (request: FastifyRequest, _reply) => {
    const body = createTenantSchema.parse(request.body);
    const tier = body.tier as TenantTier;
    const defaults = TIER_DEFAULTS[tier];
    const { key, hash, prefix } = generateApiKey();

    const rows = await pg.query<{ id: string }>(
      `INSERT INTO ${tablePrefix}api_tenants
        (name, email, api_key_hash, api_key_prefix, tier, max_users,
         max_embeddings_per_month, rate_limit_per_minute,
         email_verified, email_verified_at, registration_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), 'admin')
       RETURNING id`,
      [body.name, body.email, hash, prefix, tier, defaults.maxUsers, defaults.maxEmbeddingsPerMonth, defaults.rateLimitPerMinute],
    );

    if (audit && rows.length > 0) {
      audit.log({
        tenantId: rows[0].id,
        eventType: 'admin_create_tenant',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { tier, name: body.name, email: body.email },
      });
    }

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

  // GET /admin/tenants — list all tenants (paginated)
  app.get('/tenants', async (request: FastifyRequest, _reply) => {
    const query = auditLogQuerySchema.parse(request.query); // reuse limit/offset schema
    const rows = await pg.query<{
      id: string; name: string; email: string; api_key_prefix: string;
      tier: string; max_users: number; max_embeddings_per_month: number;
      rate_limit_per_minute: number; is_active: boolean;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id, name, email, api_key_prefix, tier, max_users,
              max_embeddings_per_month, rate_limit_per_minute,
              is_active, created_at, updated_at
       FROM ${tablePrefix}api_tenants ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [query.limit, query.offset],
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

    if (audit) {
      audit.log({
        tenantId: id,
        eventType: 'admin_update_tenant',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: body as Record<string, unknown>,
      });
    }

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
