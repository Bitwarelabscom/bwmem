import { describe, it, expect, beforeEach } from 'vitest';
import { FactsService } from '../../src/memory/facts.service.js';
import { Pruner } from '../../src/consolidation/pruner.js';
import { MockPgClient, MockLLMProvider, mockLogger } from '../fixtures/mock-providers.js';

/**
 * The defect: a fact typed 'temporary' with no valid_until was IMMORTAL.
 *
 * Both expiry paths required `valid_until IS NOT NULL`, and only present-tense
 * `current_*` keys ever get a TTL stamped on write. The extraction prompt
 * meanwhile tells the model to type a fact 'temporary' whenever a state is
 * transient and to leave validUntil unset when it has no clear end. So every
 * transient fact whose key was not present-tense-shaped lived forever, and a
 * store accumulated mutually exclusive states — "on vacation" and "vacation
 * ended" — all active, all believed at once.
 */
describe('untimed temporary facts age out', () => {
  let pg: MockPgClient;

  beforeEach(() => { pg = new MockPgClient(); });

  describe('FactsService.expireTemporaryFacts', () => {
    let facts: FactsService;
    beforeEach(() => {
      facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
    });

    it('expires facts past their valid_until', async () => {
      pg.willReturn([{ id: 'a' }]);
      expect(await facts.expireTemporaryFacts()).toBe(1);
      expect(pg.lastQuery).toContain('valid_until <= NOW()');
    });

    it('ALSO expires untimed temporaries that have gone untended', async () => {
      pg.willReturn([]);
      await facts.expireTemporaryFacts();
      expect(pg.lastQuery).toContain('valid_until IS NULL');
      expect(pg.lastQuery).toContain("interval '1 day'");
    });

    it('measures age from last_mentioned, so a re-asserted state stays live', async () => {
      // last_mentioned bumps on re-assertion and never on read. Using
      // created_at would sweep a state that is still being said out loud.
      pg.willReturn([]);
      await facts.expireTemporaryFacts();
      expect(pg.lastQuery).toContain('COALESCE(last_mentioned, updated_at, created_at)');
    });

    it('defaults to 30 days', async () => {
      pg.willReturn([]);
      await facts.expireTemporaryFacts();
      expect(pg.lastParams?.[0]).toBe(30);
    });

    it('rounds a fractional age rather than passing it to ::int', async () => {
      pg.willReturn([]);
      await facts.expireTemporaryFacts(7.6);
      expect(pg.lastParams?.[0]).toBe(8);
    });

    it('disables the untimed branch on Infinity, keeping the old behaviour', async () => {
      // The escape hatch for a store that would rather keep an untyped
      // temporary forever than risk expiring a mistyped durable fact.
      pg.willReturn([]);
      await facts.expireTemporaryFacts(Infinity);
      expect(pg.lastParams?.[0]).toBeNull();
      // Null must switch the branch OFF in SQL, not compare against NULL and
      // quietly match nothing — the guard is explicit.
      expect(pg.lastQuery).toContain('$1::int IS NOT NULL');
    });

    it('treats a zero or negative age as "disabled", never as "expire everything"', async () => {
      for (const bad of [0, -5, NaN]) {
        pg.willReturn([]);
        await facts.expireTemporaryFacts(bad);
        expect(pg.lastParams?.[0]).toBeNull();
      }
    });

    it('only ever touches temporary, active rows', async () => {
      pg.willReturn([]);
      await facts.expireTemporaryFacts();
      expect(pg.lastQuery).toContain("fact_type = 'temporary'");
      expect(pg.lastQuery).toContain("fact_status = 'active'");
    });

    it('flips status rather than deleting — the sweep is reversible', async () => {
      pg.willReturn([]);
      await facts.expireTemporaryFacts();
      expect(pg.lastQuery).toContain("SET fact_status = 'expired'");
      expect(pg.lastQuery).not.toContain('DELETE');
    });
  });

  describe('Pruner.expireTemporaryFacts', () => {
    let pruner: Pruner;
    beforeEach(() => { pruner = new Pruner(pg as never, 'bwmem_', mockLogger); });

    it('carries the same second branch — the two paths must not disagree', async () => {
      pg.willReturn([{ count: '3' }]);
      expect(await pruner.expireTemporaryFacts()).toBe(3);
      expect(pg.lastQuery).toContain('valid_until IS NULL');
      expect(pg.lastQuery).toContain('COALESCE(last_mentioned, updated_at, created_at)');
      expect(pg.lastParams?.[0]).toBe(30);
    });

    it('honours Infinity the same way', async () => {
      pg.willReturn([{ count: '0' }]);
      await pruner.expireTemporaryFacts(Infinity);
      expect(pg.lastParams?.[0]).toBeNull();
    });
  });
});
