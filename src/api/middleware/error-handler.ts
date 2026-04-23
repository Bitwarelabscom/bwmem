// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ApiError, ErrorCodes } from '../utils/errors.js';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Zod validation errors — message describes which field failed validation.
  // Safe to return to the caller because Zod only reports the path and the
  // validator description, never the attacker-supplied value.
  if (error instanceof ZodError) {
    const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    void reply.status(400).send({
      success: false,
      error: `Validation error: ${messages.join('; ')}`,
      code: ErrorCodes.VALIDATION,
    });
    return;
  }

  // Custom API errors — message is explicitly safe for the caller.
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
      code: ErrorCodes.RATE_LIMIT,
    });
    return;
  }

  // Other Fastify framework errors (body parser, content-type, etc.).
  // Their `message` can echo request bytes (e.g., "Unexpected token … in
  // JSON at position …") — safe to return the message but the status code
  // is authoritative.
  const fastifyErr = error as FastifyError;
  if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    void reply.status(fastifyErr.statusCode).send({
      success: false,
      error: fastifyErr.message || 'Bad request',
      code: fastifyErr.code ?? ErrorCodes.BAD_REQUEST,
    });
    return;
  }

  // Unknown / 5xx — always opaque to the caller.
  // Full error + stack goes to the structured log with request context so
  // operators can correlate; only a generic code surfaces to the client.
  request.log.error(
    {
      err: error,
      reqId: request.id,
      method: request.method,
      url: request.url,
    },
    'Unhandled error',
  );
  void reply.status(500).send({
    success: false,
    error: 'Internal server error',
    // In non-production, surface the error message to aid local debugging.
    // Never surface stack traces or cause chains.
    ...(IS_PRODUCTION ? {} : { debug: error.message }),
    code: ErrorCodes.INTERNAL,
  });
}
