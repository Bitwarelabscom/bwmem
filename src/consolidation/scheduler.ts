import { Queue, Worker } from 'bullmq';
import type { RedisClient } from '../db/redis.js';
import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, GraphPlugin } from '../types.js';
import type { FactsService } from '../memory/facts.service.js';
import type { SummariesService } from '../memory/summaries.service.js';
import { EpisodicConsolidator } from './episodic.js';
import { SemanticConsolidator } from './semantic.js';
import { Pruner } from './pruner.js';

interface SchedulerConfig {
  daily: string;
  weekly: string;
}

interface ConsolidationJobData {
  type: 'episodic' | 'daily' | 'weekly';
  userId?: string;
  sessionId?: string;
}

const QUEUE_NAME = 'bwmem-consolidation';

export class ConsolidationScheduler {
  private queue: Queue;
  private worker: Worker | null = null;
  private redis: RedisClient;
  private episodic: EpisodicConsolidator;
  private semantic: SemanticConsolidator;
  private pruner: Pruner;
  private config: SchedulerConfig;
  private logger: Logger;

  constructor(
    pg: PgClient, redis: RedisClient, llm: LLMProvider,
    facts: FactsService, summaries: SummariesService,
    graph: GraphPlugin | null, prefix: string, config: SchedulerConfig, logger: Logger,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;

    // Create BullMQ queue using the same Redis connection
    this.queue = new Queue(QUEUE_NAME, {
      connection: redis.client,
    });

    this.episodic = new EpisodicConsolidator(pg, llm, summaries, prefix, logger);
    this.semantic = new SemanticConsolidator(pg, llm, facts, graph, prefix, logger);
    this.pruner = new Pruner(pg, prefix, logger);
  }

  async start(): Promise<void> {
    // Create worker to process jobs
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const data = job.data as ConsolidationJobData;
        this.logger.info(`Processing consolidation job: ${data.type}`, { userId: data.userId, sessionId: data.sessionId });

        try {
          switch (data.type) {
            case 'episodic':
              if (data.userId && data.sessionId) {
                await this.episodic.consolidate(data.userId, data.sessionId);
              }
              break;
            case 'daily':
              await this.runDailyConsolidation();
              break;
            case 'weekly':
              await this.runWeeklyConsolidation();
              break;
          }
        } catch (error) {
          this.logger.error(`Consolidation job failed: ${data.type}`, { error: (error as Error).message });
          throw error;
        }
      },
      { connection: this.redis.client, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error('Consolidation job failed', { jobId: job?.id, error: err.message });
    });

    // Schedule repeatable jobs
    await this.queue.upsertJobScheduler(
      'daily-consolidation',
      { pattern: this.config.daily },
      { name: 'daily', data: { type: 'daily' } as ConsolidationJobData },
    );

    await this.queue.upsertJobScheduler(
      'weekly-consolidation',
      { pattern: this.config.weekly },
      { name: 'weekly', data: { type: 'weekly' } as ConsolidationJobData },
    );

    this.logger.info('Consolidation scheduler started', {
      daily: this.config.daily,
      weekly: this.config.weekly,
    });
  }

  /** Add an episodic consolidation job (called on session.end()). */
  async addEpisodicJob(userId: string, sessionId: string): Promise<void> {
    await this.queue.add('episodic', {
      type: 'episodic',
      userId,
      sessionId,
    } as ConsolidationJobData);
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.queue.close();
    this.logger.info('Consolidation scheduler stopped');
  }

  private async runDailyConsolidation(): Promise<void> {
    await this.semantic.consolidateDaily();
    await this.pruner.expireBehavioral(7);
  }

  private async runWeeklyConsolidation(): Promise<void> {
    await this.semantic.consolidateWeekly();
    await this.pruner.pruneSemanticKnowledge(0.3);
  }
}
