import type { PgClient } from '../db/postgres.js';
import type { FactsService } from './facts.service.js';
import type { EmbeddingService } from './embedding.service.js';
import type { EmotionalMomentsService } from './emotional-moments.service.js';
import type { ContradictionService } from './contradiction.service.js';
import type { BehavioralService } from './behavioral.service.js';
import type { GraphPlugin, Logger, MemoryContext, BuildContextOptions, EpisodicPattern, SemanticEntry } from '../types.js';
import { safeQuery } from '../utils/safe-query.js';

const DEFAULT_TIMEOUT_MS = 5000;

export class ContextBuilder {
  private pg: PgClient;
  private facts: FactsService;
  private embedding: EmbeddingService;
  private emotionalMoments: EmotionalMomentsService;
  private contradictions: ContradictionService;
  private behavioral: BehavioralService;
  private graph: GraphPlugin | null;
  private prefix: string;
  private logger: Logger;

  constructor(
    pg: PgClient, facts: FactsService, embedding: EmbeddingService,
    emotionalMoments: EmotionalMomentsService, contradictions: ContradictionService,
    behavioral: BehavioralService,
    graph: GraphPlugin | null, prefix: string, logger: Logger,
  ) {
    this.pg = pg;
    this.facts = facts;
    this.embedding = embedding;
    this.emotionalMoments = emotionalMoments;
    this.contradictions = contradictions;
    this.behavioral = behavioral;
    this.graph = graph;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Build memory context for LLM prompt injection. */
  async build(userId: string, options?: BuildContextOptions): Promise<MemoryContext> {
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const query = options?.query;
    const sessionId = options?.sessionId;

    // Run all sources in parallel with timeout protection
    const results = await Promise.allSettled([
      safeQuery('facts', this.facts.getUserFacts(userId, undefined, options?.maxFacts ?? 30), [], timeout, this.logger),
      safeQuery('similarMessages', query
        ? this.embedding.searchSimilarMessages(userId, query, options?.maxSimilarMessages ?? 5, options?.similarityThreshold ?? 0.7, sessionId)
        : Promise.resolve([]), [], timeout, this.logger),
      safeQuery('similarConversations', query
        ? this.embedding.searchSimilarConversations(userId, query, 3)
        : Promise.resolve([]), [], timeout, this.logger),
      safeQuery('emotionalMoments', this.emotionalMoments.getRecent(userId, 7, options?.maxEmotionalMoments ?? 5), [], timeout, this.logger),
      safeQuery('contradictions', this.contradictions.getUnsurfaced(userId, sessionId, 3), [], timeout, this.logger),
      safeQuery('behavioral', this.behavioral.getActive(userId, 5), [], timeout, this.logger),
      safeQuery('episodic', this.getEpisodicPatterns(userId), [], timeout, this.logger),
      safeQuery('semantic', this.getSemanticKnowledge(userId), [], timeout, this.logger),
      safeQuery('graph', this.graph ? this.graph.getContext(userId) : Promise.resolve(null), null, timeout, this.logger),
    ]);

    // Extract values (safeQuery wraps in {value, ok})
    const extract = <T>(idx: number): T => {
      const r = results[idx];
      if (r.status === 'fulfilled') return r.value.value as T;
      return ([] as unknown) as T;
    };

    const factsResult = extract<Awaited<ReturnType<FactsService['getUserFacts']>>>(0);
    const similarMessages = extract<Awaited<ReturnType<EmbeddingService['searchSimilarMessages']>>>(1);
    const similarConversations = extract<Awaited<ReturnType<EmbeddingService['searchSimilarConversations']>>>(2);
    const emotionalMoments = extract<Awaited<ReturnType<EmotionalMomentsService['getRecent']>>>(3);
    const contradictionsList = extract<Awaited<ReturnType<ContradictionService['getUnsurfaced']>>>(4);
    const behavioralObs = extract<Awaited<ReturnType<BehavioralService['getActive']>>>(5);
    const episodicPatterns = extract<EpisodicPattern[]>(6);
    const semanticKnowledge = extract<SemanticEntry[]>(7);
    const graphContext = extract<string | null>(8);

    // Count how many sources responded
    const responded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const total = results.length;

    // Build formatted context string
    const formatted = this.format(
      factsResult, similarMessages, emotionalMoments, contradictionsList,
      behavioralObs, episodicPatterns, semanticKnowledge, graphContext,
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
      formatted,
      sourcesResponded: `${responded}/${total}`,
    };
  }

  private format(
    facts: Awaited<ReturnType<FactsService['getUserFacts']>>,
    similarMessages: Awaited<ReturnType<EmbeddingService['searchSimilarMessages']>>,
    emotionalMoments: Awaited<ReturnType<EmotionalMomentsService['getRecent']>>,
    contradictions: Awaited<ReturnType<ContradictionService['getUnsurfaced']>>,
    behavioral: Awaited<ReturnType<BehavioralService['getActive']>>,
    episodic: EpisodicPattern[],
    semantic: SemanticEntry[],
    graphContext: string | null,
  ): string {
    const sections: string[] = [];

    if (facts.length > 0) {
      sections.push(`## Known Facts\n${this.facts.formatForPrompt(facts)}`);
    }

    if (similarMessages.length > 0) {
      const msgs = similarMessages
        .map(m => `- "${m.content.slice(0, 100)}..." (${(m.similarity * 100).toFixed(0)}% match)`)
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
