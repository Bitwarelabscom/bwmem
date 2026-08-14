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
    ])('%s -> gather', (q) => {
      expect(classifyRetrieval(q).intent).toBe('gather');
    });

    it('widens depth and loosens the floor', () => {
      const p = classifyRetrieval('How many times did I go to Berlin?');
      expect(p.limit).toBe(200);
      expect(p.threshold).toBe(0.35);
    });
  });

  describe('pinpoint — one specific turn', () => {
    it.each([
      'When did I adopt my dog?',
      'What is my sister called?',
      'Where did I say the keys were?',
      'What did the doctor tell me about my knee?',
      'Which hotel did I book in Lisbon?',
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
