import type { RedisClient } from '../db/redis.js';
import type { Logger } from '../types.js';

const CENTROID_PREFIX = 'bwmem:centroid:';
const CENTROID_TTL = 60 * 60 * 8; // 8 hours
const ALPHA = 0.3; // EMA decay factor

export class CentroidService {
  private redis: RedisClient;
  private logger: Logger;

  constructor(redis: RedisClient, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  /** Update the rolling centroid for a session with a new embedding. */
  async update(sessionId: string, embedding: number[]): Promise<number[]> {
    const key = `${CENTROID_PREFIX}${sessionId}`;

    try {
      const existing = await this.redis.get(key);

      let centroid: number[];
      if (existing) {
        const prev: number[] = JSON.parse(existing);
        centroid = embedding.map((val, i) => ALPHA * val + (1 - ALPHA) * (prev[i] || 0));
      } else {
        centroid = [...embedding];
      }

      await this.redis.set(key, JSON.stringify(centroid), CENTROID_TTL);
      return centroid;
    } catch (error) {
      this.logger.debug('Centroid update failed', { error: (error as Error).message });
      return embedding;
    }
  }

  /** Get current centroid without updating. */
  async get(sessionId: string): Promise<number[] | null> {
    try {
      const data = await this.redis.get(`${CENTROID_PREFIX}${sessionId}`);
      if (!data) return null;
      return JSON.parse(data) as number[];
    } catch {
      return null;
    }
  }

  /** Clear centroid for a session (on session end). */
  async clear(sessionId: string): Promise<void> {
    try {
      await this.redis.del(`${CENTROID_PREFIX}${sessionId}`);
    } catch {
      // non-critical
    }
  }
}
