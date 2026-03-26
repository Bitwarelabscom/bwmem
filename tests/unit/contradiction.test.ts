import { describe, it, expect, beforeEach } from 'vitest';
import { ContradictionService } from '../../src/memory/contradiction.service.js';
import { MockPgClient, mockLogger } from '../fixtures/mock-providers.js';

describe('ContradictionService', () => {
  let pg: MockPgClient;
  let service: ContradictionService;

  beforeEach(() => {
    pg = new MockPgClient();
    service = new ContradictionService(pg as never, 'bwmem_', mockLogger);
  });

  describe('createSignal', () => {
    it('creates a new contradiction signal', async () => {
      pg.willReturnOne(null); // no existing signal
      pg.willReturn([]);      // INSERT

      await service.createSignal(
        'user-1', 'session-1', 'location',
        'New York', 'San Francisco',
        'correction',
      );

      expect(pg.queries).toHaveLength(2);
      expect(pg.queries[1].text).toContain('INSERT INTO bwmem_contradiction_signals');
    });

    it('deduplicates by fact_key and session', async () => {
      pg.willReturnOne({ id: 'existing-1' }); // Already exists

      await service.createSignal(
        'user-1', 'session-1', 'location',
        'New York', 'San Francisco',
        'correction',
      );

      // Only the SELECT query, no INSERT
      expect(pg.queries).toHaveLength(1);
    });
  });

  describe('getUnsurfaced', () => {
    it('returns unsurfaced contradictions', async () => {
      pg.willReturn([{
        id: 'sig-1',
        user_id: 'user-1',
        session_id: 'session-1',
        fact_key: 'location',
        user_stated: 'New York',
        stored_value: 'San Francisco',
        signal_type: 'correction',
        surfaced: false,
        surfaced_session_ids: [],
        created_at: new Date(),
      }]);

      const result = await service.getUnsurfaced('user-1');
      expect(result).toHaveLength(1);
      expect(result[0].factKey).toBe('location');
      expect(result[0].signalType).toBe('correction');
    });

    it('excludes already-surfaced-in-session signals', async () => {
      pg.willReturn([]);
      await service.getUnsurfaced('user-1', 'session-2');
      expect(pg.lastQuery).toContain('surfaced_session_ids');
    });
  });

  describe('markSurfaced', () => {
    it('appends session ID to surfaced_session_ids', async () => {
      pg.willReturn([]);
      await service.markSurfaced(['sig-1', 'sig-2'], 'session-3');
      expect(pg.lastQuery).toContain('array_append');
    });

    it('does nothing for empty ids', async () => {
      await service.markSurfaced([], 'session-1');
      expect(pg.queries).toHaveLength(0);
    });
  });

  describe('formatForPrompt', () => {
    it('returns empty string for no signals', () => {
      expect(service.formatForPrompt([])).toBe('');
    });

    it('formats contradiction signals', () => {
      const result = service.formatForPrompt([{
        id: 'sig-1',
        userId: 'user-1',
        factKey: 'location',
        userStated: 'New York',
        storedValue: 'San Francisco',
        signalType: 'correction' as const,
        surfaced: false,
        surfacedSessionIds: [],
        createdAt: new Date(),
      }]);
      expect(result).toContain('location');
      expect(result).toContain('New York');
      expect(result).toContain('San Francisco');
    });
  });
});
