import { createHash } from 'node:crypto';
import type { PgClient } from '../db/postgres.js';
import type { EmbeddingProvider, Logger, SimilarMessage, SimilarConversation } from '../types.js';

interface CacheEntry {
  embedding: number[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 100;
const MAX_INPUT_CHARS = 30000;

/**
 * Cache key = SHA-256 over the truncated input the provider will see.
 * A slice-based key collides for any two texts sharing a prefix, which
 * would return the wrong embedding from cache. Hash is collision-safe.
 */
function makeCacheKey(text: string): string {
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  return createHash('sha256').update(truncated).digest('hex');
}

// ---- DB row types ----

interface SimilarMessageRow {
  id: string;
  session_id: string;
  content: string;
  role: string;
  /** pgvector returns similarity as a string via node-pg for REAL columns. */
  similarity: string;
  created_at: Date;
}

interface SimilarConversationRow {
  session_id: string;
  summary: string;
  topics: string[] | null;
  similarity: string;
  created_at: Date;
}

export class EmbeddingService {
  private pg: PgClient;
  private provider: EmbeddingProvider;
  private prefix: string;
  private logger: Logger;
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<number[]>>();

  constructor(pg: PgClient, provider: EmbeddingProvider, prefix: string, logger: Logger) {
    this.pg = pg;
    this.provider = provider;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Generate embedding for text with caching and request coalescing. */
  async generate(text: string): Promise<number[]> {
    const cacheKey = makeCacheKey(text);
    const now = Date.now();

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      return cached.embedding;
    }

    // Coalesce concurrent requests for same text
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.generateInternal(text, cacheKey);
    this.inFlight.set(cacheKey, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /** Generate embeddings for multiple texts with caching. */
  async generateBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.generate(texts[0])];

    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    const uncachedKeys: string[] = [];
    const now = Date.now();

    for (let i = 0; i < texts.length; i++) {
      const cacheKey = makeCacheKey(texts[i]);
      const cached = this.cache.get(cacheKey);
      if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        results[i] = cached.embedding;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i].slice(0, MAX_INPUT_CHARS));
        uncachedKeys.push(cacheKey);
      }
    }

    if (uncachedTexts.length === 0) return results;

    const batchResults = await this.provider.generateBatch(uncachedTexts);

    for (let j = 0; j < batchResults.length; j++) {
      const originalIndex = uncachedIndices[j];
      results[originalIndex] = batchResults[j];
      this.cache.set(uncachedKeys[j], { embedding: batchResults[j], timestamp: Date.now() });
    }

    this.cleanCache();
    return results;
  }

  /** Store a message embedding in the database. */
  async storeMessageEmbedding(
    messageId: string, userId: string, sessionId: string,
    content: string, role: string,
    sentimentValence?: number, sentimentArousal?: number, sentimentDominance?: number,
  ): Promise<void> {
    try {
      const embedding = await this.generate(content);
      const vectorString = `[${embedding.join(',')}]`;

      await this.pg.query(
        `INSERT INTO ${this.prefix}messages
           (id, session_id, user_id, role, content, embedding, sentiment_valence, sentiment_arousal, sentiment_dominance)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           sentiment_valence = EXCLUDED.sentiment_valence,
           sentiment_arousal = EXCLUDED.sentiment_arousal,
           sentiment_dominance = EXCLUDED.sentiment_dominance`,
        [messageId, sessionId, userId, role, content, vectorString,
         sentimentValence ?? null, sentimentArousal ?? null, sentimentDominance ?? null]
      );
    } catch (error) {
      this.logger.error('Failed to store message embedding', { error: (error as Error).message, messageId });
    }
  }

  /** Search for semantically similar messages. */
  async searchSimilarMessages(
    userId: string, query: string, limit = 5, threshold = 0.25,
    excludeSessionId?: string,
  ): Promise<SimilarMessage[]> {
    try {
      const embedding = await this.generate(query);
      const vectorString = `[${embedding.join(',')}]`;

      let sql = `
        SELECT id, session_id, content, role,
               1 - (embedding <=> $1::vector) as similarity,
               created_at
        FROM ${this.prefix}messages
        WHERE user_id = $2
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> $1::vector) > $3
      `;
      const params: unknown[] = [vectorString, userId, threshold];

      if (excludeSessionId) {
        sql += ` AND session_id != $4`;
        params.push(excludeSessionId);
      }

      sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<SimilarMessageRow>(sql, params);
      return rows.map(row => ({
        messageId: row.id,
        sessionId: row.session_id,
        content: row.content,
        role: row.role,
        similarity: parseFloat(row.similarity),
        createdAt: row.created_at,
      }));
    } catch (error) {
      this.logger.error('searchSimilarMessages failed', { error: (error as Error).message });
      return [];
    }
  }

  /** Search for semantically similar conversations by summary. */
  async searchSimilarConversations(
    userId: string, query: string, limit = 3, threshold = 0.2,
  ): Promise<SimilarConversation[]> {
    try {
      const embedding = await this.generate(query);
      const vectorString = `[${embedding.join(',')}]`;

      const rows = await this.pg.query<SimilarConversationRow>(
        `SELECT session_id, summary, topics,
                1 - (embedding <=> $1::vector) as similarity,
                created_at
         FROM ${this.prefix}conversation_summaries
         WHERE user_id = $2
           AND embedding IS NOT NULL
           AND 1 - (embedding <=> $1::vector) > $3
         ORDER BY embedding <=> $1::vector
         LIMIT $4`,
        [vectorString, userId, threshold, limit]
      );

      return rows.map(row => ({
        sessionId: row.session_id,
        summary: row.summary,
        topics: row.topics ?? [],
        similarity: parseFloat(row.similarity),
        createdAt: row.created_at,
      }));
    } catch (error) {
      this.logger.error('searchSimilarConversations failed', { error: (error as Error).message });
      return [];
    }
  }

  private async generateInternal(text: string, cacheKey: string): Promise<number[]> {
    const embedding = await this.provider.generate(text.slice(0, MAX_INPUT_CHARS));
    this.cache.set(cacheKey, { embedding, timestamp: Date.now() });
    this.cleanCache();
    return embedding;
  }

  private cleanCache(): void {
    if (this.cache.size <= CACHE_MAX_SIZE) return;

    const now = Date.now();
    Array.from(this.cache.entries()).forEach(([key, entry]) => {
      if (now - entry.timestamp > CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    });

    if (this.cache.size > CACHE_MAX_SIZE) {
      const entries = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, this.cache.size - CACHE_MAX_SIZE);
      toRemove.forEach(([key]) => this.cache.delete(key));
    }
  }
}
