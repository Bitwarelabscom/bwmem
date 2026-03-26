import type {
  BwMemConfig,
  BuildContextOptions,
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

export class BwMem {
  private config: ResolvedConfig;
  private pg!: PgClient;
  private redis!: RedisClient;
  private initialized = false;

  // Services (accessible after initialize)
  private _facts!: FactsService;
  private _embedding!: EmbeddingService;
  private _sentiment!: SentimentService;
  private _centroid!: CentroidService;
  private _emotionalMoments!: EmotionalMomentsService;
  private _contradictions!: ContradictionService;
  private _behavioral!: BehavioralService;
  private _summaries!: SummariesService;
  private _contextBuilder!: ContextBuilder;
  private _sessionManager!: SessionManager;
  private _scheduler?: ConsolidationScheduler;

  constructor(config: BwMemConfig) {
    this.config = resolveConfig(config);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { logger } = this.config;
    logger.info('Initializing bwmem...');

    // Connect databases
    this.pg = new PgClient(this.config.postgres, logger);
    this.redis = new RedisClient(this.config.redis, logger);

    // Run migrations
    const dimensions = this.config.embeddings.dimensions;
    const migrator = new Migrator(this.pg, this.config.tablePrefix, dimensions, logger);
    await migrator.run();

    // Initialize optional graph plugin
    if (this.config.graph) {
      await this.config.graph.initialize();
      logger.info('Graph plugin initialized');
    }

    // Create services
    const prefix = this.config.tablePrefix;

    this._embedding = new EmbeddingService(this.pg, this.config.embeddings, prefix, logger);
    this._sentiment = new SentimentService(this.config.llm, logger);
    this._centroid = new CentroidService(this.redis, logger);
    this._facts = new FactsService(this.pg, this.config.llm, this.config.graph ?? null, prefix, logger);
    this._emotionalMoments = new EmotionalMomentsService(this.pg, this.config.llm, prefix, logger);
    this._contradictions = new ContradictionService(this.pg, prefix, logger);
    this._behavioral = new BehavioralService(this.pg, prefix, logger);
    this._summaries = new SummariesService(this.pg, this.config.llm, this._embedding, prefix, logger);
    this._contextBuilder = new ContextBuilder(
      this.pg, this._facts, this._embedding, this._emotionalMoments,
      this._contradictions, this._behavioral,
      this.config.graph ?? null, prefix, logger,
    );

    this._sessionManager = new SessionManager(
      this.pg, this._embedding, this._sentiment, this._centroid,
      this._facts, this._emotionalMoments, this._contradictions,
      prefix, this.config.session.inactivityTimeoutMs, logger,
    );

    // Start consolidation scheduler if enabled
    if (this.config.consolidation.enabled) {
      this._scheduler = new ConsolidationScheduler(
        this.pg, this.redis, this.config.llm,
        this._facts, this._summaries,
        this.config.graph ?? null, prefix, this.config.consolidation, logger,
      );
      await this._scheduler.start();
    }

    this.initialized = true;
    logger.info('bwmem initialized');
  }

  // ---- Public API ----

  /** Start a new memory session for a user. */
  async startSession(config: SessionConfig): Promise<Session> {
    this.ensureInitialized();
    return this._sessionManager.startSession(config, this._scheduler ?? null);
  }

  /** Build memory context for LLM prompt injection. */
  async buildContext(userId: string, options?: BuildContextOptions): Promise<MemoryContext> {
    this.ensureInitialized();
    return this._contextBuilder.build(userId, options);
  }

  /** Facts API - direct access to fact management. */
  get facts(): FactsAPI {
    this.ensureInitialized();
    return {
      get: (userId: string) => this._facts.getUserFacts(userId),
      store: (input: StoreFact) => this._facts.storeFact(input),
      remove: (factId: string, reason?: string) => this._facts.removeFact(factId, reason),
      search: (userId: string, query: string) => this._facts.searchFacts(userId, query),
    };
  }

  /** Semantic search across messages. */
  async searchMessages(userId: string, query: string, limit?: number, threshold?: number) {
    this.ensureInitialized();
    return this._embedding.searchSimilarMessages(userId, query, limit, threshold);
  }

  /** Semantic search across conversation summaries. */
  async searchConversations(userId: string, query: string, limit?: number, threshold?: number) {
    this.ensureInitialized();
    return this._embedding.searchSimilarConversations(userId, query, limit, threshold);
  }

  /** Trigger consolidation on demand. Type: 'daily' | 'weekly'. Requires consolidation enabled. */
  async triggerConsolidation(type: 'daily' | 'weekly'): Promise<void> {
    this.ensureInitialized();
    if (!this._scheduler) throw new Error('Consolidation is not enabled');
    await this._scheduler.addJob(type);
  }

  /** Shutdown all connections and schedulers. */
  async shutdown(): Promise<void> {
    const { logger } = this.config;
    logger.info('Shutting down bwmem...');

    this._sessionManager?.shutdown();

    if (this._scheduler) {
      await this._scheduler.stop();
    }

    if (this.config.graph) {
      await this.config.graph.shutdown();
    }

    await this.redis?.close();
    await this.pg?.close();

    this.initialized = false;
    logger.info('bwmem shut down');
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('bwmem: call initialize() before using the SDK');
    }
  }
}

interface FactsAPI {
  get(userId: string): Promise<Fact[]>;
  store(input: StoreFact): Promise<Fact>;
  remove(factId: string, reason?: string): Promise<void>;
  search(userId: string, query: string): Promise<Fact[]>;
}
