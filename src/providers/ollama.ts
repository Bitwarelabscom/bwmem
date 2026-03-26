import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../types.js';

interface OllamaProviderConfig {
  baseUrl?: string;              // default: 'http://localhost:11434'
  model?: string;                // Chat model, default: 'llama3'
  embeddingModel?: string;       // Embedding model, default: 'nomic-embed-text'
  embeddingDimensions?: number;  // default: 768
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
  readonly dimensions: number;

  constructor(config?: OllamaProviderConfig) {
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.model = config?.model ?? 'llama3';
    this.embeddingModel = config?.embeddingModel ?? 'nomic-embed-text';
    this.dimensions = config?.embeddingDimensions ?? 768;
  }

  async generate(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
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
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { message: { content: string } };
    return data.message.content;
  }
}
