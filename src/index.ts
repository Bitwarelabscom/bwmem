// Main entry point for @bitwarelabs/bwmem
export { BwMem } from './bwmem.js';

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
  EntityNode,
  GraphStats,

  // Facts
  Fact,
  StoreFact,
  ExtractedFact,
  FactCategory,
  FactStatus,
  FactType,

  // Sessions
  SessionConfig,
  Message,
  RecordMessageInput,

  // Emotional / Behavioral
  EmotionalMoment,
  ContradictionSignal,
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
} from './types.js';

// Session class (for type usage)
export type { Session } from './session/session.js';

// Utilities
export { formatRelativeTime } from './utils/time-utils.js';
export { safeQuery } from './utils/safe-query.js';
