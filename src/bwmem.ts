import type {
  BwMemConfig,
  BuildContextOptions,
  ContradictionSignal,
  ConversationSummary,
  EmotionalMoment,
  BehavioralObservation,
  Fact,
  MemoryContext,
  QualityStats,
  SelfIntention,
  SelfIntentionStatus,
  SessionConfig,
  SessionTexture,
  SimilarFactMatch,
  StoreFact,
} from './types.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { PgClient } from './db/postgres.js';
import { RedisClient } from './db/redis.js';
import { Migrator } from './db/migrator.js';
import { FactsService } from './memory/facts.service.js';
import { EmbeddingService } from './memory/embedding.service.js';
import { SentimentService } from './memory/sentiment.service.js';
import { CentroidService } from './memory/centroid.service.js';
import { EmotionalMomentsService } from './memory/emotional-moments.service.js';
import { TemporalEventsService } from './memory/temporal-events.service.js';
import { FactCollisionService } from './memory/fact-collision.service.js';
import type {
  StoredCollision, DecisionResidue, SettleResult,
} from './memory/fact-collision.service.js';
import { FactMergeGate } from './memory/fact-merge-gate.service.js';
import { FactKeyMerge } from './memory/fact-key-merge.service.js';
import { ParaphraseGate } from './memory/paraphrase-gate.service.js';
import { ContradictionService } from './memory/contradiction.service.js';
import { BehavioralService } from './memory/behavioral.service.js';
import { SummariesService } from './memory/summaries.service.js';
import { ContextBuilder } from './memory/context-builder.js';
import { QualityScorerService, type ScoreResponseInput, type ResolveFollowupInput } from './memory/quality-scorer.service.js';
import { SessionTextureService } from './memory/session-texture.service.js';
import { SelfIntentionService, type IntentionPromptOptions } from './memory/self-intention.service.js';
import { SessionManager } from './session/session-manager.js';
import { ConsolidationScheduler } from './consolidation/scheduler.js';
import type { Session } from './session/session.js';
import { BwMemStats, globalStats } from './stats.js';

interface Services {
  pg: PgClient;
  redis: RedisClient;
  facts: FactsService;
  embedding: EmbeddingService;
  sentiment: SentimentService;
  centroid: CentroidService;
  emotionalMoments: EmotionalMomentsService;
  contradictions: ContradictionService;
  behavioral: BehavioralService;
  summaries: SummariesService;
  temporalEvents: TemporalEventsService;
  factCollisions: FactCollisionService;
  qualityScorer: QualityScorerService;
  sessionTexture: SessionTextureService;
  selfIntention: SelfIntentionService;
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
  scheduler: ConsolidationScheduler | null;
}

export class BwMem {
  private config: ResolvedConfig;
  private services: Services | null = null;

  readonly stats: BwMemStats = globalStats;

  constructor(config: BwMemConfig) {
    this.config = resolveConfig(config);
  }

