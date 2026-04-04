// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { z } from 'zod';

// ---- Sessions ----

export const createSessionSchema = z.object({
  userId: z.string().min(1).max(255),
  metadata: z.record(z.unknown()).optional(),
});

export const endSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

export const sessionMessagesParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

// ---- Messages ----

export const recordMessageSchema = z.object({
  sessionId: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(100_000),
});

// ---- Context ----

export const contextQuerySchema = z.object({
  userId: z.string().min(1),
  query: z.string().optional(),
  sessionId: z.string().uuid().optional(),
  maxFacts: z.coerce.number().int().positive().max(100).optional(),
  maxSimilarMessages: z.coerce.number().int().positive().max(50).optional(),
  maxEmotionalMoments: z.coerce.number().int().positive().max(50).optional(),
  similarityThreshold: z.coerce.number().min(0).max(1).optional(),
  timeoutMs: z.coerce.number().int().positive().max(30_000).optional(),
});

// ---- Search ----

export const searchQuerySchema = z.object({
  userId: z.string().min(1),
  query: z.string().min(1),
  type: z.enum(['messages', 'conversations']).default('messages'),
  limit: z.coerce.number().int().positive().max(50).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
});

// ---- Facts ----

export const factsParamsSchema = z.object({
  userId: z.string().min(1),
});

export const storeFactSchema = z.object({
  userId: z.string().min(1).max(255),
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  factType: z.enum(['permanent', 'default', 'temporary']).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  sessionId: z.string().uuid().optional(),
});

export const deleteFactParamsSchema = z.object({
  factId: z.string().uuid(),
});

export const deleteFactBodySchema = z.object({
  reason: z.string().optional(),
}).optional();

export const searchFactsQuerySchema = z.object({
  query: z.string().min(1),
});

// ---- Emotions ----

export const emotionsParamsSchema = z.object({
  userId: z.string().min(1),
});

export const emotionsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// ---- Contradictions ----

export const contradictionsParamsSchema = z.object({
  userId: z.string().min(1),
});

export const contradictionsQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

// ---- Consolidation ----

export const consolidateSchema = z.object({
  type: z.enum(['daily', 'weekly']),
});

// ---- Summary ----

export const summaryParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

// ---- Graph ----

export const graphParamsSchema = z.object({
  userId: z.string().min(1),
});

// ---- Admin ----

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  tier: z.enum(['tester', 'hobby', 'builder', 'enterprise']).default('tester'),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  tier: z.enum(['tester', 'hobby', 'builder', 'enterprise']).optional(),
  maxUsers: z.number().int().positive().optional(),
  maxEmbeddingsPerMonth: z.number().int().positive().optional(),
  rateLimitPerMinute: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export const tenantIdParamsSchema = z.object({
  id: z.string().uuid(),
});
