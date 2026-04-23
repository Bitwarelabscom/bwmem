// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { searchQuerySchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function searchRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /search — semantic search across messages or conversations
  //
  // Expensive endpoint: every call issues an embedding request followed by a
  // pgvector similarity scan. A per-route rate limit keeps LLM costs and
  // DB load predictable even under a compromised key.
  app.get('/search', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const query = searchQuerySchema.parse(request.query);

    const scopedUserId = scopeUserId(tenant.id, query.userId);

    if (query.type === 'conversations') {
      const results = await bwmem.searchConversations(
        scopedUserId, query.query, query.limit, query.threshold,
      );
      return {
        success: true,
        data: { type: 'conversations', results: stripTenantFromResponse(results) },
      };
    }

    const results = await bwmem.searchMessages(
      scopedUserId, query.query, query.limit, query.threshold,
    );
    return {
      success: true,
      data: { type: 'messages', results: stripTenantFromResponse(results) },
    };
  });
}