  /** Initialize DB connections, run migrations, and wire up services. */
  async initialize(): Promise<void> {
    if (this.services) return;

    const { logger } = this.config;
    logger.info('Initializing bwmem...');

    const pg = new PgClient(this.config.postgres, logger);
    const redis = new RedisClient(this.config.redis, logger);

    const dimensions = this.config.embeddings.dimensions;
    const migrator = new Migrator(pg, this.config.tablePrefix, dimensions, logger);
    await migrator.run();

    if (this.config.graph) {
      await this.config.graph.initialize();
      logger.info('Graph plugin initialized');
    }

    const prefix = this.config.tablePrefix;

    const embedding = new EmbeddingService(pg, this.config.embeddings, prefix, logger);
    const sentiment = new SentimentService(this.config.llm, logger);
    const centroid = new CentroidService(redis, logger);
    // The DeMem gate is shared: one definition of "same claim" must govern both
    // the key axis (fact-key merge) and the value axis (contradiction signals).
    // Two independent notions of sameness disagree, and the disagreement shows
    // up as facts that merge but still file a contradiction against themselves.
    const mergeGate = new FactMergeGate(this.config.llm, logger);
    const keyMerge = new FactKeyMerge(
      pg, prefix, this.config.embeddings, mergeGate, logger,
      this.config.factKeyMerge,
    );

    const facts = new FactsService(
      pg, this.config.llm, this.config.graph ?? null,
      prefix, logger, this.config.embeddings, keyMerge,
    );
    const temporalEvents = new TemporalEventsService(
      pg, prefix, this.config.llm, this.config.embeddings, logger,
      this.config.temporalIndex,
    );
    const emotionalMoments = new EmotionalMomentsService(pg, this.config.llm, prefix, logger);
    const contradictions = new ContradictionService(
      pg, prefix, logger, this.config.inlineContradictions,
      new ParaphraseGate(this.config.embeddings, mergeGate, logger),
    );
    const behavioral = new BehavioralService(pg, prefix, logger);
    const factCollisions = new FactCollisionService(
      pg, prefix, logger, this.config.exclusiveFamilies,
    );
    const summaries = new SummariesService(pg, this.config.llm, embedding, prefix, logger);
    const qualityScorer = new QualityScorerService(pg, this.config.llm, this.config.embeddings, prefix, logger);
    const sessionTexture = new SessionTextureService(pg, this.config.llm, prefix, logger);
    const selfIntention = new SelfIntentionService(pg, prefix, logger);

    const contextBuilder = new ContextBuilder(
      pg, facts, embedding, emotionalMoments,
      contradictions, behavioral, sessionTexture, selfIntention,
      temporalEvents,
      this.config.graph ?? null, prefix, logger,
    );

    const sessionManager = new SessionManager(
      pg, embedding, sentiment, centroid,
      facts, emotionalMoments, contradictions,
      this.config.llm,
      prefix, this.config.session.inactivityTimeoutMs, logger,
    );

    let scheduler: ConsolidationScheduler | null = null;
    if (this.config.consolidation.enabled) {
      scheduler = new ConsolidationScheduler(
        pg, redis, this.config.llm,
        facts, summaries,
        this.config.graph ?? null, prefix, this.config.consolidation, logger,
      );
      await scheduler.start();
    }

    this.services = {
      pg, redis, facts, embedding, sentiment, centroid,
      emotionalMoments, contradictions, behavioral, summaries, temporalEvents,
      factCollisions,
      qualityScorer, sessionTexture, selfIntention,
      contextBuilder, sessionManager, scheduler,
    };

    logger.info('bwmem initialized');
  }

  // ---- Public API ----

  /**
   * Start a new memory session for a user. The returned `Session` collects
   * messages, triggers background embedding/sentiment/fact-extraction, and
   * must be ended via `session.end()` to flush the final summary.
   */
  async startSession(config: SessionConfig): Promise<Session> {
    const s = this.ensureReady();
    return s.sessionManager.startSession(config, s.scheduler);
  }

  /**
   * Build a memory context for LLM prompt injection. Aggregates 11 sources
   * in parallel, each guarded by a per-source timeout so a single slow query
   * cannot stall the response.
   */
  async buildContext(userId: string, options?: BuildContextOptions): Promise<MemoryContext> {
    const s = this.ensureReady();
    return s.contextBuilder.build(userId, options);
  }

  /** Facts API. */
  get facts(): FactsAPI {
    const s = this.ensureReady();
    return {
      get: (userId: string, opts) => s.facts.getUserFacts(
        userId, opts?.category, opts?.limit, opts?.intentId, opts?.queryText,
      ),
      searchRelevant: (userId, queryText, opts) =>
        s.facts.searchRelevantFacts(userId, queryText, opts ?? {}),
      getAsOf: (userId, asOfValidTime, asOfTxnTime, opts) =>
        s.facts.getFactsAsOf(userId, asOfValidTime, asOfTxnTime, opts),
      store: (input) => s.facts.storeFact(input),
      remove: (factId, reason) => s.facts.removeFact(factId, reason),
      search: (userId, query) => s.facts.searchFacts(userId, query),
      findSimilar: (userId, value, opts) => s.facts.findSimilarActiveFact(userId, value, opts),
      touchMention: (factId) => s.facts.touchFactMention(factId),
      expireTemporary: (untimedMaxAgeDays?: number) =>
        s.facts.expireTemporaryFacts(untimedMaxAgeDays),
    };
  }

  /**
   * Cross-key collisions: one subject filed under two categories that cannot
   * both be true, each row internally coherent, so every fact_key-scoped guard
   * is blind to it.
   *
   * Nothing here writes to the facts table. `refresh` raises and closes rows on
   * its own surface; acting on what it raises is `facts.store` / `facts.remove`,
   * by the caller's hand.
   */
  get collisions(): CollisionsAPI {
    const s = this.ensureReady();
    return {
      refresh: (userId) => s.factCollisions.refresh(userId),
      list: (userId, includeClosed) => s.factCollisions.list(userId, includeClosed),
      countOpen: (userId) => s.factCollisions.countOpen(userId),
      residues: (userId) => s.factCollisions.listDecisionResidues(userId),
      settle: (userId, subject, note, decidedCategory) =>
        s.factCollisions.settle(userId, subject, note, decidedCategory),
    };
  }

  /** Semantic search across this user's messages. */
  async searchMessages(userId: string, query: string, limit?: number, threshold?: number) {
    const s = this.ensureReady();
    return s.embedding.searchSimilarMessages(userId, query, limit, threshold);
  }

