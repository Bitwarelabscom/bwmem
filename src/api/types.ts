// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { Session } from '../session/session.js';

// ---- Tenant ----

export interface ApiTenant {
  id: string;
  isAdmin?: boolean;
  name: string;
  email: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  tier: TenantTier;
  maxUsers: number;
  maxEmbeddingsPerMonth: number;
  rateLimitPerMinute: number;
  isActive: boolean;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  registrationSource: 'admin' | 'self_service';
  prevApiKeyHash: string | null;
  prevKeyExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TenantTier = 'tester' | 'hobby' | 'builder' | 'enterprise';

export const TIER_DEFAULTS: Record<TenantTier, { maxUsers: number; maxEmbeddingsPerMonth: number; rateLimitPerMinute: number }> = {
  tester:     { maxUsers: 1,  maxEmbeddingsPerMonth: 1_500,   rateLimitPerMinute: 10 },
  hobby:      { maxUsers: 1,  maxEmbeddingsPerMonth: 30_000,  rateLimitPerMinute: 30 },
  builder:    { maxUsers: 10, maxEmbeddingsPerMonth: 300_000, rateLimitPerMinute: 60 },
  enterprise: { maxUsers: 999_999, maxEmbeddingsPerMonth: 999_999_999, rateLimitPerMinute: 600 },
};

// ---- Session tracking ----

export interface ManagedSession {
  session: Session;
  tenantId: string;
  userId: string; // original (unscoped) userId
  createdAt: Date;
  lastActivityAt: Date;
}

// ---- Request decoration ----

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: ApiTenant;
  }
}

// ---- API response envelope ----

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;
