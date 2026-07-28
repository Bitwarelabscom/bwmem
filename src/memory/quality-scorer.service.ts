import type { PgClient } from '../db/postgres.js';
import type { EmbeddingProvider, LLMProvider, Logger, QualityStats } from '../types.js';

/**
 * Per-response quality scoring (mig 008).
 *
 * Splits the single old "quality" composite into two honest numbers so the
 * user's reply latency and terseness do not drag the agent's self-score:
 *
 *   • output_integrity   — the AGENT's quality (relevance, coherence,
 *                          memory_fidelity, generativity, completeness_honesty).
 *                          Computed in two passes: the deterministic floor
 *                          (relevance + coherence) at save, plus an optional
 *                          periodic LLM self-check for the rest.
 *   • interaction_vitality — engagement signal (mostly the user's): reply
 *                          speed, length, and feedback class. Real signal,
 *                          but not a quality score.
 *
 * Phases:
 *   1. scoreResponse  — at save: relevance + coherence → output_integrity.
 *   2. resolveFollowup — at the user's reply: interaction_vitality.
 *   3. runSelfCheck   — periodic sample: LLM-graded memory_fidelity /
 *      generativity / completeness_honesty, folded into output_integrity.
 */

const HEDGING_PATTERN = /\b(i think|perhaps|it might|i'm not sure|it seems|maybe|possibly|could be|i believe|i guess|sort of|kind of)\b/gi;
const REFUSAL_PATTERN = /\b(i cannot|i'm sorry,?\s+i can'?t|i'm unable to|i can'?t help with|i won'?t|i refuse|i'm not able to)\b/i;

const INTEGRITY_WEIGHTS: Record<string, number> = {
  relevance: 0.30,
  coherence: 0.25,
  memory_fidelity: 0.15,
  generativity: 0.20,
  completeness_honesty: 0.10,
};

const FEEDBACK_WEIGHTS: Record<string, number> = {
  praise: 1.0,
  elaboration_request: 0.9,
  correction: 0.8,
  shorter_request: 0.5,
};

const PRAISE_PATTERN = /\b(thank you|thanks|appreciate|great|awesome|excellent|perfect|love it|exactly|yes!)\b/i;
const ELABORATION_PATTERN = /\b(tell me more|what about|can you explain|elaborate|why|how come|interesting)\b/i;
const CORRECTION_PATTERN = /\b(actually|no,|that's wrong|not quite|incorrect|i meant|let me correct)\b/i;
const SHORTER_PATTERN = /\b(too long|shorter|tldr|brief|summary|concise)\b/i;

function detectFeedbackClass(text: string): string | null {
  if (PRAISE_PATTERN.test(text)) return 'praise';
  if (CORRECTION_PATTERN.test(text)) return 'correction';
  if (ELABORATION_PATTERN.test(text)) return 'elaboration_request';
  if (SHORTER_PATTERN.test(text)) return 'shorter_request';
  return null;
}

export interface ScoreResponseInput {
  messageId: string;
  userId: string;
  sessionId: string;
  mode?: string;
  responseContent: string;
}

export interface ResolveFollowupInput {
  userId: string;
  sessionId: string;
  previousAssistantMessageId: string;
  previousAssistantCreatedAt: Date;
  nextUserContent: string;
  nextUserCreatedAt: Date;
}

export class QualityScorerService {
  private pg: PgClient;
  private llm: LLMProvider;
  private embeddings: EmbeddingProvider | null;
  private prefix: string;
  private logger: Logger;

  constructor(
    pg: PgClient,
    llm: LLMProvider,
    embeddings: EmbeddingProvider | null,
    prefix: string,
    logger: Logger,
  ) {
    this.pg = pg;
    this.llm = llm;
    this.embeddings = embeddings;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Phase 1: deterministic floor written immediately after the assistant message saves. */
  async scoreResponse(input: ScoreResponseInput): Promise<void> {
    const { messageId, userId, sessionId, mode, responseContent } = input;
    try {
      const wordCount = countWords(responseContent);
      const hedgingMatches = (responseContent.match(HEDGING_PATTERN) || []).length;
      const hedgingDensity = wordCount > 0 ? hedgingMatches / (wordCount / 100) : 0;
      const refusalDetected = REFUSAL_PATTERN.test(responseContent);

      const askedContent = await this.getPrecedingUserMessage(sessionId, messageId);
      const relevance = askedContent && this.embeddings
        ? await this.safeCosineSimilarity(responseContent, askedContent)
        : null;
      const coherence = await this.coherenceFromContradictions(userId, sessionId);

      const scores = {
        hedging_density: round3(hedgingDensity),
        refusal_detected: refusalDetected,
        word_count: wordCount,
        relevance: relevance !== null ? round3(clamp01(relevance)) : null,
        coherence: round3(coherence),
      };
      const outputIntegrity = computeOutputIntegrity(scores);

      await this.pg.query(
        `INSERT INTO ${this.prefix}message_quality
           (message_id, user_id, session_id, mode, scores, output_integrity, composite_score)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (message_id) DO UPDATE SET
           scores = ${this.prefix}message_quality.scores || EXCLUDED.scores,
           output_integrity = EXCLUDED.output_integrity,
           composite_score = EXCLUDED.output_integrity,
           scored_at = now()`,
        [messageId, userId, sessionId, mode ?? null, JSON.stringify(scores), outputIntegrity],
      );
    } catch (err) {
      this.logger.warn('quality scoreResponse failed', {
        error: (err as Error).message, messageId: input.messageId,
      });
    }
  }

  /** Phase 2: interaction vitality, written when the user replies. */
  async resolveFollowup(input: ResolveFollowupInput): Promise<void> {
    const {
      sessionId, previousAssistantMessageId,
      previousAssistantCreatedAt, nextUserContent, nextUserCreatedAt,
    } = input;
    try {
      const followupResponseTimeMs = nextUserCreatedAt.getTime() - previousAssistantCreatedAt.getTime();
      const prevUserMessageLen = await this.getPrevUserMessageLength(sessionId, previousAssistantCreatedAt);
      const followupLengthRatio = prevUserMessageLen > 0
        ? round3(nextUserContent.length / prevUserMessageLen)
        : null;
      const feedback = detectFeedbackClass(nextUserContent);

      const vitality = computeInteractionVitality({
        followupResponseTimeMs,
        replyChars: nextUserContent.length,
        explicitFeedback: feedback,
      });

      const followupScores = {
        followup_response_time_ms: followupResponseTimeMs,
        followup_length_ratio: followupLengthRatio,
      };

      await this.pg.query(
        `UPDATE ${this.prefix}message_quality
           SET scores = scores || $2::jsonb,
               followup_resolved_at = $3,
               explicit_feedback = $4,
               interaction_vitality = $5
         WHERE message_id = $1`,
        [previousAssistantMessageId, JSON.stringify(followupScores), nextUserCreatedAt, feedback, vitality],
      );
    } catch (err) {
      this.logger.warn('quality resolveFollowup failed', {
        error: (err as Error).message, messageId: input.previousAssistantMessageId,
      });
    }
  }

  /**
   * Phase 3: periodic LLM self-check. Samples recent responses missing a
   * self-check and asks a light model the three questions only the agent can
   * be graded on (memory_fidelity / generativity / completeness_honesty),
   * folds them into output_integrity.
   */
  async runSelfCheck(sampleSize = 8): Promise<number> {
    let rows: Array<{ message_id: string; user_id: string; session_id: string; scores: Record<string, unknown> }>;
    try {
      rows = await this.pg.query<{ message_id: string; user_id: string; session_id: string; scores: Record<string, unknown> }>(
        `SELECT message_id, user_id, session_id, scores
           FROM ${this.prefix}message_quality
          WHERE output_integrity IS NOT NULL AND self_check_at IS NULL
            AND scored_at > now() - interval '3 days'
          ORDER BY scored_at DESC
          LIMIT $1`,
        [sampleSize],
      );
    } catch (err) {
      this.logger.debug('quality self-check sample query failed', { err: (err as Error).message });
      return 0;
    }
    if (rows.length === 0) return 0;

    let processed = 0;
    for (const row of rows) {
      try {
        const response = await this.getMessageContent(row.message_id);
        if (!response) { await this.markSelfCheckSkipped(row.message_id); continue; }
        const asked = await this.getPrecedingUserMessage(row.session_id, row.message_id);
        const facts = await this.getKnownFacts(row.user_id);
        const sub = await this.llmSelfCheck(asked, response, facts);
        if (!sub) { await this.markSelfCheckSkipped(row.message_id); continue; }

        const merged = { ...row.scores, ...sub.scores };
        const outputIntegrity = computeOutputIntegrity(merged);
        await this.pg.query(
          `UPDATE ${this.prefix}message_quality
             SET scores = scores || $2::jsonb,
                 output_integrity = $3,
                 composite_score = $3,
                 self_check_at = now()
           WHERE message_id = $1`,
          [row.message_id, JSON.stringify({ ...sub.scores, self_check_note: sub.note }), outputIntegrity],
        );
        processed++;
      } catch (err) {
        this.logger.debug('quality self-check row failed', { messageId: row.message_id, err: (err as Error).message });
      }
    }
    this.logger.info('quality self-check pass complete', { sampled: rows.length, processed });
    return processed;
  }

  async getStats(
    userId: string,
    options: { since?: Date; mode?: string; limit?: number } = {},
  ): Promise<QualityStats> {
    const { since, mode, limit = 10 } = options;
    const params: unknown[] = [userId];
    let where = `WHERE user_id = $1`;
    if (since) { params.push(since); where += ` AND scored_at >= $${params.length}`; }
    if (mode) { params.push(mode); where += ` AND mode = $${params.length}`; }

    const aggregate = await this.pg.query<{
      total: string; avg_integrity: string | null; avg_vitality: string | null;
      avg_hedging: string | null; refusal_rate: string | null; self_checked: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         AVG(output_integrity)::text AS avg_integrity,
         AVG(interaction_vitality)::text AS avg_vitality,
         AVG((scores->>'hedging_density')::numeric)::text AS avg_hedging,
         (SUM(CASE WHEN (scores->>'refusal_detected')::boolean THEN 1 ELSE 0 END)::numeric
           / NULLIF(COUNT(*), 0))::text AS refusal_rate,
         COUNT(*) FILTER (WHERE self_check_at IS NOT NULL)::text AS self_checked
       FROM ${this.prefix}message_quality ${where}`,
      params,
    );

    const feedbackResult = await this.pg.query<{ explicit_feedback: string | null; n: string }>(
      `SELECT explicit_feedback, COUNT(*)::text AS n
         FROM ${this.prefix}message_quality ${where} GROUP BY explicit_feedback`,
      params,
    );
    const feedbackBreakdown: Record<string, number> = {};
    for (const r of feedbackResult) feedbackBreakdown[r.explicit_feedback ?? 'none'] = parseInt(r.n, 10);

    const lowParams = [...params, limit];
    const lowResult = await this.pg.query<{
      message_id: string; session_id: string; scored_at: Date;
      output_integrity: string | null; explicit_feedback: string | null;
    }>(
      `SELECT message_id, session_id, scored_at, output_integrity::text, explicit_feedback
         FROM ${this.prefix}message_quality ${where} AND output_integrity IS NOT NULL
        ORDER BY output_integrity ASC LIMIT $${lowParams.length}`,
      lowParams,
    );

    const agg = aggregate[0];
    const num = (s: string | null | undefined) => (s ? parseFloat(s) : null);
    return {
      total: parseInt(agg?.total ?? '0', 10),
      averageOutputIntegrity: num(agg?.avg_integrity),
      averageInteractionVitality: num(agg?.avg_vitality),
      averageComposite: num(agg?.avg_integrity),
      averageHedgingDensity: num(agg?.avg_hedging),
      refusalRate: agg?.refusal_rate ? parseFloat(agg.refusal_rate) : 0,
      selfCheckedCount: parseInt(agg?.self_checked ?? '0', 10),
      feedbackBreakdown,
      recentLowQuality: lowResult.map(r => ({
        messageId: r.message_id,
        sessionId: r.session_id,
        scoredAt: r.scored_at,
        outputIntegrity: r.output_integrity ? parseFloat(r.output_integrity) : null,
        explicitFeedback: r.explicit_feedback,
      })),
    };
  }

  // ── LLM self-check ────────────────────────────────────────────────────────

  private async llmSelfCheck(
    asked: string | null,
    response: string,
    facts: Array<{ key: string; value: string }>,
  ): Promise<{ scores: Record<string, number>; note: string } | null> {
    const factLines = facts.length
      ? facts.map(f => `- ${f.key}: ${f.value}`).join('\n')
      : '(no stored facts available)';
    const system = [
      'You grade ONE assistant response on three axes that are about the assistant itself,',
      'never about whether the user liked it or replied fast. Return STRICT JSON only:',
      '{"memory_fidelity":0-1,"generativity":0-1,"completeness_honesty":0-1,"note":"<=12 words"}',
      '',
      '- memory_fidelity: does the response stay consistent with the known facts below,',
      '  inventing nothing about the user? (1 = fully consistent or N/A; lower if it',
      '  contradicts a known fact or fabricates a personal detail.)',
      '- generativity: did it ADD something — advance the thread, offer, connect — vs',
      '  merely echo/acknowledge? (1 = genuinely additive; ~0.4 = pure mirroring.)',
      '- completeness_honesty: is it structurally complete and honest (no hand-waving,',
      '  no pretending to know what it does not)? (1 = complete & honest.)',
    ].join('\n');
    const user = [
      'KNOWN FACTS ABOUT THE USER:',
      factLines,
      '',
      `USER ASKED: ${asked ? truncate(asked, 800) : '(unknown / continuation)'}`,
      '',
      `ASSISTANT RESPONSE:\n${truncate(response, 2000)}`,
    ].join('\n');

    try {
      const result = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { temperature: 0, maxTokens: 200, json: true },
      );
      const parsed = parseJsonObject(result || '');
      if (!parsed) return null;
      const scores: Record<string, number> = {};
      for (const k of ['memory_fidelity', 'generativity', 'completeness_honesty']) {
        const v = Number(parsed[k]);
        if (Number.isFinite(v)) scores[k] = round3(clamp01(v));
      }
      if (Object.keys(scores).length === 0) return null;
      return { scores, note: typeof parsed.note === 'string' ? parsed.note.slice(0, 120) : '' };
    } catch (err) {
      this.logger.debug('llmSelfCheck failed', { err: (err as Error).message });
      return null;
    }
  }

  // ── Data helpers ──────────────────────────────────────────────────────────

  private async getPrecedingUserMessage(sessionId: string, assistantMessageId: string): Promise<string | null> {
    try {
      const r = await this.pg.queryOne<{ content: string }>(
        `SELECT content FROM ${this.prefix}messages
          WHERE session_id = $1 AND role = 'user'
            AND created_at < (SELECT created_at FROM ${this.prefix}messages WHERE id = $2)
          ORDER BY created_at DESC LIMIT 1`,
        [sessionId, assistantMessageId],
      );
      return r?.content ?? null;
    } catch { return null; }
  }

  private async getMessageContent(messageId: string): Promise<string | null> {
    try {
      const r = await this.pg.queryOne<{ content: string }>(
        `SELECT content FROM ${this.prefix}messages WHERE id = $1`, [messageId],
      );
      return r?.content ?? null;
    } catch { return null; }
  }

  private async getPrevUserMessageLength(sessionId: string, beforeTime: Date): Promise<number> {
    try {
      const r = await this.pg.queryOne<{ content: string }>(
        `SELECT content FROM ${this.prefix}messages
          WHERE session_id = $1 AND role = 'user' AND created_at < $2
          ORDER BY created_at DESC LIMIT 1`,
        [sessionId, beforeTime],
      );
      return r?.content?.length ?? 0;
    } catch { return 0; }
  }

  private async coherenceFromContradictions(userId: string, sessionId: string): Promise<number> {
    try {
      const r = await this.pg.queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${this.prefix}contradiction_signals
          WHERE user_id = $1 AND session_id = $2 AND created_at > now() - interval '10 minutes'`,
        [userId, sessionId],
      );
      const n = parseInt(r?.n ?? '0', 10);
      return n === 0 ? 1.0 : Math.max(0.4, 1 - n * 0.2);
    } catch { return 1.0; }
  }

  private async getKnownFacts(userId: string): Promise<Array<{ key: string; value: string }>> {
    try {
      const rows = await this.pg.query<{ fact_key: string; fact_value: string }>(
        `SELECT fact_key, fact_value FROM ${this.prefix}facts
          WHERE user_id = $1 AND fact_status = 'active'
          ORDER BY confidence DESC NULLS LAST, mention_count DESC NULLS LAST LIMIT 14`,
        [userId],
      );
      return rows.map(x => ({ key: x.fact_key, value: x.fact_value }));
    } catch { return []; }
  }

  private async markSelfCheckSkipped(messageId: string): Promise<void> {
    try {
      await this.pg.query(
        `UPDATE ${this.prefix}message_quality SET self_check_at = now() WHERE message_id = $1`,
        [messageId],
      );
    } catch { /* best effort */ }
  }

  private async safeCosineSimilarity(a: string, b: string): Promise<number | null> {
    if (!this.embeddings) return null;
    try {
      const [va, vb] = await this.embeddings.generateBatch([a.slice(0, 4000), b.slice(0, 4000)]);
      if (!va?.length || !vb?.length || va.length !== vb.length) return null;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
      const denom = Math.sqrt(na) * Math.sqrt(nb);
      return denom > 0 ? dot / denom : null;
    } catch { return null; }
  }
}

// ── Scoring math ──────────────────────────────────────────────────────────────

function computeOutputIntegrity(scores: Record<string, unknown>): number {
  let weighted = 0, totalWeight = 0;
  for (const [key, weight] of Object.entries(INTEGRITY_WEIGHTS)) {
    const v = scores[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      weighted += clamp01(v) * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) return 0.5;
  return round3(weighted / totalWeight);
}

function computeInteractionVitality(inputs: {
  followupResponseTimeMs: number; replyChars: number; explicitFeedback: string | null;
}): number {
  const speed = sigmoid01(30000, inputs.followupResponseTimeMs);
  const length = clamp01(inputs.replyChars / 200);
  const feedback = FEEDBACK_WEIGHTS[inputs.explicitFeedback ?? ''] ?? 0.3;
  return round3(speed * 0.4 + length * 0.2 + feedback * 0.4);
}

function sigmoid01(midpointMs: number, valueMs: number): number {
  const ratio = midpointMs / Math.max(valueMs, 1);
  return Math.max(0, Math.min(1, ratio / (1 + ratio) * 2));
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function countWords(text: string): number { return text ? text.trim().split(/\s+/).filter(Boolean).length : 0; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null;
  } catch { return null; }
}
