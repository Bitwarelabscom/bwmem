// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GraphPlugin } from '../../types.js';
import { graphParamsSchema } from '../utils/schemas.js';
import { scopeUserId } from '../utils/tenant-scope.js';
import { NotFoundError } from '../utils/errors.js';

export async function graphRoutes(
  app: FastifyInstance,
  opts: { graph?: GraphPlugin },
): Promise<void> {
  const { graph } = opts;

  // GET /graph/:userId
  app.get('/graph/:userId', async (request: FastifyRequest, _reply) => {
    if (!graph) {
      throw new NotFoundError('Knowledge graph is not configured');
    }

    const tenant = request.tenant!;
    const { userId } = graphParamsSchema.parse(request.params);
    const scopedUserId = scopeUserId(tenant.id, userId);

    const [context, stats] = await Promise.all([
      graph.getContext(scopedUserId),
      graph.getStats(scopedUserId),
    ]);

    return {
      success: true,
      data: { context, stats },
    };
  });
}
