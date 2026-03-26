// Re-export provider interfaces from the main types module.
// This file exists so providers can import just the interfaces they need.
export type {
  EmbeddingProvider,
  LLMProvider,
  ChatMessage,
  LLMOptions,
} from '../types.js';
