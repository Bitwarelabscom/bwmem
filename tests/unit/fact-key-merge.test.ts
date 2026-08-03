// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { rankMergeCandidates, type MergeCandidate } from '../../src/memory/fact-key-merge.service.js';
import {
  isSetValuedFactKey, isMergeableFactKey, splitSetValue, mergeSetValue,
} from '../../src/memory/facts.service.js';

const never = () => false;

function candidate(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    id: 'c1', category: 'personal', factKey: 'other_key', factValue: 'v',
    similarity: 0.9, exactValue: false, ...over,
  };
}

describe('rankMergeCandidates', () => {
  it('ranks an exact value match above a higher-cosine one', () => {
    // An identical value under a different key is the strongest same-claim
    // evidence available without asking the gate — and the only signal that
    // survives an embedder outage.
    const ranked = rankMergeCandidates('incoming', [
      candidate({ id: 'cosine', similarity: 0.99, exactValue: false }),
      candidate({ id: 'exact', similarity: 1, exactValue: true }),
    ], { excludeKey: never });

    expect(ranked[0].id).toBe('exact');
  });

  it('never proposes the incoming key as its own merge target', () => {
    const ranked = rankMergeCandidates('same_key', [
      candidate({ id: 'self', factKey: 'same_key', similarity: 1, exactValue: true }),
    ], { excludeKey: never });

    expect(ranked).toHaveLength(0);
  });

  it('drops excluded keys even on an exact value match', () => {
    // Volatile and set-valued keys are expected to hold changing or coexisting
    // values, so an identical value there is coincidence, not the same claim.
    const ranked = rankMergeCandidates('incoming', [
      candidate({ id: 'volatile', factKey: 'work_schedule', similarity: 1, exactValue: true }),
    ], { excludeKey: (k) => k === 'work_schedule' });

    expect(ranked).toHaveLength(0);
  });

  it('applies the cosine floor only to non-exact candidates', () => {
    const ranked = rankMergeCandidates('incoming', [
      candidate({ id: 'weak', similarity: 0.3, exactValue: false }),
      candidate({ id: 'exactweak', similarity: 0, exactValue: true }),
    ], { excludeKey: never });

    expect(ranked.map((r) => r.id)).toEqual(['exactweak']);
  });

  it('caps how many candidates reach the gate', () => {
    // Each survivor costs an LLM call on a live write path.
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ id: `c${i}`, factKey: `k${i}`, similarity: 0.9 - i * 0.01 }));

    expect(rankMergeCandidates('incoming', many, { excludeKey: never })).toHaveLength(3);
  });

  it('deduplicates by row id', () => {
    const ranked = rankMergeCandidates('incoming', [
      candidate({ id: 'dupe', similarity: 0.9 }),
      candidate({ id: 'dupe', similarity: 0.8 }),
    ], { excludeKey: never });

    expect(ranked).toHaveLength(1);
  });
});

describe('fact key guards', () => {
  it('treats set-valued keys as non-mergeable', () => {
    // "allergies: peanuts" and "allergies: shellfish" are both true at once.
    expect(isSetValuedFactKey('allergies')).toBe(true);
    expect(isMergeableFactKey('allergies')).toBe(false);
  });

  it('treats volatile keys as non-mergeable', () => {
    expect(isMergeableFactKey('work_schedule')).toBe(false);
  });

  it('allows an ordinary stable key', () => {
    expect(isMergeableFactKey('partner_name')).toBe(true);
  });

  it('splits set values on separators', () => {
    expect(splitSetValue('peanuts; shellfish, dairy')).toEqual(['peanuts', 'shellfish', 'dairy']);
  });

  it('adds a new set member without duplicating case-variants', () => {
    expect(mergeSetValue('peanuts; shellfish', 'Dairy')).toBe('peanuts; shellfish; Dairy');
    expect(mergeSetValue('peanuts; shellfish', 'PEANUTS')).toBeNull();
  });
});
