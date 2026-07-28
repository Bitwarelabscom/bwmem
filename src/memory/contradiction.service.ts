import type { PgClient } from '../db/postgres.js';
import type { Logger, ContradictionSignal, InlineContradiction, Fact } from '../types.js';
import { getConceptTokens, getSemantics } from './fact-semantics.js';
import { isVolatileFactKey } from './facts.service.js';

/**
 * Common words that start with uppercase but aren't entity names. Used to
 * keep the inline contradiction scan from firing on "I", "My", "The", "Hey",
 * etc. — a key class of false positive when reading capitalized sentence
 * starts as candidate "the user just named something different."
 */
const INLINE_STOPWORDS = new Set([
  'I', 'My', 'The', 'This', 'That', 'These', 'Those', 'Here', 'There',
  'What', 'When', 'Where', 'Who', 'How', 'Why', 'Which',
  'And', 'But', 'Or', 'So', 'Yet', 'Not', 'No', 'Yes',
  'Can', 'Could', 'Would', 'Should', 'Will', 'Did', 'Does', 'Do',
  'Is', 'Are', 'Was', 'Were', 'Am', 'Been', 'Being',
  'Has', 'Have', 'Had', 'Just', 'Also', 'Very', 'Really',
  'Hey', 'Hi', 'Hello', 'Ok', 'Okay', 'Well', 'Yeah', 'Yep',
  'Maybe', 'Actually', 'Basically', 'Today', 'Now', 'Still',
  'Thanks', 'Please', 'Sure', 'Right', 'Like', 'Its',
]);

const INLINE_RELEVANT_CATEGORIES = new Set(['relationship', 'personal', 'context']);

export class ContradictionService {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
  }

  /**
   * Create a contradiction signal. Caller is expected to filter volatile keys
   * with {@link isVolatileFactKey} before invoking — but we double-check here
   * because the fact path is not the only caller, and a volatile-key signal is
   * pure noise no matter where it originated.
   */
  async createSignal(
    userId: string, sessionId: string | undefined, factKey: string,
    userStated: string, storedValue: string,
    signalType: 'correction' | 'misremember',
  ): Promise<void> {
    if (isVolatileFactKey(factKey)) {
      this.logger.debug('Skipped contradiction signal on volatile key', { factKey });
      return;
    }
    try {
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
        [userId, sessionId ?? null, factKey, userStated.slice(0, 500), storedValue.slice(0, 500), signalType]
      );

      this.logger.debug('Contradiction signal created', { userId, factKey, signalType });
    } catch (error) {
      this.logger.error('createSignal failed', { error: (error as Error).message });
    }
  }

  /**
   * Get unsurfaced contradictions for a user, deduplicated per fact_key. Only
   * the most recent signal per key is returned, so repeated supersessions of
   * the same fact do not flood the prompt with "you said X but stored Y" lines.
   */
  async getUnsurfaced(userId: string, sessionId?: string, limit = 3): Promise<ContradictionSignal[]> {
    try {
      const params: unknown[] = [userId];
      let sql = `
        SELECT DISTINCT ON (fact_key)
          id, user_id, session_id, fact_key, user_stated, stored_value,
          signal_type, surfaced, surfaced_session_ids, created_at
        FROM ${this.prefix}contradiction_signals
        WHERE user_id = $1 AND surfaced = FALSE
      `;

      if (sessionId) {
        sql += ` AND NOT ($${params.length + 1}::uuid = ANY(surfaced_session_ids))`;
        params.push(sessionId);
      }

      sql += ` ORDER BY fact_key, created_at DESC LIMIT $${params.length + 1}`;
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

  /**
   * Real-time contradiction scan against stored facts. Pure-synchronous,
   * zero I/O, no LLM call — runs on every message ingestion. Fires when the
   * message mentions a concept token for a well-established fact but uses a
   * different value than what's stored.
   *
   * This complements the async {@link createSignal} path (which only fires
   * on actual supersession in {@link FactsService.storeFact}) by catching
   * "you said X" before extraction even runs.
   */
  detectInline(message: string, facts: Fact[]): InlineContradiction[] {
    const contradictions: InlineContradiction[] = [];
    const messageLower = message.toLowerCase();
    const messageWords = messageLower.split(/\s+/);

    // Candidate "user-named values": capitalized words, minus the stopwords
    // (sentence starts, pronouns, greetings).
    const capitalizedWords = message
      .split(/\s+/)
      .map(w => w.replace(/[.,!?;:'"()]/g, ''))
      .filter(w => /^[A-Z][a-z]/.test(w) && !INLINE_STOPWORDS.has(w) && w.length >= 2);

    if (capitalizedWords.length === 0) return [];

    for (const fact of facts) {
      if (!INLINE_RELEVANT_CATEGORIES.has(fact.category)) continue;
      // Volatile keys vary as a matter of life — never a contradiction.
      if (isVolatileFactKey(fact.factKey)) continue;

      // Name-type facts (pet_name, etc.) worth checking even at mentionCount 1;
      // others need >=2 to dampen weak extractions.
      const hasSemantic = !!getSemantics(fact.factKey);
      if (!hasSemantic && fact.mentionCount < 2) continue;

      const conceptTokens = getConceptTokens(fact.factKey);
      const conceptMatch = conceptTokens.some(token => messageWords.includes(token.toLowerCase()));
      if (!conceptMatch) continue;

      // If the stored value IS in the message, no contradiction — they're
      // confirming, not changing.
      if (messageLower.includes(fact.factValue.toLowerCase())) continue;

      for (const candidate of capitalizedWords) {
        if (candidate.toLowerCase() === fact.factValue.toLowerCase()) continue;
        contradictions.push({
          factKey: fact.factKey,
          factCategory: fact.category,
          storedValue: fact.factValue,
          suspectedValue: candidate,
        });
        break;
      }
    }

    return contradictions;
  }

  /** Format inline contradictions for LLM context — same gentle frame as the persisted signals. */
  formatInline(contradictions: InlineContradiction[]): string {
    if (contradictions.length === 0) return '';
    return contradictions
      .map(c =>
        `- You remember "${c.factKey}" as "${c.storedValue}", but they just said "${c.suspectedValue}". ` +
        `If it comes up naturally, gently mention what you recall — not as a correction, but as memory.`,
      )
      .join('\n');
  }

  /** Format contradictions for LLM context. */
  formatForPrompt(signals: ContradictionSignal[]): string {
    if (signals.length === 0) return '';
    return signals
      .map(s => `- ${s.factKey}: user said "${s.userStated}" but stored "${s.storedValue}" (${s.signalType})`)
      .join('\n');
  }
}
