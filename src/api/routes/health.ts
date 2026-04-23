// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { RedisClient } from '../../db/redis.js';
import type { BwMem } from '../../bwmem.js';
import { ForbiddenError } from '../utils/errors.js';

export async function healthRoutes(
  app: FastifyInstance,
  opts: { pg: PgClient; redis: RedisClient; bwmem: BwMem },
): Promise<void> {
  // Public health check — minimal info to avoid leaking internals (#10)
  //
  // Response schema lets Fastify use fast-json-stringify for ~5× faster
  // serialization and strips any unexpected fields so the response shape
  // can't accidentally leak future additions.
  app.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
      },
    },
  }, async (_request, _reply) => {
    const [postgres, redis] = await Promise.all([
      opts.pg.healthCheck(),
      opts.redis.healthCheck(),
    ]);

    const status = postgres && redis ? 'ok' : 'degraded';

    return { status };
  });

  // Admin-only detailed health — includes background task error counters
  // so ops can detect silent degradation of fire-and-forget pipelines
  // (graph sync, fact extraction, behavioral contradiction detection).
  app.get('/health/detailed', async (request, _reply) => {
    if (!request.tenant?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }
    const [postgres, redis] = await Promise.all([
      opts.pg.healthCheck(),
      opts.redis.healthCheck(),
    ]);

    return {
      status: postgres && redis ? 'ok' : 'degraded',
      components: {
        postgres: postgres ? 'ok' : 'down',
        redis: redis ? 'ok' : 'down',
      },
      backgroundErrors: opts.bwmem.stats.snapshot(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  });
}
