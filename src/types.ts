// ---- Provider Interfaces ----

export interface EmbeddingProvider {
  generate(text: string): Promise<number[]>;
  generateBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: LLMOptions): Promise<string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

// ---- Config ----

export interface BwMemConfig {
  postgres: string | PostgresConfig;
  redis: string | RedisConfig;
  embeddings: EmbeddingProvider;
  llm: LLMProvider;
  graph?: GraphPlugin;
  consolidation?: ConsolidationConfig;
  session?: SessionOptions;
  tablePrefix?: string;
  logger?: Logger;

  /**
   * Close the KEY axis of the duplicate-fact problem: when an extractor mints a
   * new fact_key for a claim already stored, adjudicate whether the two are the
   * same claim and merge instead of filing a parallel row. Costs an embed batch
   * plus up to three LLM calls on a write that creates a new key; fails open to
   * a plain insert on every failure mode. Default true.
   */
  factKeyMerge?: boolean;

  /**
   * Enable the synchronous inline contradiction scan. OFF by default: it is a
   * heuristic over capitalized words with no model behind it, and before the
   * proximity rule and cap it emitted 35 phantom contradictions on one message.
   */
  inlineContradictions?: boolean;

  /**
   * Extract a (subject, predicate, occurred_on) timeline at consolidation time,
   * so ordering and elapsed-time questions become a SORT rather than a vector
   * search. Costs one LLM call per consolidated session over the whole
   * transcript — far more token-hungry than per-message extraction, so it is
   * OFF by default and deserves its own budget. Measured +11.4pp on that
   * question class.
   */
  temporalIndex?: boolean;

  /**
   * Which category axes are mutually exclusive, for the cross-key collision
   * check. Defaults to DEFAULT_EXCLUSIVE_FAMILIES (cat vs dog), which is a
   * sensible demonstration and almost certainly not your domain.
   *
   * Keep any family you add NARROW. Members must be genuine alternatives: one
   * subject cannot be both without one of the rows being false. Categories that
   * merely differ ('pet' vs 'dog' — a dog IS a pet) produce a flag that is
   * wrong on every pass, and a surface that cries wolf is worse than no
   * surface.
   */
  exclusiveFamilies?: import('./memory/fact-collision.service.js').ExclusiveFamily[];
}

export interface PostgresConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean | object;
  max?: number;
}

export interface RedisConfig {
  host: string;
  port?: number;
  password?: string;
}

export interface ConsolidationConfig {
  enabled?: boolean;
  daily?: string;   // cron expression, default '0 2 * * *'
  weekly?: string;  // cron expression, default '0 3 * * 0'
}

export interface SessionOptions {
  inactivityTimeoutMs?: number;  // default 300000 (5 min)
}

/**
 * Optional context passed to every graph plugin method.
 *
 * Historically, bwmem scoped userIds as `t_{tenantId}:{userId}` strings so
 * multi-tenant graph stores could derive isolation boundaries from the
 * userId. That scheme still works, but it is fragile — a plugin had to
 * reverse-engineer the format. The explicit `tenantId` here lets a plugin
 * enforce isolation without string parsing. Implementations that do not
 * care about tenancy can ignore it.
 */
export interface GraphPluginContext {
  tenantId?: string;
}

