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

/**
 * Why the gate kept two statements apart.
 *
 * `compatible: false` has always meant two different things at once, and a
 * contradiction surface reading only that flag cannot tell them apart:
 *
 *  - 'different_question' — the new statement answers something the key never
 *    asked (a role where the key names a company; a note ABOUT the fact rather
 *    than an answer to it). Nothing has been contradicted, so raising this to a
 *    user as a conflict is pure noise.
 *  - 'conflicting_answer' — both statements answer the question the key names
 *    and disagree. That is a real value swap, and exactly what a contradiction
 *    surface exists to catch.
 *
 * null means the model did not say, and null must never suppress: an older
 * model, a truncated reply or a prompt regression must not be able to silence a
 * contradiction by omission.
 */
export type MergeSeparation = 'different_question' | 'conflicting_answer';

export interface MergeGateVerdict {
  compatible: boolean;
  reason: string;
  /** Only meaningful when `compatible` is false; null when the model didn't say. */
  separation: MergeSeparation | null;
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
  'When compatible is false, also name WHICH kind of separation it is, in "separation":\n' +
  '  "different_question" — the new statement answers something other than the question the key ' +
  'names, or merely comments on the fact instead of answering it. Nothing is being contradicted.\n' +
  '  "conflicting_answer" — both statements answer the question the key names, but the answers ' +
  'cannot both be true: different objects, times, scopes, polarity, quantities or conditions.\n' +
  'Worked examples: existing company_name / "Acme" vs "member of the dev team at Acme" -> ' +
  '{"compatible": false, "separation": "different_question"}. Existing esp32_power / "balcony ' +
  'ESP32 on battery" vs "balcony ESP32 on USB power" -> {"compatible": false, "separation": ' +
  '"conflicting_answer"}.\n' +
  'If you cannot tell which, answer "conflicting_answer".\n' +
  'Reply with JSON only: {"compatible": true|false, "separation": "different_question"|' +
  '"conflicting_answer"|null, "reason": "<one short sentence>"}';

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

      const parsed = parseGateJson<{
        compatible?: unknown; separation?: unknown; reason?: unknown;
      }>(result);
      if (!parsed || typeof parsed.compatible !== 'boolean') {
        return { verdict: null, outcome: 'unparseable' };
      }
      // Only the two exact strings count. A missing, misspelled or invented
      // value becomes null, and null is read downstream as "say nothing was
      // ruled out" rather than as "this is only a wording difference".
      const separation: MergeSeparation | null =
        parsed.separation === 'different_question' || parsed.separation === 'conflicting_answer'
          ? parsed.separation
          : null;
      return {
        verdict: {
          compatible: parsed.compatible,
          reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
          separation,
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
