// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance } from 'fastify';
import type { PgClient } from '../../db/postgres.js';
import type { RedisClient } from '../../db/redis.js';

export async function healthRoutes(
  app: FastifyInstance,
  opts: { pg: PgClient; redis: RedisClient },
): Promise<void> {
  // Public health check — minimal info to avoid leaking internals (#10)
  app.get('/health', async (_request, _reply) => {
    const [postgres, redis] = await Promise.all([
      opts.pg.healthCheck(),
      opts.redis.healthCheck(),
    ]);

    const status = postgres && redis ? 'ok' : 'degraded';

    return { status };
  });
}
