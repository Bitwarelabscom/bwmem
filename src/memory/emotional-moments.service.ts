import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, EmotionalMoment } from '../types.js';

export class EmotionalMomentsService {
  private pg: PgClient;
  private llm: LLMProvider;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Capture an emotional moment when VAD thresholds are crossed. */
  async capture(
    userId: string, sessionId: string, rawText: string,
    valence: number, arousal: number, dominance: number,
    contextTopic?: string,
  ): Promise<void> {
    try {
      // Generate a brief moment tag via LLM (fire-and-forget style)
      let momentTag = '';
      try {
        const valenceLabel = valence > 0.3 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral';
        momentTag = await this.llm.chat([
          { role: 'system', content: `Tag this emotional moment with a specific, descriptive phrase (3-8 words).
Be specific about WHAT caused the emotion, not just the emotion itself.

Good examples: "Career milestone and pride", "Frustration with slow progress", "Nostalgia for childhood home", "Excitement about new relationship", "Grief over lost friendship"
Bad examples: "positive moment", "negative feeling", "emotional experience", "happy"

The emotional valence is ${valenceLabel}. Return ONLY the phrase, no quotes.` },
          { role: 'user', content: rawText.slice(0, 500) },
        ], { temperature: 0.3, maxTokens: 30 });
        momentTag = momentTag.trim().replace(/^["']|["']$/g, '');
        // Reject generic tags
        if (/^(positive|negative|neutral|emotional)\s*(moment|feeling|experience)?$/i.test(momentTag)) {
          momentTag = `${valenceLabel} reaction: ${rawText.slice(0, 40).trim()}`;
        }
      } catch {
        momentTag = `${valence > 0 ? 'positive' : 'negative'} reaction: ${rawText.slice(0, 40).trim()}`;
      }

      await this.pg.query(
        `INSERT INTO ${this.prefix}emotional_moments
          (user_id, session_id, raw_text, moment_tag, valence, arousal, dominance, context_topic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, sessionId, rawText.slice(0, 2000), momentTag, valence, arousal, dominance, contextTopic ?? null]
      );
    } catch (error) {
      this.logger.error('Failed to capture emotional moment', { error: (error as Error).message });
    }
  }

  /** Get recent emotional moments for a user. */
  async getRecent(userId: string, days = 7, limit = 10): Promise<EmotionalMoment[]> {
    try {
      const rows = await this.pg.query<Record<string, unknown>>(
        `SELECT id, user_id, session_id, raw_text, moment_tag, valence, arousal, dominance,
                context_topic, created_at
         FROM ${this.prefix}emotional_moments
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [userId, days, limit]
      );

      return rows.map(row => ({
        id: row.id as string,
        userId: row.user_id as string,
        sessionId: row.session_id as string,
        rawText: row.raw_text as string,
        momentTag: row.moment_tag as string,
        valence: row.valence as number,
        arousal: row.arousal as number,
        dominance: row.dominance as number,
        contextTopic: row.context_topic as string | undefined,
        createdAt: row.created_at as Date,
      }));
    } catch (error) {
      this.logger.error('getRecentMoments failed', { error: (error as Error).message });
      return [];
    }
  }

  /** Format emotional moments for LLM context. */
  formatForPrompt(moments: EmotionalMoment[]): string {
    if (moments.length === 0) return '';
    return moments
      .map(m => `- "${m.momentTag}" (v:${m.valence.toFixed(1)} a:${m.arousal.toFixed(1)})`)
      .join('\n');
  }
}
