import { describe, it, expect } from 'vitest';
import { FactMergeGate } from '../../src/memory/fact-merge-gate.service.js';
import type { DecisionProvider, DecisionRequest, DecisionResponse, LLMProvider } from '../../src/types.js';
import { mockLogger } from '../fixtures/mock-providers.js';

describe('FactMergeGate with DecisionProvider (TypeSafe System One)', () => {
  const dummyLlm: LLMProvider = {
    chat: async () => JSON.stringify({ compatible: true, reason: 'llm fallback' }),
  };

  it('uses decision provider fast path for compatible merge', async () => {
    const decisionProvider: DecisionProvider = {
      decide: async (_req: DecisionRequest): Promise<DecisionResponse> => ({
        model: '~typesafe/jev-latest',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'compatible_merge',
            probabilities: { compatible_merge: 0.94 },
          },
        },
      }),
    };

    const gate = new FactMergeGate(dummyLlm, mockLogger, 5000, decisionProvider);
    const res = await gate.checkDetailed(
      { key: 'hobby', value: 'loves playing acoustic guitar' },
      { key: 'hobby', value: 'plays acoustic guitar' },
    );

    expect(res.outcome).toBe('ok');
    expect(res.verdict?.compatible).toBe(true);
    expect(res.verdict?.reason).toContain('94%');
    expect(res.verdict?.separation).toBeNull();
  });

  it('identifies conflicting_answer separation through decision model', async () => {
    const decisionProvider: DecisionProvider = {
      decide: async (_req: DecisionRequest): Promise<DecisionResponse> => ({
        model: '~typesafe/jev-latest',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'conflicting_answer',
            probabilities: { conflicting_answer: 0.91 },
          },
        },
      }),
    };

    const gate = new FactMergeGate(dummyLlm, mockLogger, 5000, decisionProvider);
    const res = await gate.checkDetailed(
      { key: 'esp32_power', value: 'balcony ESP32 on battery' },
      { key: 'esp32_power', value: 'balcony ESP32 on USB power' },
    );

    expect(res.outcome).toBe('ok');
    expect(res.verdict?.compatible).toBe(false);
    expect(res.verdict?.separation).toBe('conflicting_answer');
  });

  it('identifies different_question separation through decision model', async () => {
    const decisionProvider: DecisionProvider = {
      decide: async (_req: DecisionRequest): Promise<DecisionResponse> => ({
        model: '~typesafe/jev-latest',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'different_question',
            probabilities: { different_question: 0.89 },
          },
        },
      }),
    };

    const gate = new FactMergeGate(dummyLlm, mockLogger, 5000, decisionProvider);
    const res = await gate.checkDetailed(
      { key: 'company_name', value: 'BitwareLabs' },
      { key: 'job_role', value: 'member of the dev team at BitwareLabs' },
    );

    expect(res.outcome).toBe('ok');
    expect(res.verdict?.compatible).toBe(false);
    expect(res.verdict?.separation).toBe('different_question');
  });

  it('falls back to LLM completion when decision provider throws', async () => {
    let llmCalled = false;
    const fallbackLlm: LLMProvider = {
      chat: async () => {
        llmCalled = true;
        return JSON.stringify({ compatible: true, reason: 'llm was consulted' });
      },
    };

    const failingDecisionProvider: DecisionProvider = {
      decide: async () => {
        throw new Error('Connection refused');
      },
    };

    const gate = new FactMergeGate(fallbackLlm, mockLogger, 5000, failingDecisionProvider);
    const res = await gate.checkDetailed(
      { key: 'food', value: 'pizza' },
      { key: 'food', value: 'pizza' },
    );

    expect(llmCalled).toBe(true);
    expect(res.outcome).toBe('ok');
    expect(res.verdict?.compatible).toBe(true);
    expect(res.verdict?.reason).toBe('llm was consulted');
  });
});
