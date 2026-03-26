import type { PgClient } from '../db/postgres.js';
import type { Logger } from '../types.js';

/**
 * Pruner - handles stale data cleanup during consolidation.
 */
export class Pruner {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Expire old behavioral observations. */
  async expireBehavioral(maxAgeDays = 7): Promise<number> {
    try {
      const result = await this.pg.query<{ count: string }>(
        `WITH expired AS (
           UPDATE ${this.prefix}behavioral_observations
           SET expired = TRUE
           WHERE expired = FALSE AND created_at < NOW() - INTERVAL '1 day' * $1
           RETURNING id
         )
         SELECT COUNT(*) as count FROM expired`,
        [maxAgeDays]
      );
      const count = parseInt(result[0]?.count ?? '0', 10);
      if (count > 0) {
        this.logger.info('Expired behavioral observations', { count });
      }
      return count;
    } catch (error) {
      this.logger.error('expireBehavioral failed', { error: (error as Error).message });
      return 0;
    }
  }

  /** Prune low-confidence semantic knowledge. */
  async pruneSemanticKnowledge(minConfidence = 0.3): Promise<number> {
    try {
      const result = await this.pg.query<{ count: string }>(
        `WITH pruned AS (
           DELETE FROM ${this.prefix}semantic_knowledge
           WHERE confidence < $1
           RETURNING id
         )
         SELECT COUNT(*) as count FROM pruned`,
        [minConfidence]
      );
      const count = parseInt(result[0]?.count ?? '0', 10);
      if (count > 0) {
        this.logger.info('Pruned low-confidence semantic knowledge', { count, minConfidence });
      }
      return count;
    } catch (error) {
      this.logger.error('pruneSemanticKnowledge failed', { error: (error as Error).message });
      return 0;
    }
  }

  /** Expire temporary facts past their valid_until date. */
  async expireTemporaryFacts(): Promise<number> {
    try {
      const result = await this.pg.query<{ count: string }>(
        `WITH expired AS (
           UPDATE ${this.prefix}facts
           SET fact_status = 'expired', updated_at = NOW()
           WHERE fact_type = 'temporary'
             AND fact_status = 'active'
             AND valid_until IS NOT NULL
             AND valid_until <= NOW()
           RETURNING id
         )
         SELECT COUNT(*) as count FROM expired`
      );
      const count = parseInt(result[0]?.count ?? '0', 10);
      if (count > 0) {
        this.logger.info('Expired temporary facts', { count });
      }
      return count;
    } catch (error) {
      this.logger.error('expireTemporaryFacts failed', { error: (error as Error).message });
      return 0;
    }
  }
}
