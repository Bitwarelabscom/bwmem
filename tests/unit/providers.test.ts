import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { OllamaProvider } from '../../src/providers/ollama.js';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';

describe('OpenAIProvider', () => {
  it('creates with default config', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    expect(provider.dimensions).toBe(1024);
  });

  it('accepts custom dimensions', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', embeddingDimensions: 512 });
    expect(provider.dimensions).toBe(512);
  });

  it('implements EmbeddingProvider interface', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    expect(typeof provider.generate).toBe('function');
    expect(typeof provider.generateBatch).toBe('function');
    expect(typeof provider.dimensions).toBe('number');
  });

  it('implements LLMProvider interface', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    expect(typeof provider.chat).toBe('function');
  });
});

describe('OllamaProvider', () => {
  it('creates with default config', () => {
    const provider = new OllamaProvider();
    expect(provider.dimensions).toBe(768);
  });

  it('accepts custom config', () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://custom:11434',
      model: 'mistral',
      embeddingModel: 'mxbai-embed-large',
      embeddingDimensions: 1024,
    });
    expect(provider.dimensions).toBe(1024);
  });
});

describe('OpenRouterProvider', () => {
  it('creates with API key', () => {
    const provider = new OpenRouterProvider({ apiKey: 'or-test' });
    expect(provider.dimensions).toBe(1024);
  });

  it('accepts custom models', () => {
    const provider = new OpenRouterProvider({
      apiKey: 'or-test',
      model: 'openai/gpt-4o',
      embeddingModel: 'openai/text-embedding-3-large',
      embeddingDimensions: 3072,
    });
    expect(provider.dimensions).toBe(3072);
  });
});
