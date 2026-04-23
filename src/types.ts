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
  supersedesId?: string;
  overridePriority: number;
  mentionCount: number;
  lastMentioned?: Date;
  sourceSessionId?: string;
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

export interface ContradictionSignal {
  id: string;
  userId: string;
  sessionId?: string;
  factKey: string;
  userStated: string;
  storedValue: string;
  signalType: 'correction' | 'misremember';
  surfaced: boolean;
  surfacedSessionIds: string[];
  createdAt: Date;
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
  formatted: string;
  sourcesResponded: string;
}

export interface BuildContextOptions {
  query?: string;
  sessionId?: string;
  maxFacts?: number;
  maxSimilarMessages?: number;
  maxEmotionalMoments?: number;
  similarityThreshold?: number;
  timeoutMs?: number;
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
