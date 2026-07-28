import type { PgClient } from '../db/postgres.js';
import type {
  LLMProvider, EmbeddingProvider, Logger,
  Fact, StoreFact, ExtractedFact, GraphPlugin, SimilarFactMatch,
} from '../types.js';
import { formatRelativeTime } from '../utils/time-utils.js';
import { globalStats } from '../stats.js';

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

export class FactsService {
  private pg: PgClient;
  private llm: LLMProvider;
  private embeddings: EmbeddingProvider | null;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;

  constructor(
    pg: PgClient,
    llm: LLMProvider,
    graph: GraphPlugin | null,
    prefix: string,
    logger: Logger,
    embeddings: EmbeddingProvider | null = null,
  ) {
    this.pg = pg;
    this.llm = llm;
    this.embeddings = embeddings;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Get active facts for a user with priority-aware deduplication. */
  async getUserFacts(
    userId: string,
    category?: string,
    limit = 50,
    intentId?: string | null,
  ): Promise<Fact[]> {
    try {
      const params: unknown[] = [userId];
      let sql = `
        WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY category, fact_key,
              COALESCE(intent_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY
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

      if (intentId === undefined) {
        // No intent scoping — return only unscoped (general) facts.
        sql += ` AND intent_id IS NULL`;
      } else if (intentId === null) {
        sql += ` AND intent_id IS NULL`;
      } else {
        // Intent scoping — return both the intent's own facts and unscoped ones.
        sql += ` AND (intent_id = $${params.length + 1} OR intent_id IS NULL)`;
        params.push(intentId);
      }

      sql += `)
        SELECT * FROM ranked WHERE rn = 1
        ORDER BY intent_id NULLS LAST, mention_count DESC, last_mentioned DESC
        LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(mapRowToFact);
    } catch (error) {
      this.logger.error('getUserFacts failed', { error: (error as Error).message, userId });
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

    return this.pg.transaction(async (client) => {
      // 1. Find existing active fact with same key (within this intent scope)
      const existingResult = await client.query<{
        id: string; fact_value: string; mention_count: number;
        fact_type: string; fact_status: string;
      }>(
        `SELECT id, fact_value, mention_count, fact_type, fact_status
         FROM ${this.prefix}facts
         WHERE user_id = $1 AND category = $2 AND fact_key = $3
           AND (intent_id = $4 OR (intent_id IS NULL AND $4 IS NULL))
           AND fact_status = 'active'
         ORDER BY override_priority DESC, mention_count DESC
         LIMIT 1`,
        [userId, category, key, intentId ?? null]
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
          [userId, category, key, value, confidence, sessionId ?? null, intentId ?? null,
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
        [userId, category, key, value, confidence, sessionId ?? null, intentId ?? null,
         factType, validFrom ?? null, validUntil ?? null, existing.id, priority, inheritedMentionCount]
      );
      const fact = mapRowToFact(result.rows[0]);

      // Append-only audit log of the supersession.
      await client.query(
        `INSERT INTO ${this.prefix}fact_corrections
          (user_id, fact_key, old_value, new_value, correction_type, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, key, existing.fact_value, value,
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
    const userMessages = messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');

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
      ], { temperature: 0.1, maxTokens: 2000, json: true });

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
   * Expire active temporary facts whose valid_until has passed. Sets
   * fact_status='expired' and stamps superseded_at. Returns the count expired.
   * Call from a periodic job.
   */
  async expireTemporaryFacts(): Promise<number> {
    try {
      const rows = await this.pg.query<{ id: string }>(
        `UPDATE ${this.prefix}facts
            SET fact_status = 'expired', superseded_at = NOW(), updated_at = NOW()
          WHERE fact_status = 'active'
            AND fact_type = 'temporary'
            AND valid_until IS NOT NULL
            AND valid_until <= NOW()
          RETURNING id`,
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
