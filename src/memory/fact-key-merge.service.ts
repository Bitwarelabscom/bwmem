// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Key-axis same-claim merge for storeFact.
 *
 * storeFact dedups on (user_id, fact_key) EXACTLY. When an extractor mints a new
 * key for a claim the store already holds — `learning_style_visual`, then
 * `visual_learning`, then `correction_preference_visual` — the lookup misses and
 * control falls to the plain INSERT, filing a parallel active row. Measured on a
 * production install: 129 active keys sharing one prefix in a single day, one
 * claim stored five times under five keys.
 *
 * Those near-duplicates are also what generates false "recall is drifting"
 * signals. The contradiction counter is a SYMPTOM of key fragmentation, not
 * evidence of drift — which is why migration 011 (the category axis) and this
 * (the key axis) are the same bug fixed twice on different axes.
 *
 * Shape, deliberately reusing machinery that already exists:
 *   1. candidate-narrow — exact value match plus embedding cosine over the
 *      user's recent active facts. Cosine only PRUNES; it never decides.
 *      Embeddings are negation-blind (a negation measured 0.85, ABOVE a true
 *      paraphrase at 0.80), so no threshold can mean "same claim".
 *   2. adjudicate — the same DeMem gate the contradiction path uses, so ONE
 *      definition of same-claim governs both axes.
 *   3. the caller rewrites fact_key onto the matched row and falls into
 *      storeFact's normal supersede/bump branches, leaving bi-temporal
 *      supersession and the unique-active invariant untouched.
 *
 * Runs ONLY when the incoming key has no active row — an existing key costs one
 * indexed SELECT and nothing else — and never on volatile or set-valued keys,
 * where changing or coexisting values are correct.
 *
 * FAILS OPEN to a plain INSERT on every failure mode: embedder down, gate
 * down/timeout/unparseable, query error, deadline. A duplicate row is
 * recoverable; a dropped fact is not.
 */
import type { EmbeddingProvider, Logger } from '../types.js';
import type { PgClient } from '../db/postgres.js';
import type { FactMergeGate } from './fact-merge-gate.service.js';
import { cosineSimilarity } from './paraphrase-gate.service.js';

/** Cosine floor for CANDIDATES. Not a same-claim threshold — none exists. */
const MERGE_FLOOR = 0.6;

/**
 * Whole-check deadline. This sits in front of a live write; the gate averages
 * ~2.9s (p90 6.7s), so 8s clears the average with room for the embed batch.
 * Blowing it is not an error — it falls open to the INSERT, and the next
 * mention gets another try.
 */
const MERGE_DEADLINE_MS = 8_000;

/** At most this many gate calls per write, best candidate first. */
const MAX_ADJUDICATED = 3;

/** Recent active rows the embedding pass scores. Bounds one batch call. */
const CANDIDATE_WINDOW = 60;

/** Below this, cosine is dominated by string length rather than meaning. */
const MIN_EMBEDDABLE_CHARS = 8;

export interface ActiveFactRow {
  id: string;
  category: string;
  factKey: string;
  factValue: string;
}

export interface MergeCandidate extends ActiveFactRow {
  /** Cosine against the incoming value; 1 for an exact value match. */
  similarity: number;
  exactValue: boolean;
}

export interface SameClaimMatch extends ActiveFactRow {
  similarity: number;
  /** The gate's one-line justification, for the log. */
  reason: string;
}

export interface SameClaimOptions {
  /**
   * Keys that may never be a merge target — volatile keys (whose value is
   * expected to change, so they are not a stable claim) and set-valued keys
   * (which hold a joined compound with its own append semantics).
   */
  excludeKey: (key: string) => boolean;
}

/**
 * Pure: which rows are worth an LLM look, best first.
 *
 * Exact value matches rank above cosine matches — an identical value under a
 * different key is the strongest same-claim evidence available without asking
 * the gate, and the one signal that survives an embedder outage.
 */
export function rankMergeCandidates(
  incomingKey: string,
  candidates: MergeCandidate[],
  opts: { floor?: number; max?: number; excludeKey: (key: string) => boolean },
): MergeCandidate[] {
  const floor = opts.floor ?? MERGE_FLOOR;
  const max = opts.max ?? MAX_ADJUDICATED;

  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (c.factKey === incomingKey) return false; // same key is storeFact's own job
      if (opts.excludeKey(c.factKey)) return false;
      if (!c.exactValue && c.similarity < floor) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => {
      if (a.exactValue !== b.exactValue) return a.exactValue ? -1 : 1;
      return b.similarity - a.similarity;
    })
    .slice(0, max);
}

