import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingService } from '../../src/memory/embedding.service.js';
import { MockPgClient, MockEmbeddingProvider, mockLogger } from '../fixtures/mock-providers.js';

describe('EmbeddingService', () => {
  let pg: MockPgClient;
  let provider: MockEmbeddingProvider;
  let service: EmbeddingService;

  beforeEach(() => {
    pg = new MockPgClient();
    provider = new MockEmbeddingProvider();
    service = new EmbeddingService(pg as never, provider, 'bwmem_', mockLogger);
  });

  describe('generate', () => {
    it('generates an embedding for text', async () => {
      const result = await service.generate('hello world');
      expect(result).toHaveLength(4); // MockEmbeddingProvider dimensions
      expect(provider.generateCalls).toHaveLength(1);
    });

    it('caches embeddings for repeated text', async () => {
      const r1 = await service.generate('hello world');
      const r2 = await service.generate('hello world');
      expect(r1).toEqual(r2);
      expect(provider.generateCalls).toHaveLength(1); // Only called once
    });

    it('generates different embeddings for different text', async () => {
      const r1 = await service.generate('hello world');
      const r2 = await service.generate('goodbye world');
      expect(r1).not.toEqual(r2);
      expect(provider.generateCalls).toHaveLength(2);
    });
  });

  describe('generateBatch', () => {
    it('returns empty array for empty input', async () => {
      const result = await service.generateBatch([]);
      expect(result).toEqual([]);
    });

    it('delegates single text to generate', async () => {
      const result = await service.generateBatch(['hello']);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(4);
    });

    it('generates embeddings for multiple texts', async () => {
      const result = await service.generateBatch(['hello', 'world', 'test']);
      expect(result).toHaveLength(3);
      result.forEach(emb => expect(emb).toHaveLength(4));
    });

    it('uses cache for previously seen texts', async () => {
      // Pre-cache
      await service.generate('hello');
      expect(provider.generateCalls).toHaveLength(1);

      // Batch with one cached
      const result = await service.generateBatch(['hello', 'world']);
      expect(result).toHaveLength(2);
      // 'hello' was cached, 'world' was new - but generateBatch calls provider for uncached
      expect(provider.generateCalls).toHaveLength(2); // 1 from generate + 1 from batch (only 'world')
    });
  });

  describe('storeMessageEmbedding', () => {
    it('stores embedding with vector string', async () => {
      pg.willReturn([]); // INSERT result
      await service.storeMessageEmbedding(
        'msg-1', 'user-1', 'session-1', 'hello world', 'user',
        0.5, 0.3, 0.7,
      );

      expect(pg.queries).toHaveLength(1);
      expect(pg.lastQuery).toContain('bwmem_messages');
      expect(pg.lastQuery).toContain('::vector');
      expect(pg.lastParams?.[0]).toBe('msg-1');
    });
  });

  describe('searchSimilarMessages', () => {
    it('returns empty array when no similar messages found', async () => {
      pg.willReturn([]);
      const result = await service.searchSimilarMessages('user-1', 'test query');
      expect(result).toEqual([]);
    });

    it('queries with cosine similarity', async () => {
      pg.willReturn([]);
      await service.searchSimilarMessages('user-1', 'test query', 5, 0.7);
      expect(pg.lastQuery).toContain('<=>');
      expect(pg.lastQuery).toContain('bwmem_messages');
    });

    it('excludes current session when specified', async () => {
      pg.willReturn([]);
      await service.searchSimilarMessages('user-1', 'test', 5, 0.7, 'exclude-session');
      expect(pg.lastQuery).toContain('session_id !=');
    });

    it('maps result rows correctly', async () => {
      pg.willReturn([{
        id: 'msg-1',
        session_id: 'sess-1',
        content: 'matching content',
        role: 'user',
        similarity: '0.85',
        created_at: new Date('2026-03-01'),
      }]);

      const result = await service.searchSimilarMessages('user-1', 'test');
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('msg-1');
      expect(result[0].similarity).toBe(0.85);
      expect(result[0].content).toBe('matching content');
    });
  });

  describe('searchSimilarConversations', () => {
    it('queries conversation_summaries table', async () => {
      pg.willReturn([]);
      await service.searchSimilarConversations('user-1', 'test');
      expect(pg.lastQuery).toContain('bwmem_conversation_summaries');
    });
  });
});
