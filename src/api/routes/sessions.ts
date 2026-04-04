// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import type { PgClient } from '../../db/postgres.js';
import type { ManagedSession } from '../types.js';
import { createSessionSchema, endSessionParamsSchema, sessionMessagesParamsSchema } from '../utils/schemas.js';
import { scopeUserId, unscopeUserId, isScopedToTenant, stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';

const MAX_SESSIONS_PER_TENANT = 100; // Prevent memory exhaustion (#5)

export async function sessionRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem; pg: PgClient; activeSessions: Map<string, ManagedSession>; tablePrefix: string },
): Promise<void> {
  const { bwmem, pg, activeSessions, tablePrefix } = opts;

  // POST /sessions — start a new session
  app.post('/sessions', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = createSessionSchema.parse(request.body);

    // Enforce per-tenant session cap (#5)
    const tenantSessionCount = [...activeSessions.values()]
      .filter(s => s.tenantId === tenant.id).length;
    if (tenantSessionCount >= MAX_SESSIONS_PER_TENANT) {
      throw new ValidationError('Maximum concurrent sessions reached');
    }

    // Check user count limit — use exact prefix match, not LIKE (#11)
    const scopedId = scopeUserId(tenant.id, body.userId);
    const tenantPrefix = `t_${tenant.id}:`;
    const userCountResult = await pg.queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT user_id) AS count FROM ${tablePrefix}sessions
       WHERE user_id >= $1 AND user_id < $2`,
      [tenantPrefix, tenantPrefix.slice(0, -1) + String.fromCharCode(tenantPrefix.charCodeAt(tenantPrefix.length - 1) + 1)],
    );
    const currentUsers = parseInt(userCountResult?.count ?? '0', 10);

    // Check if this is a new user
    const existingUser = await pg.queryOne<{ user_id: string }>(
      `SELECT user_id FROM ${tablePrefix}sessions WHERE user_id = $1 LIMIT 1`,
      [scopedId],
    );

    if (!existingUser && currentUsers >= tenant.maxUsers) {
      throw new ValidationError('User limit reached for your plan'); // Generic message (#17)
    }

    const session = await bwmem.startSession({ userId: scopedId, metadata: body.metadata });

    activeSessions.set(session.id, {
      session,
      tenantId: tenant.id,
      userId: body.userId,
      createdAt: new Date(),
    });

    return {
      success: true,
      data: {
        sessionId: session.id,
        userId: body.userId,
        createdAt: new Date().toISOString(),
      },
    };
  });

  // POST /sessions/:sessionId/end
  app.post('/sessions/:sessionId/end', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { sessionId } = endSessionParamsSchema.parse(request.params);

    const managed = activeSessions.get(sessionId);
    if (!managed) {
      throw new NotFoundError('Session not found or already ended');
    }
    if (managed.tenantId !== tenant.id) {
      throw new ForbiddenError();
    }

    await managed.session.end();
    activeSessions.delete(sessionId);

    return { success: true, data: { ended: true, sessionId } };
  });

  // GET /sessions/:sessionId/messages
  app.get('/sessions/:sessionId/messages', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { sessionId } = sessionMessagesParamsSchema.parse(request.params);

    // Try active session first
    const managed = activeSessions.get(sessionId);
    if (managed) {
      if (managed.tenantId !== tenant.id) throw new ForbiddenError();
      const messages = await managed.session.getMessages();
      return { success: true, data: { messages: stripTenantFromResponse(messages) } };
    }

    // Fall back to DB for ended sessions
    const sessionRow = await pg.queryOne<{ user_id: string }>(
      `SELECT user_id FROM ${tablePrefix}sessions WHERE id = $1`,
      [sessionId],
    );

    if (!sessionRow || !isScopedToTenant(sessionRow.user_id, tenant.id)) {
      throw new NotFoundError('Session not found');
    }

    const messages = await pg.query<{
      id: string; session_id: string; user_id: string; role: string;
      content: string; sentiment_valence: number | null;
      sentiment_arousal: number | null; sentiment_dominance: number | null;
      created_at: Date;
    }>(
      `SELECT id, session_id, user_id, role, content,
              sentiment_valence, sentiment_arousal, sentiment_dominance, created_at
       FROM ${tablePrefix}messages WHERE session_id = $1 ORDER BY created_at`,
      [sessionId],
    );

    const formatted = messages.map(m => ({
      id: m.id,
      sessionId: m.session_id,
      userId: unscopeUserId(m.user_id),
      role: m.role,
      content: m.content,
      sentimentValence: m.sentiment_valence,
      sentimentArousal: m.sentiment_arousal,
      sentimentDominance: m.sentiment_dominance,
      createdAt: m.created_at,
    }));

    return { success: true, data: { messages: formatted } };
  });
}
