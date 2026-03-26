# @bitwarelabs/bwmem

Memory SDK for AI chatbots. Gives your bot persistent, per-user memory: facts, semantic search, emotional capture, contradiction detection, and multi-stage consolidation.

Drop it into any chatbot — record messages, build context, inject into your LLM prompt. The SDK handles fact extraction, embeddings, sentiment analysis, and long-term memory consolidation in the background.

## Features

- **Fact extraction** — automatically extracts structured facts from conversations (name, job, preferences, etc.)
- **Semantic search** — find similar messages and conversations via pgvector embeddings
- **Emotional capture** — detects high-emotion moments using VAD (Valence-Arousal-Dominance) analysis
- **Contradiction detection** — catches when a user corrects or contradicts previously stored facts
- **Memory consolidation** — episodic (per-session), daily, and weekly consolidation pipelines
- **Conversation summaries** — auto-generated summaries with topic extraction
- **Context builder** — aggregates 9 memory sources into a single formatted prompt injection
- **Provider-agnostic** — works with OpenAI, Ollama, OpenRouter, or any custom provider
- **Optional knowledge graph** — Neo4j integration for entity relationships

## Requirements

- Node.js >= 18
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension
- Redis

## Install

```bash
npm install @bitwarelabs/bwmem
```

## Quick Start

```typescript
import { BwMem } from '@bitwarelabs/bwmem';
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

const mem = new BwMem({
  postgres: 'postgresql://localhost/myapp',
  redis: 'redis://localhost:6379',
  embeddings: provider,
  llm: provider,
});

await mem.initialize();

// Start a conversation
const session = await mem.startSession({ userId: 'user-123' });

// Record messages (fact extraction + embeddings run in background)
await session.recordMessage({ role: 'user', content: 'I live in Tokyo and work at SakuraTech.' });
await session.recordMessage({ role: 'assistant', content: 'Nice! What do you do there?' });
await session.recordMessage({ role: 'user', content: 'I lead the ML perception team.' });

// Build memory context for your LLM prompt
const context = await mem.buildContext('user-123', { query: 'Tell me about yourself' });

const response = await provider.chat([
  { role: 'system', content: `You are helpful.\n\n${context.formatted}` },
  { role: 'user', content: 'What do you know about me?' },
]);

// End session (triggers episodic consolidation)
await session.end();
await mem.shutdown();
```

## Providers

All three bundled providers implement both `EmbeddingProvider` and `LLMProvider`, so a single instance handles both.

### OpenAI

```typescript
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';

const provider = new OpenAIProvider({
  apiKey: 'sk-...',           // required
  model: 'gpt-4o-mini',      // default
  embeddingModel: 'text-embedding-3-small', // default
  embeddingDimensions: 1024,  // default
  baseUrl: 'https://api.openai.com/v1', // default
});
```

### Ollama (local, free)

```typescript
import { OllamaProvider } from '@bitwarelabs/bwmem/providers/ollama';

const provider = new OllamaProvider({
  baseUrl: 'http://localhost:11434', // default
  model: 'llama3',                   // default
  embeddingModel: 'nomic-embed-text', // default
  embeddingDimensions: 768,          // default
});
```

### OpenRouter (200+ models)

```typescript
import { OpenRouterProvider } from '@bitwarelabs/bwmem/providers/openrouter';

const provider = new OpenRouterProvider({
  apiKey: 'sk-or-...',                    // required
  model: 'anthropic/claude-3.5-haiku',    // default
  embeddingModel: 'qwen/qwen3-embedding-8b', // default
  embeddingDimensions: 1024,             // default
});
```

### Custom provider

Implement the interfaces directly:

```typescript
import type { EmbeddingProvider, LLMProvider } from '@bitwarelabs/bwmem';

const myProvider: EmbeddingProvider & LLMProvider = {
  dimensions: 1024,
  async generate(text) { /* return number[] */ },
  async generateBatch(texts) { /* return number[][] */ },
  async chat(messages, options?) { /* return string */ },
};
```

## API Reference

### `BwMem`

#### `new BwMem(config)`

```typescript
const mem = new BwMem({
  postgres: 'postgresql://localhost/mydb',  // or PostgresConfig object
  redis: 'redis://localhost:6379',          // or RedisConfig object
  embeddings: provider,                     // EmbeddingProvider (required)
  llm: provider,                            // LLMProvider (required)
  graph: neo4jGraph,                        // GraphPlugin (optional)
  consolidation: {
    enabled: true,                          // default: true
    daily: '0 2 * * *',                    // default: 2 AM daily
    weekly: '0 3 * * 0',                   // default: 3 AM Sundays
  },
  session: {
    inactivityTimeoutMs: 300_000,           // default: 5 minutes
  },
  tablePrefix: 'bwmem_',                   // default
  logger: console,                          // default: built-in console logger
});
```

