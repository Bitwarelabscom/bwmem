// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ManagedSession } from '../types.js';
import { recordMessageSchema } from '../utils/schemas.js';
import { stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

export async function messageRoutes(
  app: FastifyInstance,
  opts: { activeSessions: Map<string, ManagedSession> },
): Promise<void> {
  const { activeSessions } = opts;

  // POST /messages — record a message in a session
  // Each message triggers background embedding + sentiment + (every 3 msgs)
  // fact extraction + contradiction detection. Tighter per-route limit
  // keeps LLM cost predictable per tenant.
  app.post('/messages', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = recordMessageSchema.parse(request.body);

    const managed = activeSessions.get(body.sessionId);
    if (!managed) {
      throw new NotFoundError('Session not found or already ended');
    }
    if (managed.tenantId !== tenant.id) {
      throw new ForbiddenError();
    }
    managed.lastActivityAt = new Date();

    const message = await managed.session.recordMessage({
      role: body.role,
      content: body.content,
    });

    return {
      success: true,
      data: stripTenantFromResponse(message),
    };
  });
}
