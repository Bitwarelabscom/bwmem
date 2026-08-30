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
 * Bounds for the keyword arm. The unbounded first version measured WORSE than
 * no keyword arm at all; these exist to keep it a precision supplement rather
 * than a second, noisier recall channel.
 */
/** Drop a term appearing in more than this fraction of the user's messages. */
const KEYWORD_MAX_DOC_FREQ = 0.15;
/** At most this many terms survive into the query, rarest first. */
const KEYWORD_MAX_TERMS = 6;
/** Hard cap on rows this arm may contribute, whatever the caller's limit. */
const KEYWORD_ARM_CAP = 10;
/** Keep rows within this fraction of the arm's own best rank. Relative, never absolute. */
const KEYWORD_RELATIVE_FLOOR = 0.35;

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
  ): Promise<number[] | null> {
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
      // Returned so callers that need the same vector (the session centroid)
      // can reuse it. It used to return void and the centroid re-embedded the
      // identical string, which doubled the embedding bill for every message
      // in the system to recompute a value that was already in hand.
      return embedding;
    } catch (error) {
      this.logger.error('Failed to store message embedding', { error: (error as Error).message, messageId });
      return null;
    }
  }

  /** Update only the sentiment columns (used when sentiment is computed after the embedding is already stored). */
  async updateMessageSentiment(messageId: string, valence: number, arousal: number, dominance: number): Promise<void> {
    try {
      await this.pg.query(
        `UPDATE ${this.prefix}messages SET sentiment_valence = $2, sentiment_arousal = $3, sentiment_dominance = $4 WHERE id = $1`,
        [messageId, valence, arousal, dominance]
      );
    } catch (error) {
      this.logger.debug('Failed to update message sentiment', { error: (error as Error).message, messageId });
    }
  }

  /**
   * Every message from the sessions named, in chronological order.
   *
   * Used by session expansion. Returned with `similarity: 0` because these rows
   * were not ranked — they are neighbours of something that was, and reporting a
   * score for them would invent evidence of relevance.
   */
  async messagesInSessions(userId: string, sessionIds: string[]): Promise<SimilarMessage[]> {
    if (sessionIds.length === 0) return [];
    try {
      const rows = await this.pg.query<SimilarMessageRow>(
        `SELECT id, session_id, content, role, 0 AS similarity, created_at
           FROM ${this.prefix}messages
          WHERE user_id = $1 AND session_id = ANY($2::uuid[])
            AND content IS NOT NULL AND content <> ''
          ORDER BY created_at, id`,
        [userId, sessionIds],
      );
      return rows.map(row => ({
        messageId: row.id,
        sessionId: row.session_id,
        content: row.content,
        role: row.role,
        similarity: 0,
        createdAt: row.created_at,
      }));
    } catch (error) {
      this.logger.error('messagesInSessions failed', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Keyword arm of hybrid recall, bounded for PRECISION.
   *
   * The first version of this arm made retrieval measurably worse (70.0% ->
   * 66.7% tight, 73.3% -> 58.3% wide). It OR'd up to 25 terms with no relevance
   * floor, so a question naming "train", "airport" and "hotel" matched a large
   * weakly-related slice of the corpus — and because fusion works on RANK, that
   * slice entered the fused top-N and displaced rows the vector arm had ranked
   * well. It was a recall device where the point was precision. The vector arm
   * already provides recall; this arm exists only to catch what embeddings are
   * bad at, which is rare literal tokens.
   *
   * So it is bounded four ways:
   *
   *   1. NON-DISCRIMINATIVE TERMS ARE DROPPED. A term appearing in a large
   *      fraction of this user's messages carries no signal — matching it
   *      returns the corpus. Document frequency is measured against the user's
   *      own messages rather than assumed, because what is common depends
   *      entirely on who is talking.
   *   2. A RELATIVE RANK FLOOR. Rows below a fraction of the best rank in this
   *      arm are dropped. Relative, never absolute: `ts_rank` scales with
   *      document length and term frequency, so an absolute floor tuned here
   *      would silently fail on a corpus with different-length messages.
   *   3. A HARD CAP on how many rows the arm may contribute, independent of the
   *      caller's overall limit.
   *   4. A FUSION WEIGHT below 1 (applied by the caller), so a row the keyword
   *      arm alone likes cannot outrank one both arms like.
   *
   * Returns `similarity: 0` — ranked lexically, so reporting a cosine score
   * would be inventing a number. Rank order is what fusion consumes.
   */
  async searchMessagesByKeyword(
    userId: string, query: string, limit = KEYWORD_ARM_CAP, excludeSessionId?: string,
  ): Promise<SimilarMessage[]> {
    const candidates = Array.from(new Set(
      (query.match(/[a-zà-ÿ0-9]{3,}/gi) ?? []).map(t => t.toLowerCase()),
    )).slice(0, 25);
    if (candidates.length === 0) return [];

    try {
      const discriminative = await this.selectDiscriminativeTerms(userId, candidates);
      if (discriminative.length === 0) return [];

      const tsq = discriminative.join(' | ');
      const params: unknown[] = [userId, tsq];
      let sql = `
        WITH scored AS (
          SELECT id, session_id, content, role, created_at,
                 ts_rank(to_tsvector('english', content), to_tsquery('english', $2)) AS rank
            FROM ${this.prefix}messages
           WHERE user_id = $1
             AND content IS NOT NULL AND content <> ''
             AND to_tsvector('english', content) @@ to_tsquery('english', $2)
      `;
      if (excludeSessionId) {
        sql += ` AND session_id != $${params.length + 1}`;
        params.push(excludeSessionId);
      }
      // The floor is a FRACTION of this query's own best rank, so it travels
      // to corpora with different message lengths.
      sql += `
        )
        SELECT id, session_id, content, role, 0 AS similarity, created_at
          FROM scored
         WHERE rank >= (SELECT MAX(rank) FROM scored) * ${KEYWORD_RELATIVE_FLOOR}
         ORDER BY rank DESC
         LIMIT $${params.length + 1}`;
      params.push(Math.min(limit, KEYWORD_ARM_CAP));

      const rows = await this.pg.query<SimilarMessageRow>(sql, params);
      return rows.map(row => ({
        messageId: row.id,
        sessionId: row.session_id,
        content: row.content,
        role: row.role,
        similarity: 0,
        createdAt: row.created_at,
      }));
    } catch (error) {
      // An arm, not the whole of retrieval: degrade to vector-only.
      this.logger.warn('searchMessagesByKeyword failed', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Keep only the terms that actually narrow the search for THIS user.
   *
   * "Hotel" is discriminative for someone who mentions it twice and useless for
   * someone who books them weekly. Measuring against the user's own corpus is
   * the only way to tell, and it is one indexed query.
   */
  private async selectDiscriminativeTerms(userId: string, terms: string[]): Promise<string[]> {
    const rows = await this.pg.query<{ term: string; df: number; total: number }>(
      `WITH total AS (SELECT COUNT(*)::float AS n FROM ${this.prefix}messages WHERE user_id = $1)
       SELECT t AS term,
              (SELECT COUNT(*) FROM ${this.prefix}messages m
                WHERE m.user_id = $1
                  AND to_tsvector('english', m.content) @@ plainto_tsquery('english', t))::float AS df,
              (SELECT n FROM total) AS total
         FROM unnest($2::text[]) AS t`,
      [userId, terms],
    );

    const kept = rows
      .filter(r => r.total > 0 && r.df > 0 && (r.df / r.total) <= KEYWORD_MAX_DOC_FREQ)
      .sort((a, b) => a.df - b.df)
      .slice(0, KEYWORD_MAX_TERMS)
      .map(r => r.term);

    this.logger.debug('keyword arm terms', { candidates: terms.length, kept: kept.length });
    return kept;
  }

  /**
   * Search for semantically similar messages.
   *
   * Defaults match the benchmarked configuration (see BuildContextOptions):
   * depth 25, cosine floor 0.5. They were 5 and 0.25, which is shallower than
   * the losing arm of the k=8-vs-k=25 comparison.
   */
  async searchSimilarMessages(
    userId: string, query: string, limit = 25, threshold = 0.5,
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

  /**
   * Fetch adjacent turns (before and after) for the provided message hits
   * within the same session. Captures surrounding conversational dialogue
   * (e.g. Q&A pairs) without inflating the context to full sessions.
   */
  async fetchAdjacentMessages(
    userId: string,
    hits: Array<{ sessionId?: string; createdAt?: Date | string; messageId?: string }>,
    windowTurns = 1,
  ): Promise<SimilarMessage[]> {
    if (windowTurns <= 0 || !hits.length) return [];

    const validHits = hits.filter(h => h.sessionId && h.createdAt);
    if (!validHits.length) return [];

    const sessionIds = validHits.map(h => h.sessionId);
    const createdAts = validHits.map(h =>
      h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.createdAt)
    );

    try {
      const rows = await this.pg.query<SimilarMessageRow>(
        `WITH hits AS (
           SELECT unnest($1::uuid[]) AS session_id, unnest($2::timestamptz[]) AS created_at
         ),
         adjacent_before AS (
           SELECT m.id, m.session_id, m.content, m.role, m.created_at, 0.0::real as similarity
           FROM hits h
           CROSS JOIN LATERAL (
             SELECT id, session_id, content, role, created_at
             FROM ${this.prefix}messages
             WHERE user_id = $3 AND session_id = h.session_id AND created_at < h.created_at
             ORDER BY created_at DESC
             LIMIT $4
           ) m
         ),
         adjacent_after AS (
           SELECT m.id, m.session_id, m.content, m.role, m.created_at, 0.0::real as similarity
           FROM hits h
           CROSS JOIN LATERAL (
             SELECT id, session_id, content, role, created_at
             FROM ${this.prefix}messages
             WHERE user_id = $3 AND session_id = h.session_id AND created_at > h.created_at
             ORDER BY created_at ASC
             LIMIT $4
           ) m
         )
         SELECT DISTINCT ON (id) id, session_id, content, role, created_at, similarity
         FROM (
           SELECT * FROM adjacent_before
           UNION ALL
           SELECT * FROM adjacent_after
         ) combined`,
        [sessionIds, createdAts, userId, windowTurns],
      );

      return rows.map(row => ({
        messageId: row.id,
        sessionId: row.session_id,
        content: row.content,
        role: row.role,
        similarity: 0,
        createdAt: row.created_at,
      }));
    } catch (error) {
      this.logger.error('fetchAdjacentMessages failed', { error: (error as Error).message });
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

/**
 * Diversify candidate messages across sessions so no single session dominates the quota.
 */
export function diversifyBySession<T extends { sessionId?: string }>(
  hits: T[],
  limit: number,
  maxPerSession = 4,
): T[] {
  if (hits.length <= limit && maxPerSession <= 0) return hits;
  const counts = new Map<string, number>();
  const selected: T[] = [];
  const deferred: T[] = [];

  for (const h of hits) {
    const sid = h.sessionId || '__no_session__';
    const c = counts.get(sid) ?? 0;
    if (maxPerSession > 0 && c >= maxPerSession) {
      deferred.push(h);
    } else {
      counts.set(sid, c + 1);
      selected.push(h);
      if (selected.length >= limit) return selected;
    }
  }

  for (const h of deferred) {
    selected.push(h);
    if (selected.length >= limit) break;
  }

  return selected;
}

