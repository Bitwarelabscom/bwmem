// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BwMem } from '../../bwmem.js';
import { consolidateSchema } from '../utils/schemas.js';
import { ForbiddenError } from '../utils/errors.js';

export async function consolidationRoutes(
  app: FastifyInstance,
  opts: { bwmem: BwMem },
): Promise<void> {
  const { bwmem } = opts;

  // POST /consolidate — trigger daily or weekly consolidation (admin-only #8)
  app.post('/consolidate', async (request: FastifyRequest, _reply) => {
    if (request.tenant?.id !== 'admin') {
      throw new ForbiddenError('Admin access required');
    }

    const body = consolidateSchema.parse(request.body);
    await bwmem.triggerConsolidation(body.type);

    return {
      success: true,
      data: { triggered: true, type: body.type },
    };
  });
}