export class FactKeyMerge {
  constructor(
    private pg: PgClient,
    private prefix: string,
    private embeddings: EmbeddingProvider,
    private gate: FactMergeGate,
    private logger: Logger,
    private enabled = true,
  ) {}

  /**
   * The active fact that already holds this claim under a different key, or null.
   *
   * Null means "insert as before" — including every failure mode. Callers must
   * treat null as a non-event, never as an error.
   */
  async findSameClaimActiveFact(
    userId: string,
    fact: { factKey: string; factValue: string },
    opts: SameClaimOptions,
  ): Promise<SameClaimMatch | null> {
    if (!this.enabled) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MERGE_DEADLINE_MS);
      });
      return await Promise.race([this.search(userId, fact, opts), deadline]);
    } catch (error) {
      this.logger.debug('fact key merge unavailable, storing under the new key', {
        factKey: fact.factKey,
        error: (error as Error).message,
      });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async search(
    userId: string,
    fact: { factKey: string; factValue: string },
    opts: SameClaimOptions,
  ): Promise<SameClaimMatch | null> {
    if (await this.hasActiveRowForKey(userId, fact.factKey)) return null;

    const value = (fact.factValue || '').trim();
    if (!value) return null;

    const exactRows = await this.loadExactValueRows(userId, fact.factKey, value);
    const candidates: MergeCandidate[] = exactRows.map((r) => ({
      ...r, similarity: 1, exactValue: true,
    }));

    if (value.length >= MIN_EMBEDDABLE_CHARS) {
      try {
        const rows = (await this.loadRecentRows(userId, fact.factKey))
          .filter((r) => !exactRows.some((e) => e.id === r.id))
          .filter((r) => !opts.excludeKey(r.factKey));
        if (rows.length > 0) {
          const vectors = await this.embeddings.generateBatch([
            value, ...rows.map((r) => r.factValue),
          ]);
          const cand = vectors[0];
          if (cand) {
            for (let i = 0; i < rows.length; i++) {
              const e = vectors[i + 1];
              if (!e) continue;
              candidates.push({ ...rows[i], similarity: cosineSimilarity(cand, e), exactValue: false });
            }
          }
        }
      } catch (error) {
        // Embedder down: keep the exact-value candidates and carry on. Losing
        // the cosine pass narrows what this catches; it must not fail the write.
        this.logger.debug('fact key merge: embedding pass unavailable', {
          factKey: fact.factKey, error: (error as Error).message,
        });
      }
    }

    const ranked = rankMergeCandidates(fact.factKey, candidates, { excludeKey: opts.excludeKey });
    if (ranked.length === 0) return null;

    for (const candidate of ranked) {
      const { verdict, outcome } = await this.gate.checkDetailed(
        { key: candidate.factKey, value: candidate.factValue },
        { key: fact.factKey, value },
      );
      // A gate that never landed says nothing about the next candidate either —
      // stop rather than burn more calls into the same outage.
      if (outcome !== 'ok' || !verdict) return null;
      if (verdict.compatible) return { ...candidate, reason: verdict.reason };
    }
    return null;
  }

  private async hasActiveRowForKey(userId: string, key: string): Promise<boolean> {
    const row = await this.pg.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM ${this.prefix}facts
        WHERE user_id = $1 AND fact_key = $2 AND fact_status = 'active' LIMIT 1`,
      [userId, key],
    );
    return row !== null && row !== undefined;
  }

  private async loadExactValueRows(userId: string, key: string, value: string): Promise<ActiveFactRow[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, category, fact_key, fact_value
         FROM ${this.prefix}facts
        WHERE user_id = $1 AND fact_status = 'active'
          AND fact_key <> $2
          AND lower(btrim(fact_value)) = lower(btrim($3))
        ORDER BY mention_count DESC, last_mentioned DESC NULLS LAST
        LIMIT 5`,
      [userId, key, value],
    );
    return rows.map(mapRow);
  }

  private async loadRecentRows(userId: string, key: string): Promise<ActiveFactRow[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, category, fact_key, fact_value
         FROM ${this.prefix}facts
        WHERE user_id = $1 AND fact_status = 'active'
          AND fact_key <> $2
        ORDER BY last_mentioned DESC NULLS LAST, created_at DESC
        LIMIT $3`,
      [userId, key, CANDIDATE_WINDOW],
    );
    return rows.map(mapRow);
  }
}

function mapRow(row: Record<string, unknown>): ActiveFactRow {
  return {
    id: String(row.id),
    category: row.category as string,
    factKey: row.fact_key as string,
    factValue: row.fact_value as string,
  };
}
