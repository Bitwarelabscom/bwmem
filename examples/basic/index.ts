/**
 * Basic bwmem example - shows the core API flow.
 *
 * Prerequisites:
 *   - PostgreSQL with pgvector: CREATE DATABASE bwmem_example;
 *   - Redis running on localhost:6379
 *   - OpenAI API key
 *
 * Run:
 *   npx tsx examples/basic/index.ts
 */
import { BwMem } from '../../src/index.js';
import { OpenAIProvider } from '../../src/providers/openai.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY environment variable');
  process.exit(1);
}

const provider = new OpenAIProvider({ apiKey: OPENAI_API_KEY });

const mem = new BwMem({
  postgres: process.env.DATABASE_URL || 'postgresql://localhost/bwmem_example',
  redis: process.env.REDIS_URL || 'redis://localhost:6379',
  embeddings: provider,
  llm: provider,
  consolidation: { enabled: false }, // Disable for this demo
});

async function main() {
  console.log('Initializing bwmem...');
  await mem.initialize();
  console.log('Ready!\n');

  // Start a session
  const session = await mem.startSession({ userId: 'demo-user' });
  console.log(`Session started: ${session.id}\n`);

  // Record some messages
  await session.recordMessage({
    role: 'user',
    content: 'My name is Alice and I live in Portland. I work as a software engineer at Acme Corp.',
  });
  console.log('Recorded user message');

  await session.recordMessage({
    role: 'assistant',
    content: 'Nice to meet you, Alice! Portland is a great city. What kind of software do you work on at Acme?',
  });
  console.log('Recorded assistant message');

  await session.recordMessage({
    role: 'user',
    content: 'I mostly work on backend services in Go. I also love hiking on weekends.',
  });
  console.log('Recorded user message\n');

  // Wait a moment for background processing (embeddings, fact extraction)
  console.log('Waiting for background processing...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check extracted facts
  const facts = await mem.facts.get('demo-user');
  console.log(`\nExtracted ${facts.length} facts:`);
  facts.forEach(f => console.log(`  ${f.category}/${f.factKey}: ${f.factValue} (confidence: ${f.confidence})`));

  // Build memory context (what you'd inject into your LLM prompt)
  const context = await mem.buildContext('demo-user', { query: 'What does Alice do?' });
  console.log(`\nMemory context (${context.sourcesResponded} sources responded):`);
  console.log('---');
  console.log(context.formatted || '(no context yet)');
  console.log('---\n');

  // Search similar messages
  const similar = await mem.searchMessages('demo-user', 'programming languages');
  console.log(`Found ${similar.length} similar messages`);

  // Store a manual fact
  await mem.facts.store({
    userId: 'demo-user',
    category: 'preference',
    key: 'favorite_food',
    value: 'sushi',
    confidence: 1.0,
  });
  console.log('\nStored manual fact: favorite_food = sushi');

  // End session
  await session.end();
  console.log('Session ended');

  // Cleanup
  await mem.shutdown();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
