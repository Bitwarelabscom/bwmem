import type { PgClient } from '../db/postgres.js';
import type {
  Logger, ContradictionSignal, ContradictionDecision, ContradictionStatus,
  InlineContradiction, Fact,
} from '../types.js';
import { getConceptTokens, getSemantics } from './fact-semantics.js';
import { isVolatileFactKey } from './facts.service.js';
import type { ParaphraseGate } from './paraphrase-gate.service.js';

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

/** Past a handful this is an interrogation, not a memory check. */
const MAX_INLINE_CONTRADICTIONS = 3;

/**
 * How far a candidate value may sit from the concept token it supposedly
 * contradicts. Roughly one clause — beyond that the two are beside each other
 * by coincidence.
 */
const INLINE_PROXIMITY_WORDS = 8;

export class ContradictionService {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  /**
   * Inline detection is OPT-IN and defaults OFF.
   *
   * It is a heuristic over capitalized words with no model behind it, and its
   * failure mode is loud: it produced 35 phantom contradictions on a single
   * message before the cap and proximity rule below. Even fixed it is a
   * best-effort hint, so a consumer has to ask for it deliberately rather than
   * inherit it from a default.
   */
  private inlineEnabled: boolean;

  /**
   * Decides whether a supersession is real drift or the same claim reworded.
   * Optional: absent, every supersession files a signal, which is 0.3.0
   * behaviour and the reason the counter climbed on a stable memory.
   */
  private paraphraseGate: ParaphraseGate | null;

