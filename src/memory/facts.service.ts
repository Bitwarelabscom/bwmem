import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, Fact, StoreFact, ExtractedFact, GraphPlugin } from '../types.js';
import { formatRelativeTime } from '../utils/time-utils.js';

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
        this.graph.syncFact(userId, fact).catch(e =>
          this.logger.warn('Graph sync failed', { error: (e as Error).message })
        );
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
      [userId, `%${query}%`]
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
      let systemPrompt = `You are a fact extraction assistant. Extract personal facts about the user from the conversation.

Rules:
- Only extract facts the user explicitly states about themselves
- Do not infer or assume facts
- Use simple, normalized values
- Confidence: 1.0 for explicit statements, 0.8 for strongly implied
- Categories: ${FACT_CATEGORIES.join(', ')}
- NEVER store interpretations or psychological observations
- If a fact contains "suggests", "implies", "may reflect" - discard it

Lifecycle:
- If the user corrects a previously known fact, set "isCorrection": true
- Temporary states: set "factType": "temporary" and "validUntil": ISO date if known
- Recurring baselines: set "factType": "default"
- Default to "permanent"

Output JSON array:
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

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const facts = JSON.parse(jsonMatch[0]) as ExtractedFact[];

      return facts.filter(f => {
        if (!f.category || !f.factKey || !f.factValue || typeof f.confidence !== 'number') return false;
        if (isSpeculativeFact(f.factValue)) {
          this.logger.warn('Rejected speculative fact', { key: f.factKey });
          return false;
        }
        return true;
      });
    } catch (error) {
      this.logger.error('Fact extraction failed', { error: (error as Error).message });
      return [];
    }
  }

  /** Store facts extracted by LLM, handling supersession. */
  async storeExtractedFacts(userId: string, facts: ExtractedFact[], sessionId?: string): Promise<Fact[]> {
    const stored: Fact[] = [];
    for (const f of facts) {
      try {
        const fact = await this.storeFact({
          userId,
          category: f.category,
          key: f.factKey,
          value: f.factValue,
          confidence: f.confidence,
          factType: f.factType || 'permanent',
          sessionId,
        });
        stored.push(fact);
      } catch (error) {
        this.logger.error('Failed to store extracted fact', { error: (error as Error).message, factKey: f.factKey });
      }
    }
    return stored;
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
