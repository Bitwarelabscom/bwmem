// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { z } from 'zod';

// ---- Bounded free-form metadata ----
//
// Fastify caps the request body at 1 MB, but an open `z.record(z.unknown())`
// still permits deeply-nested objects that force JSON.stringify / audit
// serialization to do pathological work. Require each metadata object to
// be a flat-ish dictionary with a bounded number of keys and bounded
// serialized size.
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_SERIALIZED_BYTES = 8 * 1024;

export const boundedMetadataSchema = z
  .record(z.unknown())
  .refine(
    (obj) => Object.keys(obj).length <= MAX_METADATA_KEYS,
    { message: `metadata must have at most ${MAX_METADATA_KEYS} keys` },
  )
  .refine(
    (obj) => {
      try {
        return JSON.stringify(obj).length <= MAX_METADATA_SERIALIZED_BYTES;
      } catch {
        return false;
      }
    },
    { message: `metadata must serialize to ${MAX_METADATA_SERIALIZED_BYTES} bytes or fewer` },
  );

// ---- Sessions ----

export const createSessionSchema = z.object({
  userId: z.string().min(1).max(255),
  metadata: boundedMetadataSchema.optional(),
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
  userId: z.string().min(1).max(255),
  query: z.string().max(30_000).optional(),
  sessionId: z.string().uuid().optional(),
  maxFacts: z.coerce.number().int().positive().max(100).optional(),
  maxSimilarMessages: z.coerce.number().int().positive().max(50).optional(),
  maxEmotionalMoments: z.coerce.number().int().positive().max(50).optional(),
  similarityThreshold: z.coerce.number().min(0).max(1).optional(),
  timeoutMs: z.coerce.number().int().positive().max(30_000).optional(),
});

// ---- Search ----

export const searchQuerySchema = z.object({
  userId: z.string().min(1).max(255),
  query: z.string().min(1).max(5_000),
  type: z.enum(['messages', 'conversations']).default('messages'),
  limit: z.coerce.number().int().positive().max(50).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
});

// ---- Facts ----

export const factsParamsSchema = z.object({
  userId: z.string().min(1).max(255),
});

export const storeFactSchema = z.object({
  userId: z.string().min(1).max(255),
  category: z.string().min(1).max(100),
  key: z.string().min(1).max(255),
  value: z.string().min(1).max(10_000),
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
  query: z.string().min(1).max(1_000),
});

// ---- Emotions ----

export const emotionsParamsSchema = z.object({
  userId: z.string().min(1).max(255),
});

export const emotionsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// ---- Contradictions ----

export const contradictionsParamsSchema = z.object({
  userId: z.string().min(1).max(255),
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
  userId: z.string().min(1).max(255),
});

// ---- Auth (self-service) ----

export const registerSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  tier: z.literal('tester').default('tester'),
});

export const magicLinkRequestSchema = z.object({
  email: z.string().email().max(255),
});

export const verifyTokenSchema = z.object({
  token: z.string().min(30).max(200),
});

// ---- Account (self-service) ----

export const addIpAllowlistSchema = z.object({
  cidr: z.string().min(7).max(43).regex(
    /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-fA-F:]+\/\d{1,3}$/,
    'Must be valid CIDR notation (e.g., 192.168.1.0/24)',
  ),
  label: z.string().max(100).optional(),
});

export const removeIpAllowlistParamsSchema = z.object({
  id: z.string().uuid(),
});

export const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Admin ----

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  tier: z.enum(['tester', 'hobby', 'builder', 'enterprise']).default('tester'),
  // Emergency provisioning only — skips email verification. Audit-logged.
  skipVerification: z.boolean().optional(),
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

// ---- Inferred request/response types ----
//
// Expose `z.infer<>` for each schema so route handlers and API clients
// derive their types from the same source as validation — no drift between
// schema and type.

export type CreateSessionRequest = z.infer<typeof createSessionSchema>;
export type EndSessionParams = z.infer<typeof endSessionParamsSchema>;
export type SessionMessagesParams = z.infer<typeof sessionMessagesParamsSchema>;
export type RecordMessageRequest = z.infer<typeof recordMessageSchema>;
export type ContextQuery = z.infer<typeof contextQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type FactsParams = z.infer<typeof factsParamsSchema>;
export type StoreFactRequest = z.infer<typeof storeFactSchema>;
export type DeleteFactParams = z.infer<typeof deleteFactParamsSchema>;
export type DeleteFactBody = z.infer<typeof deleteFactBodySchema>;
export type SearchFactsQuery = z.infer<typeof searchFactsQuerySchema>;
export type EmotionsParams = z.infer<typeof emotionsParamsSchema>;
export type EmotionsQuery = z.infer<typeof emotionsQuerySchema>;
export type ContradictionsParams = z.infer<typeof contradictionsParamsSchema>;
export type ContradictionsQuery = z.infer<typeof contradictionsQuerySchema>;
export type ConsolidateRequest = z.infer<typeof consolidateSchema>;
export type SummaryParams = z.infer<typeof summaryParamsSchema>;
export type GraphParams = z.infer<typeof graphParamsSchema>;
export type RegisterRequest = z.infer<typeof registerSchema>;
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;
export type VerifyTokenRequest = z.infer<typeof verifyTokenSchema>;
export type AddIpAllowlistRequest = z.infer<typeof addIpAllowlistSchema>;
export type RemoveIpAllowlistParams = z.infer<typeof removeIpAllowlistParamsSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type CreateTenantRequest = z.infer<typeof createTenantSchema>;
export type UpdateTenantRequest = z.infer<typeof updateTenantSchema>;
export type TenantIdParams = z.infer<typeof tenantIdParamsSchema>;
export type BoundedMetadata = z.infer<typeof boundedMetadataSchema>;
