import type { PgClient } from '../db/postgres.js';
import type {
  LLMProvider, EmbeddingProvider, Logger,
  Fact, StoreFact, ExtractedFact, GraphPlugin, SimilarFactMatch,
} from '../types.js';
import { formatRelativeTime } from '../utils/time-utils.js';
import { globalStats } from '../stats.js';
import type { FactKeyMerge } from './fact-key-merge.service.js';

/** Normalize a fact key for dedup comparison: lowercase, strip underscores/hyphens, trim common prefixes. */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/^(work|personal|hobby|preference|relationship|goal|context)[_\s]*/i, '')
    .trim();
}

/** Check if two fact values are semantically similar (normalized string overlap). */
function valuesAreSimilar(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(/\s+/));
  const wb = new Set(nb.split(/\s+/));
  const overlap = [...wa].filter(w => wb.has(w)).length;
  const minSize = Math.min(wa.size, wb.size);
  return minSize > 0 && overlap / minSize > 0.6;
}

const FACT_CATEGORIES = [
  'personal', 'work', 'preference', 'hobby', 'relationship', 'goal', 'context',
];

const SPECULATION_PATTERNS = [
  /\b(suggests?|implies?|may reflect|might indicate|could mean|deeper desire|self-identification)\b/i,
  /\b(hypothesis|assumption|potentially|arguably|seems to)\b/i,
  /\b(further validation|require[sd]? validation|based on assumptions)\b/i,
];

function isSpeculativeFact(value: string): boolean {
  return SPECULATION_PATTERNS.some(p => p.test(value));
}

// "Who is talking right now" is structural session state, never a durable user
// fact. Storing it as a fact is exactly the bug that lets a 'current_speaker =
// Claude' value written in one session bleed into another.
const SPEAKER_FACT_KEY_PATTERNS = [
  /(^|_)speaker(_|$)/i,
  /(^|_)interlocutor(_|$)/i,
  /who.*(talking|speaking)/i,
  /current_conversation_type/i,
];

/** True if the key names "who is talking" — drop it from the fact graph. */
export function isSpeakerFact(key: string): boolean {
  return SPEAKER_FACT_KEY_PATTERNS.some(p => p.test(key));
}

// Present-tense session-moment state ("current_drink", "current_action", …).
// Legitimate to note, but it must NEVER persist as a permanent, user-scoped
// fact — it's stale the moment the session ends and pollutes every future
// session. We force these to short-lived temporaries instead of rejecting.
const EPHEMERAL_FACT_KEY_PATTERN = /^current_/i;
const EPHEMERAL_FACT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/** True if the key names a present-tense state that should expire on its own. */
export function isEphemeralFactKey(key: string): boolean {
  return EPHEMERAL_FACT_KEY_PATTERN.test(key) || key === 'conversation_topic';
}

// "Contradiction" is only meaningful for facts asserted as STABLE. Schedules,
// shifts, sleep/times, location, current state, transient project status change
// as a matter of life — a new value is normal life, not a misremember. Firing
// a contradiction signal on every such change generates pure noise.
const VOLATILE_FACT_KEY_PATTERN =
  /(schedule|shift|sleep|_time|^time|location|remaining|routine|activity|work_?load|upcoming|setup_status|today|tomorrow|yesterday)/i;

/** True if the key names a naturally-changing fact (no contradiction signal). */
export function isVolatileFactKey(key: string): boolean {
  return isEphemeralFactKey(key) || VOLATILE_FACT_KEY_PATTERN.test(key);
}

// Some keys hold a SET, not a single value: allergies, languages, pets. A new
// member is an addition, not a correction, so the supersede path is wrong for
// them — and so is the key-axis merge, since two set-valued keys holding
// different members are not the same claim.
const SET_VALUED_FACT_KEY_PATTERN =
  /(allerg|languages?|pets?|siblings?|children|skills?|instruments?|dietary|medications?)/i;

/** True if the key holds a set whose members accumulate rather than replace. */
export function isSetValuedFactKey(key: string): boolean {
  return SET_VALUED_FACT_KEY_PATTERN.test(key);
}

const SET_VALUE_SEPARATOR = '; ';

