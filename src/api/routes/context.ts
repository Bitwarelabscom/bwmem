// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { contextQuerySchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function contextRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /context — build memory context for prompt injection
  app.get('/context', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const query = contextQuerySchema.parse(request.query);

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
