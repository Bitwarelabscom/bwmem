// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
}

export const tenantStore = new AsyncLocalStorage<TenantContext>();

const PREFIX = 't_';
const SEP = ':';

/** Scope a userId to a tenant: t_{tenantId}:{userId} */
export function scopeUserId(tenantId: string, userId: string): string {
  return `${PREFIX}${tenantId}${SEP}${userId}`;
}

/** Strip tenant prefix from a scoped userId, returning the original. */
export function unscopeUserId(scopedId: string): string {
  const sepIndex = scopedId.indexOf(SEP);
  if (sepIndex === -1 || !scopedId.startsWith(PREFIX)) return scopedId;
  return scopedId.slice(sepIndex + 1);
}

/** Check if a scoped userId belongs to the given tenant. */
export function isScopedToTenant(scopedUserId: string, tenantId: string): boolean {
  return scopedUserId.startsWith(`${PREFIX}${tenantId}${SEP}`);
}

/** Escape LIKE/ILIKE metacharacters to prevent pattern injection (#11) */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/**
 * Recursively strip tenant prefixes from userId fields in API response objects.
 * Handles objects, arrays, and nested structures.
 */
export function stripTenantFromResponse<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripTenantFromResponse) as T;
  if (obj instanceof Date) return obj;
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'userId' && typeof value === 'string') {
        result[key] = unscopeUserId(value);
      } else {
        result[key] = stripTenantFromResponse(value);
      }
    }
    return result as T;
  }
  return obj;
}
