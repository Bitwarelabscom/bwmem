// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyInstance } from 'fastify';
import type { RedisClient } from '../../db/redis.js';

export async function registerRateLimiter(app: FastifyInstance, redis: RedisClient): Promise<void> {
  await app.register(import('@fastify/rate-limit'), {
    global: true,
    // Run in preHandler so request.tenant is already set by auth hook
    hook: 'preHandler',
    max: (request) => {
      return request.tenant?.rateLimitPerMinute ?? 10;
    },
    timeWindow: 60_000,
    keyGenerator: (request) => {
      return request.tenant?.id ?? request.ip;
    },
    redis: redis.client,
    skipOnError: false,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
}
