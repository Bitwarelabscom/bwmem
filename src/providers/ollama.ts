import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../types.js';
import { assertComplete } from './completion.js';

interface OllamaProviderConfig {
  baseUrl?: string;              // default: 'http://localhost:11434'
  model?: string;                // Chat model, default: 'llama3'
  embeddingModel?: string;       // Embedding model, default: 'nomic-embed-text'
  embeddingDimensions?: number;  // default: 768
  /**
   * Ollama's `think` flag, for thinking models (deepseek-r1, qwen3, ...). Set
   * false on those to stop thinking tokens eating a small `num_predict` budget,
   * which is the same failure the OpenRouter provider disables reasoning to
   * avoid.
   *
   * Unlike OpenRouter's, this is only sent when you set it explicitly. Ollama
   * rejects the field outright on models that do not support thinking, so a
   * helpful default here would break every plain llama3 setup.
   */
  think?: boolean;
}

/**
 * Ollama provider - local, free, no API key needed.
 *
 * Usage:
 *   const provider = new OllamaProvider()
 *   const mem = new BwMem({ embeddings: provider, llm: provider, ... })
 */
export class OllamaProvider implements EmbeddingProvider, LLMProvider {
  private baseUrl: string;
  private model: string;
  private embeddingModel: string;
  private think: boolean | undefined;
  readonly dimensions: number;

  constructor(config?: OllamaProviderConfig) {
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.model = config?.model ?? 'llama3';
    this.embeddingModel = config?.embeddingModel ?? 'nomic-embed-text';
    this.dimensions = config?.embeddingDimensions ?? 768;
    this.think = config?.think;
  }

  async generate(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embeddingModel, input: text, keep_alive: '30m' }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    // Ollama supports batch via input array
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embeddingModel, input: texts, keep_alive: '30m' }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed batch failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      keep_alive: '30m',
      options: {
        temperature: options?.temperature ?? 0.7,
      },
    };

    if (options?.maxTokens) {
      (body.options as Record<string, unknown>).num_predict = options.maxTokens;
    }

    if (options?.json) {
      body.format = 'json';
    }

    if (this.think !== undefined) {
      body.think = this.think;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
    }

    // Ollama reports truncation as done_reason='length' — it hit num_predict.
    const data = await response.json() as {
      message: { content: string | null };
      done_reason?: string | null;
    };

    return assertComplete({
      provider: 'Ollama',
      content: data.message?.content ?? '',
      finishReason: data.done_reason,
      maxTokens: options?.maxTokens,
    });
  }
}
