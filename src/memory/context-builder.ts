import type { PgClient } from '../db/postgres.js';
import type { FactsService } from './facts.service.js';
import type { EmbeddingService } from './embedding.service.js';
import type { EmotionalMomentsService } from './emotional-moments.service.js';
import type { ContradictionService } from './contradiction.service.js';
import type { BehavioralService } from './behavioral.service.js';
import type { SessionTextureService } from './session-texture.service.js';
import type { SelfIntentionService } from './self-intention.service.js';
import type { TemporalEventsService } from './temporal-events.service.js';
import type { GraphPlugin, Logger, MemoryContext, BuildContextOptions, EpisodicPattern, SemanticEntry } from '../types.js';
import { safeQuery } from '../utils/safe-query.js';
import { classifyRetrieval } from './retrieval-profile.js';
import { fuseByRank } from './rank-fusion.js';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Retrieval defaults, set to the configuration that scored highest on
 * LongMemEval rather than to conservative round numbers.
 *
 * Measured on a 60-question stratified subset, same corpus, same judge:
 *   k=8   -> 65.0%      k=25 -> 78.3%      (depth alone: +13 points)
 *   clip 300 chars cut 58% of stored passages before the reader saw them
 *   session expansion -> 71.7%, DOWN 6.6 points, 5.7x the prompt
 *   timeline block on the temporal questions -> best run of the set
 *
 * A memory SDK whose defaults are worse than its measured best is shipping the
 * wrong thing; every one of these is overridable per call.
 */
const DEFAULT_RECALL_K = 25;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
/** 0 = do not truncate. */
const DEFAULT_CLIP_CHARS = 0;

export class ContextBuilder {
  private pg: PgClient;
  private facts: FactsService;
  private embedding: EmbeddingService;
  private emotionalMoments: EmotionalMomentsService;
  private contradictions: ContradictionService;
  private behavioral: BehavioralService;
  private sessionTexture: SessionTextureService;
  private selfIntention: SelfIntentionService;
  private temporalEvents: TemporalEventsService | null;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;

