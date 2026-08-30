import { describe, it, expect } from 'vitest';
import { classifyRetrieval } from '../../src/memory/retrieval-profile.js';

describe('classifyRetrieval', () => {
  describe('gather — evidence spread across sessions', () => {
    it.each([
      ['How many times did I mention wanting to move?', 'aggregation'],
      ['How often do I go running?', 'aggregation'],
      ['What is the total I have spent on the car?', 'aggregation'],
      ['List all the books I said I wanted to read', 'enumeration'],
      ['Which ones did I end up buying?', 'enumeration'],
      ['Compare what I said about the two job offers', 'comparison'],
      ['Am I still working at the same place?', 'knowledge-update'],
      ['Do I go to the gym anymore?', 'knowledge-update'],
      ['Where do I live now that things changed?', 'knowledge-update'],
      ['How many occasions did I travel for work?', 'recurrence'],
      ['What do I usually do on weekends?', 'pattern'],
      ['How many plants did I acquire in the last month?', 'aggregation'],
      ['How many total pieces of writing have I completed since I started writing again?', 'aggregation'],
      ['How much total money did I spend on attending workshops in the last four months?', 'aggregation'],
      ['How many graduation ceremonies have I attended in the past three months?', 'aggregation'],
      ['How many rare items do I have in total?', 'aggregation'],
    ])('%s -> gather', (q) => {
      expect(classifyRetrieval(q).intent).toBe('gather');
    });

    it('widens depth, loosens floor, and enables session diversification and windowing', () => {
      const p = classifyRetrieval('How many times did I go to Berlin?');
      expect(p.limit).toBe(200);
      expect(p.threshold).toBe(0.35);
      expect(p.sessionDiversify).toBe(true);
      expect(p.windowTurns).toBe(1);
    });
  });

  describe('pinpoint — one specific turn', () => {
    it.each([
      'When did I adopt my dog?',
      'What is my sister called?',
      'Where did I say the keys were?',
      'What did the doctor tell me about my knee?',
      'Which hotel did I book in Lisbon?',
      'How many days ago did I attend a networking event?',
      'How many weeks have I been taking sculpting classes?',
      'How long did Alex marinate the BBQ ribs in special sauce?',
      'Who graduated first, second and third among Emma, Rachel and Alex?',
    ])('%s -> pinpoint', (q) => {
      expect(classifyRetrieval(q).intent).toBe('pinpoint');
    });

    it('keeps the tight benchmarked defaults', () => {
      const p = classifyRetrieval('When did I adopt my dog?');
      expect(p.limit).toBe(25);
      expect(p.threshold).toBe(0.5);
    });
  });

  it('defaults to pinpoint, because widening is the expensive direction', () => {
    // ~10x the context and the token bill with it, so it has to be asked for by
    // something in the question rather than assumed.
    const p = classifyRetrieval('asdf qwer zxcv');
    expect(p.intent).toBe('pinpoint');
    expect(p.reason).toBe('default');
  });

  it('reports which rule fired', () => {
    // A surprising context should be explainable without a debugger.
    expect(classifyRetrieval('How many times did I call?').reason).toBe('aggregation');
    expect(classifyRetrieval('Do I still smoke?').reason).toBe('knowledge-update');
  });

  it('does not fire on substrings inside other words', () => {
    // \b anchors matter: "allergy" contains "all", "counting" contains "count".
    expect(classifyRetrieval('What is my allergy?').intent).toBe('pinpoint');
    expect(classifyRetrieval('What is my nowhere plan?').intent).toBe('pinpoint');
  });
});
