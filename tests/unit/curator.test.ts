import { describe, it, expect } from 'vitest';
import {
  scoreMessageComplexity,
  MemoryCurationService,
  type MemoryCandidates,
} from '../../src/memory/memory-curation.service.js';
import { CuratorRejectionService } from '../../src/memory/curator-rejection.service.js';
import type { DecisionProvider, DecisionRequest, DecisionResponse, LLMProvider, Fact, SimilarMessage } from '../../src/types.js';
import { mockLogger } from '../fixtures/mock-providers.js';

describe('scoreMessageComplexity', () => {
  it('marks empty or trivial messages as trivial', () => {
    expect(scoreMessageComplexity('').isTrivial).toBe(true);
    expect(scoreMessageComplexity('ok').isTrivial).toBe(true);
    expect(scoreMessageComplexity('thanks').isTrivial).toBe(true);
  });

  it('scores higher for questions, emotional words, and deep topics', () => {
    const complex = scoreMessageComplexity(
      'I am feeling very worried about my new project design and need advice. Can you explain the strategy?',
    );
    expect(complex.isTrivial).toBe(false);
    expect(complex.score).toBeGreaterThanOrEqual(0.6);
  });
});

describe('MemoryCurationService', () => {
  const dummyFact: Fact = {
    id: 'f1',
    userId: 'u1',
    category: 'preference',
    factKey: 'coffee',
    factValue: 'Drinks espresso without sugar',
    factType: 'static',
    validFrom: new Date(),
    validUntil: null,
    txnFrom: new Date(),
    txnUntil: null,
    status: 'active',
    supersededBy: null,
    sourceMessageId: null,
    confidence: 1.0,
    mentionCount: 3,
    lastMentioned: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const dummyFact2: Fact = {
    id: 'f2',
    userId: 'u1',
    category: 'hardware',
    factKey: 'keyboard',
    factValue: 'Uses mechanical keyboard with brown switches',
    factType: 'static',
    validFrom: new Date(),
    validUntil: null,
    txnFrom: new Date(),
    txnUntil: null,
    status: 'active',
    supersededBy: null,
    sourceMessageId: null,
    confidence: 1.0,
    mentionCount: 1,
    lastMentioned: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const dummyMsg: SimilarMessage = {
    id: 'm1',
    sessionId: 's1',
    role: 'user',
    content: 'Do you remember what coffee I like?',
    similarity: 0.85,
    createdAt: new Date(),
  };

  const candidates: MemoryCandidates = {
    facts: [dummyFact, dummyFact2],
    similarMessages: [dummyMsg],
    similarConversations: [],
  };

  it('returns empty storage curator ring when candidates are empty', async () => {
    const dummyLlm: LLMProvider = { chat: async () => '' };
    const curator = new MemoryCurationService(dummyLlm, undefined, undefined, mockLogger);
    const res = await curator.curateMemory({
      message: 'Hello',
      candidates: { facts: [], similarMessages: [], similarConversations: [] },
    });

    expect(res.curatorRing).toBe('[Curator: 0 evaluated — storage returned no candidate memories]');
    expect(res.facts.length).toBe(0);
  });

  it('curates with DecisionProvider and generates token-0 curator ring', async () => {
    const dummyLlm: LLMProvider = { chat: async () => '' };
    const rejection = new CuratorRejectionService(null, 'test_', mockLogger);

    const decisionProvider: DecisionProvider = {
      decide: async (req: DecisionRequest): Promise<DecisionResponse> => {
        // F0 is relevant (coffee), F1 is irrelevant (keyboard), M0 is relevant (coffee message)
        const answers: any = {};
        for (const key of Object.keys(req.questions)) {
          if (key === 'F0') answers[key] = { type: 'noul', noul: 0.85 };
          else if (key === 'F1') answers[key] = { type: 'noul', noul: 0.05 };
          else if (key === 'M0') answers[key] = { type: 'noul', noul: 0.75 };
        }
        return { answers };
      },
    };

    const curator = new MemoryCurationService(dummyLlm, decisionProvider, rejection, mockLogger);
    const res = await curator.curateMemory({
      message: 'I want some coffee',
      candidates,
      sessionId: 'test-session',
    });

    expect(res.skipped).toBe(false);
    expect(res.facts.length).toBe(1);
    expect(res.facts[0].factKey).toBe('coffee');
    expect(res.similarMessages.length).toBe(1);
    expect(res.curatorRing).toBe('[Curator: 3 evaluated, 2 kept, 1 dropped]');

    // Check that dropped fact (keyboard) went into rejection ledger
    const dropped = await rejection.getDroppedMemories('test-session');
    expect(dropped.length).toBe(1);
    expect(dropped[0].key).toBe('hardware/keyboard');
    expect(dropped[0].score).toBe(0.05);
  });

  it('reports all dropped when all candidates score below threshold', async () => {
    const dummyLlm: LLMProvider = { chat: async () => '' };
    const decisionProvider: DecisionProvider = {
      decide: async (req: DecisionRequest): Promise<DecisionResponse> => {
        const answers: any = {};
        for (const key of Object.keys(req.questions)) {
          answers[key] = { type: 'noul', noul: 0.02 }; // all below 0.45/0.50
        }
        return { answers };
      },
    };

    const curator = new MemoryCurationService(dummyLlm, decisionProvider, undefined, mockLogger);
    const res = await curator.curateMemory({
      message: 'Completely unrelated question about Mars rover',
      candidates,
    });

    expect(res.facts.length).toBe(0);
    expect(res.similarMessages.length).toBe(0);
    expect(res.curatorRing).toBe(
      '[Curator: 3 evaluated, 0 kept, 3 dropped — all candidates scored below relevance threshold]',
    );
  });
});
