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

// Truncation (0.7.0). Exported from the root, not just the provider subpaths,
// because a consumer writing its own LLMProvider needs the same guard — a
// provider that returns truncated text silently reintroduces the bug for every
// caller in this package.
export { TruncatedCompletionError, assertComplete } from './providers/completion.js';

// Fact-key guards (0.5.0). isMergeableFactKey is the one the key-axis merge
// consults; the others are exported because a consumer classifying its own keys
// needs the same definitions the store uses.
export {
  isSetValuedFactKey, isMergeableFactKey, splitSetValue, mergeSetValue,
} from './memory/facts.service.js';

// Same-claim adjudication (0.5.0). One definition of "same claim" governs both
// the key axis and the value axis — two independent notions disagree, and the
// disagreement shows up as facts that merge but still contradict themselves.
export { FactMergeGate } from './memory/fact-merge-gate.service.js';
export type {
  MergeGateVerdict, MergeGateOutcome, MergeSeparation,
} from './memory/fact-merge-gate.service.js';
export { ParaphraseGate, shouldConsultGate, cosineSimilarity } from './memory/paraphrase-gate.service.js';
export type { ParaphraseVerdict, ParaphraseGatePath } from './memory/paraphrase-gate.service.js';
export { FactKeyMerge, rankMergeCandidates } from './memory/fact-key-merge.service.js';
export type { MergeCandidate, SameClaimMatch } from './memory/fact-key-merge.service.js';

// Timeline index (0.5.0). Ordering and elapsed-time questions are the one class
// semantic search structurally cannot serve — one query embedding cannot sit
// near three events at once.
export { TemporalEventsService } from './memory/temporal-events.service.js';
export type { TemporalEvent } from './memory/temporal-events.service.js';

// Cross-key collisions (0.6.0). Every other guard compares a new value against
// the old value of the SAME fact_key, so two rows under DIFFERENT keys can each
// be coherent, both be active, and flatly contradict one another unseen. The
// detection rules are exported as pure functions because that is how they are
// tested — and because a false alarm on this surface is expensive.
export {
  FactCollisionService, DEFAULT_EXCLUSIVE_FAMILIES,
  findCollisions, residueFor, categoriseKey, familyOfCategory,
  knownCategories, keyTokens, properNounsIn,
  describeCollision, describeDecision,
} from './memory/fact-collision.service.js';
export type {
  ExclusiveFamily, CategoryCollision, CollisionFact, ActiveFactRow,
  StoredCollision, DecisionResidue, SettleResult,
} from './memory/fact-collision.service.js';
