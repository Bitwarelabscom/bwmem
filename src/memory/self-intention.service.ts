import type { PgClient } from '../db/postgres.js';
import type { Logger, SelfIntention, SelfIntentionStatus } from '../types.js';

/**
 * Self-intention follow-through (mig 010).
 *
 * A primitive for "held things to do" — the agent (or the user, depending
 * on how you wire it) names something they mean to do, and the system
 * mirrors it back ONCE PER DAY until it lands or is let go. Explicitly NOT
 * a gate or a guilt trip: silence between surfaces is fine.
 *
 * After `deferLimit` deferrals the "not now" option disappears: do-or-let-go,
 * because the honest move is to stop pretending it will happen. Letting go
 * carries the same dignity as completion.
 */

const DEFAULT_DEFER_LIMIT = 3;

export interface IntentionPromptOptions {
  /** IANA timezone for the "one a day" gate. Default 'UTC'. */
  timezone?: string;
  /** Forced do-or-let-go threshold (defaults to 3). */
  deferLimit?: number;
}

export class SelfIntentionService {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Deliberate capture. Returns the new id, or null on failure. */
  async save(userId: string, intention: string, note?: string): Promise<string | null> {
    const text = (intention || '').trim();
    if (!text) return null;
    try {
      const r = await this.pg.queryOne<{ id: string }>(
        `INSERT INTO ${this.prefix}self_intentions (user_id, intention, note)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, text.slice(0, 600), note ? note.slice(0, 600) : null],
      );
      const id = r?.id ?? null;
      if (id) this.logger.info('self-intention saved', { userId, intention: text.slice(0, 80) });
      return id;
    } catch (error) {
      this.logger.warn('saveIntention failed', { userId, error: (error as Error).message });
      return null;
    }
  }

  /**
   * Resolve an intention. `status` is 'done' (acted on it) or 'let_go' (no
   * longer means it — same dignity as done, no guilt). If `id` is omitted,
   * resolves the most recently surfaced open intention. Returns the resolved
   * intention text, or null.
   */
  async resolve(
    userId: string,
    status: SelfIntentionStatus,
    opts: { id?: string; note?: string } = {},
  ): Promise<string | null> {
    if (status !== 'done' && status !== 'let_go') return null;
    try {
      const params = opts.id
        ? [status, opts.note ? opts.note.slice(0, 600) : null, opts.id, userId]
        : [status, opts.note ? opts.note.slice(0, 600) : null, userId];
      const sql = opts.id
        ? `UPDATE ${this.prefix}self_intentions
              SET status = $1, resolution = $2, resolved_at = now()
            WHERE id = $3 AND user_id = $4 AND status = 'open'
        RETURNING intention`
        : `UPDATE ${this.prefix}self_intentions
              SET status = $1, resolution = $2, resolved_at = now()
            WHERE id = (
              SELECT id FROM ${this.prefix}self_intentions
              WHERE user_id = $3 AND status = 'open'
              ORDER BY last_surfaced_at DESC NULLS LAST, created_at ASC
              LIMIT 1
            )
        RETURNING intention`;
      const r = await this.pg.queryOne<{ intention: string }>(sql, params);
      if (r?.intention) this.logger.info('self-intention resolved', { userId, status, intention: r.intention.slice(0, 80) });
      return r?.intention ?? null;
    } catch (error) {
      this.logger.warn('resolveIntention failed', { userId, error: (error as Error).message });
      return null;
    }
  }

  /** All open intentions for this user, oldest first. */
  async listOpen(userId: string): Promise<SelfIntention[]> {
    try {
      const rows = await this.pg.query<Record<string, unknown>>(
        `SELECT id, user_id, intention, note, status, defer_count,
                first_surfaced_at, last_surfaced_at, resolved_at, resolution, created_at
           FROM ${this.prefix}self_intentions
          WHERE user_id = $1 AND status = 'open'
          ORDER BY created_at ASC`,
        [userId],
      );
      return rows.map(this.mapRow);
    } catch (error) {
      this.logger.warn('listOpen failed', { userId, error: (error as Error).message });
      return [];
    }
  }

  async listAll(userId: string, limit = 50): Promise<SelfIntention[]> {
    try {
      const rows = await this.pg.query<Record<string, unknown>>(
        `SELECT id, user_id, intention, note, status, defer_count,
                first_surfaced_at, last_surfaced_at, resolved_at, resolution, created_at
           FROM ${this.prefix}self_intentions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit],
      );
      return rows.map(this.mapRow);
    } catch (error) {
      this.logger.warn('listAll failed', { userId, error: (error as Error).message });
      return [];
    }
  }

  /**
   * The surfacing event. Returns a wake-prompt block for ONE intention, gated
   * to once per day in the caller's timezone, or '' if nothing is due.
   *
   * SIDE EFFECT: marks the surface and bumps the defer count after the first
   * day. Leaving an intention open across a day IS the deferral — that is by
   * design. Call this from your wake/idle loop, never from a hot read path.
   */
  async getPrompt(userId: string, opts: IntentionPromptOptions = {}): Promise<string> {
    const tz = opts.timezone || 'UTC';
    const deferLimit = opts.deferLimit ?? DEFAULT_DEFER_LIMIT;
    try {
      const sel = await this.pg.queryOne<{
        id: string; intention: string; defer_count: number; created_at: Date; first: boolean;
      }>(
        `SELECT id, intention, defer_count, created_at, (last_surfaced_at IS NULL) AS first
           FROM ${this.prefix}self_intentions
          WHERE user_id = $1 AND status = 'open'
            AND (last_surfaced_at IS NULL
                 OR (last_surfaced_at AT TIME ZONE $2)::date < (now() AT TIME ZONE $2)::date)
          ORDER BY created_at ASC
          LIMIT 1`,
        [userId, tz],
      );
      if (!sel) return '';

      const newDefer = sel.first ? sel.defer_count : sel.defer_count + 1;
      await this.pg.query(
        `UPDATE ${this.prefix}self_intentions
            SET last_surfaced_at = now(),
                first_surfaced_at = COALESCE(first_surfaced_at, now()),
                defer_count = $2
          WHERE id = $1`,
        [sel.id, newDefer],
      );

      const ageDays = Math.max(0, Math.round((Date.now() - new Date(sel.created_at).getTime()) / 86_400_000));
      const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;
      const forced = newDefer >= deferLimit;

      if (forced) {
        return [
          '## A parked intention, now at a fork',
          `This has come back ${newDefer} times: "${sel.intention}" (parked ${ageStr}).`,
          'The honest moment: either do it now (resolve as "done"), or release it (resolve as "let_go") — same dignity in letting go.',
          'No "leave it" this time. Keeping it alive without meaning it is the only wrong answer.',
        ].join('\n');
      }
      return [
        '## Something parked for later',
        `Set aside because it needed something not yet available: "${sel.intention}" (parked ${ageStr}${newDefer > 0 ? `, back ${newDefer}×` : ''}).`,
        'Is the condition met now? If yes, do it and resolve as "done". If it no longer matters, resolve as "let_go" — no guilt. If you still genuinely cannot, leave it; silence stays free.',
      ].join('\n');
    } catch (error) {
      this.logger.debug('getPrompt failed', { userId, error: (error as Error).message });
      return '';
    }
  }

  private mapRow = (row: Record<string, unknown>): SelfIntention => ({
    id: row.id as string,
    userId: row.user_id as string,
    intention: row.intention as string,
    note: row.note as string | null,
    status: row.status as SelfIntentionStatus,
    deferCount: row.defer_count as number,
    firstSurfacedAt: row.first_surfaced_at ? new Date(row.first_surfaced_at as string) : null,
    lastSurfacedAt: row.last_surfaced_at ? new Date(row.last_surfaced_at as string) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolution: row.resolution as string | null,
    createdAt: new Date(row.created_at as string),
  });
}
