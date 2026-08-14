import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../types.js';
import { assertComplete } from './completion.js';

interface OpenRouterProviderConfig {
  apiKey: string;
  model?: string;               // Chat model, default: 'anthropic/claude-3.5-haiku'
  embeddingModel?: string;      // default: 'qwen/qwen3-embedding-8b'
  embeddingDimensions?: number; // default: 1024
  /**
   * Let the model emit reasoning tokens. Default false, and the default is the
   * important part.
   *
   * OpenRouter fronts a lot of reasoning-first models — most of the free tier is
   * reasoning-first — and reasoning tokens are billed and emitted BEFORE any
   * content while counting against the same `max_tokens`. Every internal caller
   * in this package asks for a small, deliberate budget (30 tokens for an
   * emotion label, 120 for a merge gate, 200 for a quality score). With
   * reasoning on, that budget is consumed thinking and the caller gets an empty
   * string with `finish_reason: 'length'`.
   *
   * None of this package's prompts benefit from reasoning: they are extraction
   * and classification with a fixed output shape. So it is off unless you ask.
   */
  reasoning?: boolean;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/**
 * OpenRouter provider - access to 200+ models through one API.
 * Includes retry logic for transient 429/5xx errors.
 */
export class OpenRouterProvider implements EmbeddingProvider, LLMProvider {
  private apiKey: string;
  private model: string;
  private embeddingModel: string;
  private reasoning: boolean;
  readonly dimensions: number;

  constructor(config: OpenRouterProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'anthropic/claude-3.5-haiku';
    this.embeddingModel = config.embeddingModel ?? 'qwen/qwen3-embedding-8b';
    this.dimensions = config.embeddingDimensions ?? 1024;
    this.reasoning = config.reasoning ?? false;
  }

  async generate(text: string): Promise<number[]> {
    const [result] = await this.generateBatch([text]);
    return result;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    return this.withRetry(async () => {
      const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: texts,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new RetryableError(`OpenRouter embeddings failed: ${response.status} ${text}`, response.status);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      return data.data
        .sort((a, b) => a.index - b.index)
        .map(item => item.embedding);
    });
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    return this.withRetry(async () => {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0.7,
      };

      if (options?.maxTokens) body.max_tokens = options.maxTokens;
      if (options?.json) body.response_format = { type: 'json_object' };

      // Sent unconditionally, including when reasoning is enabled: on a
      // non-reasoning model this is ignored, and on a reasoning one the
      // difference between an explicit flag and an omitted one is the whole bug.
      body.reasoning = { enabled: this.reasoning };

      const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new RetryableError(`OpenRouter chat failed: ${response.status} ${text}`, response.status);
      }

      const data = await response.json() as {
        choices: Array<{
          message: { content: string | null };
          finish_reason?: string | null;
          // OpenRouter normalises `finish_reason` across upstreams but passes
          // the provider's own wording through here. Prefer the normalised one;
          // fall back to native so an unmapped upstream still reports honestly.
          native_finish_reason?: string | null;
        }>;
      };

      const choice = data.choices[0];

      return assertComplete({
        provider: 'OpenRouter',
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? choice?.native_finish_reason,
        maxTokens: options?.maxTokens,
      });
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const status = (err as RetryableError).statusCode;
        // Retry on 429 (rate limit) and 5xx (server errors)
        if (status && (status === 429 || status >= 500) && attempt < MAX_RETRIES - 1) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}

class RetryableError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
