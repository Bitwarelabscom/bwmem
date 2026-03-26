import type { PgClient } from '../db/postgres.js';
import type { Logger, ContradictionSignal } from '../types.js';

export class ContradictionService {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Create a contradiction signal when user states something conflicting with stored facts. */
  async createSignal(
    userId: string, sessionId: string | undefined, factKey: string,
    userStated: string, storedValue: string,
    signalType: 'correction' | 'misremember',
  ): Promise<void> {
    try {
      // Dedup: don't create duplicate signals for the same fact_key in the same session
      const existing = await this.pg.queryOne<{ id: string }>(
        `SELECT id FROM ${this.prefix}contradiction_signals
         WHERE user_id = $1 AND fact_key = $2 AND session_id = $3`,
        [userId, factKey, sessionId ?? null]
      );

      if (existing) {
        this.logger.debug('Contradiction signal already exists', { factKey, sessionId });
        return;
      }

      await this.pg.query(
        `INSERT INTO ${this.prefix}contradiction_signals
          (user_id, session_id, fact_key, user_stated, stored_value, signal_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, sessionId ?? null, factKey, userStated, storedValue, signalType]
      );

      this.logger.debug('Contradiction signal created', { userId, factKey, signalType });
    } catch (error) {
      this.logger.error('createSignal failed', { error: (error as Error).message });
    }
  }

  /** Get unsurfaced contradictions for a user, optionally excluding already-surfaced-in-session. */
  async getUnsurfaced(userId: string, sessionId?: string, limit = 3): Promise<ContradictionSignal[]> {
    try {
      let sql = `
        SELECT id, user_id, session_id, fact_key, user_stated, stored_value,
               signal_type, surfaced, surfaced_session_ids, created_at
        FROM ${this.prefix}contradiction_signals
        WHERE user_id = $1 AND surfaced = FALSE
      `;
      const params: unknown[] = [userId];

      if (sessionId) {
        sql += ` AND NOT ($2 = ANY(surfaced_session_ids))`;
        params.push(sessionId);
      }

      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(row => ({
        id: row.id as string,
        userId: row.user_id as string,
        sessionId: row.session_id as string | undefined,
        factKey: row.fact_key as string,
        userStated: row.user_stated as string,
        storedValue: row.stored_value as string,
        signalType: row.signal_type as ContradictionSignal['signalType'],
        surfaced: row.surfaced as boolean,
        surfacedSessionIds: (row.surfaced_session_ids as string[]) ?? [],
        createdAt: row.created_at as Date,
      }));
    } catch (error) {
      this.logger.error('getUnsurfaced failed', { error: (error as Error).message });
      return [];
    }
  }

  /** Mark contradictions as surfaced in a session. */
  async markSurfaced(ids: string[], sessionId: string): Promise<void> {
    if (ids.length === 0) return;

    try {
      await this.pg.query(
        `UPDATE ${this.prefix}contradiction_signals
         SET surfaced_session_ids = array_append(surfaced_session_ids, $1::uuid),
             surfaced = CASE WHEN array_length(surfaced_session_ids, 1) >= 2 THEN TRUE ELSE surfaced END
         WHERE id = ANY($2::uuid[])`,
        [sessionId, ids]
      );
    } catch (error) {
      this.logger.error('markSurfaced failed', { error: (error as Error).message });
    }
  }

  /** Format contradictions for LLM context. */
  formatForPrompt(signals: ContradictionSignal[]): string {
    if (signals.length === 0) return '';
    return signals
      .map(s => `- ${s.factKey}: user said "${s.userStated}" but stored "${s.storedValue}" (${s.signalType})`)
      .join('\n');
  }
}