  constructor(
    pg: PgClient,
    facts: FactsService,
    embedding: EmbeddingService,
    emotionalMoments: EmotionalMomentsService,
    contradictions: ContradictionService,
    behavioral: BehavioralService,
    sessionTexture: SessionTextureService,
    selfIntention: SelfIntentionService,
    temporalEvents: TemporalEventsService | null,
    graph: GraphPlugin | null,
    prefix: string,
    logger: Logger,
  ) {
    this.pg = pg;
    this.facts = facts;
    this.embedding = embedding;
    this.emotionalMoments = emotionalMoments;
    this.contradictions = contradictions;
    this.behavioral = behavioral;
    this.sessionTexture = sessionTexture;
    this.selfIntention = selfIntention;
    this.temporalEvents = temporalEvents;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Build memory context for LLM prompt injection. */
  async build(userId: string, options?: BuildContextOptions): Promise<MemoryContext> {
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const query = options?.query;
    const sessionId = options?.sessionId;
    const mode = options?.mode;
    const speaker = options?.speaker;
    const includeSessionTexture = options?.includeSessionTexture !== false;
    const includeIntention = options?.includeIntentionPrompt === true;
    // Retrieval depth is chosen from the question unless the caller overrides
    // it. A fixed depth is wrong for half the workload in opposite directions:
    // widening is worth +31 points on multi-session questions and costs 12 on
    // temporal ones. See retrieval-profile.ts for the measurements.
    const profile = query && options?.adaptiveRetrieval === true
      ? classifyRetrieval(query)
      : null;
    const recallK = options?.maxSimilarMessages ?? profile?.limit ?? DEFAULT_RECALL_K;
    const threshold = options?.similarityThreshold ?? profile?.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    if (profile) {
      this.logger.debug('retrieval profile', {
        intent: profile.intent, reason: profile.reason, k: recallK, threshold,
      });
    }
    const includeTimeline = options?.includeTimeline !== false;
    const expandSessions = options?.expandSessions ?? 0;

    const results = await Promise.allSettled([
      // `query` is also passed to the facts source (0.5.1): without it the fact
      // window is ordered by mention_count alone and is therefore identical on
      // every turn, so a fact mentioned once or twice can never surface however
      // relevant it is. Relevance matches are appended to the core set, never
      // substituted for it. intentId stays undefined = no scoping (see
      // getUserFacts) — before 0.5.1 that silently excluded every scoped fact.
      safeQuery('facts', this.facts.getUserFacts(
        userId, undefined, options?.maxFacts ?? 30, undefined, query,
      ), [], timeout, this.logger),
      safeQuery('similarMessages', query
        ? this.recallMessages(userId, query, recallK, threshold, sessionId, expandSessions,
                              options?.keywordRecall === true)
        : Promise.resolve([]), [], timeout, this.logger),
      safeQuery('similarConversations', query
        ? this.embedding.searchSimilarConversations(userId, query, 3)
        : Promise.resolve([]), [], timeout, this.logger),
      safeQuery('emotionalMoments', this.emotionalMoments.getRecent(userId, 7, options?.maxEmotionalMoments ?? 5), [], timeout, this.logger),
      safeQuery('contradictions', this.contradictions.getOpen(userId, sessionId, 3), [], timeout, this.logger),
      safeQuery('behavioral', this.behavioral.getActive(userId, 5), [], timeout, this.logger),
      safeQuery('episodic', this.getEpisodicPatterns(userId), [], timeout, this.logger),
      safeQuery('semantic', this.getSemanticKnowledge(userId), [], timeout, this.logger),
      // Entity arm. Query-scoped when the plugin supports it, falling back to
      // the user-scoped blob — getContext returns the same thing whatever is
      // asked, which makes it a preamble rather than a retrieval signal.
      safeQuery('graph', this.graph
        ? (query && this.graph.searchEntities
            ? this.graph.searchEntities(userId, query).then(r => r ?? this.graph!.getContext(userId))
            : this.graph.getContext(userId))
        : Promise.resolve(null), null, timeout, this.logger),
      safeQuery('sessionTexture', includeSessionTexture
        ? this.sessionTexture.getForPrompt(userId, { mode, speaker })
        : Promise.resolve(''), '', timeout, this.logger),
      // Intention surfacing has a side effect (defer_count bump). Caller must
      // opt in explicitly via `includeIntentionPrompt: true` — never run it
      // from a hot read path that may fire many times per session.
      safeQuery('intentionPrompt', includeIntention
        ? this.selfIntention.getPrompt(userId, { timezone: options?.timezone })
        : Promise.resolve(''), '', timeout, this.logger),
      // Self-gating: forPrompt() returns '' unless the query looks temporal, so
      // this costs an embedding call only on the questions it can help.
      safeQuery('timeline', includeTimeline && this.temporalEvents && query
        ? this.temporalEvents.forPrompt(userId, query)
        : Promise.resolve(''), '', timeout, this.logger),
    ]);

    const extract = <T>(idx: number, fallback: T): T => {
      const r = results[idx];
      if (r.status === 'fulfilled') return r.value.value as T;
      return fallback;
    };

    const factsResult = extract<Awaited<ReturnType<FactsService['getUserFacts']>>>(0, []);
    const similarMessages = extract<Awaited<ReturnType<EmbeddingService['searchSimilarMessages']>>>(1, []);
    const similarConversations = extract<Awaited<ReturnType<EmbeddingService['searchSimilarConversations']>>>(2, []);
    const emotionalMoments = extract<Awaited<ReturnType<EmotionalMomentsService['getRecent']>>>(3, []);
    const contradictionsList = extract<Awaited<ReturnType<ContradictionService['getOpen']>>>(4, []);
    const behavioralObs = extract<Awaited<ReturnType<BehavioralService['getActive']>>>(5, []);
    const episodicPatterns = extract<EpisodicPattern[]>(6, []);
    const semanticKnowledge = extract<SemanticEntry[]>(7, []);
    const graphContext = extract<string | null>(8, null);
    const textureBlock = extract<string>(9, '');
    const intentionBlock = extract<string>(10, '');
    const timelineBlock = extract<string>(11, '');

    const responded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const total = results.length;

    const formatted = this.format(
      factsResult, similarMessages, emotionalMoments, contradictionsList,
      behavioralObs, episodicPatterns, semanticKnowledge, graphContext,
      textureBlock, intentionBlock, timelineBlock,
      options?.clipRecalledChars ?? DEFAULT_CLIP_CHARS,
      options?.chronologicalRecall !== false,
    );

    return {
      facts: factsResult,
      similarMessages,
      similarConversations,
      emotionalMoments,
      contradictions: contradictionsList,
      behavioralObservations: behavioralObs,
      episodicPatterns,
      semanticKnowledge,
      graphContext: graphContext ?? undefined,
      sessionTexture: textureBlock || undefined,
      intentionPrompt: intentionBlock || undefined,
      timeline: timelineBlock || undefined,
      retrievalProfile: profile ?? undefined,
      formatted,
      sourcesResponded: `${responded}/${total}`,
    };
  }

  /**
   * Ranked message recall, optionally widened to the full sessions the hits
   * landed in.
   *
   * Expansion is off by default and that is a measured result — see
   * BuildContextOptions.expandSessions. When it is on, the ranked hits decide
   * WHICH sessions to pull, so the ordering work is not wasted; the widened set
   * then replaces them rather than being appended, because the ranked rows are
   * already inside it.
   */
  private async recallMessages(
    userId: string, query: string, limit: number, threshold: number,
    excludeSessionId: string | undefined, expandSessions: number,
    keywordRecall: boolean,
  ): Promise<Awaited<ReturnType<EmbeddingService['searchSimilarMessages']>>> {
    // Hybrid: vector and keyword arms run concurrently and are fused by RANK.
    //
    // Vector-only recall was the root of the precision/recall bind — tighten
    // the cosine floor and multi-session questions starve, loosen it and
    // single-turn questions drown. Both arms of that trade come from ranking on
    // one signal. Keyword recall catches what embeddings are worst at: rare
    // literal tokens, proper nouns, model numbers, coined spellings.
    //
    // The keyword arm is additive and failure-isolated — it returns [] on any
    // error, which degrades to exactly the previous vector-only behaviour.
    const [vectorHits, keywordHits] = await Promise.all([
      this.embedding.searchSimilarMessages(userId, query, limit, threshold, excludeSessionId),
      keywordRecall
        ? this.embedding.searchMessagesByKeyword(userId, query, limit, excludeSessionId)
        : Promise.resolve([]),
    ]);

    // Vector arm first: it decides ties, and it carries the real similarity
    // scores that the prompt renders.
    const hits = keywordHits.length > 0
      ? fuseByRank([{ items: vectorHits }, { items: keywordHits }], limit)
      : vectorHits;

    if (expandSessions <= 0 || hits.length === 0) return hits;

    // Session order follows hit rank, so truncating keeps the best sessions.
    const ordered: string[] = [];
    for (const h of hits) {
      if (h.sessionId && !ordered.includes(h.sessionId)) ordered.push(h.sessionId);
    }
    const keep = ordered.slice(0, expandSessions);
    const expanded = await this.embedding.messagesInSessions(userId, keep);
    return expanded.length > 0 ? expanded : hits;
  }

  private format(
    facts: Awaited<ReturnType<FactsService['getUserFacts']>>,
    similarMessages: Awaited<ReturnType<EmbeddingService['searchSimilarMessages']>>,
    emotionalMoments: Awaited<ReturnType<EmotionalMomentsService['getRecent']>>,
    contradictions: Awaited<ReturnType<ContradictionService['getOpen']>>,
    behavioral: Awaited<ReturnType<BehavioralService['getActive']>>,
    episodic: EpisodicPattern[],
    semantic: SemanticEntry[],
    graphContext: string | null,
    sessionTexture: string,
    intentionPrompt: string,
    timeline: string,
    clipChars: number,
    chronological: boolean,
  ): string {
    const sections: string[] = [];

    // Texture leads (carries the felt momentum from the last session).
    if (sessionTexture) sections.push(sessionTexture);

    // Timeline before the prose it summarises: the reader should have the
    // ordering in hand before it starts reading turns out of several sessions.
    if (timeline) sections.push(timeline);

    if (facts.length > 0) {
      sections.push(`## Known Facts\n${this.facts.formatForPrompt(facts)}`);
    }

    if (similarMessages.length > 0) {
      // Oldest-first by default. Similarity order scatters one conversation
      // across the block; chronological order is what lets the reader tell which
      // of two conflicting values came later, which is the whole of the
      // knowledge-update and temporal question classes.
      const rows = chronological
        ? [...similarMessages].sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return at - bt;
          })
        : similarMessages;

      const msgs = rows
        .map(m => {
          const body = clipChars > 0 && m.content.length > clipChars
            ? m.content.slice(0, clipChars) + '…'
            : m.content;
          // Date carried inline: a reader cannot order what it cannot see, and
          // the block is chronological precisely so ordering is readable.
          const when = m.createdAt
            ? `[${new Date(m.createdAt).toISOString().slice(0, 10)}] `
            : '';
          // Expanded rows carry similarity 0 because they were never ranked;
          // printing "0% match" next to real evidence reads as a relevance
          // claim about a row that never made one.
          const score = m.similarity > 0 ? ` (${(m.similarity * 100).toFixed(0)}% match)` : '';
          return `- ${when}"${body}"${score}`;
        })
        .join('\n');
      sections.push(`## Relevant Past Messages\n${msgs}`);
    }

