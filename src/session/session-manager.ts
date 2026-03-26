import { v4 as uuidv4 } from 'uuid';
import type { PgClient } from '../db/postgres.js';
import type { EmbeddingService } from '../memory/embedding.service.js';
import type { SentimentService } from '../memory/sentiment.service.js';
import type { CentroidService } from '../memory/centroid.service.js';
import type { FactsService } from '../memory/facts.service.js';
import type { EmotionalMomentsService } from '../memory/emotional-moments.service.js';
import type { ContradictionService } from '../memory/contradiction.service.js';
import type { ConsolidationScheduler } from '../consolidation/scheduler.js';
import type { Logger, SessionConfig } from '../types.js';
import { Session } from './session.js';

export class SessionManager {
  private pg: PgClient;
  private embedding: EmbeddingService;
  private sentiment: SentimentService;
  private centroid: CentroidService;
  private facts: FactsService;
  private emotionalMoments: EmotionalMomentsService;
  private contradictions: ContradictionService;
  private prefix: string;
  private inactivityTimeoutMs: number;
  private logger: Logger;

  // Track active sessions for inactivity timeouts
  private activeSessions = new Map<string, { session: Session; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    pg: PgClient, embedding: EmbeddingService, sentiment: SentimentService,
    centroid: CentroidService, facts: FactsService,
    emotionalMoments: EmotionalMomentsService, contradictions: ContradictionService,
    prefix: string, inactivityTimeoutMs: number, logger: Logger,
  ) {
    this.pg = pg;
    this.embedding = embedding;
    this.sentiment = sentiment;
    this.centroid = centroid;
    this.facts = facts;
    this.emotionalMoments = emotionalMoments;
    this.contradictions = contradictions;
    this.prefix = prefix;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.logger = logger;
  }

  /** Start a new session. */
  async startSession(config: SessionConfig, scheduler: ConsolidationScheduler | null): Promise<Session> {
    const sessionId = uuidv4();

    await this.pg.query(
      `INSERT INTO ${this.prefix}sessions (id, user_id, metadata)
       VALUES ($1, $2, $3)`,
      [sessionId, config.userId, JSON.stringify(config.metadata ?? {})]
    );

    const session = new Session(
      sessionId, config.userId, config.metadata ?? {},
      this.pg, this.embedding, this.sentiment, this.centroid,
      this.facts, this.emotionalMoments, this.contradictions,
      scheduler, this.prefix, this.logger,
    );

    // Set up inactivity timeout
    this.trackSession(session);

    this.logger.info('Session started', { sessionId, userId: config.userId });
    return session;
  }

  /** Shutdown - end all active sessions. */
  shutdown(): void {
    Array.from(this.activeSessions.entries()).forEach(([id, entry]) => {
      clearTimeout(entry.timer);
      entry.session.end().catch(err =>
        this.logger.error('Failed to end session on shutdown', { sessionId: id, error: (err as Error).message })
      );
    });
    this.activeSessions.clear();
  }

  private trackSession(session: Session): void {
    // Wrap recordMessage to reset inactivity timer
    const originalRecordMessage = session.recordMessage.bind(session);
    session.recordMessage = async (input) => {
      this.resetTimer(session.id);
      return originalRecordMessage(input);
    };

    // Wrap end to clean up tracking
    const originalEnd = session.end.bind(session);
    session.end = async () => {
      this.untrackSession(session.id);
      return originalEnd();
    };

    const timer = setTimeout(() => {
      this.logger.info('Session inactivity timeout', { sessionId: session.id });
      session.end().catch(err =>
        this.logger.error('Inactivity timeout end failed', { error: (err as Error).message })
      );
    }, this.inactivityTimeoutMs);

    this.activeSessions.set(session.id, { session, timer });
  }

  private resetTimer(sessionId: string): void {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.logger.info('Session inactivity timeout', { sessionId });
      entry.session.end().catch(err =>
        this.logger.error('Inactivity timeout end failed', { error: (err as Error).message })
      );
    }, this.inactivityTimeoutMs);
  }

  private untrackSession(sessionId: string): void {
    const entry = this.activeSessions.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.activeSessions.delete(sessionId);
    }
  }
}
