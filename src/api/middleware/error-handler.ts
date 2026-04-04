// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors.js';

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Zod validation errors
  if (error instanceof ZodError) {
    const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    void reply.status(400).send({
      success: false,
      error: `Validation error: ${messages.join('; ')}`,
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  // Custom API errors
  if (error instanceof ApiError) {
    void reply.status(error.statusCode).send({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }

  // Fastify rate limit errors
  if ('statusCode' in error && (error as FastifyError).statusCode === 429) {
    void reply.status(429).send({
      success: false,
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
    });
    return;
  }

  // Unknown errors
  request.log.error(error, 'Unhandled error');
  void reply.status(500).send({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
