import { describe, it, expect } from 'vitest';
import { fuseByRank } from '../../src/memory/rank-fusion.js';

const m = (id: string) => ({ messageId: id });

describe('fuseByRank', () => {
  it('ranks a row found by both arms above one found by a single arm', () => {
    // The entire point of fusion: agreement across independent signals is
    // stronger evidence than one arm's confidence.
    const vector = [m('a'), m('b'), m('c')];
    const keyword = [m('c'), m('d'), m('e')];
    const out = fuseByRank([{ items: vector }, { items: keyword }], 5);
    expect(out[0].messageId).toBe('c');
  });

  it('deduplicates — the same message from two arms is one row', () => {
    const out = fuseByRank([{ items: [m('a'), m('b')] }, { items: [m('a')] }], 10);
    expect(out.map(x => x.messageId)).toEqual(['a', 'b']);
  });

  it('keeps the first arm\'s copy of a shared row', () => {
    // Arms disagree about derived fields: the vector arm carries a real
    // similarity, the keyword arm reports 0. Taking whichever came last would
    // make the reported score depend on iteration order.
    const vector = [{ messageId: 'a', similarity: 0.82 }];
    const keyword = [{ messageId: 'a', similarity: 0 }];
    const out = fuseByRank([{ items: vector }, { items: keyword }], 5);
    expect(out[0].similarity).toBe(0.82);
  });

  it('uses rank, not score — an arm with no scores still contributes', () => {
    // ts_rank has no fixed range, so the keyword arm reports no comparable
    // score at all. Fusion must work from order alone.
    const keyword = [m('x'), m('y')];
    const out = fuseByRank([{ items: [] }, { items: keyword }], 5);
    expect(out.map(x => x.messageId)).toEqual(['x', 'y']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => m(`m${i}`));
    expect(fuseByRank([{ items: many }], 10)).toHaveLength(10);
  });

  it('returns the sole arm unchanged when the other is empty', () => {
    // The degraded path: keyword search failed, recall must still work.
    const vector = [m('a'), m('b'), m('c')];
    const out = fuseByRank([{ items: vector }, { items: [] }], 10);
    expect(out.map(x => x.messageId)).toEqual(['a', 'b', 'c']);
  });

  it('handles both arms empty', () => {
    expect(fuseByRank([{ items: [] }, { items: [] }], 10)).toEqual([]);
  });

  it('weights an arm when asked', () => {
    // Equal ranks, so only the weight can decide.
    const out = fuseByRank(
      [{ items: [m('a')], weight: 1 }, { items: [m('b')], weight: 5 }], 5);
    expect(out[0].messageId).toBe('b');
  });
});
