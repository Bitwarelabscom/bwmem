import type { PgClient } from '../db/postgres.js';
import type { Logger, BehavioralObservation } from '../types.js';

export class BehavioralService {
  private pg: PgClient;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Get active (non-expired) behavioral observations for a user. */
  async getActive(userId: string, limit = 10): Promise<BehavioralObservation[]> {
    try {
      const rows = await this.pg.query<Record<string, unknown>>(
        `SELECT id, user_id, observation_type, observation, evidence_summary,
                severity, window_start, window_end, expired, created_at
         FROM ${this.prefix}behavioral_observations
         WHERE user_id = $1 AND expired = FALSE
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return rows.map(row => ({
        id: row.id as string,
        userId: row.user_id as string,
        observationType: row.observation_type as string,
        observation: row.observation as string,
        evidenceSummary: row.evidence_summary as string,
        severity: row.severity as number,
        windowStart: row.window_start as Date,
        windowEnd: row.window_end as Date,
        expired: row.expired as boolean,
        createdAt: row.created_at as Date,
      }));
    } catch (error) {
      this.logger.error('getActive failed', { error: (error as Error).message });
      return [];
    }
  }

  /** Detect behavioral patterns from recent message sentiment data. */
  async detectPatterns(userId: string): Promise<void> {
    try {
      // Get recent message sentiment data (last 24h)
      const recentSentiment = await this.pg.query<Record<string, unknown>>(
        `SELECT sentiment_valence, sentiment_arousal, created_at
         FROM ${this.prefix}messages
         WHERE user_id = $1
           AND created_at > NOW() - INTERVAL '24 hours'
           AND sentiment_valence IS NOT NULL
         ORDER BY created_at`,
        [userId]
      );

      if (recentSentiment.length < 5) return; // Not enough data

      // Calculate trends
      const valences = recentSentiment.map(r => r.sentiment_valence as number);
      const arousals = recentSentiment.map(r => r.sentiment_arousal as number);

      const avgValence = valences.reduce((a, b) => a + b, 0) / valences.length;
      const avgArousal = arousals.reduce((a, b) => a + b, 0) / arousals.length;

      // Detect significant patterns
      const observations: Array<{ type: string; observation: string; severity: number }> = [];

      if (avgValence < -0.3) {
        observations.push({
          type: 'mood_decline',
          observation: `Sustained negative mood trend (avg valence: ${avgValence.toFixed(2)})`,
          severity: Math.min(1, Math.abs(avgValence)),
        });
      }

      if (avgArousal > 0.7) {
        observations.push({
          type: 'high_arousal',
          observation: `Elevated arousal levels (avg: ${avgArousal.toFixed(2)})`,
          severity: avgArousal,
        });
      }

      // Check for valence volatility
      const valenceVariance = valences.reduce((sum, v) => sum + Math.pow(v - avgValence, 2), 0) / valences.length;
      if (valenceVariance > 0.3) {
        observations.push({
          type: 'mood_volatility',
          observation: `High emotional volatility (variance: ${valenceVariance.toFixed(2)})`,
          severity: Math.min(1, valenceVariance),
        });
      }

      const now = new Date();
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      for (const obs of observations) {
        await this.pg.query(
          `INSERT INTO ${this.prefix}behavioral_observations
            (user_id, observation_type, observation, evidence_summary, severity, window_start, window_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, obs.type, obs.observation, `Based on ${recentSentiment.length} messages`, obs.severity, windowStart, now]
        );
      }
    } catch (error) {
      this.logger.error('detectPatterns failed', { error: (error as Error).message });
    }
  }

  /** Expire old behavioral observations. */
  async expireStale(maxAgeDays = 7): Promise<number> {
    try {
      const result = await this.pg.query<{ count: string }>(
        `WITH expired AS (
           UPDATE ${this.prefix}behavioral_observations
           SET expired = TRUE
           WHERE expired = FALSE AND created_at < NOW() - INTERVAL '1 day' * $1
           RETURNING id
         )
         SELECT COUNT(*) as count FROM expired`,
        [maxAgeDays]
      );
      return parseInt(result[0]?.count ?? '0', 10);
    } catch (error) {
      this.logger.error('expireStale failed', { error: (error as Error).message });
      return 0;
    }
  }

  /** Format behavioral observations for LLM context. */
  formatForPrompt(observations: BehavioralObservation[]): string {
    if (observations.length === 0) return '';
    return observations
      .map(o => `- [${o.observationType}] ${o.observation} (severity: ${o.severity.toFixed(1)})`)
      .join('\n');
  }
}