export interface GraphPlugin {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  syncFact(userId: string, fact: Fact, ctx?: GraphPluginContext): Promise<void>;
  syncEntity(userId: string, entity: EntityNode, ctx?: GraphPluginContext): Promise<void>;
  getContext(userId: string, ctx?: GraphPluginContext): Promise<string | null>;
  getStats(userId: string, ctx?: GraphPluginContext): Promise<GraphStats | null>;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---- Facts ----

/** The well-known fact categories extracted by the built-in fact extractor. */
export type KnownFactCategory = 'personal' | 'work' | 'preference' | 'hobby'
  | 'relationship' | 'goal' | 'context';

/**
 * Fact category. Callers usually use one of the well-known values, but
 * storing a custom category string is allowed. The explicit union with
 * `string` keeps autocomplete for the canonical values while not blocking
 * extension — unlike the previous `(string & {})` hack which silently
 * accepted any string without signalling intent.
 */
export type FactCategory = KnownFactCategory | string;

export type FactStatus = 'active' | 'overridden' | 'superseded' | 'expired';
export type FactType = 'permanent' | 'default' | 'temporary';

export interface Fact {
  id: string;
  userId: string;
  category: FactCategory;
  factKey: string;
  factValue: string;
  confidence: number;
  factStatus: FactStatus;
  factType: FactType;
  validFrom?: Date;
  validUntil?: Date;
  /** Transaction-time start: when we first wrote this row. */
  recordedAt?: Date;
  /** Transaction-time end: when we stopped believing this row (NULL while believed). */
  supersededAt?: Date;
  supersedesId?: string;
  overridePriority: number;
  mentionCount: number;
  lastMentioned?: Date;
  sourceSessionId?: string;
  /** Optional scope: same fact key can hold different values across intents. */
  intentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreFact {
  userId: string;
  category: FactCategory;
  key: string;
  value: string;
  confidence?: number;
  factType?: FactType;
  validFrom?: Date;
  validUntil?: Date;
  sessionId?: string;
  /** Optional intent scope (see Fact.intentId). */
  intentId?: string | null;
  /** Set true to mark this as an explicit user correction (vs misremember). */
  isCorrection?: boolean;
}

/**
 * Result of {@link FactsService.findSimilarActiveFact}. Returned when an
 * embedding-based similarity scan finds an existing active fact with the same
 * meaning under a different key/wording — lets the caller collapse the new
 * write onto the existing row via {@link FactsService.touchFactMention}
 * instead of creating a near-duplicate.
 */
export interface SimilarFactMatch {
  id: string;
  category: string;
  factKey: string;
  factValue: string;
  score: number;
}

export interface ExtractedFact {
  category: FactCategory;
  factKey: string;
  factValue: string;
  confidence: number;
  factType: FactType;
  isCorrection: boolean;
}

// ---- Sessions ----

export interface SessionConfig {
  userId: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  embedding?: number[];
  sentimentValence?: number;
  sentimentArousal?: number;
  sentimentDominance?: number;
  createdAt: Date;
}

export interface RecordMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ---- Emotional / Behavioral ----

export interface EmotionalMoment {
  id: string;
  userId: string;
  sessionId: string;
  rawText: string;
  momentTag: string;
  valence: number;
  arousal: number;
  dominance: number;
  contextTopic?: string;
  createdAt: Date;
}

/**
 * Which value won, recorded when a contradiction is resolved. Required to
 * resolve: a close-out that carries only a free-text note is a mute, because
 * nothing downstream can read prose.
 *
 *   user_stated - what the user said now was right; the stored fact was wrong
 *   stored      - the stored fact was right; the user misspoke or misremembered
 *   neither     - both wrong, or the question dissolved
 */
export type ContradictionDecision = 'user_stated' | 'stored' | 'neither';

/**
 * Lifecycle state (0.7.0, migration 017).
 *
 *   open     - outstanding, nobody has decided
 *   held     - set aside without a decision; LAPSES when the underlying fact
 *              moves off the value the hold was taken against
 *   resolved - decided, with the decision recorded
 */
export type ContradictionStatus = 'open' | 'held' | 'resolved';

export interface ContradictionSignal {
  id: string;
  userId: string;
  sessionId?: string;
  factKey: string;
  userStated: string;
  storedValue: string;
  signalType: 'correction' | 'misremember';
  status: ContradictionStatus;
  decision: ContradictionDecision | null;
  resolution: string | null;
  resolvedAt: Date | null;
  heldAt: Date | null;
  holdReason: string | null;
  /**
   * DISPLAY bookkeeping: has this been shown to the user. Not a lifecycle
   * state — read `status` for that. Conflating the two is the bug 017 fixed.
   */
  surfaced: boolean;
  surfacedSessionIds: string[];
  createdAt: Date;
}

/**
 * Result of {@link ContradictionService.detectInline} — a real-time, zero-I/O
 * scan that fires when the current user message names a concept token for a
 * well-established fact but uses a different value than what's stored. Lighter
 * than `ContradictionSignal` because no DB row is written.
 */
export interface InlineContradiction {
  factKey: string;
  factCategory: string;
  storedValue: string;
  suspectedValue: string;
}

export interface BehavioralObservation {
  id: string;
  userId: string;
  observationType: string;
  observation: string;
  evidenceSummary: string;
  severity: number;
  windowStart: Date;
  windowEnd: Date;
  expired: boolean;
  createdAt: Date;
}

// ---- Semantic Search ----

export interface SimilarMessage {
  messageId: string;
  sessionId: string;
  content: string;
  role: string;
  similarity: number;
  createdAt: Date;
}

export interface SimilarConversation {
  sessionId: string;
  summary: string;
  topics: string[];
  similarity: number;
  createdAt: Date;
}

// ---- Consolidation ----

export interface EpisodicPattern {
  id: string;
  userId: string;
  sessionId?: string;
  consolidationRunId?: string;
  patternType: string;
  pattern: string;
  confidence: number;
  createdAt: Date;
}

export interface SemanticEntry {
  id: string;
  userId: string;
  entryType: string;
  theme: string;
  value: string;
  confidence: number;
  sourceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsolidationRun {
  id: string;
  runType: 'episodic' | 'daily' | 'weekly';
  userId?: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'failed';
  patternsExtracted: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

// ---- Context Builder ----

export interface MemoryContext {
  facts: Fact[];
  similarMessages: SimilarMessage[];
  similarConversations: SimilarConversation[];
  emotionalMoments: EmotionalMoment[];
  contradictions: ContradictionSignal[];
  behavioralObservations: BehavioralObservation[];
  conversationSummary?: string;
  episodicPatterns: EpisodicPattern[];
  semanticKnowledge: SemanticEntry[];
  graphContext?: string;
  /** Anchor block for the next session in the same (mode, speaker) pair. */
  sessionTexture?: string;
  /** Oldest open intention, gated to once a day in `options.timezone`. */
  intentionPrompt?: string;
  /**
   * `[Timeline]` block from the temporal index — dated events selected
   * semantically then sorted chronologically. Present only when the query looks
   * temporal, so absence is the normal case, not a failure.
   */
  timeline?: string;
  formatted: string;
  sourcesResponded: string;
}

export interface BuildContextOptions {
  query?: string;
  sessionId?: string;
  maxFacts?: number;
  /**
   * Recall depth for message search. Default **25**.
   *
   * This is the single highest-leverage retrieval parameter and the default is
   * measured, not guessed: on LongMemEval, k=8 scored 65.0% and k=25 scored
   * 78.3% with the same reader on the same corpus. Recall depth alone was worth
   * 13 points. It was 5 before 0.8.0, which is below even the losing arm of that
   * comparison.
   */
  maxSimilarMessages?: number;
  maxEmotionalMoments?: number;
  /**
   * Cosine floor for message search. Default **0.5**.
   *
   * Raised from 0.25 in 0.8.0 to match the benchmarked configuration. At k=25 a
   * loose floor spends the budget on weak matches; the floor is what makes depth
   * pay off rather than just adding noise.
   */
  similarityThreshold?: number;
  /**
   * Truncate each recalled message to this many characters. Default **0 = no
   * truncation**, which is the benchmarked setting.
   *
   * This used to be a hardcoded 300 with no way to turn it off. On the benchmark
   * corpus 58% of stored passages are longer than that, so the majority of what
   * retrieval found was being cut before the model saw it — and silently, since
   * the ellipsis looks like a summary rather than a loss. Set a value only if
   * you are under real prompt-budget pressure, and know it costs recall.
   */
  clipRecalledChars?: number;
  /**
   * Order recalled messages oldest-first rather than by similarity.
   * Default **true**.
   *
   * Similarity order scatters a conversation across the prompt. Chronological
   * order lets the reader do date arithmetic and see which of two values came
   * later, which is most of what temporal and knowledge-update questions ask.
   */
  chronologicalRecall?: boolean;
  /**
   * Include the `[Timeline]` block from the temporal index. Default **true**.
   *
   * Self-gating: emits nothing unless the query actually looks temporal, so it
   * costs one embedding call and a few hundred characters only on the questions
   * that need it. Requires `temporalIndex` to be enabled.
   */
  includeTimeline?: boolean;
  /**
   * Pull every message from the sessions the top hits landed in.
   * Default **false**, and the default is a measured result, not caution.
   *
   * The idea is sound — vector search returns isolated turns and a question like
   * "who graduated first" needs the conversation around each hit — but on
   * LongMemEval it LOST 6.6 points (78.3% -> 71.7%) while making the prompt 5.7x
   * larger and 5x more expensive. The extra turns crowd out the ranked evidence.
   * Exposed because it may still help on corpora with shorter sessions than the
   * benchmark's; measure before trusting it.
   */
  expandSessions?: number;
  timeoutMs?: number;
  /** Selector for the session-texture source (default: 'default' / 'user'). */
  mode?: string;
  speaker?: string;
  /** IANA timezone for the self-intention daily gate (default: UTC). */
  timezone?: string;
  /** Pass false to skip the bi-temporal "as of" sources (rarely needed). */
  includeSessionTexture?: boolean;
  includeIntentionPrompt?: boolean;
}

// ---- Graph ----

export interface EntityNode {
  label: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  topEntities: Array<{ label: string; type: string; connections: number }>;
}

// ---- Sentiment ----

export interface SentimentResult {
  valence: number;    // -1 to 1
  arousal: number;    // 0 to 1
  dominance: number;  // 0 to 1
}

// ---- Conversation Summary ----

export interface ConversationSummary {
  id: string;
  sessionId: string;
  userId: string;
  summary: string;
  topics: string[];
  keyPoints: string[];
  embedding?: number[];
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Quality Scoring ----

/**
 * Per-response quality record. Two honest numbers instead of one composite:
 *
 *  - `outputIntegrity` — the agent's own quality (relevance, coherence,
 *    memory_fidelity, generativity, completeness_honesty). Reply latency
 *    never touches this.
 *  - `interactionVitality` — engagement signal (mostly the user's): reply
 *    speed, reply length, feedback class. Real signal, but not a quality
 *    score the agent should self-criticize over.
 *
 * `compositeScore` is kept for back-compat and mirrors `outputIntegrity`.
 */
export interface QualityScore {
  messageId: string;
  userId: string;
  sessionId: string;
  mode?: string;
  scoredAt: Date;
  followupResolvedAt?: Date;
  scores: Record<string, unknown>;
  outputIntegrity?: number;
  interactionVitality?: number;
  compositeScore?: number;
  selfCheckAt?: Date;
  explicitFeedback?: string;
}

export interface QualityStats {
  total: number;
  averageOutputIntegrity: number | null;
  averageInteractionVitality: number | null;
  averageComposite: number | null;
  averageHedgingDensity: number | null;
  refusalRate: number;
  selfCheckedCount: number;
  feedbackBreakdown: Record<string, number>;
  recentLowQuality: Array<{
    messageId: string;
    sessionId: string;
    scoredAt: Date;
    outputIntegrity: number | null;
    explicitFeedback: string | null;
  }>;
}

// ---- Session Texture ----

export interface SessionTexture {
  id: string;
  userId: string;
  sessionId?: string;
  mode: string;
  speaker: string;
  throughline: string;
  emotionalRegister: string;
  createdAt: Date;
}

// ---- Self-Intention ----

export type SelfIntentionStatus = 'open' | 'done' | 'let_go';

export interface SelfIntention {
  id: string;
  userId: string;
  intention: string;
  note: string | null;
  status: SelfIntentionStatus;
  deferCount: number;
  firstSurfacedAt: Date | null;
  lastSurfacedAt: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
  createdAt: Date;
}
