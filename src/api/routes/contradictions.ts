// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { contradictionsParamsSchema, contradictionsQuerySchema } from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';

export async function contradictionRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /contradictions/:userId
  app.get('/contradictions/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = contradictionsParamsSchema.parse(request.params);
    const query = contradictionsQuerySchema.parse(request.query);

    const contradictions = await bwmem.contradictions.getUnsurfaced(
      scopeUserId(tenant.id, userId), query.sessionId, query.limit,
    );

    return { success: true, data: { contradictions: stripTenantFromResponse(contradictions) } };
  });
}
