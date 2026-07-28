// Main entry point for @bitwarelabs/bwmem
export { BwMem } from './bwmem.js';
export { BwMemStats } from './stats.js';

// Types
export type {
  // Config
  BwMemConfig,
  PostgresConfig,
  RedisConfig,
  ConsolidationConfig,
  SessionOptions,
  Logger,

  // Provider interfaces
  EmbeddingProvider,
  LLMProvider,
  ChatMessage,
  LLMOptions,

  // Graph plugin interface
  GraphPlugin,
  GraphPluginContext,
  EntityNode,
  GraphStats,

  // Facts
  Fact,
  StoreFact,
  ExtractedFact,
  FactCategory,
  FactStatus,
  FactType,
  SimilarFactMatch,

  // Sessions
  SessionConfig,
  Message,
  RecordMessageInput,

  // Emotional / Behavioral
  EmotionalMoment,
  ContradictionSignal,
  InlineContradiction,
  BehavioralObservation,
  SentimentResult,

  // Search
  SimilarMessage,
  SimilarConversation,

  // Consolidation
  EpisodicPattern,
  SemanticEntry,
  ConsolidationRun,

  // Context
  MemoryContext,
  BuildContextOptions,

  // Summaries
  ConversationSummary,

  // Quality scoring
  QualityScore,
  QualityStats,

  // Session texture + self-intention
  SessionTexture,
  SelfIntention,
  SelfIntentionStatus,
} from './types.js';

// Session class (for type usage)
export type { Session } from './session/session.js';

// Quality scorer input types
export type { ScoreResponseInput, ResolveFollowupInput } from './memory/quality-scorer.service.js';
export type { IntentionPromptOptions } from './memory/self-intention.service.js';

// Fact key guards (exposed so callers writing their own save paths can
// short-circuit volatile/structural keys the same way storeFact does).
export { isSpeakerFact, isEphemeralFactKey, isVolatileFactKey } from './memory/facts.service.js';

// Utilities
export { formatRelativeTime } from './utils/time-utils.js';
export { safeQuery } from './utils/safe-query.js';
