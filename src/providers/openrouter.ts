import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../types.js';

interface OpenRouterProviderConfig {
  apiKey: string;
  model?: string;               // Chat model, default: 'anthropic/claude-3.5-haiku'
  embeddingModel?: string;      // default: 'qwen/qwen3-embedding-8b'
  embeddingDimensions?: number; // default: 1024
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter provider - access to 200+ models through one API.
 *
 * Usage:
 *   const provider = new OpenRouterProvider({ apiKey: '...' })
 *   const mem = new BwMem({ embeddings: provider, llm: provider, ... })
 */
export class OpenRouterProvider implements EmbeddingProvider, LLMProvider {
  private apiKey: string;
  private model: string;
  private embeddingModel: string;
  readonly dimensions: number;

  constructor(config: OpenRouterProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'anthropic/claude-3.5-haiku';
    this.embeddingModel = config.embeddingModel ?? 'qwen/qwen3-embedding-8b';
    this.dimensions = config.embeddingDimensions ?? 1024;
  }

  async generate(text: string): Promise<number[]> {
    const [result] = await this.generateBatch([text]);
    return result;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
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
      throw new Error(`OpenRouter embeddings failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
    };

    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if (options?.json) body.response_format = { type: 'json_object' };

    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter chat failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? '';
  }
}