#### `mem.initialize()`

Connects to PostgreSQL and Redis, runs migrations (creates tables + pgvector extension), starts the consolidation scheduler if enabled.

#### `mem.startSession(config): Promise<Session>`

```typescript
const session = await mem.startSession({
  userId: 'user-123',
  metadata: { source: 'web' },  // optional
});
```

#### `mem.buildContext(userId, options?): Promise<MemoryContext>`

Aggregates memory from 9 sources in parallel with timeout protection:

```typescript
const context = await mem.buildContext('user-123', {
  query: 'What does the user do for work?', // for semantic search
  sessionId: session.id,                     // exclude current session from similar messages
  maxFacts: 30,                              // default
  maxSimilarMessages: 5,                     // default
  similarityThreshold: 0.7,                  // default
  timeoutMs: 5000,                           // default
});

// context.formatted — ready to inject into your system prompt
// context.facts — array of Fact objects
// context.sourcesResponded — e.g. "9/9"
```

**Sources:** facts, similar messages, similar conversations, emotional moments, contradictions, behavioral observations, episodic patterns, semantic knowledge, graph context.

#### `mem.facts`

Direct access to the facts API:

```typescript
// Get all active facts for a user
const facts = await mem.facts.get('user-123');

// Store a fact manually
await mem.facts.store({
  userId: 'user-123',
  category: 'preference',
  key: 'editor',
  value: 'VS Code',
  confidence: 1.0,
});

// Search facts semantically
const results = await mem.facts.search('user-123', 'programming tools');

// Remove a fact
await mem.facts.remove(factId);
```

**Fact categories:** `personal`, `work`, `preference`, `hobby`, `relationship`, `goal`, `context`

