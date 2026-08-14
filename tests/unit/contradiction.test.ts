import { describe, it, expect, beforeEach } from 'vitest';
import { ContradictionService } from '../../src/memory/contradiction.service.js';
import { MockPgClient, mockLogger } from '../fixtures/mock-providers.js';

describe('ContradictionService', () => {
  let pg: MockPgClient;
  let service: ContradictionService;
  /** Inline detection is opt-in, so the detectInline block needs it switched on. */
  let inline: ContradictionService;

  beforeEach(() => {
    pg = new MockPgClient();
    service = new ContradictionService(pg as never, 'bwmem_', mockLogger);
    inline = new ContradictionService(pg as never, 'bwmem_', mockLogger, true);
  });

  describe('createSignal', () => {
    it('records a signal as a single upsert', async () => {
      pg.willReturn([]); // upsert

      // Use a stable fact key — volatile keys (location, schedule, _time, …)
      // are silently skipped by createSignal to keep the signal feed clean.
      await service.createSignal(
        'user-1', 'session-1', 'partner_name',
        'Alice', 'Beth',
        'correction',
      );

      // One statement, not SELECT-then-INSERT: the check-then-act had a race
      // and only deduplicated within a single session.
      expect(pg.queries).toHaveLength(1);
      expect(pg.queries[0].text).toContain('INSERT INTO bwmem_contradiction_signals');
      expect(pg.queries[0].text).toContain('ON CONFLICT');
    });

    it('bumps the repeat counter instead of filing a second row', async () => {
      pg.willReturn([]);

      await service.createSignal(
        'user-1', 'session-2', 'partner_name',
        'Alice', 'Beth',
        'correction',
      );

      const sql = pg.queries[0].text;
      // created_at must NOT be touched on conflict — it is the FIRST sighting,
      // and "this has been wrong since Tuesday" depends on it surviving.
      expect(sql).toContain('repeat_count');
      expect(sql).toContain('last_seen_at    = NOW()');
      expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*created_at/);
    });

    it('persists the gate verdict that let the signal through', async () => {
      pg.willReturn([]);

      await service.createSignal(
        'user-1', 'session-1', 'partner_name',
        'Alice', 'Beth',
        'misremember',
        { path: 'gate_separate', similarity: 0.81, reason: 'different people' },
      );

      const params = pg.queries[0].params as unknown[];
      expect(params).toContain('gate_separate');
      expect(params).toContain(0.81);
      expect(params).toContain('different people');
    });

    it('stores no similarity when the gate could not run', async () => {
      pg.willReturn([]);

      // -1 is the "gate never ran" sentinel; writing it would make an outage
      // look like a measured cosine of -1.
      await service.createSignal(
        'user-1', 'session-1', 'partner_name',
        'Alice', 'Beth',
        'misremember',
        { path: 'gate_error', similarity: -1 },
      );

      const params = pg.queries[0].params as unknown[];
      expect(params).toContain('gate_error');
      expect(params).not.toContain(-1);
    });

    it('drops volatile-key signals before the SELECT', async () => {
      // location is volatile — should short-circuit with zero queries.
      await service.createSignal(
        'user-1', 'session-1', 'location',
        'New York', 'San Francisco',
        'correction',
      );
      expect(pg.queries).toHaveLength(0);
    });
  });

  describe('detectInline', () => {
    it('returns empty for messages with no capitalized non-stopwords', () => {
      const result = inline.detectInline('i live in new york', []);
      expect(result).toEqual([]);
    });

    it('is OFF unless explicitly enabled', () => {
      // The default matters: this is a heuristic with no model behind it, and
      // it once emitted 35 phantom contradictions on one message. A consumer
      // has to ask for it rather than inherit it.
      const result = service.detectInline('My wife Beth is great', [{
        id: 'f1', userId: 'u', category: 'relationship', factKey: 'partner_name',
        factValue: 'Alice', confidence: 1, factStatus: 'active', factType: 'permanent',
        overridePriority: 0, mentionCount: 3,
        createdAt: new Date(), updatedAt: new Date(),
      }]);
      expect(result).toEqual([]);
    });

    it('caps output and never emits two rows for one key', () => {
      // Ten concept-matching facts and several proper nouns in one message is
      // exactly the shape that produced 35 signals before the cap.
      const facts = Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`, userId: 'u', category: 'relationship', factKey: 'partner_name',
        factValue: `Stored${i}`, confidence: 1, factStatus: 'active' as const,
        factType: 'permanent' as const, overridePriority: 0, mentionCount: 5,
        createdAt: new Date(), updatedAt: new Date(),
      }));
      const result = inline.detectInline('My wife Beth and Clara and Dana visited', facts);
      expect(result.length).toBeLessThanOrEqual(3);
      expect(new Set(result.map(r => r.factKey)).size).toBe(result.length);
    });

    it('ignores a proper noun far from the concept token', () => {
      // "Beth" is a clause away from "wife" and has nothing to do with it.
      const result = inline.detectInline(
        'My wife is fine but I spent all morning debugging a deploy and then Beth called about something unrelated entirely',
        [{
          id: 'f1', userId: 'u', category: 'relationship', factKey: 'partner_name',
          factValue: 'Alice', confidence: 1, factStatus: 'active', factType: 'permanent',
          overridePriority: 0, mentionCount: 3,
          createdAt: new Date(), updatedAt: new Date(),
        }],
      );
      expect(result).toEqual([]);
    });

    it('flags a contradiction when a concept token + different value appears', () => {
      // partner_name has the concept token "wife"; stored Alice, message says Beth.
      const result = inline.detectInline('My wife Beth is great', [{
        id: 'f1', userId: 'u', category: 'relationship', factKey: 'partner_name',
        factValue: 'Alice', confidence: 1, factStatus: 'active', factType: 'permanent',
        overridePriority: 0, mentionCount: 3,
        createdAt: new Date(), updatedAt: new Date(),
      }]);
      expect(result).toHaveLength(1);
      expect(result[0].factKey).toBe('partner_name');
      expect(result[0].suspectedValue).toBe('Beth');
    });

    it('skips facts on volatile keys', () => {
      const result = inline.detectInline('I live in Berlin', [{
        id: 'f1', userId: 'u', category: 'personal', factKey: 'location',
        factValue: 'Tokyo', confidence: 1, factStatus: 'active', factType: 'permanent',
        overridePriority: 0, mentionCount: 5,
        createdAt: new Date(), updatedAt: new Date(),
      }]);
      // location is volatile — never a contradiction.
      expect(result).toEqual([]);
    });

    it('skips low-mentionCount facts without semantic mapping', () => {
      const result = inline.detectInline('My nickname Hank is good', [{
        id: 'f1', userId: 'u', category: 'personal', factKey: 'unmapped_key',
        factValue: 'Henrik', confidence: 1, factStatus: 'active', factType: 'permanent',
        overridePriority: 0, mentionCount: 1,
        createdAt: new Date(), updatedAt: new Date(),
      }]);
      expect(result).toEqual([]);
    });
  });

  describe('getOpen', () => {
    /** getOpen runs the hold-lapse sweep first, so the SELECT is the second query. */
    const openRow = {
      id: 'sig-1',
      user_id: 'user-1',
      session_id: 'session-1',
      fact_key: 'location',
      user_stated: 'New York',
      stored_value: 'San Francisco',
      signal_type: 'correction',
      status: 'open',
      decision: null,
      resolution: null,
      resolved_at: null,
      held_at: null,
      hold_reason: null,
      surfaced: false,
      surfaced_session_ids: [],
      created_at: new Date(),
    };

    it('returns open contradictions', async () => {
      pg.willReturn([]).willReturn([openRow]);

      const result = await service.getOpen('user-1');
      expect(result).toHaveLength(1);
      expect(result[0].factKey).toBe('location');
      expect(result[0].signalType).toBe('correction');
      expect(result[0].status).toBe('open');
    });

    it('filters on status, not on the display flag', async () => {
      // The whole point of 017. `surfaced` said "has been shown"; every reader
      // took it to mean "has been dealt with".
      pg.willReturn([]).willReturn([]);
      await service.getOpen('user-1');
      expect(pg.lastQuery).toContain("status = 'open'");
      expect(pg.lastQuery).not.toContain('surfaced = FALSE');
    });

    it('excludes already-surfaced-in-session signals', async () => {
      pg.willReturn([]).willReturn([]);
      await service.getOpen('user-1', 'session-2');
      expect(pg.lastQuery).toContain('surfaced_session_ids');
    });

    it('lapses stale holds before reading', async () => {
      pg.willReturn([]).willReturn([]);
      await service.getOpen('user-1');
      expect(pg.queries[0].text).toContain("status = 'held'");
      expect(pg.queries[0].text).toContain("SET status        = 'open'");
    });

    it('getUnsurfaced still works and delegates to getOpen', async () => {
      pg.willReturn([]).willReturn([openRow]);
      const result = await service.getUnsurfaced('user-1');
      expect(result).toHaveLength(1);
      expect(pg.lastQuery).toContain("status = 'open'");
    });
  });

  describe('markSurfaced', () => {
    it('appends session ID to surfaced_session_ids', async () => {
      pg.willReturn([]);
      await service.markSurfaced(['sig-1', 'sig-2'], 'session-3');
      expect(pg.lastQuery).toContain('array_append');
    });

    it('holds rather than resolves once shown repeatedly', async () => {
      // Being looked at three times and ignored is not a decision. It used to
      // set the same flag that meant "dealt with", which is why "resolved"
      // could never be counted.
      pg.willReturn([]);
      await service.markSurfaced(['sig-1'], 'session-3');
      expect(pg.lastQuery).toContain("THEN 'held'");
      expect(pg.lastQuery).not.toContain("'resolved'");
      expect(pg.lastQuery).toContain('held_at_value');
    });

    it('does nothing for empty ids', async () => {
      await service.markSurfaced([], 'session-1');
      expect(pg.queries).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('records which value won, not just a note', async () => {
      pg.willReturnOne({ id: 'sig-1' });
      const ok = await service.resolve('user-1', 'sig-1', 'user_stated', 'they moved');
      expect(ok).toBe(true);
      expect(pg.lastQuery).toContain("status      = 'resolved'");
      expect(pg.lastQuery).toContain('decision');
      expect(pg.lastParams).toContain('user_stated');
    });

    it('rejects an unknown decision without touching the database', async () => {
      const ok = await service.resolve('user-1', 'sig-1', 'whatever' as never);
      expect(ok).toBe(false);
      expect(pg.queries).toHaveLength(0);
    });

    it('reports false when no row moved', async () => {
      pg.willReturnOne(null);
      expect(await service.resolve('user-1', 'sig-1', 'stored')).toBe(false);
    });

    it('clears the hold fields so a resolved row cannot lapse back to open', async () => {
      pg.willReturnOne({ id: 'sig-1' });
      await service.resolve('user-1', 'sig-1', 'neither');
      expect(pg.lastQuery).toContain('held_at_value = NULL');
    });
  });

  describe('hold', () => {
    it('pins the hold to the value it was taken against', async () => {
      pg.willReturnOne({ id: 'sig-1' });
      const ok = await service.hold('user-1', 'sig-1', 'ask them later');
      expect(ok).toBe(true);
      expect(pg.lastQuery).toContain('held_at_value = stored_value');
      expect(pg.lastQuery).toContain("status        = 'held'");
    });

    it('only holds an open signal', async () => {
      pg.willReturnOne(null);
      await service.hold('user-1', 'sig-1');
      expect(pg.lastQuery).toContain("status = 'open'");
    });
  });

  describe('counts', () => {
    it('reports all three states', async () => {
      pg.willReturn([
        { status: 'open', n: '3' },
        { status: 'held', n: '1' },
        { status: 'resolved', n: '7' },
      ]);
      expect(await service.counts('user-1')).toEqual({ open: 3, held: 1, resolved: 7 });
    });

    it('reports zero for states with no rows', async () => {
      pg.willReturn([{ status: 'open', n: '2' }]);
      expect(await service.counts('user-1')).toEqual({ open: 2, held: 0, resolved: 0 });
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
        status: 'open' as const,
        decision: null,
        resolution: null,
        resolvedAt: null,
        heldAt: null,
        holdReason: null,
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
