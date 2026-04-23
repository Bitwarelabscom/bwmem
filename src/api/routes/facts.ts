// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import type { PgClient } from '../../db/postgres.js';
import {
  factsParamsSchema, storeFactSchema, deleteFactParamsSchema,
  deleteFactBodySchema, searchFactsQuerySchema,
} from '../utils/schemas.js';
import { scopeUserId, isScopedToTenant, stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

export async function factRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem; pg: PgClient; tablePrefix: string },
): Promise<void> {
  const { bwmem, pg, tablePrefix } = opts;

  // GET /facts/:userId
  app.get('/facts/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = factsParamsSchema.parse(request.params);
    const facts = await bwmem.facts.get(scopeUserId(tenant.id, userId));
    return { success: true, data: { facts: stripTenantFromResponse(facts) } };
  });

  // POST /facts
  app.post('/facts', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const body = storeFactSchema.parse(request.body);
    const fact = await bwmem.facts.store({
      userId: scopeUserId(tenant.id, body.userId),
      category: body.category,
      key: body.key,
      value: body.value,
      confidence: body.confidence,
      factType: body.factType,
      validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
      validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
      sessionId: body.sessionId,
    });
    return { success: true, data: { fact: stripTenantFromResponse(fact) } };
  });

  // DELETE /facts/:factId
  app.delete('/facts/:factId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { factId } = deleteFactParamsSchema.parse(request.params);
    const body = deleteFactBodySchema.parse(request.body);

    // Verify fact belongs to this tenant
    const row = await pg.queryOne<{ user_id: string }>(
      `SELECT user_id FROM ${tablePrefix}facts WHERE id = $1`,
      [factId],
    );
    if (!row) throw new NotFoundError('Fact not found');
    if (!isScopedToTenant(row.user_id, tenant.id)) throw new ForbiddenError();

    await bwmem.facts.remove(factId, body?.reason);
    return { success: true, data: { deleted: true } };
  });

  // GET /facts/:userId/search
  // Per-route rate limit: fact search runs an ILIKE query across the facts
  // table, cheaper than vector search but still worth capping per tenant.
  app.get('/facts/:userId/search', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = factsParamsSchema.parse(request.params);
    const { query } = searchFactsQuerySchema.parse(request.query);
    const facts = await bwmem.facts.search(scopeUserId(tenant.id, userId), query);
    return { success: true, data: { facts: stripTenantFromResponse(facts) } };
  });
}
