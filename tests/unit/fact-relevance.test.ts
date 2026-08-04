/**
 * 0.5.1 — intent scoping as a preference, and query-aware fact retrieval.
 *
 * The defect these cover: getUserFacts' `undefined` branch applied
 * `AND intent_id IS NULL`, and ContextBuilder.build() calls it with `undefined`
 * and has no way to pass an intent. So any fact written via
 * `store({ intentId })` — a documented option — could never appear in the
 * context the SDK exists to build. In the system this was extracted from, that
 * hid 93% of the active fact store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FactsService, messageToOrQuery } from '../../src/memory/facts.service.js';
import { MockPgClient, MockLLMProvider, mockLogger } from '../fixtures/mock-providers.js';

const INTENT = '3a4c1f47-d0e4-4704-a896-7cf582fa3b5d';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('messageToOrQuery', () => {
  it('ORs its terms — a short fact carries only one or two of a message\'s words', () => {
    const q = messageToOrQuery('what is my cat called');
    expect(q).toContain(' | ');
    expect(q!.split(' | ')).toEqual(expect.arrayContaining(['cat', 'called']));
    expect(q).not.toContain('&');
  });

  it('drops sub-3-character tokens and punctuation', () => {
    const terms = messageToOrQuery('is my cat ok?? a b')!.split(' | ');
    expect(terms).toContain('cat');
    expect(terms).not.toContain('a');
    expect(terms.every(t => /^[a-zà-ÿ0-9]+$/i.test(t))).toBe(true);
  });

  it('de-duplicates so one repeated word cannot dominate the rank', () => {
    expect(messageToOrQuery('cat cat CAT Cat')).toBe('cat');
  });

  it('caps term count so a pasted wall of text cannot build a huge tsquery', () => {
    const many = Array.from({ length: 200 }, (_, i) => `term${i}`).join(' ');
    expect(messageToOrQuery(many)!.split(' | ')).toHaveLength(25);
  });

  it('returns null rather than letting an empty tsquery reach Postgres', () => {
    expect(messageToOrQuery('')).toBeNull();
    expect(messageToOrQuery('a b !! ??')).toBeNull();
  });
});

describe('getUserFacts — intent is a preference, not a filter', () => {
  let pg: MockPgClient;
  let facts: FactsService;

  beforeEach(() => {
    pg = new MockPgClient();
    facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
  });

  it('does NOT exclude intent-scoped facts when no intent is given (the 0.5.1 fix)', async () => {
    pg.willReturn([]);
    await facts.getUserFacts('user-1');
    expect(pg.queries[0].text).not.toContain('AND intent_id IS NULL');
  });

  it('still filters to unscoped when null is passed explicitly', async () => {
    pg.willReturn([]);
    await facts.getUserFacts('user-1', undefined, 30, null);
    expect(pg.queries[0].text).toContain('AND intent_id IS NULL');
  });

  it('prefers a given intent without excluding the others', async () => {
    pg.willReturn([]);
    await facts.getUserFacts('user-1', undefined, 30, INTENT);
    const sql = pg.queries[0].text;
    expect(sql).not.toContain('AND intent_id IS NULL');
    expect(sql).not.toContain('OR intent_id IS NULL');   // the old scoping filter
    expect(sql).toContain('intent_rank');
    expect(pg.queries[0].params?.[1]).toBe(INTENT);
  });

  it('binds SQL NULL for the intent in every mode so $2 is always safe', async () => {
    pg.willReturn([]);
    await facts.getUserFacts('user-1');
    expect(pg.queries[0].params?.[1]).toBeNull();
  });

  it('partitions without intent_id so one key yields one winner across intents', async () => {
    pg.willReturn([]);
    await facts.getUserFacts('user-1');
    const sql = norm(pg.queries[0].text);
    expect(sql).toContain('PARTITION BY category, fact_key ORDER BY');
    expect(sql).not.toContain("COALESCE(intent_id, '00000000-0000-0000-0000-000000000000'::uuid)");
  });
});

describe('searchRelevantFacts', () => {
  let pg: MockPgClient;
  let facts: FactsService;

  beforeEach(() => {
    pg = new MockPgClient();
    facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
  });

  it('never queries at all when the text has nothing matchable', async () => {
    expect(await facts.searchRelevantFacts('user-1', 'a b !!')).toEqual([]);
    expect(pg.queries).toHaveLength(0);
  });

  it('uses a floor relative to the best match, not an absolute one', async () => {
    // An absolute floor is unusable here: ts_rank falls off with query-term
    // count, so a value tuned for a bare question empties out once the caller
    // passes a few sentences of context.
    pg.willReturn([]);
    await facts.searchRelevantFacts('user-1', 'what is my cat called');
    expect(norm(pg.queries[0].text)).toContain('MAX(relevance) FROM winners) * 0.5');
  });

  it('weights the key above the value so a key match outranks an incidental one', async () => {
    pg.willReturn([]);
    await facts.searchRelevantFacts('user-1', 'what is my cat called');
    const sql = norm(pg.queries[0].text);
    expect(sql).toContain("setweight(to_tsvector('english', replace(fact_key, '_', ' ')), 'A')");
    expect(sql).toContain("setweight(to_tsvector('english', fact_value), 'B')");
  });

  it('filters on the SAME expression migration 015 indexes, or it will seq-scan', () => {
    // This is the documented footgun: a GIN expression index is only used when
    // the predicate matches it character for character. Asserting it here means
    // editing one without the other fails the build instead of silently costing
    // a sequential scan on every turn.
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      join(here, '../../src/db/migrations/015_fact_relevance_index.sql'), 'utf8',
    );
    const indexed = norm(migration)
      .match(/USING GIN \((to_tsvector\('english',.*?fact_value)\)\)/)?.[1];
    expect(indexed, 'could not find the indexed expression in migration 015').toBeTruthy();

    const pg2 = new MockPgClient();
    const svc = new FactsService(pg2 as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
    pg2.willReturn([]);
    return svc.searchRelevantFacts('user-1', 'what is my cat called').then(() => {
      expect(norm(pg2.queries[0].text)).toContain(indexed!);
    });
  });
});

describe('getUserFacts + queryText', () => {
  it('appends relevance matches to the core set without displacing it', async () => {
    const pg = new MockPgClient();
    const facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
    const row = (id: string, key: string) => ({
      id, category: 'personal', fact_key: key, fact_value: 'v', confidence: 1,
      mention_count: 1, fact_status: 'active', fact_type: 'permanent',
    });
    pg.willReturn([row('a', 'core_one')]);      // core query
    pg.willReturn([row('b', 'cat_name')]);      // relevance query

    const out = await facts.getUserFacts('user-1', undefined, 30, undefined, 'what is my cat called');
    expect(out.map(f => f.id)).toEqual(['a', 'b']);
  });

  it('does not return the same fact twice when it is in both sets', async () => {
    const pg = new MockPgClient();
    const facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
    const row = { id: 'dup', category: 'personal', fact_key: 'cat_name', fact_value: 'Max',
                  confidence: 1, mention_count: 1, fact_status: 'active', fact_type: 'permanent' };
    pg.willReturn([row]);
    pg.willReturn([row]);

    const out = await facts.getUserFacts('user-1', undefined, 30, undefined, 'cat');
    expect(out).toHaveLength(1);
  });

  it('issues no relevance query when no queryText is given', async () => {
    const pg = new MockPgClient();
    const facts = new FactsService(pg as never, new MockLLMProvider(), null, 'bwmem_', mockLogger);
    pg.willReturn([]);
    await facts.getUserFacts('user-1');
    expect(pg.queries).toHaveLength(1);
  });
});
