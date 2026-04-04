import { describe, it, expect } from 'vitest';
import {
  ApiError, UnauthorizedError, ForbiddenError, NotFoundError,
  RateLimitError, QuotaExceededError, ValidationError,
} from '../../../src/api/utils/errors.js';

describe('API errors', () => {
  it('ApiError has statusCode and code', () => {
    const err = new ApiError(418, 'teapot', 'TEAPOT');
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('teapot');
    expect(err.code).toBe('TEAPOT');
    expect(err).toBeInstanceOf(Error);
  });

  it('UnauthorizedError is 401', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('ForbiddenError is 403', () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });

  it('NotFoundError is 404', () => {
    expect(new NotFoundError().statusCode).toBe(404);
  });

  it('RateLimitError is 429', () => {
    expect(new RateLimitError().statusCode).toBe(429);
  });

  it('QuotaExceededError is 429 with QUOTA_EXCEEDED code', () => {
    const err = new QuotaExceededError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('QUOTA_EXCEEDED');
  });

  it('ValidationError is 400', () => {
    const err = new ValidationError('bad input');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('bad input');
  });
});
