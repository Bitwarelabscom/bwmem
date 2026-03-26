import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, ConversationSummary } from '../types.js';
import type { EmbeddingService } from './embedding.service.js';

export class SummariesService {
  private pg: PgClient;
  private llm: LLMProvider;
  private embedding: EmbeddingService;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, embedding: EmbeddingService, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.embedding = embedding;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Generate and store a conversation summary for a session. */
  async summarizeSession(userId: string, sessionId: string): Promise<ConversationSummary | null> {
    try {
      // Get messages for this session
      const messages = await this.pg.query<Record<string, unknown>>(
        `SELECT role, content FROM ${this.prefix}messages
         WHERE session_id = $1 ORDER BY created_at`,
        [sessionId]
      );

      if (messages.length < 2) return null;

      const transcript = messages
        .map(m => `${(m.role as string).toUpperCase()}: ${(m.content as string).slice(0, 500)}`)
        .join('\n');

      // Generate summary via LLM
      const response = await this.llm.chat([
        {
          role: 'system',
          content: `Summarize this conversation. Return JSON:
{"summary": "1-2 sentence summary", "topics": ["topic1", "topic2"], "keyPoints": ["point1", "point2"]}`,
        },
        { role: 'user', content: transcript.slice(0, 4000) },
      ], { temperature: 0.3, maxTokens: 500, json: true });

      const parsed = JSON.parse(response);
      const summary = parsed.summary || 'Conversation summary unavailable';
      const topics: string[] = parsed.topics || [];
      const keyPoints: string[] = parsed.keyPoints || [];

      // Generate embedding for the summary
      const emb = await this.embedding.generate(summary);
      const vectorString = `[${emb.join(',')}]`;

      // Store
      const result = await this.pg.query<Record<string, unknown>>(
        `INSERT INTO ${this.prefix}conversation_summaries
          (session_id, user_id, summary, topics, key_points, embedding, message_count)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
         ON CONFLICT (session_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           topics = EXCLUDED.topics,
           key_points = EXCLUDED.key_points,
           embedding = EXCLUDED.embedding,
           message_count = EXCLUDED.message_count,
           updated_at = NOW()
         RETURNING *`,
        [sessionId, userId, summary, topics, keyPoints, vectorString, messages.length]
      );

      const row = result[0];
      return {
        id: row.id as string,
        sessionId: row.session_id as string,
        userId: row.user_id as string,
        summary: row.summary as string,
        topics: (row.topics as string[]) ?? [],
        keyPoints: (row.key_points as string[]) ?? [],
        messageCount: row.message_count as number,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
      };
    } catch (error) {
      this.logger.error('summarizeSession failed', { error: (error as Error).message, sessionId });
      return null;
    }
  }

  /** Get summary for a session. */
  async getForSession(sessionId: string): Promise<ConversationSummary | null> {
    const row = await this.pg.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${this.prefix}conversation_summaries WHERE session_id = $1`,
      [sessionId]
    );
    if (!row) return null;

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      summary: row.summary as string,
      topics: (row.topics as string[]) ?? [],
      keyPoints: (row.key_points as string[]) ?? [],
      messageCount: row.message_count as number,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
