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

export interface RetrievalProfile {
  intent: RetrievalIntent;
  limit: number;
  threshold: number;
  sessionDiversify: boolean;
  windowTurns: number;
  /** Which rule fired, for logging and for explaining a surprising context. */
  reason: string;
}

/**
 * Pure temporal duration/elapsed-time questions. These need pinpoint date calculations.
 */
const TEMPORAL_DURATION_PATTERN =
  /\b(how many (days|weeks|months|years|hours|minutes|seconds)|how long|how much time)\b/i;

/**
 * Aggregation / enumeration questions. Even if bounded by time windows ('in the last month', 'since'),
 * counting non-time entities across conversations requires gathering across sessions.
 */
const AGGREGATION_PATTERN =
  /\b(how many|how often|how much|total|altogether|count|number of)\b/i;

/**
 * Pure temporal point / ordering patterns without aggregation.
 */
const TEMPORAL_ORDER_PATTERN =
  /\b(first|earliest|latest|earlier|later|before|after|order|most recent|oldest|newest|what year|what month|which day)\b/i;
const TEMPORAL_AGO_PATTERN =
  /\b(days|weeks|months|years)\s+ago\b/i;
const TEMPORAL_WHEN_PATTERN =
  /^\s*when\b/i;

/**
 * Other multi-session gather patterns: enumeration, comparison, knowledge-update, etc.
 */
const GATHER_PATTERNS: Array<[RegExp, string]> = [
  [/\b(all|every|each|both|list|which ones|what are)\b/i, 'enumeration'],
  [/\b(compare|comparison|versus|vs\.?|difference between|more than|less than|most|least|fewest)\b/i, 'comparison'],
  [/\b(still|anymore|any more|no longer|these days|nowadays|currently|now that|updated?|changed?|switch(ed)?|move[ds]?)\b/i, 'knowledge-update'],
  [/\b(times|occasions|instances|throughout|across|over the (past|last)|so far)\b/i, 'recurrence'],
  [/\b(usually|typically|tend to|habit|pattern|routine|generally|often)\b/i, 'pattern'],
];

/**
 * Defaults for each intent.
 *
 * `pinpoint` keeps the 0.5 floor and tight depth, with no diversification or window expansion.
 * `gather` uses 0.35 floor, depth 200, session diversification and ±1 turn dialogue windowing.
 */
const PROFILES: Record<RetrievalIntent, { limit: number; threshold: number; sessionDiversify: boolean; windowTurns: number }> = {
  pinpoint: { limit: 25, threshold: 0.5, sessionDiversify: false, windowTurns: 0 },
  gather: { limit: 200, threshold: 0.35, sessionDiversify: true, windowTurns: 1 },
};

/**
 * Choose a retrieval profile for a query.
 *
 * Defaults to `pinpoint`, deliberately. Widening is the expensive direction —
 * ~10x the context and the token bill that goes with it — so it has to be
 * asked for by something in the question, not assumed.
 */
export function classifyRetrieval(query: string): RetrievalProfile {
  // 1. Pure temporal duration/elapsed-time first ('how many days/weeks/months/years', 'how long').
  if (TEMPORAL_DURATION_PATTERN.test(query)) {
    return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'temporal-duration' };
  }

  // 2. Aggregations (how many items/places, total money/views, etc.) -> gather.
  if (AGGREGATION_PATTERN.test(query)) {
    return { intent: 'gather', ...PROFILES.gather, reason: 'aggregation' };
  }

  // 3. Pure ordering / point-in-time questions.
  if (TEMPORAL_ORDER_PATTERN.test(query)) {
    return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'temporal-order' };
  }
  if (TEMPORAL_AGO_PATTERN.test(query)) {
    return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'temporal-ago' };
  }
  if (TEMPORAL_WHEN_PATTERN.test(query)) {
    return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'temporal-when' };
  }

  // 4. Other gather patterns (enumeration, comparison, knowledge-update, etc.).
  for (const [pattern, reason] of GATHER_PATTERNS) {
    if (pattern.test(query)) {
      return { intent: 'gather', ...PROFILES.gather, reason };
    }
  }

  return { intent: 'pinpoint', ...PROFILES.pinpoint, reason: 'default' };
}
