// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import type { ManagedSession } from '../types.js';
import { contextQuerySchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function contextRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem; activeSessions: Map<string, ManagedSession> },
): Promise<void> {
  const { bwmem, activeSessions } = opts;

  // GET /context — build memory context for prompt injection
  //
  // Expensive endpoint: triggers up to 9 parallel queries including vector
  // search and graph lookups. A tighter per-route rate limit prevents a
  // single tenant from saturating the embedding / pgvector workload.
  app.get('/context', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const query = contextQuerySchema.parse(request.query);

    // Touch the owning managed session (if any) so the inactivity sweep
    // doesn't evict an actively-used session.
    if (query.sessionId) {
      const managed = activeSessions.get(query.sessionId);
      if (managed && managed.tenantId === tenant.id) {
        managed.lastActivityAt = new Date();
      }
    }

    const scopedUserId = scopeUserId(tenant.id, query.userId);
    const context = await bwmem.buildContext(scopedUserId, {
      query: query.query,
      sessionId: query.sessionId,
      maxFacts: query.maxFacts,
      maxSimilarMessages: query.maxSimilarMessages,
      maxEmotionalMoments: query.maxEmotionalMoments,
      similarityThreshold: query.similarityThreshold,
      timeoutMs: query.timeoutMs,
    });

    return {
      success: true,
      data: stripTenantFromResponse(context),
    };
  });
}
