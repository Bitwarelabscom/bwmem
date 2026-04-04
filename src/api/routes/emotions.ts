// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { emotionsParamsSchema, emotionsQuerySchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function emotionRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /emotions/:userId
  app.get('/emotions/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = emotionsParamsSchema.parse(request.params);
    const query = emotionsQuerySchema.parse(request.query);

    const emotions = await bwmem.emotions.getRecent(
      scopeUserId(tenant.id, userId), query.days, query.limit,
    );

    return { success: true, data: { emotions: stripTenantFromResponse(emotions) } };
  });
}
