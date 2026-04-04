import { describe, it, expect } from 'vitest';
import {
  scopeUserId, unscopeUserId, isScopedToTenant, stripTenantFromResponse,
} from '../../../src/api/utils/tenant-scope.js';

describe('tenant-scope', () => {
  describe('scopeUserId', () => {
    it('produces t_{tenantId}:{userId} format', () => {
      expect(scopeUserId('abc', 'user_1')).toBe('t_abc:user_1');
    });

    it('handles UUIDs', () => {
      const tid = '550e8400-e29b-41d4-a716-446655440000';
      expect(scopeUserId(tid, 'u1')).toBe(`t_${tid}:u1`);
    });
  });

  describe('unscopeUserId', () => {
    it('strips tenant prefix', () => {
      expect(unscopeUserId('t_abc:user_1')).toBe('user_1');
    });

    it('returns input unchanged if no prefix', () => {
      expect(unscopeUserId('user_1')).toBe('user_1');
    });

    it('handles userId containing colons', () => {
      expect(unscopeUserId('t_abc:user:with:colons')).toBe('user:with:colons');
    });
  });

  describe('isScopedToTenant', () => {
    it('returns true for matching tenant', () => {
      expect(isScopedToTenant('t_abc:user_1', 'abc')).toBe(true);
    });

    it('returns false for different tenant', () => {
      expect(isScopedToTenant('t_abc:user_1', 'xyz')).toBe(false);
    });

    it('returns false for unscoped userId', () => {
      expect(isScopedToTenant('user_1', 'abc')).toBe(false);
    });
  });

  describe('stripTenantFromResponse', () => {
    it('strips userId fields from objects', () => {
      const input = { userId: 't_abc:user_1', name: 'test' };
      const output = stripTenantFromResponse(input);
      expect(output).toEqual({ userId: 'user_1', name: 'test' });
    });

    it('strips userId from arrays of objects', () => {
      const input = [
        { userId: 't_abc:u1', content: 'hi' },
        { userId: 't_abc:u2', content: 'bye' },
      ];
      const output = stripTenantFromResponse(input);
      expect(output[0].userId).toBe('u1');
      expect(output[1].userId).toBe('u2');
    });

    it('handles nested objects', () => {
      const input = { data: { userId: 't_abc:u1', nested: { userId: 't_abc:u2' } } };
      const output = stripTenantFromResponse(input);
      expect(output.data.userId).toBe('u1');
      expect(output.data.nested.userId).toBe('u2');
    });

    it('passes through nulls and primitives', () => {
      expect(stripTenantFromResponse(null)).toBeNull();
      expect(stripTenantFromResponse('hello')).toBe('hello');
      expect(stripTenantFromResponse(42)).toBe(42);
    });

    it('preserves Date objects', () => {
      const d = new Date();
      expect(stripTenantFromResponse(d)).toBe(d);
    });
  });
});
