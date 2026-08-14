/**
 * Reciprocal Rank Fusion for combining retrieval arms.
 *
 * WHY RANK AND NOT SCORE
 *
 * The obvious approach — normalise each arm's scores and add them — does not
 * work here, because the two numbers are not commensurable and neither is
 * stable:
 *
 *   * cosine similarity sits in a narrow band whose absolute value depends on
 *     the embedding model. 0.5 is a strict floor for bge-m3 over conversational
 *     turns and a loose one somewhere else.
 *   * `ts_rank` has no fixed range at all. It scales with document length and
 *     term frequency, so a "good" absolute value in one corpus is meaningless
 *     in another. Tuning an absolute ts_rank floor is a known way to build
 *     something that works on your data and silently fails on someone else's.
 *
 * RRF sidesteps both by using only ORDER. Each arm contributes 1/(k + rank),
 * so a row ranked first anywhere gets a large constant contribution regardless
 * of what its raw score happened to be, and a row that both arms rank highly
 * beats one that only a single arm loves. Nothing needs calibrating per corpus,
 * which is the property that matters for a library shipped to other people.
 */

/** Anything a retrieval arm can return, keyed for dedup. */
export interface Rankable {
  messageId: string;
}

/**
 * RRF smoothing constant. 60 is the value from the original Cormack et al.
 * work and the de facto default in every implementation since.
 *
 * Its job is to stop rank 1 from dominating: with k=60 the gap between ranks 1
 * and 2 is small, so agreement across arms outweighs a single arm's confidence.
 * Lower k makes the top of each list more decisive; higher k flattens toward
 * "appears in many arms at all".
 */
const RRF_K = 60;

/**
 * Fuse ranked lists into one. Later ties break toward the earlier list, so pass
 * the arm you trust most first.
 *
 * Rows are matched on `messageId`: the same message found by both arms is one
 * row scoring twice, which is exactly the signal fusion exists to capture.
 */
export function fuseByRank<T extends Rankable>(
  lists: Array<{ items: T[]; weight?: number }>,
  limit: number,
): T[] {
  const scores = new Map<string, { item: T; score: number; arms: number }>();

  for (const { items, weight = 1 } of lists) {
    items.forEach((item, index) => {
      const contribution = weight / (RRF_K + index + 1);
      const existing = scores.get(item.messageId);
      if (existing) {
        existing.score += contribution;
        existing.arms += 1;
      } else {
        // Keep the FIRST arm's copy of the row. Arms can disagree about
        // derived fields — the vector arm carries a real similarity, the
        // keyword arm reports 0 — and taking whichever happened to be last
        // would make the reported score depend on iteration order.
        scores.set(item.messageId, { item, score: contribution, arms: 1 });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => (b.score - a.score) || (b.arms - a.arms))
    .slice(0, limit)
    .map(e => e.item);
}
