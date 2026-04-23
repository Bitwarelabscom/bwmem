// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { TenantTier } from '../types.js';
import { TIER_DEFAULTS } from '../types.js';
import { generateApiKey } from '../utils/api-keys.js';
import { registerSchema, magicLinkRequestSchema, verifyTokenSchema } from '../utils/schemas.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { MagicLinkService } from '../services/magic-link.js';
import type { EmailService } from '../services/email.js';
import type { AuditService } from '../services/audit.js';

const GENERIC_CHECK_EMAIL = 'If an account exists for that email, a message has been sent.';

export async function authRoutes(
  app: FastifyInstance,
  opts: {
    pg: PgClient;
    tablePrefix: string;
    magicLink: MagicLinkService;
    email: EmailService;
    audit: AuditService;
    baseUrl: string;
  },
): Promise<void> {
  const { pg, tablePrefix, magicLink, email, audit, baseUrl } = opts;

  // POST /auth/register — self-service signup (tester/hobby only)
  app.post('/register', async (request: FastifyRequest, _reply) => {
    const body = registerSchema.parse(request.body);
    const tier = body.tier as TenantTier;
    const defaults = TIER_DEFAULTS[tier];

    // Check if email already exists (don't reveal this to the caller)
    const existing = await pg.queryOne<{ id: string }>(
      `SELECT id FROM ${tablePrefix}api_tenants WHERE email = $1`,
      [body.email],
    );

    if (existing) {
      // Return same message to prevent email enumeration
      return { success: true, data: { message: GENERIC_CHECK_EMAIL } };
    }

    const { hash, prefix } = generateApiKey();

    await pg.query(
      `INSERT INTO ${tablePrefix}api_tenants
        (name, email, api_key_hash, api_key_prefix, tier, max_users,
         max_embeddings_per_month, rate_limit_per_minute,
         email_verified, registration_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 'self_service')`,
      [body.name, body.email, hash, prefix, tier,
       defaults.maxUsers, defaults.maxEmbeddingsPerMonth, defaults.rateLimitPerMinute],
    );

    // Get the new tenant ID for token creation
    const tenant = await pg.queryOne<{ id: string }>(
      `SELECT id FROM ${tablePrefix}api_tenants WHERE api_key_hash = $1`,
      [hash],
    );

    if (tenant) {
      const token = await magicLink.createToken(tenant.id, 'verify_email', request.ip);
      await email.sendVerificationEmail(body.email, token, body.name);

      audit.log({
        tenantId: tenant.id,
        eventType: 'register',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { tier, name: body.name },
      });
    }

    // Key is NOT revealed here — only after email verification.
    // Return same shape as existing-account response to prevent email enumeration.
    return {
      success: true,
      data: { message: GENERIC_CHECK_EMAIL },
    };
  });

  // POST /auth/magic-link — request a magic link email
  //
  // Anti-enumeration: every branch returns the same generic message and all
  // DB / email work is deferred to a background task, so the response time
  // does not leak whether the email is registered.
  app.post('/magic-link', async (request: FastifyRequest, _reply) => {
    const body = magicLinkRequestSchema.parse(request.body);

    // Rate limit by email (hash-based, constant-cost regardless of existence).
    const rateLimited = await magicLink.checkEmailRateLimit(body.email);
    if (rateLimited) {
      return { success: true, data: { message: GENERIC_CHECK_EMAIL } };
    }

    const ip = request.ip;
    const userAgent = request.headers['user-agent'] ?? null;

    // Fire-and-forget: any lookup / token / send work runs after the response
    // is dispatched so legitimate and non-existent emails complete the
    // request in indistinguishable time.
    void (async () => {
      try {
        const tenant = await pg.queryOne<{ id: string; name: string; is_active: boolean }>(
          `SELECT id, name, is_active FROM ${tablePrefix}api_tenants WHERE email = $1`,
          [body.email],
        );
        if (!tenant || !tenant.is_active) return;

        const recent = await magicLink.getRecentCount(tenant.id, 60);
        if (recent >= 5) return;

        const token = await magicLink.createToken(tenant.id, 'login', ip);
        await email.sendMagicLinkEmail(body.email, token, tenant.name);

        audit.log({
          tenantId: tenant.id,
          eventType: 'login_request',
          ip,
          userAgent,
        });
      } catch (err) {
        app.log.error(err, 'magic-link background task failed');
      }
    })();

    return { success: true, data: { message: GENERIC_CHECK_EMAIL } };
  });

  // GET /auth/verify?token=... — browser flow (redirects)
  app.get('/verify', async (request: FastifyRequest, reply) => {
    const query = request.query as Record<string, string>;
    const parsed = verifyTokenSchema.safeParse({ token: query.token });

    if (!parsed.success) {
      return reply.redirect(`${baseUrl}/?error=invalid_token`);
    }

    const result = await magicLink.verifyToken(parsed.data.token);

    if (!result) {
      audit.log({
        tenantId: null,
        eventType: 'login_failed',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { reason: 'invalid_or_expired_token' },
      });
      return reply.redirect(`${baseUrl}/?error=invalid_token`);
    }

    if (result.purpose === 'verify_email') {
      // Mark email as verified
      await pg.query(
        `UPDATE ${tablePrefix}api_tenants
         SET email_verified = TRUE, email_verified_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [result.tenantId],
      );

      // Fetch the API key to reveal it (one-time display)
      const tenant = await pg.queryOne<{ api_key_hash: string; api_key_prefix: string }>(
        `SELECT api_key_hash, api_key_prefix FROM ${tablePrefix}api_tenants WHERE id = $1`,
        [result.tenantId],
      );

      audit.log({
        tenantId: result.tenantId,
        eventType: 'verify_email',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      // Redirect with prefix — the actual key was generated at registration.
      // For security we don't pass the full key in a URL. The POST flow returns it.
      return reply.redirect(`${baseUrl}/?verified=true&prefix=${encodeURIComponent(tenant?.api_key_prefix ?? '')}`);
    }

    // Login flow
    const tenant = await pg.queryOne<{ api_key_prefix: string; name: string; tier: string }>(
      `SELECT api_key_prefix, name, tier FROM ${tablePrefix}api_tenants WHERE id = $1`,
      [result.tenantId],
    );

    audit.log({
      tenantId: result.tenantId,
      eventType: 'login_success',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.redirect(`${baseUrl}/?login=true&prefix=${encodeURIComponent(tenant?.api_key_prefix ?? '')}`);
  });

  // POST /auth/verify — API flow (returns JSON)
  app.post('/verify', async (request: FastifyRequest, _reply) => {
    const body = verifyTokenSchema.parse(request.body);
    const result = await magicLink.verifyToken(body.token);

    if (!result) {
      audit.log({
        tenantId: null,
        eventType: 'login_failed',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { reason: 'invalid_or_expired_token' },
      });
      throw new UnauthorizedError('Invalid or expired token');
    }

    if (result.purpose === 'verify_email') {
      // Look up whether this tenant was self-service or admin-created. For
      // admin-created tenants the plaintext API key was already delivered
      // at creation time, so verification only flips the flag. For self-
      // service tenants the original plaintext was never revealed, so we
      // regenerate a fresh key and return it here.
      const existing = await pg.queryOne<{ registration_source: string; api_key_prefix: string }>(
        `SELECT registration_source, api_key_prefix FROM ${tablePrefix}api_tenants WHERE id = $1`,
        [result.tenantId],
      );
      const isAdminProvisioned = existing?.registration_source === 'admin';

      if (isAdminProvisioned) {
        await pg.query(
          `UPDATE ${tablePrefix}api_tenants
           SET email_verified = TRUE, email_verified_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [result.tenantId],
        );
        audit.log({
          tenantId: result.tenantId,
          eventType: 'verify_email',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { source: 'admin' },
        });
        return {
          success: true,
          data: {
            verified: true,
            // Admin already delivered the plaintext key; do not re-reveal.
            apiKeyPrefix: existing?.api_key_prefix,
          },
        };
      }

      // Self-service: regenerate and reveal.
      const { key, hash, prefix } = generateApiKey();
      await pg.query(
        `UPDATE ${tablePrefix}api_tenants
         SET email_verified = TRUE, email_verified_at = NOW(),
             api_key_hash = $1, api_key_prefix = $2, updated_at = NOW()
         WHERE id = $3`,
        [hash, prefix, result.tenantId],
      );

      audit.log({
        tenantId: result.tenantId,
        eventType: 'verify_email',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { source: 'self_service' },
      });

      return {
        success: true,
        data: { verified: true, apiKey: key, apiKeyPrefix: prefix },
      };
    }

    // Login flow
    const tenant = await pg.queryOne<{
      id: string; name: string; email: string; tier: string; api_key_prefix: string;
    }>(
      `SELECT id, name, email, tier, api_key_prefix FROM ${tablePrefix}api_tenants WHERE id = $1`,
      [result.tenantId],
    );

    audit.log({
      tenantId: result.tenantId,
      eventType: 'login_success',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return {
      success: true,
      data: {
        tenantId: tenant?.id,
        name: tenant?.name,
        email: tenant?.email,
        tier: tenant?.tier,
        apiKeyPrefix: tenant?.api_key_prefix,
      },
    };
  });
}