  constructor(
    pg: PgClient, prefix: string, logger: Logger,
    inlineEnabled = false,
    paraphraseGate: ParaphraseGate | null = null,
  ) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
    this.inlineEnabled = inlineEnabled;
    this.paraphraseGate = paraphraseGate;
  }

  /**
   * File a misremember signal unless the two values are the same claim reworded.
   *
   * This is the entry point the fact path should use. Without the gate every
   * rewording files a contradiction, and any consumer reading the count as a
   * rate reports drifting recall over a memory that never moved.
   */
  async createMisrememberSignal(
    userId: string, sessionId: string | undefined, factKey: string,
    userStated: string, storedValue: string,
  ): Promise<{ filed: boolean; path: string }> {
    if (!this.paraphraseGate) {
      await this.createSignal(userId, sessionId, factKey, userStated, storedValue, 'misremember');
      return { filed: true, path: 'no_gate' };
    }

    const verdict = await this.paraphraseGate.isSemanticParaphrase(factKey, userStated, storedValue);
    if (verdict.paraphrase) {
      this.logger.debug('contradiction suppressed as paraphrase', {
        factKey, path: verdict.path, similarity: verdict.similarity,
      });
      return { filed: false, path: verdict.path };
    }

    await this.createSignal(
      userId, sessionId, factKey, userStated, storedValue, 'misremember',
      { path: verdict.path, similarity: verdict.similarity, reason: verdict.reason },
    );
    return { filed: true, path: verdict.path };
  }

  /**
   * The capitalized word closest to a concept token for this fact, or null.
   *
   * "Closest" is the whole point: a message can name several proper nouns, and
   * pairing a fact with an unrelated one two clauses away is how the detector
   * invented contradictions the user never implied.
   */
  private nearestCandidate(
    messageWords: string[],
    candidates: string[],
    conceptTokens: string[],
  ): string | null {
    const conceptAt = messageWords.findIndex((w) =>
      conceptTokens.some((t) => w.includes(t.toLowerCase())));
    if (conceptAt === -1) return null;

    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const at = messageWords.findIndex((w) => w.includes(candidate.toLowerCase()));
      if (at === -1) continue;
      const distance = Math.abs(at - conceptAt);
      if (distance <= INLINE_PROXIMITY_WORDS && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
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
    gate?: { path: string; similarity?: number; reason?: string },
  ): Promise<void> {
    if (isVolatileFactKey(factKey)) {
      this.logger.debug('Skipped contradiction signal on volatile key', { factKey });
      return;
    }
    try {
      // Upsert on (user_id, fact_key, md5(stored_value)) WHERE status = 'open'.
      //
      // The old guard was per-SESSION, which only suppressed repeats inside one
      // conversation — the case that matters least. Across sessions, one stale
      // fact that came up eight times became eight rows, and anything reading
      // the count as a rate reported "recall is drifting" when exactly one fact
      // was out of date.
      //
      // Keyed on `status` since 017, not on `surfaced`: a signal used to fall
      // out of this guard the moment it had been DISPLAYED twice, so the ninth
      // sighting of the same unresolved disagreement opened a second row and the
      // counter started over. An open disagreement now stays one row until
      // somebody actually decides it.
      //
      // created_at is deliberately NOT touched on conflict: it is the FIRST
      // sighting, and "this has been wrong since Tuesday" is only answerable if
      // it survives. last_seen_at carries recency instead.
      //
      // The gate verdict IS refreshed — the latest judgement is the most
      // informed one, and a stale reason is worse than none.
      await this.pg.query(
        `INSERT INTO ${this.prefix}contradiction_signals
          (user_id, session_id, fact_key, user_stated, stored_value, signal_type,
           gate_path, gate_similarity, gate_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, fact_key, md5(stored_value)) WHERE status = 'open'
         DO UPDATE SET
           repeat_count    = ${this.prefix}contradiction_signals.repeat_count + 1,
           last_seen_at    = NOW(),
           user_stated     = EXCLUDED.user_stated,
           gate_path       = EXCLUDED.gate_path,
           gate_similarity = EXCLUDED.gate_similarity,
           gate_reason     = EXCLUDED.gate_reason`,
        [
          userId, sessionId ?? null, factKey,
          userStated.slice(0, 500), storedValue.slice(0, 500), signalType,
          gate?.path ?? null,
          typeof gate?.similarity === 'number' && gate.similarity >= 0 ? gate.similarity : null,
          gate?.reason ? gate.reason.slice(0, 300) : null,
        ]
      );

      this.logger.debug('Contradiction signal recorded', {
        userId, factKey, signalType, gatePath: gate?.path,
      });
    } catch (error) {
      this.logger.error('createSignal failed', { error: (error as Error).message });
    }
  }

  /**
   * Reopen holds that events have overtaken.
   *
   * A hold is a "not now", not a verdict, so it is scoped to the value it was
   * taken against. Once the live fact no longer says what it said when the row
   * was held, the reason for holding is gone and the signal goes back to open.
   * Without this a hold is indistinguishable from a resolve: both make the row
   * disappear, and only one of them was a decision.
   *
   * Runs on the read path so a caller cannot forget it. The partial index on
   * (user_id, fact_key) WHERE status = 'held' keeps it an index probe, and the
   * common case updates nothing.
   */
  async lapseStaleHolds(userId: string): Promise<number> {
    try {
      const rows = await this.pg.query<{ id: string }>(
        `UPDATE ${this.prefix}contradiction_signals c
            SET status        = 'open',
                held_at       = NULL,
                hold_reason   = NULL,
                held_at_value = NULL
          WHERE c.user_id = $1
            AND c.status = 'held'
            AND NOT EXISTS (
              SELECT 1 FROM ${this.prefix}facts f
               WHERE f.user_id = c.user_id
                 AND f.fact_key = c.fact_key
                 AND f.fact_status = 'active'
                 AND f.fact_value IS NOT DISTINCT FROM c.held_at_value
            )
        RETURNING c.id`,
        [userId],
      );
      if (rows.length > 0) {
        this.logger.debug('contradiction holds lapsed', { userId, count: rows.length });
      }
      return rows.length;
    } catch (error) {
      this.logger.error('lapseStaleHolds failed', { error: (error as Error).message });
      return 0;
    }
  }

  /**
   * Open contradictions for a user, deduplicated per fact_key. Only the most
   * recent signal per key is returned, so repeated supersessions of the same
   * fact do not flood the prompt with "you said X but stored Y" lines.
   *
   * Filters on `status`, not on `surfaced`. Those are different axes and
   * treating the display flag as the lifecycle is what 017 removed.
   */
  async getOpen(userId: string, sessionId?: string, limit = 3): Promise<ContradictionSignal[]> {
    try {
      await this.lapseStaleHolds(userId);

      const params: unknown[] = [userId];
      let sql = `
        SELECT DISTINCT ON (fact_key)
          id, user_id, session_id, fact_key, user_stated, stored_value,
          signal_type, status, decision, resolution, resolved_at,
          held_at, hold_reason, surfaced, surfaced_session_ids, created_at
        FROM ${this.prefix}contradiction_signals
        WHERE user_id = $1 AND status = 'open'
      `;

      if (sessionId) {
        sql += ` AND NOT ($${params.length + 1}::uuid = ANY(surfaced_session_ids))`;
        params.push(sessionId);
      }

      sql += ` ORDER BY fact_key, created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(mapSignal);
    } catch (error) {
      this.logger.error('getOpen failed', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * @deprecated Renamed to {@link getOpen} in 0.7.0. The old name described the
   * filter it used to apply — "unsurfaced" — and that filter was the bug: it
   * read a display flag as a lifecycle state. Kept as a delegating alias so
   * 0.6.x callers keep working; it now returns OPEN signals, which is what
   * every caller meant.
   */
  async getUnsurfaced(userId: string, sessionId?: string, limit = 3): Promise<ContradictionSignal[]> {
    return this.getOpen(userId, sessionId, limit);
  }

  /**
   * Record that these signals were shown to the user in this session.
   *
   * This writes DISPLAY bookkeeping and nothing else. It used to also flip
   * `surfaced = TRUE` after two sessions, which was the only exit the queue
   * had — a signal looked at twice and ignored left by the same door as one
   * that had been dealt with, and the second door did not exist.
   *
   * Shown-twice now takes a HOLD, which is honest about what happened (nobody
   * decided anything) and, unlike the old permanent flag, lapses the moment the
   * underlying fact moves. The anti-flood property is kept; the lie is not.
   */
  async markSurfaced(ids: string[], sessionId: string): Promise<void> {
    if (ids.length === 0) return;

    try {
      await this.pg.query(
        `UPDATE ${this.prefix}contradiction_signals
         SET surfaced_session_ids = array_append(surfaced_session_ids, $1::uuid),
             surfaced = TRUE,
             status = CASE
               WHEN status = 'open' AND array_length(surfaced_session_ids, 1) >= 2
               THEN 'held' ELSE status END,
             held_at = CASE
               WHEN status = 'open' AND array_length(surfaced_session_ids, 1) >= 2
               THEN NOW() ELSE held_at END,
             hold_reason = CASE
               WHEN status = 'open' AND array_length(surfaced_session_ids, 1) >= 2
               THEN 'auto:shown in 3 sessions without a decision' ELSE hold_reason END,
             held_at_value = CASE
               WHEN status = 'open' AND array_length(surfaced_session_ids, 1) >= 2
               THEN stored_value ELSE held_at_value END
         WHERE id = ANY($2::uuid[])`,
        [sessionId, ids]
      );
    } catch (error) {
      this.logger.error('markSurfaced failed', { error: (error as Error).message });
    }
  }

  /**
   * Close a contradiction with a decision. Returns true if a row moved.
   *
   * `decision` is required and is the point: it names which value won, so a
   * downstream reader can act on the outcome. Migration 016 learned this on
   * fact collisions — a close-out carrying only a free-text note is a mute
   * dressed as a decision, because nothing can read prose. `note` is where the
   * prose goes, and it is optional.
   */
  async resolve(
    userId: string,
    id: string,
    decision: ContradictionDecision,
    note?: string,
  ): Promise<boolean> {
    if (decision !== 'user_stated' && decision !== 'stored' && decision !== 'neither') {
      this.logger.warn('resolve rejected: unknown decision', { userId, id, decision });
      return false;
    }
    try {
      const row = await this.pg.queryOne<{ id: string }>(
        `UPDATE ${this.prefix}contradiction_signals
            SET status      = 'resolved',
                decision    = $3,
                resolution  = $4,
                resolved_at = NOW(),
                held_at       = NULL,
                hold_reason   = NULL,
                held_at_value = NULL
          WHERE id = $2 AND user_id = $1 AND status <> 'resolved'
      RETURNING id`,
        [userId, id, decision, note ? note.slice(0, 600) : null],
      );
      if (row) this.logger.info('contradiction resolved', { userId, id, decision });
      return Boolean(row);
    } catch (error) {
      this.logger.error('resolve failed', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Set a contradiction aside without deciding it. Returns true if a row moved.
   *
   * Deliberately separate from {@link resolve} and deliberately not permanent:
   * the hold is pinned to the fact's current value and lapses when that value
   * changes. "Not now" and "settled" are different answers and the store should
   * not be able to confuse them.
   */
  async hold(userId: string, id: string, reason?: string): Promise<boolean> {
    try {
      const row = await this.pg.queryOne<{ id: string }>(
        `UPDATE ${this.prefix}contradiction_signals
            SET status        = 'held',
                held_at       = NOW(),
                hold_reason   = $3,
                held_at_value = stored_value
          WHERE id = $2 AND user_id = $1 AND status = 'open'
      RETURNING id`,
        [userId, id, reason ? reason.slice(0, 300) : null],
      );
      return Boolean(row);
    } catch (error) {
      this.logger.error('hold failed', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Lifecycle counts for a user. `resolved` is now a number that can be
   * non-zero — before 017 there was no code path that could produce one.
   */
  async counts(userId: string): Promise<{ open: number; held: number; resolved: number }> {
    try {
      const rows = await this.pg.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n
           FROM ${this.prefix}contradiction_signals
          WHERE user_id = $1
          GROUP BY status`,
        [userId],
      );
      const out = { open: 0, held: 0, resolved: 0 };
      for (const r of rows) {
        if (r.status === 'open' || r.status === 'held' || r.status === 'resolved') {
          out[r.status] = Number(r.n);
        }
      }
      return out;
    } catch (error) {
      this.logger.error('counts failed', { error: (error as Error).message });
      return { open: 0, held: 0, resolved: 0 };
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
    if (!this.inlineEnabled) return [];

    const contradictions: InlineContradiction[] = [];
    const seenKeys = new Set<string>();
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

      // PROXIMITY, not "any capitalized word in the message". Without this, a
      // message containing several proper nouns pairs EVERY concept-matching
      // fact with the first one, and one message produced 35 phantom
      // contradictions — each a confident claim that the user had changed their
      // mind about something they never mentioned.
      const candidate = this.nearestCandidate(messageWords, capitalizedWords, conceptTokens);
      if (!candidate) continue;
      if (candidate.toLowerCase() === fact.factValue.toLowerCase()) continue;
      if (seenKeys.has(fact.factKey)) continue;

      seenKeys.add(fact.factKey);
      contradictions.push({
        factKey: fact.factKey,
        factCategory: fact.category,
        storedValue: fact.factValue,
        suspectedValue: candidate,
      });

      // Hard cap. Past a handful this is not a memory check any more, it is an
      // interrogation, and the sheer volume is itself evidence the detector is
      // wrong rather than the user.
      if (contradictions.length >= MAX_INLINE_CONTRADICTIONS) break;
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

/**
 * Row -> ContradictionSignal. The lifecycle columns are absent from rows written
 * before 017 only in the sense that the migration defaulted them; `status` is
 * NOT NULL with a default, so the fallback here is belt-and-braces for a
 * consumer querying through an older view.
 */
function mapSignal(row: Record<string, unknown>): ContradictionSignal {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sessionId: row.session_id as string | undefined,
    factKey: row.fact_key as string,
    userStated: row.user_stated as string,
    storedValue: row.stored_value as string,
    signalType: row.signal_type as ContradictionSignal['signalType'],
    status: (row.status as ContradictionStatus) ?? 'open',
    decision: (row.decision as ContradictionDecision | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    heldAt: row.held_at ? new Date(row.held_at as string) : null,
    holdReason: (row.hold_reason as string | null) ?? null,
    surfaced: row.surfaced as boolean,
    surfacedSessionIds: (row.surfaced_session_ids as string[]) ?? [],
    createdAt: row.created_at as Date,
  };
}
