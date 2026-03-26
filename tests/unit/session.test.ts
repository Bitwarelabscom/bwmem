import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../src/session/session.js';
import {
  MockPgClient, MockEmbeddingProvider, MockLLMProvider,
  MockRedisClient, mockLogger,
} from '../fixtures/mock-providers.js';
import { EmbeddingService } from '../../src/memory/embedding.service.js';
import { SentimentService } from '../../src/memory/sentiment.service.js';
import { CentroidService } from '../../src/memory/centroid.service.js';
import { FactsService } from '../../src/memory/facts.service.js';
import { EmotionalMomentsService } from '../../src/memory/emotional-moments.service.js';
import { ContradictionService } from '../../src/memory/contradiction.service.js';

describe('Session', () => {
  let pg: MockPgClient;
  let llm: MockLLMProvider;
  let redis: MockRedisClient;
  let session: Session;

  beforeEach(() => {
    pg = new MockPgClient();
    llm = new MockLLMProvider();
    redis = new MockRedisClient();
    const provider = new MockEmbeddingProvider();
    const embedding = new EmbeddingService(pg as never, provider, 'bwmem_', mockLogger);
    const sentiment = new SentimentService(llm, mockLogger);
    const centroid = new CentroidService(redis as never, mockLogger);
    const facts = new FactsService(pg as never, llm, null, 'bwmem_', mockLogger);
    const emotional = new EmotionalMomentsService(pg as never, llm, 'bwmem_', mockLogger);
    const contradictions = new ContradictionService(pg as never, 'bwmem_', mockLogger);

    session = new Session(
      'session-1', 'user-1', {},
      pg as never, embedding, sentiment, centroid,
      facts, emotional, contradictions,
      null, // no scheduler
      'bwmem_', mockLogger,
    );
  });

  describe('recordMessage', () => {
    it('inserts message into database', async () => {
      pg.willReturn([]); // INSERT
      // Background processing needs sentiment LLM call
      llm.respond('{"valence": 0, "arousal": 0.3, "dominance": 0.5}');
      // Background processing may need more pg calls
      pg.willReturn([]); // embedding store
      pg.willReturn([]); // fact extraction existing facts

      const msg = await session.recordMessage({ role: 'user', content: 'Hello world' });

      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello world');
      expect(msg.sessionId).toBe('session-1');
      expect(msg.userId).toBe('user-1');
      expect(msg.id).toBeTruthy();

      // First query should be the message INSERT
      expect(pg.queries[0].text).toContain('INSERT INTO bwmem_messages');
    });

    it('throws after session ended', async () => {
      pg.willReturn([]); // UPDATE for end
      await session.end();

      await expect(
        session.recordMessage({ role: 'user', content: 'test' })
      ).rejects.toThrow('Session has ended');
    });
  });

  describe('end', () => {
    it('marks session as ended in database', async () => {
      pg.willReturn([]); // UPDATE
      await session.end();

      expect(pg.queries.some(q => q.text.includes('ended_at') && q.text.includes('is_active = FALSE'))).toBe(true);
    });

    it('is idempotent', async () => {
      pg.willReturn([]); // UPDATE
      await session.end();
      const queryCount = pg.queries.length;

      await session.end(); // Second call should be a no-op
      expect(pg.queries.length).toBe(queryCount);
    });
  });

  describe('getMessages', () => {
    it('returns messages ordered by created_at', async () => {
      pg.willReturn([
        { id: 'msg-1', session_id: 'session-1', user_id: 'user-1', role: 'user', content: 'Hello', has_embedding: true, created_at: new Date('2026-03-01T10:00:00Z') },
        { id: 'msg-2', session_id: 'session-1', user_id: 'user-1', role: 'assistant', content: 'Hi there', has_embedding: true, created_at: new Date('2026-03-01T10:00:01Z') },
      ]);

      const messages = await session.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].content).toBe('Hi there');
    });
  });
});
