// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import {
  contradictionsParamsSchema,
  contradictionsQuerySchema,
  contradictionIdParamsSchema,
  contradictionResolveSchema,
  contradictionHoldSchema,
} from '../utils/schemas.js';
import { scopeUserId, stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError } from '../utils/errors.js';

export async function contradictionRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // GET /contradictions/:userId — outstanding contradictions.
  app.get('/contradictions/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = contradictionsParamsSchema.parse(request.params);
    const query = contradictionsQuerySchema.parse(request.query);

    const contradictions = await bwmem.contradictions.getOpen(
      scopeUserId(tenant.id, userId), query.sessionId, query.limit,
    );

    return { success: true, data: { contradictions: stripTenantFromResponse(contradictions) } };
  });

  // GET /contradictions/:userId/counts — open / held / resolved.
  //
  // Worth having as its own endpoint: before 0.7.0 a caller counting "resolved"
  // got a structural zero, because nothing could produce a resolved row.
  app.get('/contradictions/:userId/counts', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = contradictionsParamsSchema.parse(request.params);

    const counts = await bwmem.contradictions.counts(scopeUserId(tenant.id, userId));

    return { success: true, data: counts };
  });

  // POST /contradictions/:userId/:id/resolve — close it with a decision.
  //
  // The decision is required by the schema, so this cannot be used as a mute.
  // To set something aside without deciding, use /hold, which is honest about
  // being temporary and lapses when the fact moves.
  app.post('/contradictions/:userId/:id/resolve', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId, id } = contradictionIdParamsSchema.parse(request.params);
    const body = contradictionResolveSchema.parse(request.body);

    const moved = await bwmem.contradictions.resolve(
      scopeUserId(tenant.id, userId), id, body.decision, body.note,
    );

    // Already resolved, or not this tenant's row. Both are "nothing to close".
    if (!moved) throw new NotFoundError('Contradiction not found or already resolved');

    return { success: true, data: { id, status: 'resolved', decision: body.decision } };
  });

  // POST /contradictions/:userId/:id/hold — set aside without deciding.
  app.post('/contradictions/:userId/:id/hold', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId, id } = contradictionIdParamsSchema.parse(request.params);
    const body = contradictionHoldSchema.parse(request.body ?? {});

    const moved = await bwmem.contradictions.hold(
      scopeUserId(tenant.id, userId), id, body.reason,
    );

    if (!moved) throw new NotFoundError('Contradiction not found or not open');

    return { success: true, data: { id, status: 'held' } };
  });
}
