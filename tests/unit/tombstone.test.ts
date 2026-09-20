import { describe, it, expect, beforeEach } from 'vitest';
import {
  TombstoneService,
  hashFactValue,
  formatTombstoneForPrompt,
} from '../../src/memory/tombstone.service.js';
import { MockPgClient, mockLogger } from '../fixtures/mock-providers.js';

describe('TombstoneService', () => {
  let pg: MockPgClient;
  let service: TombstoneService;

  beforeEach(() => {
    pg = new MockPgClient();
    service = new TombstoneService(pg as never, 'bwmem_', mockLogger);
  });

  describe('hashFactValue', () => {
    it('produces deterministic hash ignoring case and extra whitespace', () => {
      const h1 = hashFactValue('likes spicy food');
      const h2 = hashFactValue('  Likes   Spicy Food  ');
      expect(h1).toBe(h2);
    });
  });

  describe('recordTombstone', () => {
    it('inserts into fact_tombstones with value hash', async () => {
      pg.willReturn([{
        id: 'tomb-1',
        user_id: 'user-1',
        fact_key: 'city',
        fact_value: 'Berlin',
        value_hash: hashFactValue('Berlin'),
        reason: 'User moved away',
        source_fact_id: 'fact-123',
        created_at: new Date().toISOString(),
      }]);

      const tomb = await service.recordTombstone({
        userId: 'user-1',
        factKey: 'city',
        factValue: 'Berlin',
        reason: 'User moved away',
        sourceFactId: 'fact-123',
      });

      expect(pg.lastQuery).toContain('bwmem_fact_tombstones');
      expect(pg.lastQuery).toContain('ON CONFLICT (user_id, fact_key, value_hash)');
      expect(tomb.factKey).toBe('city');
      expect(tomb.factValue).toBe('Berlin');
      expect(tomb.reason).toBe('User moved away');
      expect(tomb.sourceFactId).toBe('fact-123');
    });
  });

  describe('isTombstoned', () => {
    it('returns true when exact hash matches', async () => {
      pg.willReturn([{
        fact_value: 'Berlin',
        value_hash: hashFactValue('Berlin'),
      }]);

      const result = await service.isTombstoned('user-1', 'city', 'berlin');
      expect(result).toBe(true);
      expect(pg.lastQuery).toContain('SELECT fact_value, value_hash FROM bwmem_fact_tombstones');
    });

    it('returns true when values are semantically similar', async () => {
      pg.willReturn([{
        fact_value: 'loves Italian pasta and pizza',
        value_hash: hashFactValue('loves Italian pasta and pizza'),
      }]);

      const result = await service.isTombstoned('user-1', 'food', 'Italian pasta and pizza');
      expect(result).toBe(true);
    });

    it('returns false when no tombstones exist for key', async () => {
      pg.willReturn([]);
      const result = await service.isTombstoned('user-1', 'city', 'London');
      expect(result).toBe(false);
    });

    it('returns false when tombstones for key have completely different values', async () => {
      pg.willReturn([{
        fact_value: 'Tokyo',
        value_hash: hashFactValue('Tokyo'),
      }]);
      const result = await service.isTombstoned('user-1', 'city', 'Paris');
      expect(result).toBe(false);
    });
  });

  describe('loadTombstonesForKeys', () => {
    it('batch loads tombstones for multiple keys', async () => {
      pg.willReturn([
        {
          id: 't-1',
          user_id: 'user-1',
          fact_key: 'city',
          fact_value: 'Berlin',
          value_hash: hashFactValue('Berlin'),
          reason: 'Moved',
          source_fact_id: null,
          created_at: new Date().toISOString(),
        },
        {
          id: 't-2',
          user_id: 'user-1',
          fact_key: 'diet',
          fact_value: 'vegan',
          value_hash: hashFactValue('vegan'),
          reason: 'No longer vegan',
          source_fact_id: null,
          created_at: new Date().toISOString(),
        },
      ]);

      const map = await service.loadTombstonesForKeys('user-1', ['city', 'diet']);
      expect(map.size).toBe(2);
      expect(map.get('city')?.[0].factValue).toBe('Berlin');
      expect(map.get('diet')?.[0].factValue).toBe('vegan');
      expect(pg.lastQuery).toContain('ANY($2::text[])');
    });

    it('returns empty map for empty keys array', async () => {
      const map = await service.loadTombstonesForKeys('user-1', []);
      expect(map.size).toBe(0);
      expect(pg.queries.length).toBe(0);
    });
  });

  describe('getTombstones', () => {
    it('queries tombstones with user and optional fact_key', async () => {
      pg.willReturn([{
        id: 't-1',
        user_id: 'user-1',
        fact_key: 'company',
        fact_value: 'Acme',
        value_hash: hashFactValue('Acme'),
        reason: 'Left company',
        source_fact_id: null,
        created_at: new Date().toISOString(),
      }]);

      const list = await service.getTombstones('user-1', { factKey: 'company', limit: 10 });
      expect(list).toHaveLength(1);
      expect(pg.lastQuery).toContain('WHERE user_id = $1 AND fact_key = $2');
      expect(pg.lastParams?.[0]).toBe('user-1');
      expect(pg.lastParams?.[1]).toBe('company');
      expect(pg.lastParams?.[2]).toBe(10);
    });
  });

  describe('removeTombstone', () => {
    it('deletes tombstone by id and user', async () => {
      pg.willReturn([{ id: 't-1' }]);
      const deleted = await service.removeTombstone('user-1', 't-1');
      expect(deleted).toBe(true);
      expect(pg.lastQuery).toContain('DELETE FROM bwmem_fact_tombstones');
      expect(pg.lastQuery).toContain('WHERE id = $1 AND user_id = $2');
    });
  });

  describe('formatTombstoneForPrompt', () => {
    it('formats readable tombstone string', () => {
      const formatted = formatTombstoneForPrompt({
        id: 't-1',
        userId: 'user-1',
        factKey: 'pet',
        factValue: 'dog named Rex',
        valueHash: 'hash',
        reason: 'User clarified they have a cat, not a dog',
        createdAt: new Date('2026-05-10T12:00:00Z'),
      });

      expect(formatted).toContain('[TOMBSTONE]');
      expect(formatted).toContain('"pet: dog named Rex"');
      expect(formatted).toContain('rejected on 2026-05-10');
      expect(formatted).toContain('User clarified they have a cat, not a dog');
    });
  });
});
