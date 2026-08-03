import type { PgClient } from '../db/postgres.js';
import type { Logger, ContradictionSignal, InlineContradiction, Fact } from '../types.js';
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
      // Upsert on (user_id, fact_key, md5(stored_value)) WHERE surfaced = FALSE.
      //
      // The old guard was per-SESSION, which only suppressed repeats inside one
      // conversation — the case that matters least. Across sessions, one stale
      // fact that came up eight times became eight rows, and anything reading
      // the count as a rate reported "recall is drifting" when exactly one fact
      // was out of date.
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
         ON CONFLICT (user_id, fact_key, md5(stored_value)) WHERE surfaced = FALSE
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
