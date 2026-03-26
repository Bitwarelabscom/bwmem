import { describe, it, expect } from 'vitest';
import { safeQuery } from '../../src/utils/safe-query.js';
import { mockLogger } from '../fixtures/mock-providers.js';

describe('safeQuery', () => {
  it('returns the value on success', async () => {
    const result = await safeQuery('test', Promise.resolve(42), 0, 5000, mockLogger);
    expect(result).toEqual({ value: 42, ok: true });
  });

  it('returns fallback on error', async () => {
    const result = await safeQuery('test', Promise.reject(new Error('fail')), 'fallback', 5000, mockLogger);
    expect(result).toEqual({ value: 'fallback', ok: false });
  });

  it('returns fallback on timeout', async () => {
    const slow = new Promise<string>(resolve => setTimeout(() => resolve('too late'), 500));
    const result = await safeQuery('test', slow, 'timed out', 50, mockLogger);
    expect(result).toEqual({ value: 'timed out', ok: false });
  });

  it('returns fallback with null value', async () => {
    const result = await safeQuery('test', Promise.reject(new Error('fail')), null, 5000);
    expect(result).toEqual({ value: null, ok: false });
  });

  it('returns arrays as fallback', async () => {
    const result = await safeQuery('test', Promise.reject(new Error('fail')), [], 5000);
    expect(result).toEqual({ value: [], ok: false });
  });
});
