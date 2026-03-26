import { v4 as uuidv4 } from 'uuid';
import type { PgClient } from '../db/postgres.js';
import type { EmbeddingService } from '../memory/embedding.service.js';
import type { SentimentService } from '../memory/sentiment.service.js';
import type { CentroidService } from '../memory/centroid.service.js';
import type { FactsService } from '../memory/facts.service.js';
import type { EmotionalMomentsService } from '../memory/emotional-moments.service.js';
import type { ContradictionService } from '../memory/contradiction.service.js';
import type { ConsolidationScheduler } from '../consolidation/scheduler.js';
import type { Logger, Message, RecordMessageInput } from '../types.js';

export class Session {
  readonly id: string;
  readonly userId: string;
  readonly metadata: Record<string, unknown>;

  private pg: PgClient;
  private embedding: EmbeddingService;
  private sentiment: SentimentService;
  private centroid: CentroidService;
  private facts: FactsService;
  private emotionalMoments: EmotionalMomentsService;
  private contradictions: ContradictionService;
  private scheduler: ConsolidationScheduler | null;
  private prefix: string;
  private logger: Logger;
  private messageBuffer: Array<{ role: string; content: string }> = [];
  private ended = false;

  constructor(
    id: string, userId: string, metadata: Record<string, unknown>,
    pg: PgClient, embedding: EmbeddingService, sentiment: SentimentService,
    centroid: CentroidService, facts: FactsService,
    emotionalMoments: EmotionalMomentsService, contradictions: ContradictionService,
    scheduler: ConsolidationScheduler | null,
    prefix: string, logger: Logger,
  ) {
    this.id = id;
    this.userId = userId;
    this.metadata = metadata;
    this.pg = pg;
    this.embedding = embedding;
    this.sentiment = sentiment;
    this.centroid = centroid;
    this.facts = facts;
    this.emotionalMoments = emotionalMoments;
    this.contradictions = contradictions;
    this.scheduler = scheduler;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Record a message in this session. Triggers embedding, sentiment, and fact extraction in background. */
  async recordMessage(input: RecordMessageInput): Promise<Message> {
    if (this.ended) throw new Error('Session has ended');

    const messageId = uuidv4();
    const { role, content } = input;

    // Insert message (without embedding - that's async)
    await this.pg.query(
      `INSERT INTO ${this.prefix}messages (id, session_id, user_id, role, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, this.id, this.userId, role, content]
    );

    this.messageBuffer.push({ role, content });

    // Background: embedding + sentiment + fact extraction + emotional moments
    this.processMessageBackground(messageId, role, content).catch(err =>
      this.logger.error('Background message processing failed', { error: (err as Error).message })
    );

    return {
      id: messageId,
      sessionId: this.id,
      userId: this.userId,
      role,
      content,
      createdAt: new Date(),
    };
  }

  /** End this session. Triggers episodic consolidation. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    // Mark session as ended
    await this.pg.query(
      `UPDATE ${this.prefix}sessions SET ended_at = NOW(), is_active = FALSE WHERE id = $1`,
      [this.id]
    );

    // Clear centroid
    await this.centroid.clear(this.id);

    // Trigger episodic consolidation
    if (this.scheduler && this.messageBuffer.length > 0) {
      await this.scheduler.addEpisodicJob(this.userId, this.id);
    }

    this.logger.info('Session ended', { sessionId: this.id, messages: this.messageBuffer.length });
  }

  /** Get all messages in this session. */
  async getMessages(): Promise<Message[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, session_id, user_id, role, content, embedding IS NOT NULL as has_embedding,
              sentiment_valence, sentiment_arousal, sentiment_dominance, created_at
       FROM ${this.prefix}messages
       WHERE session_id = $1
       ORDER BY created_at`,
      [this.id]
    );

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      sentimentValence: row.sentiment_valence as number | undefined,
      sentimentArousal: row.sentiment_arousal as number | undefined,
      sentimentDominance: row.sentiment_dominance as number | undefined,
      createdAt: row.created_at as Date,
    }));
  }

  private async processMessageBackground(messageId: string, role: string, content: string): Promise<void> {
    // Generate sentiment
    const sentimentResult = await this.sentiment.analyze(content);

    // Store embedding + sentiment
    await this.embedding.storeMessageEmbedding(
      messageId, this.userId, this.id, content, role,
      sentimentResult.valence, sentimentResult.arousal, sentimentResult.dominance,
    );

    // Update session centroid
    try {
      const emb = await this.embedding.generate(content);
      await this.centroid.update(this.id, emb);
    } catch { /* non-critical */ }

    // For user messages: extract facts + check emotional moments + contradictions
    if (role === 'user') {
      // Fact extraction (every 3 messages to reduce LLM calls)
      if (this.messageBuffer.length % 3 === 0 || this.messageBuffer.length <= 2) {
        const recentMessages = this.messageBuffer.slice(-6);
        const extracted = await this.facts.extractFromMessages(recentMessages, this.userId, this.id);
        if (extracted.length > 0) {
          await this.facts.storeExtractedFacts(this.userId, extracted, this.id);

          // Check for contradictions on extracted facts
          const existingFacts = await this.facts.getUserFacts(this.userId);
          for (const ef of extracted) {
            if (ef.isCorrection) {
              const existing = existingFacts.find(f => f.factKey === ef.factKey);
              if (existing) {
                await this.contradictions.createSignal(
                  this.userId, this.id, ef.factKey,
                  ef.factValue, existing.factValue,
                  'correction'
                );
              }
            }
          }
        }
      }

      // Emotional moment capture
      if (Math.abs(sentimentResult.valence) > 0.5 || sentimentResult.arousal > 0.6) {
        await this.emotionalMoments.capture(
          this.userId, this.id, content,
          sentimentResult.valence, sentimentResult.arousal, sentimentResult.dominance,
        );
      }
    }
  }
}
