// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import type { PgClient } from '../../db/postgres.js';
import {
  factsParamsSchema, factsQuerySchema, storeFactSchema,
  deleteFactParamsSchema, deleteFactBodySchema, searchFactsQuerySchema,
} from '../utils/schemas.js';
import { scopeUserId, isScopedToTenant, stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

export async function factRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem; pg: PgClient; tablePrefix: string },
): Promise<void> {
  const { bwmem, pg, tablePrefix } = opts;

  // GET /facts/:userId
  // Returns current beliefs by default. Set asOfTxnTime / asOfValidTime
  // (ISO-8601) to ask the bi-temporal question instead:
  //   asOfTxnTime  → "what did we believe at time T?"
  //   asOfValidTime → "what was true at time T?"
  //   both → "what did we believe at T1 about state at T2?"
  app.get('/facts/:userId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { userId } = factsParamsSchema.parse(request.params);
    const q = factsQuerySchema.parse(request.query ?? {});

    const scopedUserId = scopeUserId(tenant.id, userId);
    const facts = (q.asOfTxnTime || q.asOfValidTime)
      ? await bwmem.facts.getAsOf(
          scopedUserId,
          q.asOfValidTime ? new Date(q.asOfValidTime) : undefined,
          q.asOfTxnTime ? new Date(q.asOfTxnTime) : undefined,
          { category: q.category, limit: q.limit },
        )
      : await bwmem.facts.get(scopedUserId, {
          category: q.category,
          limit: q.limit,
          intentId: q.intentId ?? null,
        });
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
      intentId: body.intentId ?? null,
      isCorrection: body.isCorrection,
    });
    // fact may be null if the key was dropped by a structural guard
    // (speaker/ephemeral). Surface that as 200 with `dropped: true` rather
    // than 500, since the caller's intent was honored (don't store it).
    if (!fact) {
      return { success: true, data: { fact: null, dropped: true } };
    }
    return { success: true, data: { fact: stripTenantFromResponse(fact) } };
  });

  // DELETE /facts/:factId
  app.delete('/facts/:factId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { factId } = deleteFactParamsSchema.parse(request.params);
    const body = deleteFactBodySchema.parse(request.body);

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
