/**
 * How wide to cast the net, decided from the question itself.
 *
 * WHY THIS EXISTS
 *
 * There is no single best retrieval depth. Measured on a 60-question
 * LongMemEval subset, same corpus, same reader, changing only the cosine floor:
 *
 *   floor   overall   multi-session   temporal   knowledge-update
 *   0.50    71.7%        37.5%         81.2%         66.7%
 *   0.35    75.0%        68.8%         68.8%         77.8%
 *   0.20    75.0%        56.2%         75.0%         77.8%
 *
 * Widening the net is worth **+31 points** on multi-session questions and
 * **costs 12** on temporal ones. Those are not noise and they point in opposite
 * directions, so any fixed default is deliberately wrong for half the workload.
 * Picking the best floor per category would score 49/60 = 81.7%, against 43/60
 * for the best single setting — the gap is entirely in choosing per question.
 *
 * The mechanism is not mysterious. A question like "how many times did I
 * mention X" needs evidence scattered across many conversations, and a tight
 * floor returns twenty rows from one of them. A question like "when did I first
 * do X" needs one specific turn, and burying it in two hundred loosely-related
 * ones makes the reader's job harder, not easier.
 *
 * ZERO LLM CALLS. This runs on the read path of every context build, so it is
 * pure string matching. A classifier that costs a model call would eat the
 * latency budget it is supposed to protect.
 */

/**
 * What the question needs from retrieval.
 *
 *   `gather`   evidence spread across many sessions — cast wide, accept noise
 *   `pinpoint` one specific turn — stay tight, protect precision
 */
export type RetrievalIntent = 'gather' | 'pinpoint';

/**
 * Temporal phrasing overlaps heavily with aggregation phrasing — "how many
 * months since I moved" is both "how many" and a date calculation — and the two
 * want OPPOSITE depths: temporal scored 81.2% tight and 68.8% wide.
 *
 * Checked BEFORE the gather patterns for exactly that reason. Routing temporal
 * questions on their "how many" alone sent 10 of 16 the wrong way.
 */
const TEMPORAL_PATTERN =
  /\b(first|last|earliest|latest|earlier|later|before|after|order|when|how long|how many (days|weeks|months|years)|ago|since|between|most recent|oldest|newest|what year|what month|which day)\b/i;

export interface RetrievalProfile {
  intent: RetrievalIntent;
  limit: number;
  threshold: number;
  /** Which rule fired, for logging and for explaining a surprising context. */
  reason: string;
}

/**
 * Questions whose answer is assembled from several conversations: counting,
 * aggregating, comparing, or tracking something that changed over time.
 *
 * Knowledge-update lives here too and the measurement says so (66.7% -> 77.8%
 * when the net widens): deciding what is CURRENTLY true means finding every
 * time the user said something about it, not just the best-matching one.
 */
const GATHER_PATTERNS: Array<[RegExp, string]> = [
  [/\b(how many|how often|how much|total|altogether|count|number of)\b/i, 'aggregation'],
  [/\b(all|every|each|both|list|which ones|what are)\b/i, 'enumeration'],
  [/\b(compare|comparison|versus|vs\.?|difference between|more than|less than|most|least|fewest)\b/i, 'comparison'],
  [/\b(still|anymore|any more|no longer|these days|nowadays|currently|now that|updated?|changed?|switch(ed)?|move[ds]?)\b/i, 'knowledge-update'],
  [/\b(times|occasions|instances|throughout|across|over the (past|last)|so far)\b/i, 'recurrence'],
  [/\b(usually|typically|tend to|habit|pattern|routine|generally|often)\b/i, 'pattern'],
];

/**
 * Defaults for each intent, from the table above.
 *
 * `pinpoint` keeps the 0.5 floor, which scored best on temporal and
 * single-session. `gather` uses 0.35 rather than 0.20: both scored 75.0%
 * overall, but 0.35 was better on the category that motivates widening at all
 * (68.8% vs 56.2% multi-session) and sends ~20% less context.
 */
const PROFILES: Record<RetrievalIntent, { limit: number; threshold: number }> = {
  pinpoint: { limit: 25, threshold: 0.5 },
  gather: { limit: 200, threshold: 0.35 },
};

/**
 * Choose a retrieval profile for a query.
 *
 * Defaults to `pinpoint`, deliberately. Widening is the expensive direction —
 * ~10x the context and the token bill that goes with it — so it has to be
 * asked for by something in the question, not assumed.
 */
export function classifyRetrieval(query: string): RetrievalProfile {
  // Temporal first. It shares vocabulary with aggregation and wants the
  // opposite treatment, so whichever is tested first decides — and the
  // measurement says temporal should win.
  if (TEMPORAL_PATTERN.test(query)) {
    return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'temporal' };
  }

  for (const [pattern, reason] of GATHER_PATTERNS) {
    if (pattern.test(query)) {
      return { intent: 'gather', ...PROFILES.gather, reason };
    }
  }
  return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'default' };
}
