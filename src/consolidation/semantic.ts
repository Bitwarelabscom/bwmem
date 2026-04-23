import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, GraphPlugin } from '../types.js';
import type { FactsService } from '../memory/facts.service.js';
import { mapLimit } from '../utils/concurrent.js';

const CONSOLIDATION_CONCURRENCY = 5;

/**
 * Semantic consolidation - aggregates episodic patterns into long-term knowledge.
 * Daily: merge recent patterns. Weekly: deep analysis + pruning.
 */
export class SemanticConsolidator {
  private pg: PgClient;
  private llm: LLMProvider;
  private facts: FactsService;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, facts: FactsService, graph: GraphPlugin | null, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.facts = facts;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Daily consolidation: aggregate recent episodic patterns into semantic knowledge. */
  async consolidateDaily(): Promise<void> {
    const run = await this.pg.queryOne<{ id: string }>(
      `INSERT INTO ${this.prefix}consolidation_runs (run_type) VALUES ('daily') RETURNING id`
    );
    if (!run) return;

    try {
      // Get distinct users with recent episodic patterns
      const users = await this.pg.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM ${this.prefix}episodic_patterns
         WHERE created_at > NOW() - INTERVAL '24 hours'`
      );

      const counts = await mapLimit(users, CONSOLIDATION_CONCURRENCY, async ({ user_id: userId }) => {
        try {
          return await this.consolidateUserDaily(userId);
        } catch (err) {
          this.logger.warn('Per-user daily consolidation failed', {
            userId, error: (err as Error).message,
          });
          return 0;
        }
      });
      const totalPatterns = counts.reduce((a, b) => a + b, 0);

      await this.pg.query(
        `UPDATE ${this.prefix}consolidation_runs
         SET status = 'completed', patterns_extracted = $2, completed_at = NOW()
         WHERE id = $1`,
        [run.id, totalPatterns]
      );

      this.logger.info('Daily consolidation complete', { users: users.length, patterns: totalPatterns });
    } catch (error) {
      await this.pg.query(
        `UPDATE ${this.prefix}consolidation_runs
         SET status = 'failed', error_message = $2, completed_at = NOW()
         WHERE id = $1`,
        [run.id, (error as Error).message]
      );
      throw error;
    }
  }

  /** Weekly consolidation: deep analysis, pruning, graph sync. */
  async consolidateWeekly(): Promise<void> {
    const run = await this.pg.queryOne<{ id: string }>(
      `INSERT INTO ${this.prefix}consolidation_runs (run_type) VALUES ('weekly') RETURNING id`
    );
    if (!run) return;

    try {
      const users = await this.pg.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM ${this.prefix}semantic_knowledge`
      );

      await mapLimit(users, CONSOLIDATION_CONCURRENCY, async ({ user_id: userId }) => {
        try {
          await this.consolidateUserWeekly(userId);
        } catch (err) {
          this.logger.warn('Per-user weekly consolidation failed', {
            userId, error: (err as Error).message,
          });
        }
      });

      await this.pg.query(
        `UPDATE ${this.prefix}consolidation_runs
         SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [run.id]
      );

      this.logger.info('Weekly consolidation complete', { users: users.length });
    } catch (error) {
      await this.pg.query(
        `UPDATE ${this.prefix}consolidation_runs
         SET status = 'failed', error_message = $2, completed_at = NOW()
         WHERE id = $1`,
        [run.id, (error as Error).message]
      );
      throw error;
    }
  }

  private async consolidateUserDaily(userId: string): Promise<number> {
    // Get recent episodic patterns
    const patterns = await this.pg.query<Record<string, unknown>>(
      `SELECT pattern_type, pattern, confidence
       FROM ${this.prefix}episodic_patterns
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`,
      [userId]
    );

    if (patterns.length === 0) return 0;

    // Get existing semantic knowledge for context
    const existing = await this.pg.query<Record<string, unknown>>(
      `SELECT entry_type, theme, value, confidence
       FROM ${this.prefix}semantic_knowledge
       WHERE user_id = $1
       ORDER BY confidence DESC LIMIT 20`,
      [userId]
    );

    const patternsText = patterns
      .map(p => `[${p.pattern_type}] ${p.pattern} (confidence: ${p.confidence})`)
      .join('\n');

    const existingText = existing.length > 0
      ? existing.map(e => `[${e.entry_type}] ${e.theme}: ${e.value}`).join('\n')
      : 'None';

    // LLM aggregation
    const response = await this.llm.chat([
      {
        role: 'system',
        content: `Consolidate these recent conversation patterns into long-term semantic knowledge.
Merge similar patterns, update existing knowledge, identify new insights.

Existing knowledge:
${existingText}

Return JSON array:
[{"entryType": "preference|known_fact|behavioral_baseline", "theme": "short label", "value": "description", "confidence": 0.0-1.0, "action": "create|update|merge"}]

- "create": new knowledge entry
- "update": update existing entry with new confidence/value
- "merge": merge with existing entry

Return [] if no significant knowledge to consolidate.`,
      },
      { role: 'user', content: `Recent patterns:\n${patternsText}` },
    ], { temperature: 0.2, maxTokens: 1000, json: true });

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const entries = JSON.parse(jsonMatch[0]) as Array<{
      entryType: string;
      theme: string;
      value: string;
      confidence: number;
      action: string;
    }>;

    for (const entry of entries) {
      await this.pg.query(
        `INSERT INTO ${this.prefix}semantic_knowledge
          (user_id, entry_type, theme, value, confidence, source_count)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (user_id, entry_type, theme) DO UPDATE SET
           value = EXCLUDED.value,
           confidence = GREATEST(${this.prefix}semantic_knowledge.confidence, EXCLUDED.confidence),
           source_count = ${this.prefix}semantic_knowledge.source_count + 1,
           updated_at = NOW()`,
        [userId, entry.entryType, entry.theme, entry.value, entry.confidence]
      );
    }

    return entries.length;
  }

  private async consolidateUserWeekly(userId: string): Promise<void> {
    // Get all semantic knowledge
    const knowledge = await this.pg.query<Record<string, unknown>>(
      `SELECT id, entry_type, theme, value, confidence, source_count
       FROM ${this.prefix}semantic_knowledge
       WHERE user_id = $1
       ORDER BY confidence DESC`,
      [userId]
    );

    if (knowledge.length === 0) return;

    // Get user facts for cross-referencing
    const facts = await this.facts.getUserFacts(userId);

    const knowledgeText = knowledge
      .map(k => `[${k.entry_type}] ${k.theme}: ${k.value} (confidence: ${k.confidence}, sources: ${k.source_count})`)
      .join('\n');

    const factsText = facts.slice(0, 20)
      .map(f => `${f.category}/${f.factKey}: ${f.factValue}`)
      .join('\n');

    // Deep analysis via LLM
    const response = await this.llm.chat([
      {
        role: 'system',
        content: `Review this user's semantic knowledge for consistency and accuracy.

Known facts:
${factsText}

Return JSON:
{"prune": ["theme1", "theme2"], "updateConfidence": [{"theme": "x", "newConfidence": 0.5}]}

- prune: themes that are outdated, contradictory, or low-value
- updateConfidence: adjust confidence based on fact alignment`,
      },
      { role: 'user', content: `Current knowledge:\n${knowledgeText}` },
    ], { temperature: 0.2, maxTokens: 500, json: true });

    try {
      const parsed = JSON.parse(response);

      // Prune
      if (parsed.prune?.length > 0) {
        for (const theme of parsed.prune) {
          await this.pg.query(
            `DELETE FROM ${this.prefix}semantic_knowledge WHERE user_id = $1 AND theme = $2`,
            [userId, theme]
          );
        }
      }

      // Update confidence
      if (parsed.updateConfidence?.length > 0) {
        for (const update of parsed.updateConfidence) {
          await this.pg.query(
            `UPDATE ${this.prefix}semantic_knowledge
             SET confidence = $3, updated_at = NOW()
             WHERE user_id = $1 AND theme = $2`,
            [userId, update.theme, update.newConfidence]
          );
        }
      }
    } catch {
      // Non-critical - weekly analysis is best-effort
    }

    // Sync to graph if available
    if (this.graph) {
      for (const fact of facts) {
        await this.graph.syncFact(userId, fact).catch(() => {});
      }
    }
  }
}
