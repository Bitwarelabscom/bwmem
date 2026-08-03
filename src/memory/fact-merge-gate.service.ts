// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Decision-compatibility gate for semantic fact dedup (DeMem, arXiv 2605.10870).
 *
 * `findSimilarActiveFact` matches by embedding cosine — descriptive similarity.
 * The paper's Theorem 1 says the only sound merge criterion is DECISION
 * compatibility: two statements may share one fact slot iff treating them as the
 * same claim would never change what the system should do or say. Descriptive
 * similarity is a weak proxy for that (their measurement: AUC 0.548), and
 * high-cosine opposites — "runs on battery" vs "runs on USB power" — are exactly
 * the pairs a cosine threshold collapses.
 *
 * One-sided and deliberately conservative: a confident "incompatible" BLOCKS the
 * merge; everything else — compatible, unparseable, timeout, LLM down — returns
 * null and the caller keeps its previous behaviour. Absence of conflict evidence
 * is not proof of compatibility, but this is a noise filter on a noise filter and
 * it must never make the write path flakier than it was without it.
 */
import type { LLMProvider, Logger } from '../types.js';

/**
 * A cold provider call was measured at 3-5s, and over 128 live gate calls: avg
 * 2.9s, p90 6.7s, max 13.9s. At 8s, 7% of calls fell open — i.e. filed a
 * contradiction with no verdict behind it. 12s clears p90 with headroom.
 */
const DEFAULT_TIMEOUT_MS = 12_000;

export interface MergeGateVerdict {
  compatible: boolean;
  reason: string;
}

/**
 * How the call ended. A null verdict has three very different meanings — "the
 * model said these are separate" is not "the call never landed" — and any caller
 * recording WHY a contradiction fired needs to tell them apart.
 */
export type MergeGateOutcome = 'ok' | 'timeout' | 'error' | 'unparseable';

export interface MergeGateResult {
  verdict: MergeGateVerdict | null;
  outcome: MergeGateOutcome;
}

const SYSTEM_PROMPT =
  'You gate a memory merge for a personal AI. Two remembered statements about the same person ' +
  'were flagged as near-duplicates by wording similarity. Decide whether treating them as ONE ' +
  'fact (the new wording replacing the old) could ever change what the AI should do or say.\n' +
  'Decision-relevant differences — different objects, times, scopes, polarity, quantities, or ' +
  'conditions — mean KEEP SEPARATE (compatible: false).\n' +
  'Only say compatible: true when the two are plainly the same claim reworded.\n' +
  'Reply with JSON only: {"compatible": true|false, "reason": "<one short sentence>"}';

/**
 * Tolerant JSON extraction. Models wrap answers in prose, fences, and — for
 * reasoning models — think blocks and special tokens whose delimiters are
 * full-width bars and underscores, not ASCII. Returns null rather than throwing
 * so a stop-token-only response reads as "no result" instead of an exception on
 * the write path.
 */
export function parseGateJson<T>(raw: string): T | null {
  if (!raw) return null;
  let text = raw
    .replace(/<[|｜][^>]*[|｜]>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  text = text.slice(start, end + 1);
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class FactMergeGate {
  constructor(
    private llm: LLMProvider,
    private logger: Logger,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Same one-sided logic as {@link check}, but reports how the call ended. */
  async checkDetailed(
    existing: { key: string; value: string },
    candidate: { key: string; value: string },
  ): Promise<MergeGateResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = this.llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Existing fact (${existing.key}): ${existing.value}\n` +
              `New statement (${candidate.key}): ${candidate.value}`,
          },
        ],
        { temperature: 0.1, maxTokens: 120, json: true },
      );

      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.timeoutMs);
      });

      const result = await Promise.race([completion, deadline]);
      if (result === null) {
        this.logger.debug('merge gate timed out — falling open');
        return { verdict: null, outcome: 'timeout' };
      }

      const parsed = parseGateJson<{ compatible?: unknown; reason?: unknown }>(result);
      if (!parsed || typeof parsed.compatible !== 'boolean') {
        return { verdict: null, outcome: 'unparseable' };
      }
      return {
        verdict: {
          compatible: parsed.compatible,
          reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
        },
        outcome: 'ok',
      };
    } catch (error) {
      this.logger.debug('merge gate failed — falling open', { error: (error as Error).message });
      return { verdict: null, outcome: 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** null means "no confident verdict" — treat as compatible and carry on. */
  async check(
    existing: { key: string; value: string },
    candidate: { key: string; value: string },
  ): Promise<MergeGateVerdict | null> {
    return (await this.checkDetailed(existing, candidate)).verdict;
  }
}