#### `mem.searchMessages(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchMessages('user-123', 'machine learning', 5, 0.3);
// Returns SimilarMessage[] with { messageId, sessionId, content, role, similarity, createdAt }
```

#### `mem.searchConversations(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchConversations('user-123', 'work discussion', 3, 0.3);
// Returns SimilarConversation[] with { sessionId, summary, topics, similarity, createdAt }
```

#### `mem.triggerConsolidation(type)`

Trigger daily or weekly consolidation on demand (requires `consolidation.enabled: true`):

```typescript
await mem.triggerConsolidation('daily');
await mem.triggerConsolidation('weekly');
```

#### `mem.shutdown()`

Closes all connections and stops the consolidation scheduler.

### `Session`

#### `session.recordMessage(input): Promise<Message>`

Records a message and triggers background processing:

```typescript
const msg = await session.recordMessage({
  role: 'user',  // 'user' | 'assistant' | 'system'
  content: 'I just moved to Berlin.',
});
```

**Background processing** (fire-and-forget):
- Embedding generation + storage
- Sentiment analysis (VAD model)
- Fact extraction (every 3 user messages)
- Contradiction checking against stored facts
- Emotional moment capture (high valence/arousal)
- Session centroid update

#### `session.flush(): Promise<void>`

Wait for all pending background processing to complete. Useful in tests or when you need search results immediately after recording messages.

```typescript
await session.recordMessage({ role: 'user', content: '...' });
await session.flush(); // all embeddings and facts now stored
const results = await mem.searchMessages(userId, '...');
```

#### `session.end(): Promise<void>`

Ends the session and triggers episodic consolidation (pattern extraction + conversation summary).

#### `session.getMessages(): Promise<Message[]>`

Returns all messages in the session with sentiment data.

## Consolidation

Three-stage memory consolidation pipeline:

### Episodic (on session end)

When `session.end()` is called, the SDK:
1. Builds a transcript from the session's messages
2. Sends it to the LLM to extract patterns (themes, mood shifts, key moments, preference signals)
3. Stores patterns in `episodic_patterns` table
4. Generates a conversation summary with embedding

### Daily (cron or manual)

Runs at 2 AM by default or via `mem.triggerConsolidation('daily')`:
1. Gets recent episodic patterns (last 24h)
2. LLM aggregates them into semantic knowledge (preferences, known facts, behavioral baselines)
3. Merges with existing semantic knowledge
4. Expires old behavioral observations

### Weekly (cron or manual)

Runs at 3 AM Sundays by default or via `mem.triggerConsolidation('weekly')`:
1. Reviews all semantic knowledge for consistency
2. Cross-references with stored facts
3. Prunes outdated or low-confidence entries
4. Syncs to knowledge graph (if enabled)

## Knowledge Graph (optional)

```typescript
import { Neo4jGraph } from '@bitwarelabs/bwmem/graph';

const graph = new Neo4jGraph({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});

const mem = new BwMem({
  // ...
  graph,
});
```

Automatically syncs facts and entities to Neo4j during consolidation.

## Database

The SDK auto-creates all tables on `initialize()` via migrations. Tables are prefixed with `bwmem_` by default (configurable via `tablePrefix`).

**Core tables:**
| Table | Purpose |
|---|---|
| `sessions` | Session tracking with active/ended state |
| `messages` | Messages with pgvector embeddings and VAD sentiment |
| `facts` | Structured facts with lifecycle (active/superseded/expired) |
| `conversation_summaries` | Auto-generated session summaries with embeddings |

**Resonant memory:**
| Table | Purpose |
|---|---|
| `emotional_moments` | High-emotion messages (valence > 0.5 or arousal > 0.6) |
| `contradiction_signals` | Conflicts between user statements and stored facts |
| `behavioral_observations` | Behavioral pattern observations |

**Consolidation:**
| Table | Purpose |
|---|---|
| `consolidation_runs` | Audit log of all consolidation jobs |
| `episodic_patterns` | Patterns extracted per session (themes, key moments) |
| `semantic_knowledge` | Long-term aggregated knowledge from daily consolidation |

## Examples

### CLI Chatbot

Interactive terminal chatbot with memory. Auto-detects provider from environment variables.

```bash
# With OpenAI
OPENAI_API_KEY=sk-... npx tsx examples/cli-chatbot/index.ts

# With Ollama (local)
OLLAMA_BASE_URL=http://localhost:11434 npx tsx examples/cli-chatbot/index.ts

# With OpenRouter
OPENROUTER_API_KEY=sk-or-... npx tsx examples/cli-chatbot/index.ts
```

Commands: `/facts` to show extracted facts, `/quit` to exit.

### HTTP Chatbot

Multi-user HTTP chatbot with session management.

```bash
OPENAI_API_KEY=sk-... npx tsx examples/express-chatbot/index.ts

# Send a message
curl -X POST http://localhost:3030/chat \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","message":"My name is Alice and I love hiking"}'

# Get facts
curl http://localhost:3030/facts/demo
```

### Basic Usage

Shows the core API flow: init, session, messages, facts, context, search.

```bash
OPENAI_API_KEY=sk-... npx tsx examples/basic/index.ts
```

## Testing

```bash
# Unit tests (no external services needed)
npm test

# Install test — spins up Postgres + Redis via Docker, installs from tarball, verifies all exports
./scripts/install-test.sh path/to/bitwarelabs-bwmem-*.tgz

# Real LLM integration test (33 assertions with OpenRouter)
./scripts/test-real-llm.sh path/to/tarball your-openrouter-key

# 50-message consolidation test (3 sessions, episodic + daily consolidation)
./scripts/test-consolidation.sh path/to/tarball your-openrouter-key
```

## Architecture

```
User Message
    │
    ▼
Session.recordMessage()
    │
    ├──▶ Store message in PostgreSQL
    │
    └──▶ Background processing (fire-and-forget)
           ├── Generate embedding → store with pgvector
           ├── Sentiment analysis (VAD) → store scores
           ├── Fact extraction (every 3 msgs) → store/update facts
           ├── Contradiction check → flag conflicts
           ├── Emotional moment capture → store if high emotion
           └── Update session centroid

Session.end()
    │
    └──▶ Episodic consolidation (BullMQ job)
           ├── Extract patterns (themes, moments, preferences)
           └── Generate conversation summary with embedding

Daily Consolidation (cron / manual)
    │
    └──▶ Aggregate episodic patterns → semantic knowledge

Weekly Consolidation (cron / manual)
    │
    └──▶ Review, prune, and sync semantic knowledge

buildContext()
    │
    └──▶ Query 9 sources in parallel (5s timeout each)
           ├── Facts
           ├── Similar messages (pgvector)
           ├── Similar conversations (pgvector)
           ├── Emotional moments
           ├── Contradictions
           ├── Behavioral observations
           ├── Episodic patterns
           ├── Semantic knowledge
           └── Graph context (optional)
           │
           ▼
         MemoryContext.formatted → inject into LLM system prompt
```

## License

MIT
