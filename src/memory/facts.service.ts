import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, Fact, StoreFact, ExtractedFact, GraphPlugin } from '../types.js';
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
  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  // Word overlap > 60%
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
    supersedesId: row.supersedes_id as string | undefined,
    overridePriority: (row.override_priority as number) || 0,
    mentionCount: row.mention_count as number,
    lastMentioned: row.last_mentioned ? new Date(row.last_mentioned as string) : undefined,
    sourceSessionId: row.source_session_id as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class FactsService {
  private pg: PgClient;
  private llm: LLMProvider;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, graph: GraphPlugin | null, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Get active facts for a user with priority-aware deduplication. */
  async getUserFacts(userId: string, category?: string, limit = 50): Promise<Fact[]> {
    try {
      let sql = `
        WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY category, fact_key
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
      const params: unknown[] = [userId];

      if (category) {
        sql += ` AND category = $${params.length + 1}`;
        params.push(category);
      }

      sql += `)
        SELECT * FROM ranked WHERE rn = 1
        ORDER BY mention_count DESC, last_mentioned DESC
        LIMIT $${params.length + 1}`;
      params.push(limit);

      const rows = await this.pg.query<Record<string, unknown>>(sql, params);
      return rows.map(mapRowToFact);
    } catch (error) {
      this.logger.error('getUserFacts failed', { error: (error as Error).message, userId });
      return [];
    }
  }

  /** Store a new fact or update existing via lifecycle-aware supersession. */
  async storeFact(input: StoreFact): Promise<Fact> {
    const { userId, category, key, value, confidence = 0.8, factType = 'permanent', validFrom, validUntil, sessionId } = input;

    return this.pg.transaction(async (client) => {
      // Find existing active fact with same key
      const existingResult = await client.query(
        `SELECT id, fact_value, mention_count, fact_type, fact_status
         FROM ${this.prefix}facts
         WHERE user_id = $1 AND category = $2 AND fact_key = $3
           AND fact_status = 'active'
         ORDER BY override_priority DESC, mention_count DESC
         LIMIT 1`,
        [userId, category, key]
      );
      const existing = existingResult.rows[0];

      if (!existing) {
        // New fact
        const priority = factType === 'temporary' ? 20 : 0;
        const result = await client.query(
          `INSERT INTO ${this.prefix}facts
            (user_id, category, fact_key, fact_value, confidence, source_session_id,
             fact_status, fact_type, valid_from, valid_until, override_priority)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10)
           RETURNING *`,
          [userId, category, key, value, confidence, sessionId ?? null,
           factType, validFrom ?? null, validUntil ?? null, priority]
        );
        const fact = mapRowToFact(result.rows[0]);

        // Sync to graph (non-blocking)
        if (this.graph) {
          this.graph.syncFact(userId, fact).catch(e =>
            this.logger.warn('Graph sync failed', { error: (e as Error).message })
          );
        }

        return fact;
      }

      if (existing.fact_value === value) {
        // Same value - bump mention count
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

      // Different value - supersession
      const inheritedMentionCount = (existing.mention_count as number) + 1;
      const newStatus = factType === 'temporary' ? 'overridden' : 'superseded';

      await client.query(
        `UPDATE ${this.prefix}facts SET fact_status = $2, updated_at = NOW() WHERE id = $1`,
        [existing.id, newStatus]
      );

      const priority = factType === 'temporary' ? 20 : 10;
      const result = await client.query(
        `INSERT INTO ${this.prefix}facts
          (user_id, category, fact_key, fact_value, confidence, source_session_id,
           fact_status, fact_type, valid_from, valid_until, supersedes_id, override_priority, mention_count)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [userId, category, key, value, confidence, sessionId ?? null,
         factType, validFrom ?? null, validUntil ?? null, existing.id, priority, inheritedMentionCount]
      );
      const fact = mapRowToFact(result.rows[0]);

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
      `UPDATE ${this.prefix}facts SET fact_status = 'expired', updated_at = NOW() WHERE id = $1`,
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

Key fact types to watch for:
- People: names, relationships (partner, child, friend, colleague, ex)
- Places: where they live, work, grew up
- Work: employer, role, field, career changes, work situations
- Preferences: likes, dislikes, diet, allergies, hobbies
- Life events: moves, job changes, breakups, health changes — use factType "context" category + "temporary" type
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

      // Parse response: handle array, object with array value, or single object
      let facts: ExtractedFact[];
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        facts = JSON.parse(arrayMatch[0]) as ExtractedFact[];
      } else {
        // Some models return a single object or {key: [...]} instead of a bare array
        const parsed = JSON.parse(response);
        if (Array.isArray(parsed)) {
          facts = parsed;
        } else if (parsed && typeof parsed === 'object') {
          // Check for array value (e.g., {"facts": [...]}) or treat as single fact
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
    // Pre-fetch: all active facts for this user + any active facts whose
    // (category, fact_key) exactly matches one of the extracted pairs.
    // The second arm catches exact-match dedup targets even if the user
    // has a very large fact set where the top-ranked page would miss them.
    const existingFacts: Fact[] = await this.loadDedupCandidates(userId, facts);

    // Index by normalized key for O(1) fast-path lookup during semantic dedup.
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
      // For multi-valued keys, disambiguate by appending a value slug to the key
      // e.g., job_title → job_title:ceramics_artist vs job_title:library_worker
      const keyNorm = f.factKey.toLowerCase().replace(/[_\-\s]+/g, '_');
      if (FactsService.MULTI_VALUED_KEYS.has(keyNorm)) {
        const slug = f.factValue.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        f.factKey = `${f.factKey}:${slug}`;
      }

      // Cross-key semantic dedup: fast path by exact normalized-key hit, slow
      // path by similar-key scan.
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
        },
        original: f,
      });
    }

    // Batched bump of mention counts for all dedup hits in one round-trip.
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

    // Store each new fact. Kept as individual transactions (not one outer
    // transaction) because storeFact contains supersession logic that may
    // legitimately fail per-fact (e.g., partial input), and per-fact
    // isolation preserves the existing "log and continue" behavior.
    for (const { input, original } of toInsert) {
      try {
        const fact = await this.storeFact(input);
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
   * Build the dedup candidate set: top-ranked active facts for the user,
   * unioned with any active facts whose exact (category, fact_key) matches
   * one of the extracted pairs. The exact-match arm uses the
   * idx_<prefix>facts_user_key index so it is cheap even for users with
   * thousands of facts.
   */
  private async loadDedupCandidates(userId: string, extracted: ExtractedFact[]): Promise<Fact[]> {
    const top: Fact[] = await this.getUserFacts(userId, undefined, 100).catch(() => []);

    // Dedup extracted pairs for the IN clause.
    const pairKey = (c: string, k: string) => `${c} ${k}`;
    const pairs = new Map<string, { category: string; factKey: string }>();
    for (const f of extracted) {
      if (!f.category || !f.factKey) continue;
      pairs.set(pairKey(f.category, f.factKey), { category: f.category, factKey: f.factKey });
    }
    if (pairs.size === 0) return top;

    // Build (cat, key) IN (...) query
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

    // Merge: prefer exact matches, then top page, dedup by id.
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
