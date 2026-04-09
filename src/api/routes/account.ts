// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import { generateApiKey } from '../utils/api-keys.js';
import { addIpAllowlistSchema, removeIpAllowlistParamsSchema, auditLogQuerySchema } from '../utils/schemas.js';
import { ForbiddenError, NotFoundError, ConflictError } from '../utils/errors.js';
import type { AuditService } from '../services/audit.js';
import type { EmailService } from '../services/email.js';

const DEFAULT_GRACE_HOURS = 24;

export async function accountRoutes(
  app: FastifyInstance,
  opts: {
    pg: PgClient;
    tablePrefix: string;
    invalidateTenant: (tenantId: string) => void;
    audit: AuditService;
    email: EmailService;
    graceHours?: number;
  },
): Promise<void> {
  const { pg, tablePrefix, invalidateTenant, audit, email } = opts;
  const graceHours = opts.graceHours ?? DEFAULT_GRACE_HOURS;

  // Block admin from using account routes
  app.addHook('preHandler', async (request) => {
    if (!request.tenant || request.tenant.isAdmin) {
      throw new ForbiddenError('Use admin endpoints for admin operations');
    }
  });

  // GET /account — view own tenant info
  app.get('/', async (request: FastifyRequest, _reply) => {
    const t = request.tenant!;

    const allowlistCount = await pg.queryOne<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM ${tablePrefix}tenant_ip_allowlist WHERE tenant_id = $1`,
      [t.id],
    );

    return {
      success: true,
      data: {
        id: t.id,
        name: t.name,
        email: t.email,
        tier: t.tier,
        apiKeyPrefix: t.apiKeyPrefix,
        emailVerified: t.emailVerified,
        registrationSource: t.registrationSource,
        maxUsers: t.maxUsers,
        maxEmbeddingsPerMonth: t.maxEmbeddingsPerMonth,
        rateLimitPerMinute: t.rateLimitPerMinute,
        ipAllowlistEntries: parseInt(allowlistCount?.cnt ?? '0', 10),
        hasGracePeriodKey: t.prevKeyExpiresAt !== null && t.prevKeyExpiresAt > new Date(),
        createdAt: t.createdAt,
      },
    };
  });

  // POST /account/rotate-key — rotate API key with grace period
  app.post('/rotate-key', async (request: FastifyRequest, _reply) => {
    const t = request.tenant!;
    const { key, hash, prefix } = generateApiKey();
    const graceExpiry = new Date(Date.now() + graceHours * 60 * 60 * 1000);

    await pg.query(
      `UPDATE ${tablePrefix}api_tenants
       SET prev_api_key_hash = api_key_hash,
           prev_key_expires_at = $1,
           api_key_hash = $2,
           api_key_prefix = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [graceExpiry, hash, prefix, t.id],
    );

    invalidateTenant(t.id);

    audit.log({
      tenantId: t.id,
      eventType: 'key_rotate',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: { newPrefix: prefix, graceHours },
    });

    await email.sendKeyRotatedEmail(t.email, t.name, prefix, graceHours);

    return {
      success: true,
      data: {
        apiKey: key, // shown once
        apiKeyPrefix: prefix,
        previousKeyValidUntil: graceExpiry.toISOString(),
      },
    };
  });

  // GET /account/ip-allowlist — list IP allowlist entries
  app.get('/ip-allowlist', async (request: FastifyRequest, _reply) => {
    const entries = await pg.query<{
      id: string; cidr: string; label: string | null; created_at: Date;
    }>(
      `SELECT id, cidr, label, created_at FROM ${tablePrefix}tenant_ip_allowlist
       WHERE tenant_id = $1 ORDER BY created_at`,
      [request.tenant!.id],
    );

    return {
      success: true,
      data: {
        entries: entries.map(e => ({
          id: e.id, cidr: e.cidr, label: e.label, createdAt: e.created_at,
        })),
      },
    };
  });

  // POST /account/ip-allowlist — add CIDR entry
  app.post('/ip-allowlist', async (request: FastifyRequest, _reply) => {
    const t = request.tenant!;
    const body = addIpAllowlistSchema.parse(request.body);

    try {
      await pg.query(
        `INSERT INTO ${tablePrefix}tenant_ip_allowlist (tenant_id, cidr, label) VALUES ($1, $2::CIDR, $3)`,
        [t.id, body.cidr, body.label ?? null],
      );
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        throw new ConflictError('CIDR already in allowlist');
      }
      if (pgCode === '22P02') {
        throw new ConflictError('Invalid CIDR notation');
      }
      throw err;
    }

    invalidateTenant(t.id);

    audit.log({
      tenantId: t.id,
      eventType: 'ip_allowlist_add',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: { cidr: body.cidr, label: body.label },
    });

    return { success: true, data: { added: true } };
  });

  // DELETE /account/ip-allowlist/:id — remove CIDR entry
  app.delete('/ip-allowlist/:id', async (request: FastifyRequest, _reply) => {
    const t = request.tenant!;
    const { id } = removeIpAllowlistParamsSchema.parse(request.params);

    const deleted = await pg.query<{ id: string }>(
      `DELETE FROM ${tablePrefix}tenant_ip_allowlist WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, t.id],
    );

    if (deleted.length === 0) {
      throw new NotFoundError('IP allowlist entry not found');
    }

    invalidateTenant(t.id);

    audit.log({
      tenantId: t.id,
      eventType: 'ip_allowlist_remove',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: { entryId: id },
    });

    return { success: true, data: { removed: true } };
  });

  // GET /account/audit-log — view own audit events
  app.get('/audit-log', async (request: FastifyRequest, _reply) => {
    const t = request.tenant!;
    const query = auditLogQuerySchema.parse(request.query);

    const rows = await pg.query<{
      event_type: string; ip_address: string | null; details: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT event_type, ip_address, details, created_at
       FROM ${tablePrefix}auth_audit_log
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [t.id, query.limit, query.offset],
    );

    return {
      success: true,
      data: {
        events: rows.map(r => ({
          eventType: r.event_type,
          ip: r.ip_address,
          details: r.details,
          createdAt: r.created_at,
        })),
      },
    };
  });
}
