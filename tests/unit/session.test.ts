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
      llm, // LLM for contradiction detection
      null, // no scheduler
      null, // no temporal index
      'bwmem_', mockLogger,
    );
  });

  describe('bulkImport', () => {
    /** Build a session with bulkImport on, sharing the same mocks. */
    const importSession = () => new Session(
      'session-2', 'user-1', {},
      pg as never,
      new EmbeddingService(pg as never, new MockEmbeddingProvider(), 'bwmem_', mockLogger),
      new SentimentService(llm, mockLogger),
      new CentroidService(redis as never, mockLogger),
      new FactsService(pg as never, llm, null, 'bwmem_', mockLogger),
      new EmotionalMomentsService(pg as never, llm, 'bwmem_', mockLogger),
      new ContradictionService(pg as never, 'bwmem_', mockLogger),
      llm, null, null, 'bwmem_', mockLogger,
      true,
    );

    it('skips the per-message sentiment LLM call', async () => {
      // One LLM call on EVERY message is the single largest cost in an import
      // and nothing in retrieval reads the result.
      const s = importSession();
      pg.willReturn([]);
      const before = llm.chatCalls.length;
      await s.recordMessage({ role: 'user', content: 'I had a genuinely wonderful afternoon at the lake today.' });
      await s.flush();
      expect((llm.chatCalls.length) - before).toBe(0);
    });

    it('still stores the message and its embedding', async () => {
      // Embeddings are recall-critical: an import that skipped them would be
      // fast and useless.
      const s = importSession();
      pg.willReturn([]);
      await s.recordMessage({ role: 'user', content: 'I had a genuinely wonderful afternoon at the lake today.' });
      await s.flush();
      expect(pg.queries[0].text).toContain('INSERT INTO bwmem_messages');
      expect(pg.queries.some(q => q.text.includes('embedding'))).toBe(true);
    });

    it('writes no sentiment columns', async () => {
      const s = importSession();
      pg.willReturn([]);
      await s.recordMessage({ role: 'user', content: 'I had a genuinely wonderful afternoon at the lake today.' });
      await s.flush();
      expect(pg.queries.some(q => q.text.includes('SET sentiment_valence'))).toBe(false);
    });

    it('live mode still runs sentiment', async () => {
      pg.willReturn([]);
      llm.respond('{"valence": 0.2, "arousal": 0.3, "dominance": 0.5}');
      const before = llm.chatCalls.length;
      await session.recordMessage({ role: 'user', content: 'I had a genuinely wonderful afternoon at the lake today.' });
      await session.flush();
      expect((llm.chatCalls.length) - before).toBeGreaterThan(0);
    });
  });

  describe('recordMessage timestamps', () => {
    it('defaults created_at to now', async () => {
      pg.willReturn([]);
      const before = Date.now();
      const m = await session.recordMessage({ role: 'user', content: 'hi' });
      expect(m.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('honours an explicit timestamp so imported history keeps its dates', async () => {
      // Without this every backfilled message lands at import time, which
      // collapses the corpus onto one instant and makes recall ordering and
      // the timeline answer about the import run instead of the conversation.
      pg.willReturn([]);
      const when = new Date('2023-05-14T09:30:00Z');
      const m = await session.recordMessage({
        role: 'user', content: 'hi', timestamp: when,
      });
      expect(m.createdAt.toISOString()).toBe(when.toISOString());
      expect(pg.queries[0].text).toContain('created_at');
      expect((pg.queries[0].params as unknown[])[5]).toEqual(when);
    });

    it('accepts an ISO string', async () => {
      pg.willReturn([]);
      const m = await session.recordMessage({
        role: 'user', content: 'hi', timestamp: '2023-05-14T09:30:00Z',
      });
      expect(m.createdAt.toISOString()).toBe('2023-05-14T09:30:00.000Z');
    });
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
