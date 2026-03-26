import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../types.js';

interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;            // Chat model, default: 'gpt-4o-mini'
  embeddingModel?: string;   // Embedding model, default: 'text-embedding-3-small'
  embeddingDimensions?: number; // default: 1024
  baseUrl?: string;          // default: 'https://api.openai.com/v1'
}

/**
 * OpenAI provider - implements both EmbeddingProvider and LLMProvider.
 *
 * Usage:
 *   const provider = new OpenAIProvider({ apiKey: 'sk-...' })
 *   const mem = new BwMem({ embeddings: provider, llm: provider, ... })
 */
export class OpenAIProvider implements EmbeddingProvider, LLMProvider {
  private apiKey: string;
  private model: string;
  private embeddingModel: string;
  private baseUrl: string;
  readonly dimensions: number;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o-mini';
    this.embeddingModel = config.embeddingModel ?? 'text-embedding-3-small';
    this.dimensions = config.embeddingDimensions ?? 1024;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async generate(text: string): Promise<number[]> {
    const [result] = await this.generateBatch([text]);
    return result;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
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
      const errText = await response.text();
      throw new Error(`OpenAI embeddings failed: ${response.status} ${errText}`);
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI chat failed: ${response.status} ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? '';
  }
}