    if (emotionalMoments.length > 0) {
      sections.push(`## Recent Emotional Moments\n${this.emotionalMoments.formatForPrompt(emotionalMoments)}`);
    }

    if (contradictions.length > 0) {
      sections.push(`## Noted Contradictions\n${this.contradictions.formatForPrompt(contradictions)}`);
    }

    if (behavioral.length > 0) {
      sections.push(`## Behavioral Observations\n${this.behavioral.formatForPrompt(behavioral)}`);
    }

    if (episodic.length > 0) {
      const eps = episodic.map(e => `- [${e.patternType}] ${e.pattern}`).join('\n');
      sections.push(`## Recent Patterns\n${eps}`);
    }

    if (semantic.length > 0) {
      const sem = semantic.map(s => `- [${s.entryType}] ${s.theme}: ${s.value}`).join('\n');
      sections.push(`## Long-term Knowledge\n${sem}`);
    }

    if (graphContext) {
      sections.push(`## Knowledge Graph\n${graphContext}`);
    }

    if (intentionPrompt) sections.push(intentionPrompt);

    return sections.join('\n\n');
  }

  private async getEpisodicPatterns(userId: string): Promise<EpisodicPattern[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, user_id, session_id, consolidation_run_id, pattern_type, pattern, confidence, created_at
       FROM ${this.prefix}episodic_patterns
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );
    return rows.map(row => ({
      id: row.id as string,
      userId: row.user_id as string,
      sessionId: row.session_id as string | undefined,
      consolidationRunId: row.consolidation_run_id as string | undefined,
      patternType: row.pattern_type as string,
      pattern: row.pattern as string,
      confidence: row.confidence as number,
      createdAt: row.created_at as Date,
    }));
  }

  private async getSemanticKnowledge(userId: string): Promise<SemanticEntry[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, user_id, entry_type, theme, value, confidence, source_count, created_at, updated_at
       FROM ${this.prefix}semantic_knowledge
       WHERE user_id = $1
       ORDER BY confidence DESC, source_count DESC
       LIMIT 20`,
      [userId]
    );
    return rows.map(row => ({
      id: row.id as string,
      userId: row.user_id as string,
      entryType: row.entry_type as string,
      theme: row.theme as string,
      value: row.value as string,
      confidence: row.confidence as number,
      sourceCount: row.source_count as number,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }));
  }
}
