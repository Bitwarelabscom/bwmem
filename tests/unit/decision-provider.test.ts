import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';
import { TypeSafeProvider } from '../../src/providers/typesafe.js';
import type { DecisionRequest } from '../../src/types.js';

describe('Decision Providers', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('OpenRouterProvider.decide', () => {
    it('calls openrouter alpha decisions endpoint with ~typesafe/jev-latest by default', async () => {
      let requestUrl = '';
      let requestBody: any;
      let requestHeaders: any;

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        requestUrl = url;
        requestBody = JSON.parse(opts.body);
        requestHeaders = opts.headers;
        return {
          ok: true,
          json: async () => ({
            model: '~typesafe/jev-latest',
            answers: {
              urgency: {
                type: 'noul',
                noul: 0.88,
              },
            },
            usage: { input_tokens: 42, output_tokens: 0 },
          }),
        };
      });

      const provider = new OpenRouterProvider({ apiKey: 'test-or-key' });
      const req: DecisionRequest = {
        state: 'My server is on fire!',
        questions: {
          urgency: {
            type: 'noul',
            instructions: 'Is this urgent?',
          },
        },
      };

      const result = await provider.decide(req);

      expect(requestUrl).toBe('https://openrouter.ai/api/alpha/decisions');
      expect(requestBody.model).toBe('~typesafe/jev-latest');
      expect(requestBody.state).toBe('My server is on fire!');
      expect(requestBody.questions.urgency).toBeDefined();
      expect(requestHeaders['Authorization']).toBe('Bearer test-or-key');
      expect(result.answers.urgency).toEqual({ type: 'noul', noul: 0.88 });
      expect(result.usage?.input_tokens).toBe(42);
    });

    it('handles choice questions with probabilities and confidence', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          model: '~typesafe/jev-latest',
          answers: {
            verdict: {
              type: 'choice',
              choice: 'compatible_merge',
              probabilities: { compatible_merge: 0.92, conflicting_answer: 0.05, different_question: 0.03 },
              confidence: 0.92,
            },
          },
        }),
      }));

      const provider = new OpenRouterProvider({ apiKey: 'test-or-key' });
      const result = await provider.decide({
        state: 'Fact comparison',
        questions: {
          verdict: {
            type: 'choice',
            instructions: 'Decision',
            criteria: { compatible_merge: 'same' },
          },
        },
      });

      const verdict = result.answers.verdict;
      expect('choice' in verdict && verdict.choice).toBe('compatible_merge');
    });
  });

  describe('TypeSafeProvider.decide', () => {
    it('calls direct TypeSafe System One API', async () => {
      let requestUrl = '';
      let requestBody: any;
      let requestHeaders: any;

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        requestUrl = url;
        requestBody = JSON.parse(opts.body);
        requestHeaders = opts.headers;
        return {
          ok: true,
          json: async () => ({
            model: 'jev-latest',
            answers: {
              verdict: {
                type: 'choice',
                choice: 'conflicting_answer',
                probabilities: { conflicting_answer: 0.95 },
              },
            },
          }),
        };
      });

      const provider = new TypeSafeProvider({ apiKey: 'ts-key-123' });
      const result = await provider.decide({
        state: 'State text',
        questions: {
          verdict: {
            type: 'choice',
            instructions: 'Check conflict',
            criteria: { conflicting_answer: 'conflict' },
          },
        },
      });

      expect(requestUrl).toBe('https://api.typesafe.ai/v1/systemone');
      expect(requestBody.model).toBe('jev-latest');
      expect(requestHeaders['Authorization']).toBe('Bearer ts-key-123');
      expect('choice' in result.answers.verdict && result.answers.verdict.choice).toBe('conflicting_answer');
    });

    it('throws on non-ok response', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }));

      const provider = new TypeSafeProvider({ apiKey: 'bad-key' });
      await expect(provider.decide({
        state: 'text',
        questions: {},
      })).rejects.toThrow('TypeSafe API failed: 401');
    });
  });
});
