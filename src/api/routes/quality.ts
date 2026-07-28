// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import {
  qualityScoreSchema, qualityFollowupSchema,
  qualityStatsParamsSchema, qualityStatsQuerySchema,
} from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function qualityRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // POST /quality/score — phase 1 (deterministic floor at message save)
  app.post('/quality/score', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = qualityScoreSchema.parse(request.body);
    await bwmem.quality.scoreResponse({
      messageId: body.messageId,
      userId: scopeUserId(tenant.id, body.userId),
      sessionId: body.sessionId,
      mode: body.mode,
      responseContent: body.responseContent,
    });
    return { success: true, data: { scored: true } };
  });

  // POST /quality/followup — phase 2 (interaction vitality at user reply)
  app.post('/quality/followup', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = qualityFollowupSchema.parse(request.body);
    await bwmem.quality.resolveFollowup({
      userId: scopeUserId(tenant.id, body.userId),
      sessionId: body.sessionId,
      previousAssistantMessageId: body.previousAssistantMessageId,
      previousAssistantCreatedAt: new Date(body.previousAssistantCreatedAt),
      nextUserContent: body.nextUserContent,
      nextUserCreatedAt: new Date(body.nextUserCreatedAt),
    });
    return { success: true, data: { resolved: true } };
  });

  // GET /quality/:userId/stats — aggregate view
  app.get('/quality/:userId/stats', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = qualityStatsParamsSchema.parse(request.params);
    const q = qualityStatsQuerySchema.parse(request.query ?? {});
    const stats = await bwmem.quality.getStats(scopeUserId(tenant.id, userId), {
      since: q.since ? new Date(q.since) : undefined,
      mode: q.mode,
      limit: q.limit,
    });
    return { success: true, data: { stats: stripTenantFromResponse(stats) } };
  });
}
