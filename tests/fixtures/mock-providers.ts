import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions, Logger } from '../../src/types.js';

/**
 * Mock embedding provider that returns deterministic embeddings.
 * Embedding is based on a simple hash of the text, normalized to dimension size.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 4; // Small for tests
  generateCalls: string[] = [];

  async generate(text: string): Promise<number[]> {
    this.generateCalls.push(text);
    return this.hashToVector(text);
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    texts.forEach(t => this.generateCalls.push(t));
    return texts.map(t => this.hashToVector(t));
  }

  private hashToVector(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    // Generate deterministic vector from hash
    return Array.from({ length: this.dimensions }, (_, i) => {
      const val = Math.sin(hash + i * 1000) * 0.5;
      return parseFloat(val.toFixed(4));
    });
  }
}

/**
 * Mock LLM provider that returns configurable responses.
 */
export class MockLLMProvider implements LLMProvider {
  chatCalls: Array<{ messages: ChatMessage[]; options?: LLMOptions }> = [];
  responses: string[] = [];
  defaultResponse = '[]';

  /** Queue a response for the next chat() call. */
  respond(response: string): MockLLMProvider {
    this.responses.push(response);
    return this;
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    this.chatCalls.push({ messages, options });
    return this.responses.shift() ?? this.defaultResponse;
  }

  /** Get the last system prompt sent. */
  get lastSystemPrompt(): string | undefined {
    const lastCall = this.chatCalls[this.chatCalls.length - 1];
    return lastCall?.messages.find(m => m.role === 'system')?.content;
  }

  /** Get the last user message sent. */
  get lastUserMessage(): string | undefined {
    const lastCall = this.chatCalls[this.chatCalls.length - 1];
    return lastCall?.messages.find(m => m.role === 'user')?.content;
  }
}

/**
 * Mock PgClient for unit tests.
 */
export class MockPgClient {
  queries: Array<{ text: string; params?: unknown[] }> = [];
  queryResults: unknown[][] = [];
  queryOneResults: (unknown | null)[] = [];

  /** Queue a result for the next query() call. */
  willReturn(rows: unknown[]): MockPgClient {
    this.queryResults.push(rows);
    return this;
  }

  /** Queue a result for the next queryOne() call. */
  willReturnOne(row: unknown | null): MockPgClient {
    this.queryOneResults.push(row);
    return this;
  }

  async query<T>(_text: string, _params?: unknown[]): Promise<T[]> {
    this.queries.push({ text: _text, params: _params });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async queryOne<T>(_text: string, _params?: unknown[]): Promise<T | null> {
    this.queries.push({ text: _text, params: _params });
    return (this.queryOneResults.shift() ?? null) as T | null;
  }

  async transaction<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
    // For tests, use a mock client that delegates to this
    const mockClient = {
      query: async (text: string, params?: unknown[]) => {
        this.queries.push({ text, params });
        const rows = this.queryResults.shift() ?? [];
        return { rows };
      },
    };
    return callback(mockClient);
  }

  async close(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }

  /** Get the last query text. */
  get lastQuery(): string | undefined {
    return this.queries[this.queries.length - 1]?.text;
  }

  /** Get the last query params. */
  get lastParams(): unknown[] | undefined {
    return this.queries[this.queries.length - 1]?.params;
  }

  reset(): void {
    this.queries = [];
    this.queryResults = [];
    this.queryOneResults = [];
  }
}

/**
 * Mock Redis client for unit tests.
 */
export class MockRedisClient {
  store = new Map<string, string>();

  // Stub .client for BullMQ compatibility
  client = {} as never;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _ttlSeconds?: number): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async healthCheck(): Promise<boolean> { return true; }
  async close(): Promise<void> {}

  reset(): void {
    this.store.clear();
  }
}

/**
 * Silent logger for tests.
 */
export const mockLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
