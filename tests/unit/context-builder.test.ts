import { describe, it, expect, beforeEach } from 'vitest';
import { ContextBuilder } from '../../src/memory/context-builder.js';
import {
  MockPgClient, MockEmbeddingProvider, MockLLMProvider,
  mockLogger,
} from '../fixtures/mock-providers.js';
import { FactsService } from '../../src/memory/facts.service.js';
import { EmbeddingService } from '../../src/memory/embedding.service.js';
import { EmotionalMomentsService } from '../../src/memory/emotional-moments.service.js';
import { ContradictionService } from '../../src/memory/contradiction.service.js';
import { BehavioralService } from '../../src/memory/behavioral.service.js';
import { SessionTextureService } from '../../src/memory/session-texture.service.js';
import { SelfIntentionService } from '../../src/memory/self-intention.service.js';

describe('ContextBuilder', () => {
  let pg: MockPgClient;
  let builder: ContextBuilder;

  beforeEach(() => {
    pg = new MockPgClient();
    const llm = new MockLLMProvider();
    const provider = new MockEmbeddingProvider();
    const embedding = new EmbeddingService(pg as never, provider, 'bwmem_', mockLogger);
    const facts = new FactsService(pg as never, llm, null, 'bwmem_', mockLogger);
    const emotional = new EmotionalMomentsService(pg as never, llm, 'bwmem_', mockLogger);
    const contradictions = new ContradictionService(pg as never, 'bwmem_', mockLogger);
    const behavioral = new BehavioralService(pg as never, 'bwmem_', mockLogger);
    const sessionTexture = new SessionTextureService(pg as never, llm, 'bwmem_', mockLogger);
    const selfIntention = new SelfIntentionService(pg as never, 'bwmem_', mockLogger);

    builder = new ContextBuilder(
      pg as never, facts, embedding, emotional, contradictions, behavioral,
      sessionTexture, selfIntention,
      null, // no temporal index
      null, // no graph
      'bwmem_', mockLogger,
    );
  });

  /** The vector-search statement issued for message recall. */
  const recallQuery = (pg: MockPgClient) =>
    pg.queries.find(q => q.text.includes('<=>') && q.text.includes('messages'));

  describe('build', () => {
    it('returns memory context with all fields', async () => {
      // All queries return empty
      for (let i = 0; i < 10; i++) pg.willReturn([]);

      const context = await builder.build('user-1');

      expect(context).toHaveProperty('facts');
      expect(context).toHaveProperty('similarMessages');
      expect(context).toHaveProperty('similarConversations');
      expect(context).toHaveProperty('emotionalMoments');
      expect(context).toHaveProperty('contradictions');
      expect(context).toHaveProperty('behavioralObservations');
      expect(context).toHaveProperty('episodicPatterns');
      expect(context).toHaveProperty('semanticKnowledge');
      expect(context).toHaveProperty('formatted');
      expect(context).toHaveProperty('sourcesResponded');
    });

    it('includes sourcesResponded count', async () => {
      for (let i = 0; i < 10; i++) pg.willReturn([]);

      const context = await builder.build('user-1');
      expect(context.sourcesResponded).toMatch(/^\d+\/\d+$/);
    });

    it('includes facts in formatted output', async () => {
      // Facts query returns data
      pg.willReturn([{
        id: 'fact-1', user_id: 'user-1', category: 'personal',
        fact_key: 'name', fact_value: 'Alice', confidence: '0.9',
        fact_status: 'active', fact_type: 'permanent',
        override_priority: 0, mention_count: 5,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }]);
      // Rest return empty
      for (let i = 0; i < 10; i++) pg.willReturn([]);

      const context = await builder.build('user-1');
      expect(context.facts).toHaveLength(1);
      expect(context.formatted).toContain('Known Facts');
      expect(context.formatted).toContain('Alice');
    });

    it('performs semantic search when query provided', async () => {
      // Multiple empty results
      for (let i = 0; i < 15; i++) pg.willReturn([]);

      await builder.build('user-1', { query: 'hiking' });
      // Should have generated an embedding for the query
      // The embedding search query should have been issued
      const searchQueries = pg.queries.filter(q => q.text.includes('<=>'));
      expect(searchQueries.length).toBeGreaterThan(0);
    });

    it('handles timeouts gracefully', async () => {
      // All queries return empty (some may time out but safeQuery handles it)
      for (let i = 0; i < 10; i++) pg.willReturn([]);

      const context = await builder.build('user-1', { timeoutMs: 100 });
      expect(context).toBeTruthy();
      expect(context.facts).toBeDefined();
    });
  });

  /**
   * These defaults are measured, not stylistic — see the constants in
   * context-builder.ts. Asserting them keeps a well-meaning "5 seems safer"
   * edit from silently costing 13 points.
   */
  describe('retrieval defaults match the benchmarked configuration', () => {
    it('recalls to depth 25, not 5', async () => {
      for (let i = 0; i < 15; i++) pg.willReturn([]);
      await builder.build('user-1', { query: 'hiking' });
      expect(recallQuery(pg)?.params).toContain(25);
    });

    it('uses a 0.5 cosine floor, not 0.25', async () => {
      for (let i = 0; i < 15; i++) pg.willReturn([]);
      await builder.build('user-1', { query: 'hiking' });
      expect(recallQuery(pg)?.params).toContain(0.5);
    });

    it('honours explicit overrides', async () => {
      for (let i = 0; i < 15; i++) pg.willReturn([]);
      await builder.build('user-1', {
        query: 'hiking', maxSimilarMessages: 8, similarityThreshold: 0.3,
      });
      const p = recallQuery(pg)?.params;
      expect(p).toContain(8);
      expect(p).toContain(0.3);
    });

    it('does not expand sessions by default (expansion measured -6.6 points)', async () => {
      for (let i = 0; i < 15; i++) pg.willReturn([]);
      await builder.build('user-1', { query: 'hiking' });
      expect(pg.queries.some(q => q.text.includes('session_id = ANY'))).toBe(false);
    });
  });

  describe('recalled message formatting', () => {
    const msgRow = (id: string, content: string, iso: string, sim: string) => ({
      id, session_id: 's1', content, role: 'user', similarity: sim,
      created_at: new Date(iso),
    });

    /**
     * Dispatch on SQL text, not on call order. The sources run under
     * Promise.allSettled but message recall awaits an embedding first, so its
     * query is NOT the second one to reach the client — a positional queue
     * hands the message rows to whichever source happens to query first.
     */
    const withMessages = (rows: unknown[]) => {
      pg.query = async (text: string, params?: unknown[]) => {
        pg.queries.push({ text, params });
        const isRecall = text.includes('<=>') && text.includes('messages')
          && !text.includes('conversation');
        return (isRecall ? rows : []) as never;
      };
    };

    it('does not truncate recalled content by default', async () => {
      const long = 'x'.repeat(900);
      withMessages([msgRow('m1', long, '2024-03-01', '0.9')]);

      const ctx = await builder.build('user-1', { query: 'q' });
      // 58% of real passages exceed 300 chars; clipping them was silent.
      expect(ctx.formatted).toContain(long);
      expect(ctx.formatted).not.toContain('…');
    });

    it('clips only when explicitly asked', async () => {
      const long = 'y'.repeat(900);
      withMessages([msgRow('m1', long, '2024-03-01', '0.9')]);

      const ctx = await builder.build('user-1', { query: 'q', clipRecalledChars: 100 });
      expect(ctx.formatted).toContain('…');
      expect(ctx.formatted).not.toContain(long);
    });

    it('orders recalled messages oldest-first, not by similarity', async () => {
      withMessages([
        msgRow('m1', 'NEWER-EVENT', '2024-06-01', '0.95'),
        msgRow('m2', 'OLDER-EVENT', '2024-01-01', '0.60'),
      ]);

      const ctx = await builder.build('user-1', { query: 'q' });
      expect(ctx.formatted.indexOf('OLDER-EVENT')).toBeLessThan(
        ctx.formatted.indexOf('NEWER-EVENT'));
    });

    it('carries the date inline so the reader can actually order them', async () => {
      withMessages([msgRow('m1', 'graduated', '2024-03-05', '0.9')]);
      const ctx = await builder.build('user-1', { query: 'q' });
      expect(ctx.formatted).toContain('[2024-03-05]');
    });

    it('prints no match score for unranked expanded rows', async () => {
      // similarity 0 means "never ranked" — printing "0% match" next to real
      // evidence reads as a relevance claim the row never made.
      withMessages([msgRow('m1', 'neighbour turn', '2024-03-05', '0')]);
      const ctx = await builder.build('user-1', { query: 'q' });
      expect(ctx.formatted).toContain('neighbour turn');
      expect(ctx.formatted).not.toContain('0% match');
    });
  });
});
