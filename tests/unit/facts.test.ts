import { describe, it, expect, beforeEach } from 'vitest';
import { FactsService } from '../../src/memory/facts.service.js';
import { MockPgClient, MockLLMProvider, mockLogger } from '../fixtures/mock-providers.js';

describe('FactsService', () => {
  let pg: MockPgClient;
  let llm: MockLLMProvider;
  let facts: FactsService;

  beforeEach(() => {
    pg = new MockPgClient();
    llm = new MockLLMProvider();
    facts = new FactsService(pg as never, llm, null, 'bwmem_', mockLogger);
  });

  describe('getUserFacts', () => {
    it('returns empty array when no facts exist', async () => {
      pg.willReturn([]);
      const result = await facts.getUserFacts('user-1');
      expect(result).toEqual([]);
    });

    it('queries with correct prefix and user_id', async () => {
      pg.willReturn([]);
      await facts.getUserFacts('user-1');
      expect(pg.lastQuery).toContain('bwmem_facts');
      expect(pg.lastParams?.[0]).toBe('user-1');
    });

    it('maps database rows to Fact objects', async () => {
      pg.willReturn([{
        id: 'fact-1',
        user_id: 'user-1',
        category: 'personal',
        fact_key: 'name',
        fact_value: 'Alice',
        confidence: '0.9',
        fact_status: 'active',
        fact_type: 'permanent',
        valid_from: null,
        valid_until: null,
        supersedes_id: null,
        override_priority: 0,
        mention_count: 3,
        last_mentioned: '2026-03-01T00:00:00Z',
        source_session_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      }]);

      const result = await facts.getUserFacts('user-1');
      expect(result).toHaveLength(1);
      expect(result[0].factKey).toBe('name');
      expect(result[0].factValue).toBe('Alice');
      expect(result[0].confidence).toBe(0.9);
      expect(result[0].factStatus).toBe('active');
      expect(result[0].mentionCount).toBe(3);
    });

    it('filters by category when provided', async () => {
      pg.willReturn([]);
      await facts.getUserFacts('user-1', 'personal');
      expect(pg.lastQuery).toContain('category = $2');
      expect(pg.lastParams?.[1]).toBe('personal');
    });
  });

  describe('storeFact', () => {
    it('inserts a new fact when none exists', async () => {
      // transaction mock: first query (SELECT existing) returns empty, second (INSERT) returns new row
      pg.willReturn([]); // no existing fact
      pg.willReturn([{
        id: 'new-fact-1',
        user_id: 'user-1',
        category: 'personal',
        fact_key: 'name',
        fact_value: 'Alice',
        confidence: '0.8',
        fact_status: 'active',
        fact_type: 'permanent',
        override_priority: 0,
        mention_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]);

      const result = await facts.storeFact({
        userId: 'user-1',
        category: 'personal',
        key: 'name',
        value: 'Alice',
      });

      expect(result.factKey).toBe('name');
      expect(result.factValue).toBe('Alice');
    });

    it('bumps mention_count when storing same value', async () => {
      pg.willReturn([{
        id: 'existing-1',
        fact_value: 'Alice',
        mention_count: 2,
        fact_type: 'permanent',
        fact_status: 'active',
      }]);
      pg.willReturn([{
        id: 'existing-1',
        user_id: 'user-1',
        category: 'personal',
        fact_key: 'name',
        fact_value: 'Alice',
        confidence: '0.9',
        fact_status: 'active',
        fact_type: 'permanent',
        override_priority: 0,
        mention_count: 3,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]);

      const result = await facts.storeFact({
        userId: 'user-1',
        category: 'personal',
        key: 'name',
        value: 'Alice',
      });

      expect(result.mentionCount).toBe(3);
    });
  });

  describe('extractFromMessages', () => {
    it('returns empty for empty messages', async () => {
      const result = await facts.extractFromMessages([], 'user-1');
      expect(result).toEqual([]);
    });

    it('returns empty for assistant-only messages', async () => {
      const result = await facts.extractFromMessages(
        [{ role: 'assistant', content: 'Hello!' }],
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('extracts facts via LLM', async () => {
      pg.willReturn([]); // no existing facts
      llm.respond(JSON.stringify([{
        category: 'personal',
        factKey: 'name',
        factValue: 'Alice',
        confidence: 1.0,
        factType: 'permanent',
        isCorrection: false,
      }]));

      const result = await facts.extractFromMessages(
        [{ role: 'user', content: 'My name is Alice' }],
        'user-1',
      );

      expect(result).toHaveLength(1);
      expect(result[0].factKey).toBe('name');
      expect(result[0].factValue).toBe('Alice');
    });

    it('rejects speculative facts', async () => {
      pg.willReturn([]); // no existing facts
      llm.respond(JSON.stringify([{
        category: 'personal',
        factKey: 'personality',
        factValue: 'suggests deep desire for connection',
        confidence: 0.5,
        factType: 'permanent',
        isCorrection: false,
      }]));

      const result = await facts.extractFromMessages(
        [{ role: 'user', content: 'I like talking to people' }],
        'user-1',
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('formatForPrompt', () => {
    it('returns empty string for no facts', () => {
      expect(facts.formatForPrompt([])).toBe('');
    });

    it('groups facts by category', () => {
      const testFacts = [
        makeFact({ category: 'personal', factKey: 'name', factValue: 'Alice' }),
        makeFact({ category: 'personal', factKey: 'age', factValue: '30' }),
        makeFact({ category: 'work', factKey: 'company', factValue: 'Acme' }),
      ];

      const result = facts.formatForPrompt(testFacts);
      expect(result).toContain('[personal]');
      expect(result).toContain('[work]');
      expect(result).toContain('name: Alice');
      expect(result).toContain('company: Acme');
    });

    it('marks temporary facts', () => {
      const testFacts = [
        makeFact({
          category: 'context',
          factKey: 'status',
          factValue: 'on vacation',
          factType: 'temporary',
          validUntil: new Date('2026-04-01'),
        }),
      ];

      const result = facts.formatForPrompt(testFacts);
      expect(result).toContain('[temporary');
    });
  });

  describe('removeFact', () => {
    it('marks fact as expired', async () => {
      pg.willReturn([]); // UPDATE returns empty
      await facts.removeFact('fact-1');
      expect(pg.lastQuery).toContain("fact_status = 'expired'");
      expect(pg.lastParams?.[0]).toBe('fact-1');
    });
  });

  describe('searchFacts', () => {
    it('searches by keyword in key and value', async () => {
      pg.willReturn([]);
      await facts.searchFacts('user-1', 'hiking');
      expect(pg.lastQuery).toContain('ILIKE');
      expect(pg.lastParams).toContain('%hiking%');
    });
  });
});

function makeFact(overrides: Partial<import('../../src/types.js').Fact> = {}): import('../../src/types.js').Fact {
  return {
    id: 'test-id',
    userId: 'user-1',
    category: 'personal',
    factKey: 'test',
    factValue: 'value',
    confidence: 0.8,
    factStatus: 'active',
    factType: 'permanent',
    overridePriority: 0,
    mentionCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
