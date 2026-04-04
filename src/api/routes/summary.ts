// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import type { PgClient } from '../../db/postgres.js';
import { summaryParamsSchema } from '../utils/schemas.js';
import { isScopedToTenant, stripTenantFromResponse } from '../utils/tenant-scope.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

export async function summaryRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem; pg: PgClient; tablePrefix: string },
): Promise<void> {
  const { bwmem, pg, tablePrefix } = opts;

  // GET /summary/:sessionId
  app.get('/summary/:sessionId', async (request: FastifyRequest, _reply) => {
    const tenant = request.tenant!;
    const { sessionId } = summaryParamsSchema.parse(request.params);

    // Verify session belongs to tenant
    const sessionRow = await pg.queryOne<{ user_id: string }>(
      `SELECT user_id FROM ${tablePrefix}sessions WHERE id = $1`,
      [sessionId],
    );
    if (!sessionRow) throw new NotFoundError('Session not found');
    if (!isScopedToTenant(sessionRow.user_id, tenant.id)) throw new ForbiddenError();

    const summary = await bwmem.summaries.getForSession(sessionId);
    return {
      success: true,
      data: { summary: summary ? stripTenantFromResponse(summary) : null },
    };
  });
}
