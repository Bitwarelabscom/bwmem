import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger } from '../types.js';
import type { SummariesService } from '../memory/summaries.service.js';

/**
 * Episodic consolidation - runs when a session ends.
 * Extracts patterns from the session's messages.
 */
export class EpisodicConsolidator {
  private pg: PgClient;
  private llm: LLMProvider;
  private summaries: SummariesService;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, summaries: SummariesService, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.summaries = summaries;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Consolidate a session into episodic patterns. */
  async consolidate(userId: string, sessionId: string): Promise<void> {
    // Create consolidation run record
    const run = await this.pg.queryOne<{ id: string }>(
      `INSERT INTO ${this.prefix}consolidation_runs (run_type, user_id, session_id)
       VALUES ('episodic', $1, $2) RETURNING id`,
      [userId, sessionId]
    );
    if (!run) return;

    try {
      // Get messages from the session
      const messages = await this.pg.query<Record<string, unknown>>(
        `SELECT role, content, sentiment_valence, sentiment_arousal, created_at
         FROM ${this.prefix}messages
         WHERE session_id = $1 ORDER BY created_at`,
        [sessionId]
      );

      if (messages.length < 2) {
        await this.markComplete(run.id, 0);
        return;
      }

      // Build transcript
      const transcript = messages
        .map(m => `${(m.role as string).toUpperCase()}: ${(m.content as string).slice(0, 300)}`)
        .join('\n');

      // Extract patterns via LLM
      const response = await this.llm.chat([
        {
          role: 'system',
          content: `Analyze this conversation and extract episodic patterns. Return JSON array:
[{"patternType": "theme|mood_shift|key_moment|preference_signal", "pattern": "description", "confidence": 0.0-1.0}]

Pattern types:
- theme: Main topics discussed
- mood_shift: Significant emotional changes
- key_moment: Important decisions, revelations, or turning points
- preference_signal: User preferences expressed or implied

Return [] if no significant patterns found.`,
        },
        { role: 'user', content: transcript.slice(0, 6000) },
      ], { temperature: 0.2, maxTokens: 1000, json: true });

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        await this.markComplete(run.id, 0);
        return;
      }

      const patterns = JSON.parse(jsonMatch[0]) as Array<{
        patternType: string;
        pattern: string;
        confidence: number;
      }>;

      // Store patterns
      for (const p of patterns) {
        await this.pg.query(
          `INSERT INTO ${this.prefix}episodic_patterns
            (user_id, session_id, consolidation_run_id, pattern_type, pattern, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, sessionId, run.id, p.patternType, p.pattern, p.confidence]
        );
      }

      // Generate conversation summary
      await this.summaries.summarizeSession(userId, sessionId);

      await this.markComplete(run.id, patterns.length);
      this.logger.info('Episodic consolidation complete', { sessionId, patterns: patterns.length });
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

  private async markComplete(runId: string, patternsExtracted: number): Promise<void> {
    await this.pg.query(
      `UPDATE ${this.prefix}consolidation_runs
       SET status = 'completed', patterns_extracted = $2, completed_at = NOW()
       WHERE id = $1`,
      [runId, patternsExtracted]
    );
  }
}
