/**
 * CLI chatbot example - interactive terminal chatbot with memory.
 *
 * Prerequisites:
 *   - PostgreSQL with pgvector: CREATE DATABASE bwmem_chatbot;
 *   - Redis running on localhost:6379
 *   - At least one provider configured (see env vars below)
 *
 * Env vars:
 *   OPENAI_API_KEY      - Use OpenAI (gpt-4o-mini + text-embedding-3-small)
 *   OPENROUTER_API_KEY  - Use OpenRouter (claude-3.5-haiku)
 *   OLLAMA_BASE_URL     - Use Ollama locally (llama3 + nomic-embed-text)
 *   DATABASE_URL        - PostgreSQL connection (default: postgresql://localhost/bwmem_chatbot)
 *   REDIS_URL           - Redis connection (default: redis://localhost:6379)
 *   USER_ID             - User identifier for memory (default: cli-user)
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/cli-chatbot/index.ts
 */

import { BwMem } from '../../src/index.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { OllamaProvider } from '../../src/providers/ollama.js';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';
import type { ChatMessage, EmbeddingProvider, LLMProvider } from '../../src/types.js';
import type { Session } from '../../src/session/session.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// -- Provider auto-detection --

function createProvider(): { provider: EmbeddingProvider & LLMProvider; name: string } {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
      name: 'OpenAI (gpt-4o-mini)',
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY }),
      name: 'OpenRouter (claude-3.5-haiku)',
    };
  }

  if (process.env.OLLAMA_BASE_URL) {
    return {
      provider: new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL }),
      name: `Ollama (llama3) at ${process.env.OLLAMA_BASE_URL}`,
    };
  }

  console.error(`No provider configured. Set one of:
  OPENAI_API_KEY=sk-...          OpenAI
  OPENROUTER_API_KEY=or-...      OpenRouter
  OLLAMA_BASE_URL=http://...     Ollama (local)`);
  process.exit(1);
}

// -- Setup --

const { provider, name: providerName } = createProvider();

const mem = new BwMem({
  postgres: process.env.DATABASE_URL || 'postgresql://localhost/bwmem_chatbot',
  redis: process.env.REDIS_URL || 'redis://localhost:6379',
  embeddings: provider,
  llm: provider,
  consolidation: { enabled: false },
});

const conversationHistory: ChatMessage[] = [];
const MAX_HISTORY = 20;
let activeSession: Session | null = null;

// -- Commands --

async function showFacts(userId: string): Promise<void> {
  const facts = await mem.facts.get(userId);
  if (facts.length === 0) {
    console.log('\n  No facts stored yet. (Facts are extracted after a few messages.)\n');
    return;
  }
  console.log(`\n  Known facts (${facts.length}):`);
  for (const f of facts) {
    console.log(`    [${f.category}] ${f.factKey}: ${f.factValue} (confidence: ${f.confidence})`);
  }
  console.log('');
}

// -- Cleanup --

async function cleanup(): Promise<void> {
  try {
    if (activeSession) {
      await activeSession.end();
      activeSession = null;
    }
    await mem.shutdown();
  } catch {
    // Swallow errors during cleanup
  }
}

// -- Main --

async function main() {
  await mem.initialize();

  const userId = process.env.USER_ID || 'cli-user';
  activeSession = await mem.startSession({ userId });

  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\nbwmem CLI chatbot`);
  console.log(`Provider: ${providerName}`);
  console.log(`User: ${userId} | Session: ${activeSession.id}`);
  console.log(`Commands: /facts  /quit\n`);

  try {
    while (true) {
      const input = await rl.question('You: ');
      const trimmed = input.trim();

      if (!trimmed) continue;

      if (trimmed.toLowerCase() === '/quit') break;

      if (trimmed.toLowerCase() === '/facts') {
        await showFacts(userId);
        continue;
      }

      // Record user message (kicks off background embedding + fact extraction)
      await activeSession.recordMessage({ role: 'user', content: trimmed });
      conversationHistory.push({ role: 'user', content: trimmed });

      // Build memory context
      const context = await mem.buildContext(userId, {
        query: trimmed,
        sessionId: activeSession.id,
      });

      // Call LLM with system prompt + memory + recent history
      const systemPrompt = [
        'You are a helpful AI assistant. You remember things about the user from previous conversations.',
        context.formatted ? `\n## Memory Context\n${context.formatted}` : '',
        '\nUse the memory context to personalize your responses. Reference things you know about the user naturally.',
      ].join('');

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-MAX_HISTORY),
      ];

      const response = await provider.chat(messages, { temperature: 0.7 });

      // Record assistant response
      await activeSession.recordMessage({ role: 'assistant', content: response });
      conversationHistory.push({ role: 'assistant', content: response });

      console.log(`\nAssistant: ${response}`);
      console.log(`  [memory: ${context.sourcesResponded} sources, ${context.facts.length} facts]\n`);
    }
  } finally {
    rl.close();
  }

  console.log('\nGoodbye!');
  await cleanup();
}

// Graceful shutdown on Ctrl+C
process.on('SIGINT', async () => {
  console.log('\n\nGoodbye!');
  await cleanup();
  process.exit(0);
});

main().catch(async (err) => {
  console.error('Fatal:', err.message || err);
  await cleanup();
  process.exit(1);
});
