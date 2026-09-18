import type { RedisClient } from '../db/redis.js';
import type { Logger } from '../types.js';

export interface DroppedMemoryItem {
  type: 'fact' | 'message' | 'conversation' | 'learning';
  key: string;
  content: string;
  score: number;
  timestamp: number;
}

const DROPPED_MEMORIES_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (session lifetime)
const MAX_DROPPED_PER_SESSION = 200;

/**
 * Curator Rejection Ledger Service
 *
 * Persists and queries candidate memories dropped by the pre-reply curator
 * (curateMemory / TypeSafe System One) on a session-persistent Redis buffer
 * with an in-memory fallback.
 *
 * Implements:
 * 1. The Ring: In-band count seen at token 0 as context is injected.
 * 2. The Look: Topic-based query over session history, filtering by topic/keywords
 *    regardless of score. Jev's probability score is reported as metadata on the item.
 * 3. Session-persistent buffer (TTL 7d) allowing turns later in a session to
 *    query what earlier turns dropped.
 */
export class CuratorRejectionService {
  private redis: RedisClient | null;
  private prefix: string;
  private logger: Logger;
  private memoryFallback = new Map<string, DroppedMemoryItem[]>();

  constructor(redis: RedisClient | null, prefix: string, logger: Logger) {
    this.redis = redis;
    this.prefix = prefix;
    this.logger = logger;
  }

  getDroppedKey(sessionId: string): string {
    return `${this.prefix}curation:dropped:${sessionId}`;
  }

  /**
   * Record dropped candidate memories for a session.
   */
  async recordDroppedMemories(
    sessionId: string,
    items: DroppedMemoryItem[],
  ): Promise<void> {
    if (!sessionId || items.length === 0) return;

    // Always maintain in-memory fallback
    const existing = this.memoryFallback.get(sessionId) ?? [];
    const updated = [...existing, ...items].slice(-MAX_DROPPED_PER_SESSION);
    this.memoryFallback.set(sessionId, updated);

    if (!this.redis) return;

    try {
      const key = this.getDroppedKey(sessionId);
      const serialized = items.map(item => JSON.stringify(item));
      await this.redis.client.rpush(key, ...serialized);
      await this.redis.client.ltrim(key, -MAX_DROPPED_PER_SESSION, -1);
      await this.redis.client.expire(key, DROPPED_MEMORIES_TTL_SECONDS);
    } catch (error) {
      this.logger.warn('Failed to record dropped memories to Redis', {
        sessionId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Query dropped memories for a session, filtered by topic / keywords (NOT score).
   */
  async getDroppedMemories(
    sessionId: string,
    query?: string,
    limit = 20,
  ): Promise<DroppedMemoryItem[]> {
    if (!sessionId) return [];

    let items: DroppedMemoryItem[] = [];

    if (this.redis) {
      try {
        const key = this.getDroppedKey(sessionId);
        const raw = await this.redis.client.lrange(key, 0, -1);
        if (raw && raw.length > 0) {
          for (let i = raw.length - 1; i >= 0; i--) {
            try {
              items.push(JSON.parse(raw[i]));
            } catch {
              // skip malformed
            }
          }
        }
      } catch (error) {
        this.logger.warn('Failed to get dropped memories from Redis, falling back to memory', {
          sessionId,
          error: (error as Error).message,
        });
      }
    }

    if (items.length === 0) {
      const mem = this.memoryFallback.get(sessionId) ?? [];
      items = [...mem].reverse();
    }

    if (!query || !query.trim()) {
      return items.slice(0, limit);
    }

    const searchTerms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const filtered = items.filter(item => {
      const target = `${item.key} ${item.content}`.toLowerCase();
      return searchTerms.some(term => target.includes(term));
    });

    return filtered.slice(0, limit);
  }

  /**
   * Format dropped memories for display or tool response.
   */
  formatDroppedMemoriesForResponse(
    items: DroppedMemoryItem[],
    query?: string,
  ): string {
    if (items.length === 0) {
      return query
        ? `No memories were dropped by the curator matching "${query}".`
        : 'No memories have been dropped by the curator in this session.';
    }

    const header = query
      ? `${items.length} memor${items.length === 1 ? 'y' : 'ies'} dropped by the curator matching "${query}" (newest first):`
      : `${items.length} most recent memor${items.length === 1 ? 'y' : 'ies'} dropped by the curator in this session (newest first):`;

    const lines = items.map(item => {
      const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
      const keyPrefix = item.key ? `[${item.key}] ` : '';
      return `- [${typeLabel} | p=${item.score.toFixed(2)}] ${keyPrefix}${item.content}`;
    });

    return `${header}\n\n${lines.join('\n')}`;
  }
}
