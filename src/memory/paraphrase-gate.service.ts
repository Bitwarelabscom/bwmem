// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Paraphrase gate for "misremember" contradiction signals.
 *
 * Without it, every rewording of a stored fact files a fresh contradiction, and
 * anything reading that count reports "recall is drifting" over a memory that is
 * perfectly stable.
 *
 * Why this is NOT a cosine threshold. Measured on a 1024-dim embedder: the
 * canonical paraphrase pair scored 0.80, while a NEGATION ("likes the quiet" vs
 * "is afraid of the quiet") scored 0.85 and a value swap ("works from home
 * Fridays" vs "works at the office Fridays") scored 0.87. Real contradictions sit
 * ABOVE the paraphrase. No threshold separates them, because embeddings are
 * negation-blind — the same finding the DeMem gate exists for. So cosine only
 * prunes the obviously-unrelated (topic shifts score ~0.27) and the same-claim
 * judgment is delegated to the LLM gate.
 *
 * Two refinements that only show up in production:
 *
 *   * the floor is wrong in the 0.60-0.70 band, because cosine is
 *     length-asymmetry-biased on short strings. Live: 'C1' vs 'C1 level
 *     according to the tutor' scored 0.6518 and fired in BOTH directions — one
 *     value thrashing between two spellings of itself. Short values and
 *     containment pairs therefore go to the LLM regardless of cosine.
 *   * a gate timeout on two near-identical values is a stalled check, not
 *     evidence of drift. Retry once; only above TIMEOUT_HIGH_SIMILARITY does a
 *     second timeout suppress.
 *
 * Every other failure mode FAILS OPEN — embedder down, LLM down, unparseable —
 * and the signal fires exactly as it did before. An outage of the noise filter
 * must never suppress real signals.
 */
import type { EmbeddingProvider, Logger } from '../types.js';
import type { FactMergeGate } from './fact-merge-gate.service.js';

/** Below this the two values are clearly about different things. A cost floor, not a paraphrase threshold. */
const PARAPHRASE_FLOOR = 0.7;

/**
 * At or under this many tokens the cosine carries almost no evidence: the
 * embedder is length-asymmetry-biased, so a two-character value sits far from
 * the same value with qualifiers attached, while a genuine value swap between
 * two long sentences sits close. The floor fails open exactly where it is least
 * reliable, so short pairs skip it and pay for the LLM.
 */
const SHORT_VALUE_TOKENS = 6;

/** A repeated timeout on values this close is the check stalling, not memory moving. */
const TIMEOUT_HIGH_SIMILARITY = 0.95;

/**
 * Which branch decided. Persisted on the signal so a contradiction count can be
 * walked back to why it fired.
 *
 * 'gate_paraphrase' and 'timeout_high_sim' are the SUPPRESSING paths: no signal
 * row is written for them, so they never reach the stored gate_path — they are
 * auditable in the log line each emits.
 */
export type ParaphraseGatePath =
  | 'below_floor'
  | 'gate_separate'
  | 'gate_paraphrase'
  | 'timeout'
  | 'timeout_high_sim'
  | 'gate_error';

export interface ParaphraseVerdict {
  paraphrase: boolean;
  /** Cosine in [-1,1]; -1 when the gate could not run at all. */
  similarity: number;
  path: ParaphraseGatePath;
  /** The gate's one line, when it gave one. */
  reason: string;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Whitespace-, case- and punctuation-insensitive form. Unicode-aware on purpose:
 * stripping accented letters as "punctuation" would collapse words that differ.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(normalised: string): string[] {
  return normalised.length ? normalised.split(' ') : [];
}

/**
 * Does this pair deserve the LLM check? Above the floor, always. Below it, only
 * where cosine is known to be untrustworthy — short values, and pairs where one
 * value is the other reworded or qualified.
 *
 * Pure and exported so both behaviours that matter can be asserted without
 * standing up an embedder: the known false alarms reach the gate, and a real
 * topic shift still never costs an LLM call.
 */
export function shouldConsultGate(similarity: number, newValue: string, storedValue: string): boolean {
  if (similarity >= PARAPHRASE_FLOOR) return true;

  const a = normalise(newValue);
  const b = normalise(storedValue);
  if (!a || !b) return false;

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length <= SHORT_VALUE_TOKENS || tb.length <= SHORT_VALUE_TOKENS) return true;

  // One word split in two: 'trouble maker' vs 'troublemaker'.
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return true;

  // One value is the other plus qualifiers, as a contiguous run. Padded with
  // spaces so 'art' does not match inside 'start'.
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;

  // Same words, one carrying extras.
  const setA = new Set(ta);
  const setB = new Set(tb);
  return tb.every((t) => setA.has(t)) || ta.every((t) => setB.has(t));
}

export class ParaphraseGate {
  constructor(
    private embeddings: EmbeddingProvider,
    private gate: FactMergeGate,
    private logger: Logger,
  ) {}

  async isSemanticParaphrase(
    factKey: string,
    newValue: string,
    storedValue: string,
  ): Promise<ParaphraseVerdict> {
    try {
      const [ea, eb] = await this.embeddings.generateBatch([newValue, storedValue]);
      const similarity = cosineSimilarity(ea, eb);

      if (!shouldConsultGate(similarity, newValue, storedValue)) {
        return { paraphrase: false, similarity, path: 'below_floor', reason: '' };
      }

      const ask = () =>
        this.gate.checkDetailed(
          { key: factKey, value: storedValue },
          { key: factKey, value: newValue },
        );

      let { verdict, outcome } = await ask();

      // One retry, only on timeout. This path runs off the write transaction, so
      // a second budget costs latency nobody is waiting on — and a timeout is the
      // one outcome where the model never judged anything, so re-asking can only
      // add evidence.
      if (outcome === 'timeout') ({ verdict, outcome } = await ask());

      if (outcome === 'timeout') {
        if (similarity >= TIMEOUT_HIGH_SIMILARITY) {
          // Twice stalled on values this close. Filing a misremember here would
          // report the check's own latency as memory drifting. Logged at info
          // because this is the one place the filter suppresses without a
          // verdict behind it.
          this.logger.info('contradiction.timeout_high_sim', { factKey, similarity });
          return { paraphrase: true, similarity, path: 'timeout_high_sim', reason: '' };
        }
        return { paraphrase: false, similarity, path: 'timeout', reason: '' };
      }

      if (outcome !== 'ok' || !verdict) {
        return { paraphrase: false, similarity, path: 'gate_error', reason: '' };
      }

      return verdict.compatible
        ? { paraphrase: true, similarity, path: 'gate_paraphrase', reason: verdict.reason }
        : { paraphrase: false, similarity, path: 'gate_separate', reason: verdict.reason };
    } catch (error) {
      this.logger.debug('paraphrase gate unavailable, letting signal through', {
        factKey,
        error: (error as Error).message,
      });
      return { paraphrase: false, similarity: -1, path: 'gate_error', reason: '' };
    }
  }
}