  /** Semantic search across this user's conversation summaries. */
  async searchConversations(userId: string, query: string, limit?: number, threshold?: number) {
    const s = this.ensureReady();
    return s.embedding.searchSimilarConversations(userId, query, limit, threshold);
  }

  get emotions(): EmotionsAPI {
    const s = this.ensureReady();
    return {
      getRecent: (userId, days, limit) => s.emotionalMoments.getRecent(userId, days, limit),
    };
  }

  get contradictions(): ContradictionsAPI {
    const s = this.ensureReady();
    return {
      getOpen: (userId, sessionId, limit) =>
        s.contradictions.getOpen(userId, sessionId, limit),
      getUnsurfaced: (userId, sessionId, limit) =>
        s.contradictions.getOpen(userId, sessionId, limit),
      resolve: (userId, id, decision, note) =>
        s.contradictions.resolve(userId, id, decision, note),
      hold: (userId, id, reason) =>
        s.contradictions.hold(userId, id, reason),
      counts: (userId) => s.contradictions.counts(userId),
      detectInline: (message, facts) =>
        s.contradictions.detectInline(message, facts),
    };
  }

  get behavioral(): BehavioralAPI {
    const s = this.ensureReady();
    return {
      getActive: (userId, limit) => s.behavioral.getActive(userId, limit),
    };
  }

  get summaries(): SummariesAPI {
    const s = this.ensureReady();
    return {
      getForSession: (sessionId) => s.summaries.getForSession(sessionId),
    };
  }

  /** Quality scoring API (per-response output_integrity + interaction_vitality). */
  get quality(): QualityAPI {
    const s = this.ensureReady();
    return {
      scoreResponse: (input) => s.qualityScorer.scoreResponse(input),
      resolveFollowup: (input) => s.qualityScorer.resolveFollowup(input),
      runSelfCheck: (sampleSize) => s.qualityScorer.runSelfCheck(sampleSize),
      getStats: (userId, options) => s.qualityScorer.getStats(userId, options),
    };
  }

  /** Session texture API (throughline + emotional register carryover). */
  get textures(): TexturesAPI {
    const s = this.ensureReady();
    return {
      capture: (sessionId, opts) => s.sessionTexture.capture(sessionId, opts),
      getForPrompt: (userId, opts) => s.sessionTexture.getForPrompt(userId, opts),
      getLatest: (userId, opts) => s.sessionTexture.getLatest(userId, opts),
    };
  }

  /** Self-intention API (held things-to-do with daily surfacing). */
  get intentions(): IntentionsAPI {
    const s = this.ensureReady();
    return {
      save: (userId, intention, note) => s.selfIntention.save(userId, intention, note),
      resolve: (userId, status, opts) => s.selfIntention.resolve(userId, status, opts),
      listOpen: (userId) => s.selfIntention.listOpen(userId),
      listAll: (userId, limit) => s.selfIntention.listAll(userId, limit),
      getPrompt: (userId, opts) => s.selfIntention.getPrompt(userId, opts),
    };
  }

  /** Trigger a consolidation run on demand. */
  async triggerConsolidation(type: 'daily' | 'weekly'): Promise<void> {
    const s = this.ensureReady();
    if (!s.scheduler) throw new Error('Consolidation is not enabled');
    await s.scheduler.addJob(type);
  }

  /** Shutdown all connections and schedulers. */
  async shutdown(): Promise<void> {
    const { logger } = this.config;
    const s = this.services;
    if (!s) {
      logger.info('bwmem shutdown: never initialized');
      return;
    }
    logger.info('Shutting down bwmem...');

    s.sessionManager.shutdown();

    if (s.scheduler) await s.scheduler.stop();
    if (this.config.graph) await this.config.graph.shutdown();

    await s.redis.close();
    await s.pg.close();

    this.services = null;
    logger.info('bwmem shut down');
  }

  private ensureReady(): Services {
    if (!this.services) {
      throw new Error('bwmem: call initialize() before using the SDK');
    }
    return this.services;
  }
}

interface CollisionsAPI {
  /**
   * Detect, file and close in one pass. Returns what is open afterwards plus
   * the residue standing against every decision already on record.
   */
  refresh(userId: string): Promise<{
    open: StoredCollision[]; raised: number; resolved: number; residues: DecisionResidue[];
  }>;
  list(userId: string, includeClosed?: boolean): Promise<StoredCollision[]>;
  countOpen(userId: string): Promise<number>;
  /** Every decision on record, measured against the facts as they are now. */
  residues(userId: string): Promise<DecisionResidue[]>;
  /**
   * Close a collision by recording WHICH SIDE was kept — `decidedCategory` is
   * required, and that is the point: a settle that records only a note is a
   * mute. It suppresses the flag while every losing-side row stays active and
   * retrievable, and because the row's identity is its key list, correcting a
   * fact afterwards mints a fresh alarm. A decision inverts both: the clash is
   * never re-raised, and what surfaces instead is the shrinking residue.
   *
   * Returns that residue as measured at the moment of settling, so a settle can
   * no longer quietly hide anything.
   */
  settle(
    userId: string, subject: string, note: string, decidedCategory: string,
  ): Promise<SettleResult>;
}

