import type {
  BwMemConfig,
  BuildContextOptions,
  ContradictionSignal,
  ConversationSummary,
  EmotionalMoment,
  BehavioralObservation,
  Fact,
  MemoryContext,
  SessionConfig,
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
import { ContradictionService } from './memory/contradiction.service.js';
import { BehavioralService } from './memory/behavioral.service.js';
import { SummariesService } from './memory/summaries.service.js';
import { ContextBuilder } from './memory/context-builder.js';
import { SessionManager } from './session/session-manager.js';
import { ConsolidationScheduler } from './consolidation/scheduler.js';
import type { Session } from './session/session.js';
import { BwMemStats, globalStats } from './stats.js';

/**
 * Services constructed during `initialize()`. Held in a single optional
 * object so the type system enforces "must call initialize() first" — any
 * access through `ensureReady()` returns the non-null bag, and accidental
 * access before init throws a clean error rather than crashing with
 * "Cannot read properties of undefined".
 */
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
  contextBuilder: ContextBuilder;
  sessionManager: SessionManager;
  scheduler: ConsolidationScheduler | null;
}

export class BwMem {
  private config: ResolvedConfig;
  private services: Services | null = null;

  /**
   * Counters for background-task failures. Incremented by fire-and-forget
   * pipelines (graph sync, fact extraction, behavioral detection) when
   * they catch errors. Exposed via `/health/detailed` so ops can detect
   * silent degradation. Uses the shared `globalStats` singleton so
   * services that lack a BwMem handle can still report.
   */
  readonly stats: BwMemStats = globalStats;

  constructor(config: BwMemConfig) {
    this.config = resolveConfig(config);
  }

