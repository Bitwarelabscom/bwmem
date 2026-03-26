import { describe, it, expect, beforeEach } from 'vitest';
import { EpisodicConsolidator } from '../../src/consolidation/episodic.js';
import { Pruner } from '../../src/consolidation/pruner.js';
import { MockPgClient, MockLLMProvider, mockLogger } from '../fixtures/mock-providers.js';

// SummariesService mock
const mockSummaries = {
  summarizeSession: async () => null,
};

describe('EpisodicConsolidator', () => {
  let pg: MockPgClient;
  let llm: MockLLMProvider;
  let consolidator: EpisodicConsolidator;

  beforeEach(() => {
    pg = new MockPgClient();
    llm = new MockLLMProvider();
    consolidator = new EpisodicConsolidator(pg as never, llm, mockSummaries as never, 'bwmem_', mockLogger);
  });

  describe('consolidate', () => {
    it('creates a consolidation run record', async () => {
      pg.willReturnOne({ id: 'run-1' }); // INSERT consolidation_runs
      pg.willReturn([]); // SELECT messages (empty)
      pg.willReturn([]); // UPDATE completed

      await consolidator.consolidate('user-1', 'session-1');

      expect(pg.queries[0].text).toContain('INSERT INTO bwmem_consolidation_runs');
    });

    it('skips consolidation for sessions with < 2 messages', async () => {
      pg.willReturnOne({ id: 'run-1' });
      pg.willReturn([{ role: 'user', content: 'hi' }]); // Only 1 message
      pg.willReturn([]); // UPDATE completed

      await consolidator.consolidate('user-1', 'session-1');

      // Should have marked complete with 0 patterns
      expect(llm.chatCalls).toHaveLength(0);
    });

    it('extracts patterns from messages via LLM', async () => {
      pg.willReturnOne({ id: 'run-1' });
      pg.willReturn([
        { role: 'user', content: 'I love hiking in Colorado', sentiment_valence: 0.7, sentiment_arousal: 0.5, created_at: new Date() },
        { role: 'assistant', content: 'That sounds great!', sentiment_valence: 0.5, sentiment_arousal: 0.3, created_at: new Date() },
        { role: 'user', content: 'Yeah, been doing it for 5 years', sentiment_valence: 0.4, sentiment_arousal: 0.3, created_at: new Date() },
      ]);

      // LLM response with patterns
      llm.respond(JSON.stringify([
        { patternType: 'theme', pattern: 'User enjoys hiking in Colorado', confidence: 0.9 },
        { patternType: 'preference_signal', pattern: 'Outdoor activities preference', confidence: 0.7 },
      ]));

      // Pattern INSERTs
      pg.willReturn([]); // pattern 1
      pg.willReturn([]); // pattern 2
      pg.willReturn([]); // UPDATE completed

      await consolidator.consolidate('user-1', 'session-1');

      expect(llm.chatCalls).toHaveLength(1);
      expect(llm.lastSystemPrompt).toContain('episodic patterns');
    });
  });
});

describe('Pruner', () => {
  let pg: MockPgClient;
  let pruner: Pruner;

  beforeEach(() => {
    pg = new MockPgClient();
    pruner = new Pruner(pg as never, 'bwmem_', mockLogger);
  });

  describe('expireBehavioral', () => {
    it('expires old observations', async () => {
      pg.willReturn([{ count: '3' }]);
      const count = await pruner.expireBehavioral(7);
      expect(count).toBe(3);
      expect(pg.lastQuery).toContain('expired = TRUE');
    });
  });

  describe('pruneSemanticKnowledge', () => {
    it('deletes low-confidence entries', async () => {
      pg.willReturn([{ count: '5' }]);
      const count = await pruner.pruneSemanticKnowledge(0.3);
      expect(count).toBe(5);
      expect(pg.lastQuery).toContain('DELETE');
      expect(pg.lastParams?.[0]).toBe(0.3);
    });
  });

  describe('expireTemporaryFacts', () => {
    it('expires facts past valid_until', async () => {
      pg.willReturn([{ count: '2' }]);
      const count = await pruner.expireTemporaryFacts();
      expect(count).toBe(2);
      expect(pg.lastQuery).toContain("fact_status = 'expired'");
      expect(pg.lastQuery).toContain('valid_until <= NOW()');
    });
  });
});