interface FactsAPI {
  get(userId: string, opts?: {
    category?: string;
    limit?: number;
    intentId?: string | null;
    /**
     * Free text (typically the current message). Appends facts that lexically
     * overlap it to the popularity-ranked `limit` window, which is otherwise
     * the same on every turn regardless of the question. Additive: nothing in
     * the core set is displaced.
     */
    queryText?: string;
  }): Promise<Fact[]>;
  /** Facts overlapping `queryText`, ranked by that overlap. */
  searchRelevant(userId: string, queryText: string, opts?: {
    category?: string; intentId?: string | null; limit?: number;
  }): Promise<Fact[]>;
  getAsOf(
    userId: string,
    asOfValidTime?: Date,
    asOfTxnTime?: Date,
    opts?: { category?: string; limit?: number },
  ): Promise<Fact[]>;
  store(input: StoreFact): Promise<Fact | null>;
  remove(factId: string, reason?: string): Promise<void>;
  search(userId: string, query: string): Promise<Fact[]>;
  findSimilar(userId: string, value: string, opts?: { threshold?: number; limit?: number }): Promise<SimilarFactMatch | null>;
  touchMention(factId: string): Promise<void>;
  /**
   * Expire temporary facts: those past their valid_until, and those that never
   * carried one and have gone untended for `untimedMaxAgeDays` (default 30).
   * The second branch is not optional housekeeping — without it an untimed
   * temporary never expires at all, and untimed is the common case.
   */
  expireTemporary(untimedMaxAgeDays?: number): Promise<number>;
}

interface EmotionsAPI {
  getRecent(userId: string, days?: number, limit?: number): Promise<EmotionalMoment[]>;
}

interface ContradictionsAPI {
  /** Outstanding contradictions — filtered on lifecycle status, not on the display flag. */
  getOpen(userId: string, sessionId?: string, limit?: number): Promise<ContradictionSignal[]>;
  /** @deprecated Renamed to {@link ContradictionsAPI.getOpen} in 0.7.0. Delegates to it. */
  getUnsurfaced(userId: string, sessionId?: string, limit?: number): Promise<ContradictionSignal[]>;
  /**
   * Close one with a decision. Before 0.7.0 there was no way to do this at all:
   * the only exit was being displayed twice, which is not a decision.
   */
  resolve(
    userId: string, id: string,
    decision: import('./types.js').ContradictionDecision,
    note?: string,
  ): Promise<boolean>;
  /** Set one aside without deciding. Lapses when the underlying fact moves. */
  hold(userId: string, id: string, reason?: string): Promise<boolean>;
  counts(userId: string): Promise<{ open: number; held: number; resolved: number }>;
  detectInline(message: string, facts: Fact[]): import('./types.js').InlineContradiction[];
}

interface BehavioralAPI {
  getActive(userId: string, limit?: number): Promise<BehavioralObservation[]>;
}

interface SummariesAPI {
  getForSession(sessionId: string): Promise<ConversationSummary | null>;
}

interface QualityAPI {
  scoreResponse(input: ScoreResponseInput): Promise<void>;
  resolveFollowup(input: ResolveFollowupInput): Promise<void>;
  runSelfCheck(sampleSize?: number): Promise<number>;
  getStats(userId: string, options?: { since?: Date; mode?: string; limit?: number }): Promise<QualityStats>;
}

interface TexturesAPI {
  capture(sessionId: string, opts?: { mode?: string; speaker?: string }): Promise<void>;
  getForPrompt(userId: string, opts?: { mode?: string; speaker?: string }): Promise<string>;
  getLatest(userId: string, opts?: { mode?: string; speaker?: string }): Promise<SessionTexture | null>;
}

interface IntentionsAPI {
  save(userId: string, intention: string, note?: string): Promise<string | null>;
  resolve(userId: string, status: SelfIntentionStatus, opts?: { id?: string; note?: string }): Promise<string | null>;
  listOpen(userId: string): Promise<SelfIntention[]>;
  listAll(userId: string, limit?: number): Promise<SelfIntention[]>;
  getPrompt(userId: string, opts?: IntentionPromptOptions): Promise<string>;
}