  /** Initialize DB connections, run migrations, and wire up services. */
  async initialize(): Promise<void> {
    if (this.services) return;

    const { logger } = this.config;
    logger.info('Initializing bwmem...');

    // Connect databases
    const pg = new PgClient(this.config.postgres, logger);
    const redis = new RedisClient(this.config.redis, logger);

    // Run migrations
    const dimensions = this.config.embeddings.dimensions;
    const migrator = new Migrator(pg, this.config.tablePrefix, dimensions, logger);
    await migrator.run();

    // Initialize optional graph plugin
    if (this.config.graph) {
      await this.config.graph.initialize();
      logger.info('Graph plugin initialized');
    }

    // Create services
    const prefix = this.config.tablePrefix;

    const embedding = new EmbeddingService(pg, this.config.embeddings, prefix, logger);
    const sentiment = new SentimentService(this.config.llm, logger);
    const centroid = new CentroidService(redis, logger);
    const facts = new FactsService(pg, this.config.llm, this.config.graph ?? null, prefix, logger);
    const emotionalMoments = new EmotionalMomentsService(pg, this.config.llm, prefix, logger);
    const contradictions = new ContradictionService(pg, prefix, logger);
    const behavioral = new BehavioralService(pg, prefix, logger);
    const summaries = new SummariesService(pg, this.config.llm, embedding, prefix, logger);
    const contextBuilder = new ContextBuilder(
      pg, facts, embedding, emotionalMoments,
      contradictions, behavioral,
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

    // Publish services atomically once every step succeeded. Partial
    // initialization leaves `this.services` null so subsequent calls fail
    // cleanly instead of touching half-constructed state.
    this.services = {
      pg, redis, facts, embedding, sentiment, centroid,
      emotionalMoments, contradictions, behavioral, summaries,
      contextBuilder, sessionManager, scheduler,
    };

    logger.info('bwmem initialized');
  }

  // ---- Public API ----

  /**
   * Start a new memory session for a user. The returned `Session` collects
   * messages, triggers background embedding/sentiment/fact-extraction, and
   * must be ended via `session.end()` to flush the final summary.
   *
   * @param config - User id and optional metadata for the session.
   * @returns A live `Session` bound to this user.
   */
  async startSession(config: SessionConfig): Promise<Session> {
    const s = this.ensureReady();
    return s.sessionManager.startSession(config, s.scheduler);
  }

  /**
   * Build a memory context for LLM prompt injection.
   *
   * Aggregates facts, similar past messages, similar conversations,
   * emotional moments, contradictions, behavioral observations, episodic
   * and semantic patterns, and (optionally) graph context, each guarded by
   * a per-source timeout so a single slow query cannot stall the whole
   * response.
   *
   * @param userId - Scoped user id.
   * @param options - Query text, per-source limits, similarity threshold,
   *   and the per-source timeout in milliseconds.
   */
  async buildContext(userId: string, options?: BuildContextOptions): Promise<MemoryContext> {
    const s = this.ensureReady();
    return s.contextBuilder.build(userId, options);
  }

  /** Facts API — store, retrieve, search, and remove user facts. */
  get facts(): FactsAPI {
    const s = this.ensureReady();
    return {
      get: (userId: string) => s.facts.getUserFacts(userId),
      store: (input: StoreFact) => s.facts.storeFact(input),
      remove: (factId: string, reason?: string) => s.facts.removeFact(factId, reason),
      search: (userId: string, query: string) => s.facts.searchFacts(userId, query),
    };
  }

  /**
   * Semantic search across this user's messages using pgvector cosine
   * similarity. Returns the most similar messages ordered by score.
   */
  async searchMessages(userId: string, query: string, limit?: number, threshold?: number) {
    const s = this.ensureReady();
    return s.embedding.searchSimilarMessages(userId, query, limit, threshold);
  }

  /** Semantic search across this user's conversation summaries. */
  async searchConversations(userId: string, query: string, limit?: number, threshold?: number) {
    const s = this.ensureReady();
    return s.embedding.searchSimilarConversations(userId, query, limit, threshold);
  }

  /** Emotional moments API — retrieve recent captured high-salience moments. */
  get emotions(): EmotionsAPI {
    const s = this.ensureReady();
    return {
      getRecent: (userId: string, days?: number, limit?: number) =>
        s.emotionalMoments.getRecent(userId, days, limit),
    };
  }

  /** Contradictions API — retrieve unsurfaced contradiction signals. */
  get contradictions(): ContradictionsAPI {
    const s = this.ensureReady();
    return {
      getUnsurfaced: (userId: string, sessionId?: string, limit?: number) =>
        s.contradictions.getUnsurfaced(userId, sessionId, limit),
    };
  }

  /** Behavioral observations API — active patterns inferred from sentiment. */
  get behavioral(): BehavioralAPI {
    const s = this.ensureReady();
    return {
      getActive: (userId: string, limit?: number) =>
        s.behavioral.getActive(userId, limit),
    };
  }

  /** Conversation summaries API. */
  get summaries(): SummariesAPI {
    const s = this.ensureReady();
    return {
      getForSession: (sessionId: string) =>
        s.summaries.getForSession(sessionId),
    };
  }

  /**
   * Trigger a consolidation run on demand. Normally the scheduler runs
   * daily/weekly jobs via cron; this is useful for tests and one-off
   * replays.
   *
   * @throws Error if consolidation is disabled in config.
   */
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

    if (s.scheduler) {
      await s.scheduler.stop();
    }

    if (this.config.graph) {
      await this.config.graph.shutdown();
    }

    await s.redis.close();
    await s.pg.close();

    this.services = null;
    logger.info('bwmem shut down');
  }

  /**
   * Return the initialized service bag or throw. Internal use only — the
   * public API always reaches services through this method so "not yet
   * initialized" produces a clean error.
   */
  private ensureReady(): Services {
    if (!this.services) {
      throw new Error('bwmem: call initialize() before using the SDK');
    }
    return this.services;
  }
}

interface FactsAPI {
  get(userId: string): Promise<Fact[]>;
  store(input: StoreFact): Promise<Fact>;
  remove(factId: string, reason?: string): Promise<void>;
  search(userId: string, query: string): Promise<Fact[]>;
}

interface EmotionsAPI {
  getRecent(userId: string, days?: number, limit?: number): Promise<EmotionalMoment[]>;
}

interface ContradictionsAPI {
  getUnsurfaced(userId: string, sessionId?: string, limit?: number): Promise<ContradictionSignal[]>;
}

interface BehavioralAPI {
  getActive(userId: string, limit?: number): Promise<BehavioralObservation[]>;
}

interface SummariesAPI {
  getForSession(sessionId: string): Promise<ConversationSummary | null>;
}
