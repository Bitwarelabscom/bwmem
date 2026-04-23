// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

/**
 * Canonical error codes surfaced to API callers. Kept in a single const
 * object so the error classes and the error-handler reference one source
 * of truth. Clients should switch on `code`, not on HTTP status, because
 * some codes (e.g., QUOTA_EXCEEDED vs RATE_LIMIT_EXCEEDED) share a status.
 */
export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  QUOTA: 'QUOTA_EXCEEDED',
  TOO_MANY: 'TOO_MANY_REQUESTS',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: ErrorCode | string = 'ERROR',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Invalid or missing API key') {
    super(401, message, ErrorCodes.UNAUTHORIZED);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Access denied') {
    super(403, message, ErrorCodes.FORBIDDEN);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(404, message, ErrorCodes.NOT_FOUND);
  }
}

export class RateLimitError extends ApiError {
  constructor(message = 'Rate limit exceeded') {
    super(429, message, ErrorCodes.RATE_LIMIT);
  }
}

export class QuotaExceededError extends ApiError {
  constructor(message = 'Monthly embedding quota exceeded') {
    super(429, message, ErrorCodes.QUOTA);
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(400, message, ErrorCodes.VALIDATION);
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Resource already exists') {
    super(409, message, ErrorCodes.CONFLICT);
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests, try again later') {
    super(429, message, ErrorCodes.TOO_MANY);
  }
}
