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

    builder = new ContextBuilder(
      pg as never, facts, embedding, emotional, contradictions, behavioral,
      null, // no graph
      'bwmem_', mockLogger,
    );
  });

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
});