/** Split a set-valued fact's stored value into its members. */
export function splitSetValue(value: string): string[] {
  return value
    .split(/;|,(?![^(]*\))/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Merge a new member into a set-valued fact, preserving order and dropping
 * case-insensitive duplicates. Returns null when nothing changed, so the caller
 * can skip a write that would only bump a timestamp.
 */
export function mergeSetValue(stored: string, incoming: string): string | null {
  const members = splitSetValue(stored);
  const seen = new Set(members.map((m) => m.toLowerCase()));
  const added = splitSetValue(incoming).filter((m) => !seen.has(m.toLowerCase()));
  if (added.length === 0) return null;
  return [...members, ...added].join(SET_VALUE_SEPARATOR);
}

/** True if this key may be a target of the key-axis same-claim merge. */
export function isMergeableFactKey(key: string): boolean {
  return !isVolatileFactKey(key) && !isSetValuedFactKey(key) && !isSpeakerFact(key);
}

/** Max terms lifted from one message into a relevance tsquery. */
const MAX_QUERY_TERMS = 25;

/**
 * Turn free text into an OR'd tsquery string, or null if nothing is matchable.
 *
 * OR rather than AND is the whole point. `plainto_tsquery` and
 * `websearch_to_tsquery` AND their terms, and a fact is a short string that
 * will only ever carry one or two of a message's words — requiring all of them
 * matches nothing ("what is my cat called" would need a single fact containing
 * both 'cat' AND 'call').
 *
 * Tokenising here rather than via `tsvector_to_array` also keeps a message made
 * entirely of stopwords from ever reaching the `''::tsquery` cast.
 */
export function messageToOrQuery(text: string): string | null {
  const matched = text.match(/[a-zà-ÿ0-9]{3,}/gi) ?? [];
  const terms = Array.from(new Set(matched.map((t: string) => t.toLowerCase())))
    .slice(0, MAX_QUERY_TERMS);
  return terms.length > 0 ? terms.join(' | ') : null;
}

function mapRowToFact(row: Record<string, unknown>): Fact {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    category: row.category as string,
    factKey: row.fact_key as string,
    factValue: row.fact_value as string,
    confidence: parseFloat(row.confidence as string),
    factStatus: (row.fact_status as string || 'active') as Fact['factStatus'],
    factType: (row.fact_type as string || 'permanent') as Fact['factType'],
    validFrom: row.valid_from ? new Date(row.valid_from as string) : undefined,
    validUntil: row.valid_until ? new Date(row.valid_until as string) : undefined,
    recordedAt: row.recorded_at ? new Date(row.recorded_at as string) : undefined,
    supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
    supersedesId: row.supersedes_id as string | undefined,
    overridePriority: (row.override_priority as number) || 0,
    mentionCount: row.mention_count as number,
    lastMentioned: row.last_mentioned ? new Date(row.last_mentioned as string) : undefined,
    sourceSessionId: row.source_session_id as string | undefined,
    intentId: row.intent_id as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Ceiling on the text handed to fact extraction. See extractFromMessages: the
 * prompt is deliberately exhaustive, so output length tracks input length and
 * an unbounded input cannot be made to fit any output cap.
 */
const MAX_EXTRACTION_INPUT_CHARS = 12000;

export class FactsService {
  private pg: PgClient;
  private llm: LLMProvider;
  private embeddings: EmbeddingProvider | null;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;
  /**
   * Optional: closes the KEY axis of the duplicate-fact bug. Migration 011 fixed
   * the category axis (identity scoped too wide); this catches the case where an
   * extractor mints a NEW key for a claim already held. Absent = plain insert,
   * which is the behaviour before 0.5.0.
   */
  private keyMerge: FactKeyMerge | null;

  constructor(
    pg: PgClient,
    llm: LLMProvider,
    graph: GraphPlugin | null,
    prefix: string,
    logger: Logger,
    embeddings: EmbeddingProvider | null = null,
    keyMerge: FactKeyMerge | null = null,
  ) {
    this.pg = pg;
    this.llm = llm;
    this.embeddings = embeddings;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
    this.keyMerge = keyMerge;
  }

  /**
   * Get active facts for a user with priority-aware deduplication.
   *
   * `intentId` semantics (changed in 0.5.1 — see below):
   * - `undefined` — **no scoping**. Every active fact is a candidate; unscoped
   *   facts rank above intent-scoped ones. This is the default and what
   *   {@link ContextBuilder} uses.
   * - `null` — explicitly "unscoped only". Filters to `intent_id IS NULL`.
   * - a uuid — prefer that intent, then unscoped, then everything else.
   *
   * 0.5.1 fixes a defect in the `undefined` branch. It used to apply
   * `AND intent_id IS NULL`, which made every fact stored with an `intentId`
   * unreachable from the context builder — `build()` calls this with
   * `undefined` and has no way to pass one. So `store({ intentId })` wrote a
   * fact that `buildContext()` could never surface. In the system this SDK was
   * extracted from, the same bug hid 2,107 of 2,261 active facts (93%).
   *
   * `null` still means unscoped-only, so callers who deliberately relied on
   * that filter keep an exact way to ask for it.
   */
  async getUserFacts(
    userId: string,
    category?: string,
    limit = 50,
    intentId?: string | null,
    queryText?: string,
  ): Promise<Fact[]> {
    try {
      // Always bound as $2 so the ranking CASE can reference it whether or not
      // the caller scoped the read. `undefined` and `null` both bind SQL NULL;
      // they differ only in the WHERE clause below.
      const params: unknown[] = [userId, intentId ?? null];
      const intentRank = `
              CASE WHEN $2::uuid IS NOT NULL AND intent_id = $2::uuid THEN 0
                   WHEN intent_id IS NULL THEN 1
                   ELSE 2 END`;
      let sql = `
        WITH ranked AS (
          SELECT *, ${intentRank} AS intent_rank,
            ROW_NUMBER() OVER (
            -- Partitioned WITHOUT intent_id: one key resolves to one winner
            -- across every intent. Including it (pre-0.5.1) meant a key held
            -- under two intents produced two competing rows in the same result.
            PARTITION BY category, fact_key
            ORDER BY
              ${intentRank},
              CASE WHEN fact_type = 'temporary' AND fact_status = 'active'
                   AND (valid_until IS NULL OR valid_until > NOW())
                   THEN 0 ELSE 1 END,
              override_priority DESC, mention_count DESC, last_mentioned DESC
          ) as rn
          FROM ${this.prefix}facts
          WHERE user_id = $1
            AND fact_status = 'active'
            AND NOT (fact_type = 'temporary' AND valid_until IS NOT NULL AND valid_until <= NOW())
      `;

      if (category) {
        sql += ` AND category = $${params.length + 1}`;
        params.push(category);
      }

      // Only an EXPLICIT null still filters. `undefined` (no opinion) and a uuid
      // (a preference) both leave the candidate set whole and let the rank decide.
      if (intentId === null) {
        sql += ` AND intent_id IS NULL`;
      }

      sql += `)
        SELECT * FROM ranked WHERE rn = 1
        ORDER BY intent_rank, mention_count DESC, last_mentioned DESC
        LIMIT $${params.length + 1}`;
      params.push(limit);

      // The popularity-ranked core set and the relevance-matched set are
      // independent reads, so pay for them concurrently rather than in series.
      const [rows, relevant] = await Promise.all([
        this.pg.query<Record<string, unknown>>(sql, params),
        queryText
          ? this.searchRelevantFacts(userId, queryText, { category, intentId })
          : Promise.resolve([] as Fact[]),
      ]);

      const core = rows.map(mapRowToFact);
      if (relevant.length === 0) return core;

      // Additive: the core set is never displaced, only extended.
      const seen = new Set(core.map(f => f.id));
      return core.concat(relevant.filter(f => !seen.has(f.id)));
    } catch (error) {
      this.logger.error('getUserFacts failed', { error: (error as Error).message, userId });
      return [];
    }
  }

  /**
   * Facts that lexically overlap what is being said, ranked by that overlap.
   *
   * Complements the `limit` window in {@link getUserFacts}, which is ordered by
   * `mention_count` and therefore identical on every turn no matter what the
   * user asked. Anything mentioned once or twice can never enter that window,
   * however relevant it is right now. This is the path that reaches it.
   *
   * Deliberately lexical rather than embedding-based: facts are very short
   * strings ("Max", "06:00", "pitbulls"), cosine over short text is
   * length-biased enough to be unreliable, and it would mean embedding and
   * re-embedding the whole fact store. Word overlap on `fact_key + fact_value`
   * is crude but predictable, and the key carries most of the topic signal once
   * its underscores are split ("cat_name" -> "cat name").
   *
   * Best-effort: any failure returns `[]` so the core set still stands.
   */
  async searchRelevantFacts(
    userId: string,
    queryText: string,
    opts: { category?: string; intentId?: string | null; limit?: number } = {},
  ): Promise<Fact[]> {
    const { category, intentId, limit = 15 } = opts;
    const tsq = messageToOrQuery(queryText);
    if (!tsq) return [];

    try {
      const params: unknown[] = [userId, intentId ?? null, tsq];
      // Weighted A/B: the key carries the topic and many values are bare, so an
      // unweighted vector ties a key match with a value match on a common word.
      const doc = `setweight(to_tsvector('english', replace(fact_key, '_', ' ')), 'A') ||
                   setweight(to_tsvector('english', fact_value), 'B')`;
      // The filter uses the UNWEIGHTED expression so it can be served by the
      // GIN index from migration 015 — keep the two in sync.
      const filter = `to_tsvector('english', replace(fact_key, '_', ' ') || ' ' || fact_value)`;
      let sql = `
        WITH ranked AS (
          SELECT *,
            ts_rank(${doc}, to_tsquery('english', $3)) AS relevance,
            ROW_NUMBER() OVER (
              PARTITION BY category, fact_key
              ORDER BY
                CASE WHEN $2::uuid IS NOT NULL AND intent_id = $2::uuid THEN 0
                     WHEN intent_id IS NULL THEN 1
                     ELSE 2 END,
                override_priority DESC, mention_count DESC, last_mentioned DESC
            ) AS rn
          FROM ${this.prefix}facts
          WHERE user_id = $1
            AND fact_status = 'active'
            AND NOT (fact_type = 'temporary' AND valid_until IS NOT NULL AND valid_until <= NOW())
            AND ${filter} @@ to_tsquery('english', $3)
      `;

      if (category) {
        sql += ` AND category = $${params.length + 1}`;
        params.push(category);
      }
      if (intentId === null) {
        sql += ` AND intent_id IS NULL`;
      }

      // Relative floor, never absolute. ts_rank falls off with the number of
      // query terms, so the same fact scores very differently depending on how
      // much text the caller passed: measured on the origin system, the top
      // match was 0.6079 for a bare question and 0.1581 for the same question
      // with three turns of context folded in. A fixed floor tuned on one shape
      // silently empties the other.
      sql += `), winners AS (SELECT * FROM ranked WHERE rn = 1)
        SELECT w.* FROM winners w
        WHERE w.relevance >= (SELECT MAX(relevance) FROM winners) * 0.5
        ORDER BY w.relevance DESC, w.mention_count DESC, w.last_mentioned DESC
        LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(mapRowToFact);
    } catch (error) {
      this.logger.warn('searchRelevantFacts failed; core facts only', {
        error: (error as Error).message, userId,
      });
      return [];
    }
  }

  /**
   * Bi-temporal fact retrieval: "what we BELIEVED at txnTime about state at
   * validTime." Both axes default to now.
   *
   *   - asOfValidTime in past → "what was true on date X?"
   *   - asOfTxnTime in past → "what did we believe on date Y?"
   *   - both → "what did we believe on date Y about state on date X?"
   */
  async getFactsAsOf(
    userId: string,
    asOfValidTime: Date = new Date(),
    asOfTxnTime: Date = new Date(),
    options: { category?: string; limit?: number } = {},
  ): Promise<Fact[]> {
    const { category, limit = 200 } = options;
    try {
      const params: unknown[] = [userId, asOfTxnTime, asOfValidTime];
      let sql = `
        SELECT * FROM ${this.prefix}facts
         WHERE user_id = $1
           -- transaction-time: known to us, not yet superseded as of asOfTxnTime
           AND recorded_at <= $2
           AND (superseded_at IS NULL OR superseded_at > $2)
           -- valid-time: was true in the world at asOfValidTime
           AND (valid_from IS NULL OR valid_from <= $3)
           AND (valid_until IS NULL OR valid_until > $3)`;
      if (category) {
        sql += ` AND category = $${params.length + 1}`;
        params.push(category);
      }
      sql += ` ORDER BY category, fact_key, override_priority DESC, mention_count DESC
               LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(mapRowToFact);
    } catch (error) {
      this.logger.error('getFactsAsOf failed', {
        error: (error as Error).message, userId, asOfValidTime, asOfTxnTime,
      });
      return [];
    }
  }

  /** Store a new fact or update existing via lifecycle-aware supersession. */
  async storeFact(input: StoreFact): Promise<Fact | null> {
    let { factType = 'permanent', validUntil } = input;
    const { userId, category, key, value, confidence = 0.8, validFrom, sessionId, intentId, isCorrection } = input;

    // Guard: structural session state — never a durable fact.
    if (isSpeakerFact(key)) {
      this.logger.debug('Dropped speaker fact (structural, not memory)', { userId, key, value });
      return null;
    }

    // Guard: present-tense "current_*" state. Force to short-lived temporary
    // so it expires instead of polluting every future session.
    if (isEphemeralFactKey(key)) {
      factType = 'temporary';
      if (!validUntil) {
        validUntil = new Date(Date.now() + EPHEMERAL_FACT_TTL_MS);
      }
    }

    // Key-axis merge, BEFORE the transaction: it makes network calls (embed +
    // LLM) and must never hold a row lock while it waits. Returns null on every
    // failure mode, in which case this is a plain insert exactly as before.
    let effectiveKey = key;
    if (this.keyMerge && isMergeableFactKey(key)) {
      const match = await this.keyMerge.findSameClaimActiveFact(
        userId,
        { factKey: key, factValue: value },
        { excludeKey: (k: string) => !isMergeableFactKey(k) },
      );
      if (match) {
        // Rewrite onto the matched row's key and fall into the normal
        // supersede/bump branches below. Bi-temporal supersession and the
        // unique-active invariant are untouched.
        this.logger.debug('fact key merge: same claim under a different key', {
          from: key, to: match.factKey, similarity: match.similarity, reason: match.reason,
        });
        effectiveKey = match.factKey;
      }
    }

    return this.pg.transaction(async (client) => {
      // Serialise check-then-act per (user, key). Without it two concurrent
      // writes of the same key both see "no existing row" and both insert,
      // which the unique-active index then rejects — one of them losing a fact
      // that was never in conflict. Transaction-scoped, so it releases on
      // COMMIT or ROLLBACK with no unlock path to forget.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        userId, effectiveKey,
      ]);

      // 1. Find the existing active fact for this key.
      //
      // Scoped to (user_id, fact_key) ONLY — deliberately not category,
      // intent_id or fact_type. Those are an extractor's opinion about a claim,
      // not part of its identity, and scoping identity by them means a
      // re-classified extraction becomes a second truth rather than a
      // correction. Measured before migration 011: 51% of active rows were
      // duplicates, one key holding 25 concurrent values. Do not re-widen.
      const existingResult = await client.query<{
        id: string; fact_value: string; mention_count: number;
        fact_type: string; fact_status: string;
      }>(
        `SELECT id, fact_value, mention_count, fact_type, fact_status
         FROM ${this.prefix}facts
         WHERE user_id = $1 AND fact_key = $2
           AND fact_status = 'active'
         ORDER BY override_priority DESC, mention_count DESC
         LIMIT 1`,
        [userId, effectiveKey]
      );
      const existing = existingResult.rows[0];

      if (!existing) {
        // 2. New fact
        const priority = factType === 'temporary' ? 20 : (isCorrection ? 10 : 0);
        const result = await client.query(
          `INSERT INTO ${this.prefix}facts
            (user_id, category, fact_key, fact_value, confidence, source_session_id, intent_id,
             fact_status, fact_type, valid_from, valid_until, override_priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11)
           RETURNING *`,
          [userId, category, effectiveKey, value, confidence, sessionId ?? null, intentId ?? null,
           factType, validFrom ?? null, validUntil ?? null, priority]
        );
        const fact = mapRowToFact(result.rows[0]);

        if (this.graph) {
          this.graph.syncFact(userId, fact).catch(e => {
            globalStats.increment('graph_sync_errors');
            this.logger.warn('Graph sync failed', { error: (e as Error).message });
          });
        }

        return fact;
      }

      if (existing.fact_value === value) {
        // 3. Same value — bump mention count
        const result = await client.query(
          `UPDATE ${this.prefix}facts SET
             mention_count = mention_count + 1,
             last_mentioned = NOW(),
             confidence = GREATEST(confidence, $2),
             updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [existing.id, confidence]
        );
        return mapRowToFact(result.rows[0]);
      }

      // 4. Different value — supersession.
      // superseded_at = transaction-time of belief change (bi-temporal axis).
      const inheritedMentionCount = existing.mention_count + 1;
      const newStatus = factType === 'temporary' ? 'overridden' : 'superseded';

      await client.query(
        `UPDATE ${this.prefix}facts
           SET fact_status = $2, superseded_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [existing.id, newStatus]
      );

      const priority = factType === 'temporary' ? 20 : 10;
      const result = await client.query(
        `INSERT INTO ${this.prefix}facts
          (user_id, category, fact_key, fact_value, confidence, source_session_id, intent_id,
           fact_status, fact_type, valid_from, valid_until, supersedes_id, override_priority, mention_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [userId, category, effectiveKey, value, confidence, sessionId ?? null, intentId ?? null,
         factType, validFrom ?? null, validUntil ?? null, existing.id, priority, inheritedMentionCount]
      );
      const fact = mapRowToFact(result.rows[0]);

      // Append-only audit log of the supersession.
      await client.query(
        `INSERT INTO ${this.prefix}fact_corrections
          (user_id, fact_key, old_value, new_value, correction_type, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, effectiveKey, existing.fact_value, value,
         factType === 'temporary' ? 'temporary_override' : 'correction',
         factType === 'temporary' ? 'Temporary override' : 'Value correction']
      );

      if (this.graph) {
        this.graph.syncFact(userId, fact).catch(e => {
          globalStats.increment('graph_sync_errors');
          this.logger.warn('Graph sync failed', { error: (e as Error).message });
        });
      }

      return fact;
    });
  }

  /** Remove (soft-delete) a fact by marking it as expired. */
  async removeFact(factId: string, _reason?: string): Promise<void> {
    await this.pg.query(
      `UPDATE ${this.prefix}facts
         SET fact_status = 'expired', superseded_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [factId]
    );
  }

  /** Search facts by keyword match on fact_key or fact_value. */
  async searchFacts(userId: string, query: string): Promise<Fact[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT * FROM ${this.prefix}facts
       WHERE user_id = $1 AND fact_status = 'active'
         AND (fact_key ILIKE $2 OR fact_value ILIKE $2)
       ORDER BY mention_count DESC
       LIMIT 20`,
      [userId, `%${query.replace(/[%_\\]/g, '\\$&')}%`]
    );
    return rows.map(mapRowToFact);
  }

  /**
   * Embedding-based semantic dedup: find a currently-active fact whose
   * value is semantically close to the candidate. Returns the closest match
   * at/above `threshold`, or null.
   *
   * Use case: autonomous save paths (e.g., a background loop saving the same
   * preference under slightly different keys/wordings). The exact-key dedup
   * in {@link storeFact} cannot catch these; this scan can. Pair with
   * {@link touchFactMention} to collapse the new write onto the existing row.
   *
   * Best-effort: any failure returns null so the save proceeds — dedup is a
   * noise filter, never a gate on remembering.
   */
  async findSimilarActiveFact(
    userId: string,
    candidateValue: string,
    opts: { threshold?: number; limit?: number } = {},
  ): Promise<SimilarFactMatch | null> {
    if (!this.embeddings) {
      // Caller wired bwmem without an embedding provider — silently no-op.
      return null;
    }
    const threshold = opts.threshold ?? 0.9;
    const limit = opts.limit ?? 50;
    const value = (candidateValue || '').trim();
    if (value.length < 8) return null;

    let rows: Array<{ id: string; category: string; fact_key: string; fact_value: string }>;
    try {
      rows = await this.pg.query<{ id: string; category: string; fact_key: string; fact_value: string }>(
        `SELECT id, category, fact_key, fact_value
           FROM ${this.prefix}facts
          WHERE user_id = $1 AND fact_status = 'active'
          ORDER BY last_mentioned DESC NULLS LAST, created_at DESC
          LIMIT $2`,
        [userId, limit],
      );
    } catch (error) {
      this.logger.debug('findSimilarActiveFact query failed', { error: (error as Error).message });
      return null;
    }
    if (rows.length === 0) return null;

    try {
      const embeddings = await this.embeddings.generateBatch([value, ...rows.map(r => r.fact_value)]);
      const cand = embeddings[0];
      if (!cand) return null;
      let best = -Infinity;
      let bestIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const e = embeddings[i + 1];
        if (!e) continue;
        const sim = cosineSimilarity(cand, e);
        if (sim > best) { best = sim; bestIdx = i; }
      }
      if (bestIdx >= 0 && best >= threshold) {
        const m = rows[bestIdx];
        return { id: m.id, category: m.category, factKey: m.fact_key, factValue: m.fact_value, score: best };
      }
    } catch (error) {
      this.logger.debug('findSimilarActiveFact embedding failed', { error: (error as Error).message });
    }
    return null;
  }

  /**
   * Bump an existing fact's recency/mention count without changing its value.
   * Used after {@link findSimilarActiveFact} returns a match: the candidate
   * write is collapsed onto the kept row, but we still record that the user
   * touched the idea.
   */
  async touchFactMention(factId: string): Promise<void> {
    try {
      await this.pg.query(
        `UPDATE ${this.prefix}facts
            SET mention_count = mention_count + 1, last_mentioned = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [factId],
      );
    } catch (error) {
      this.logger.debug('touchFactMention failed', { factId, error: (error as Error).message });
    }
  }

  /** Extract facts from conversation messages using LLM. */
  async extractFromMessages(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    _sessionId?: string,
  ): Promise<ExtractedFact[]> {
    // Bounded on purpose. The prompt asks for ALL facts and the output length
    // therefore scales with the input, so an UNBOUNDED input means an output
    // no token cap can accommodate — on a corpus with long turns this produced
    // 28k characters of JSON against an 8k-token ceiling and truncated every
    // time. Raising the cap alone cannot fix an unbounded input; the input has
    // to have a ceiling of its own. Newest content is kept, since facts are
    // most likely to be stated in the turn that triggered extraction.
    const joined = messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');
    const userMessages = joined.length > MAX_EXTRACTION_INPUT_CHARS
      ? joined.slice(-MAX_EXTRACTION_INPUT_CHARS)
      : joined;

    if (!userMessages.trim()) return [];

    let existingFacts: Fact[] = [];
    try {
      existingFacts = await this.getUserFacts(userId, undefined, 30);
    } catch { /* non-blocking */ }

    try {
      let systemPrompt = `You are a fact extraction assistant. Extract ALL personal facts about the user from the conversation.

Rules:
- Extract EVERY fact the user states about themselves, their life, people, places, things, work, and feelings
- Be thorough: extract 3-15 facts per message batch — miss nothing
- Use simple, normalized values (names, places, single concepts — not long phrases)
- Use simple, normalized keys from this list where possible:
  name, location, employer, job_title, partner, child, pet_name, pet_type, interest, hobby, food, diet, allergy, dislike, field, university, goal, friend, sibling
- Confidence: 1.0 for explicit statements, 0.8 for strongly implied
- Categories: ${FACT_CATEGORIES.join(', ')}
- NEVER store interpretations or psychological observations
- NEVER extract who is currently speaking ("current_speaker", "interlocutor") — handled structurally
- Do NOT extract fleeting present-moment state as durable facts; if you must, mark "factType": "temporary"

Key fact types to watch for:
- People: names, relationships (partner, child, friend, colleague, ex)
- Places: where they live, work, grew up
- Work: employer, role, field, career changes, work situations
- Preferences: likes, dislikes, diet, allergies, hobbies
- Life events: moves, job changes, breakups, health changes — use category "context" + factType "temporary"
- Career signals: considering a job change, got promoted, funding cut — store these!

Examples:
- "My research funding got cut by 40%" → {"category":"context","factKey":"work_situation","factValue":"research funding cut significantly","confidence":1.0,"factType":"temporary"}
- "Thinking about leaving academia for an NGO" → {"category":"goal","factKey":"career_change","factValue":"considering leaving academia for NGO work","confidence":0.8,"factType":"temporary"}
- "My daughter Elsa just turned 6" → two facts: child name + child age
- "I am allergic to cats but we have a hypoallergenic one" → two facts: allergy + pet ownership

Lifecycle:
- If the user corrects a previously known fact, set "isCorrection": true
- Temporary/evolving states (moods, situations, plans): set "factType": "temporary"
- Default to "permanent"

Output a JSON array. Extract ALL facts — thoroughness matters more than brevity:
[{"category": "personal", "factKey": "name", "factValue": "John", "confidence": 1.0, "isCorrection": false, "factType": "permanent"}]

Return [] if no facts found.`;

      if (existingFacts.length > 0) {
        systemPrompt += `\n\nKnown facts:`;
        for (const f of existingFacts) {
          systemPrompt += `\n- ${f.category}/${f.factKey}: ${f.factValue}`;
        }
      }

      const response = await this.llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Extract facts from:\n\n${userMessages}` },
      // 2000 was not enough for a long session: the prompt asks for ALL
      // facts and the output length scales with the transcript. It used to
      // truncate into partial JSON that the regex below excavated and stored
      // as facts; since 0.7.0 truncation is a hard error instead, so the cap
      // has to fit the real workload rather than the happy path.
      ], { temperature: 0.1, maxTokens: 16000, json: true });

      this.logger.debug('Fact extraction LLM response', {
        responseLength: response.length,
        preview: response.slice(0, 200),
        messageCount: messages.length,
      });

      let facts: ExtractedFact[];
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        facts = JSON.parse(arrayMatch[0]) as ExtractedFact[];
      } else {
        const parsed = JSON.parse(response);
        if (Array.isArray(parsed)) {
          facts = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const arrayVal = Object.values(parsed).find(v => Array.isArray(v));
          if (arrayVal) {
            facts = arrayVal as ExtractedFact[];
          } else if (parsed.factKey) {
            facts = [parsed as ExtractedFact];
          } else {
            return [];
          }
        } else {
          return [];
        }
      }

      return facts.filter(f => {
        if (!f.category || !f.factKey || !f.factValue || typeof f.confidence !== 'number') return false;
        if (isSpeculativeFact(f.factValue)) {
          this.logger.warn('Rejected speculative fact', { key: f.factKey });
          return false;
        }
        if (isSpeakerFact(f.factKey)) {
          this.logger.debug('Rejected speaker fact (structural, not memory)', { key: f.factKey });
          return false;
        }
        return true;
      });
    } catch (error) {
      globalStats.increment('fact_extraction_errors');
      this.logger.error('Fact extraction failed', {
        error: (error as Error).message,
        stack: (error as Error).stack?.split('\n').slice(0, 3).join(' | '),
      });
      return [];
    }
  }

  /** Fact keys that can have multiple values (person can have two jobs, multiple hobbies, etc.) */
  private static readonly MULTI_VALUED_KEYS = new Set([
    'job_title', 'role', 'hobby', 'interest', 'sport', 'activity',
    'friend', 'colleague', 'pet_name', 'child', 'sibling',
    'allergy', 'dislike', 'favorite', 'language',
  ]);

  /** Store facts extracted by LLM, with cross-key semantic dedup. */
  async storeExtractedFacts(userId: string, facts: ExtractedFact[], sessionId?: string): Promise<Fact[]> {
    const existingFacts: Fact[] = await this.loadDedupCandidates(userId, facts);

    const byNormKey = new Map<string, Fact[]>();
    for (const ef of existingFacts) {
      const k = normalizeKey(ef.factKey);
      const arr = byNormKey.get(k);
      if (arr) arr.push(ef); else byNormKey.set(k, [ef]);
    }

    const stored: Fact[] = [];
    const bumpIds: string[] = [];
    const toInsert: Array<{ input: StoreFact; original: ExtractedFact }> = [];

    for (const f of facts) {
      const keyNorm = f.factKey.toLowerCase().replace(/[_\-\s]+/g, '_');
      if (FactsService.MULTI_VALUED_KEYS.has(keyNorm)) {
        const slug = f.factValue.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        f.factKey = `${f.factKey}:${slug}`;
      }

      const normKey = normalizeKey(f.factKey);
      let duplicate: Fact | undefined;
      const exactHits = byNormKey.get(normKey);
      if (exactHits) {
        duplicate = exactHits.find(existing => valuesAreSimilar(existing.factValue, f.factValue));
      }
      if (!duplicate) {
        duplicate = existingFacts.find(existing => {
          const existNormKey = normalizeKey(existing.factKey);
          return existNormKey !== normKey
            && valuesAreSimilar(existNormKey, normKey)
            && valuesAreSimilar(existing.factValue, f.factValue);
        });
      }

      if (duplicate) {
        this.logger.debug('Dedup: skipping similar fact', {
          newKey: f.factKey, existingKey: duplicate.factKey, value: f.factValue,
        });
        bumpIds.push(duplicate.id);
        continue;
      }

      toInsert.push({
        input: {
          userId,
          category: f.category,
          key: f.factKey,
          value: f.factValue,
          confidence: f.confidence,
          factType: f.factType || 'permanent',
          sessionId,
          isCorrection: (f as ExtractedFact & { isCorrection?: boolean }).isCorrection,
        },
        original: f,
      });
    }

    if (bumpIds.length > 0) {
      try {
        await this.pg.query(
          `UPDATE ${this.prefix}facts
           SET mention_count = mention_count + 1, last_mentioned = NOW()
           WHERE id = ANY($1::uuid[])`,
          [bumpIds],
        );
      } catch (error) {
        this.logger.warn('Batched mention-count bump failed', { error: (error as Error).message });
      }
    }

    for (const { input, original } of toInsert) {
      try {
        const fact = await this.storeFact(input);
        if (!fact) continue; // dropped by structural guards (speaker, etc.)
        stored.push(fact);
        existingFacts.push(fact);
        const nk = normalizeKey(fact.factKey);
        const arr = byNormKey.get(nk);
        if (arr) arr.push(fact); else byNormKey.set(nk, [fact]);
      } catch (error) {
        this.logger.error('Failed to store extracted fact', {
          error: (error as Error).message, factKey: original.factKey,
        });
      }
    }
    return stored;
  }

  /**
   * Expire active temporary facts. Sets fact_status='expired' and stamps
   * superseded_at. Returns the count expired. Call from a periodic job.
   *
   * Two branches, because a `temporary` fact does not always carry a deadline:
   *
   *  1. valid_until has passed — the plain case.
   *  2. valid_until IS NULL and the fact has gone untended for
   *     `untimedMaxAgeDays`. This branch used to be missing entirely, and
   *     without it an untimed temporary was IMMORTAL. Only `current_*` keys get
   *     a TTL stamped on write (EPHEMERAL_FACT_TTL_MS above); the extraction
   *     prompt meanwhile tells the model to type a fact 'temporary' whenever a
   *     state is transient, and to leave validUntil unset when the state has no
   *     clear end ("doing evenings for a while"). So every transient fact whose
   *     key was not present-tense-shaped lived forever, and a store would
   *     accumulate a stack of mutually exclusive states — "on vacation",
   *     "vacation ended" — all active, all believed at once.
   *
   * Age is measured from COALESCE(last_mentioned, updated_at, created_at).
   * last_mentioned bumps on re-assertion and never on read, so a state that is
   * still being said out loud stays live and is not swept; only genuinely
   * untended ones age out.
   *
   * Caveat worth knowing before you tune this down: the type is set by the
   * extractor and is sometimes wrong, so this branch will expire a durable fact
   * that was mistyped 'temporary'. It is reversible — a status flip, never a
   * delete — but that is the trade the second branch makes.
   *
   * @param untimedMaxAgeDays how long an untimed temporary may go untended
   *        before it ages out. Pass Infinity to disable branch 2 entirely.
   */
  async expireTemporaryFacts(untimedMaxAgeDays = 30): Promise<number> {
    const untimed = Number.isFinite(untimedMaxAgeDays) && untimedMaxAgeDays > 0
      ? Math.round(untimedMaxAgeDays)
      : null;
    try {
      const rows = await this.pg.query<{ id: string }>(
        `UPDATE ${this.prefix}facts
            SET fact_status = 'expired', superseded_at = NOW(), updated_at = NOW()
          WHERE fact_status = 'active'
            AND fact_type = 'temporary'
            AND ( (valid_until IS NOT NULL AND valid_until <= NOW())
                  OR ($1::int IS NOT NULL
                      AND valid_until IS NULL
                      AND COALESCE(last_mentioned, updated_at, created_at)
                          <= NOW() - ($1::int * interval '1 day')) )
          RETURNING id`,
        [untimed],
      );
      if (rows.length > 0) {
        this.logger.info('Expired temporary facts', { count: rows.length });
      }
      return rows.length;
    } catch (error) {
      this.logger.warn('expireTemporaryFacts failed', { error: (error as Error).message });
      return 0;
    }
  }

  private async loadDedupCandidates(userId: string, extracted: ExtractedFact[]): Promise<Fact[]> {
    const top: Fact[] = await this.getUserFacts(userId, undefined, 100).catch(() => []);

    const pairKey = (c: string, k: string) => `${c} ${k}`;
    const pairs = new Map<string, { category: string; factKey: string }>();
    for (const f of extracted) {
      if (!f.category || !f.factKey) continue;
      pairs.set(pairKey(f.category, f.factKey), { category: f.category, factKey: f.factKey });
    }
    if (pairs.size === 0) return top;

    const params: unknown[] = [userId];
    const tuples: string[] = [];
    for (const p of pairs.values()) {
      const ci = params.push(p.category);
      const ki = params.push(p.factKey);
      tuples.push(`($${ci}, $${ki})`);
    }
    let exactMatches: Fact[] = [];
    try {
      const rows = await this.pg.query<Record<string, unknown>>(
        `SELECT * FROM ${this.prefix}facts
         WHERE user_id = $1
           AND fact_status = 'active'
           AND (category, fact_key) IN (${tuples.join(', ')})`,
        params,
      );
      exactMatches = rows.map(mapRowToFact);
    } catch (error) {
      this.logger.warn('Dedup exact-match lookup failed', { error: (error as Error).message });
      return top;
    }

    const seen = new Set<string>();
    const merged: Fact[] = [];
    for (const f of [...exactMatches, ...top]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      merged.push(f);
    }
    return merged;
  }

  /** Format facts for inclusion in an LLM prompt. */
  formatForPrompt(facts: Fact[]): string {
    if (facts.length === 0) return '';

    const grouped = facts.reduce<Record<string, string[]>>((acc, fact) => {
      if (!acc[fact.category]) acc[fact.category] = [];
      let line = `${fact.factKey}: ${fact.factValue}`;

      if (fact.factType === 'temporary') {
        if (fact.validUntil) {
          const until = new Date(fact.validUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          line += ` [temporary, until ${until}]`;
        } else {
          line += ` [temporary, ongoing]`;
        }
      }

      if (fact.lastMentioned) {
        const rel = formatRelativeTime(fact.lastMentioned);
        if (rel) line += ` (${rel})`;
      }

      acc[fact.category].push(line);
      return acc;
    }, {});

    return Object.entries(grouped)
      .map(([cat, lines]) => `[${cat}]\n${lines.join('\n')}`)
      .join('\n\n');
  }
}
