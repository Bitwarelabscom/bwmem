# @bitwarelabs/bwmem

Memory SDK for AI chatbots. Gives your bot persistent, per-user memory: facts, semantic search, emotional capture, contradiction detection, knowledge graph, and multi-stage consolidation.

Drop it into any chatbot — record messages, build context, inject into your LLM prompt. The SDK handles fact extraction, embeddings, sentiment analysis, and long-term memory consolidation in the background.

**v0.2.0** adds a hosted REST API layer, multi-tenant support, and a Neo4j knowledge graph pipeline.

## Features

- **Fact extraction** — automatically extracts structured facts from conversations (name, job, preferences, relationships, career signals)
- **Semantic search** — find similar messages and conversations via pgvector embeddings
- **Emotional capture** — detects high-emotion moments using VAD (Valence-Arousal-Dominance) analysis with specific descriptive tags
- **Contradiction detection** — LLM-powered detection of behavioral contradictions across sessions, with awareness of multi-valued facts and temporal context
- **Memory consolidation** — episodic (per-session), daily, and weekly consolidation pipelines
- **Conversation summaries** — auto-generated summaries with topic extraction
- **Context builder** — aggregates 9 memory sources into a single formatted prompt injection
- **Knowledge graph** — Neo4j integration with schema-constrained entity relationships (27 types), entity-to-entity edges, and entity-scoped subgraphs
- **Provider-agnostic** — works with OpenAI, Ollama, OpenRouter, or any custom provider
- **REST API** — Fastify-based multi-tenant API with API key auth, rate limiting, usage tracking, and Swagger docs
- **Semantic fact dedup** — normalized key comparison + value similarity prevents duplicate facts across extraction batches

## Requirements

- Node.js >= 18
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension
- Redis
- Neo4j (optional, for knowledge graph)

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

## REST API

v0.2.0 includes a hosted REST API layer for multi-tenant access to all SDK features.

### Running the API

```bash
# With Docker
docker compose up -d

# Or directly
npm run start:api
```

### Configuration

```env
PORT=3420
DATABASE_URL=postgresql://bwmem:password@localhost:5432/bwmem
REDIS_URL=redis://:password@localhost:6379
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-large
OPENROUTER_CHAT_MODEL=google/gemma-4-31b-it
OPENROUTER_EMBEDDING_DIMENSIONS=1536
ADMIN_API_KEY=your-admin-key-min-32-chars
API_KEY_PEPPER=your-secret-pepper
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password
```

### Endpoints

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer <key>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/sessions` | Start a session |
| `POST` | `/sessions/:id/end` | End a session |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `POST` | `/messages` | Record a message |
| `GET` | `/context?userId=&query=` | Build memory context |
| `GET` | `/search?userId=&query=&type=` | Semantic search |
| `GET` | `/facts/:userId` | Get facts |
| `POST` | `/facts` | Store a fact |
| `DELETE` | `/facts/:factId` | Delete a fact |
| `GET` | `/facts/:userId/search?query=` | Search facts |
| `GET` | `/emotions/:userId` | Emotional moments |
| `GET` | `/contradictions/:userId` | Contradictions |
| `POST` | `/consolidate` | Trigger consolidation (admin) |
| `GET` | `/summary/:sessionId` | Conversation summary |
| `GET` | `/graph/:userId` | Knowledge graph |
| `POST` | `/admin/tenants` | Create tenant (admin) |
| `GET` | `/admin/tenants` | List tenants (admin) |
| `PATCH` | `/admin/tenants/:id` | Update tenant (admin) |

### Usage Tiers

| Tier | Users | Embeddings/mo | Rate limit | Price |
|------|-------|--------------|-----------|-------|
| Tester | 1 | 1,500 | 10 req/min | Free |
| Hobby | 1 | 30,000 | 30 req/min | $4/mo |
| Builder | 10 | 300,000 | 60 req/min | $29/mo |
| Enterprise | Custom | Custom | Custom | Contact us |

### Response Format

All responses follow a consistent envelope:

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "message", "code": "ERROR_CODE" }
```

Embedding quota headers on every response:
- `X-Embedding-Limit` — monthly embedding quota
- `X-Embedding-Remaining` — remaining embeddings this month

### Example

```bash
# Create a tenant
curl -X POST https://api.bitwarelabs.com/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "email": "dev@example.com", "tier": "builder"}'

# Use the returned API key
curl -X POST https://api.bitwarelabs.com/api/v1/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1"}'

curl -X POST https://api.bitwarelabs.com/api/v1/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "role": "user", "content": "My name is Vera and I live in Gothenburg"}'

curl https://api.bitwarelabs.com/api/v1/facts/user-1 \
  -H "Authorization: Bearer $API_KEY"
```

## Providers

All three bundled providers implement both `EmbeddingProvider` and `LLMProvider`, so a single instance handles both. The OpenRouter provider includes exponential backoff retry for 429/5xx errors.

### OpenAI

```typescript
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';

const provider = new OpenAIProvider({
  apiKey: 'sk-...',
  model: 'gpt-4o-mini',                    // default
  embeddingModel: 'text-embedding-3-small', // default
  embeddingDimensions: 1024,                // default
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
  apiKey: 'sk-or-...',
  model: 'anthropic/claude-3.5-haiku',        // default
  embeddingModel: 'qwen/qwen3-embedding-8b',  // default
  embeddingDimensions: 1024,                   // default
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
  postgres: 'postgresql://localhost/mydb',
  redis: 'redis://localhost:6379',
  embeddings: provider,          // EmbeddingProvider (required)
  llm: provider,                 // LLMProvider (required)
  graph: neo4jGraph,             // GraphPlugin (optional)
  consolidation: {
    enabled: true,               // default: true
    daily: '0 2 * * *',         // default: 2 AM daily
    weekly: '0 3 * * 0',        // default: 3 AM Sundays
  },
  session: {
    inactivityTimeoutMs: 300_000, // default: 5 minutes
  },
  tablePrefix: 'bwmem_',         // default
  logger: console,               // default: built-in console logger
});
```

#### `mem.initialize()`

Connects to PostgreSQL and Redis, runs migrations (creates tables + pgvector extension), starts the consolidation scheduler if enabled.

#### `mem.startSession(config): Promise<Session>`

```typescript
const session = await mem.startSession({
  userId: 'user-123',
  metadata: { source: 'web' },
});
```

#### `mem.buildContext(userId, options?): Promise<MemoryContext>`

Aggregates memory from 9 sources in parallel with timeout protection:

```typescript
const context = await mem.buildContext('user-123', {
  query: 'What does the user do for work?',
  sessionId: session.id,        // exclude current session
  maxFacts: 30,                 // default
  maxSimilarMessages: 5,        // default
  similarityThreshold: 0.25,    // default (tuned for text-embedding-3-large)
  timeoutMs: 5000,              // default
});

// context.formatted — ready to inject into your system prompt
// context.facts — array of Fact objects
// context.sourcesResponded — e.g. "9/9"
```

**Sources:** facts, similar messages, similar conversations, emotional moments, contradictions, behavioral observations, episodic patterns, semantic knowledge, graph context.

#### `mem.facts`

```typescript
const facts = await mem.facts.get('user-123');
await mem.facts.store({ userId: 'user-123', category: 'preference', key: 'editor', value: 'VS Code' });
const results = await mem.facts.search('user-123', 'programming tools');
await mem.facts.remove(factId);
```

**Fact categories:** `personal`, `work`, `preference`, `hobby`, `relationship`, `goal`, `context`

#### `mem.emotions`

```typescript
const moments = await mem.emotions.getRecent('user-123', 7, 10); // last 7 days, max 10
```

#### `mem.contradictions`

```typescript
const signals = await mem.contradictions.getUnsurfaced('user-123');
```

#### `mem.behavioral`

```typescript
const observations = await mem.behavioral.getActive('user-123');
```

#### `mem.summaries`

```typescript
const summary = await mem.summaries.getForSession(sessionId);
```

#### `mem.searchMessages(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchMessages('user-123', 'machine learning', 5, 0.25);
```

#### `mem.searchConversations(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchConversations('user-123', 'work discussion', 3, 0.2);
```

#### `mem.triggerConsolidation(type)`

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
  role: 'user',
  content: 'I just moved to Berlin.',
});
```

**Background processing** (fire-and-forget):
- Embedding generation + storage
- Sentiment analysis (VAD model)
- Fact extraction (every 3 user messages) with semantic dedup
- LLM contradiction detection against all stored facts
- Emotional moment capture with descriptive tagging
- Session centroid update
- Knowledge graph sync (entities + relationships)

#### `session.flush(): Promise<void>`

Wait for all pending background processing to complete.

#### `session.end(): Promise<void>`

Ends the session and triggers episodic consolidation (pattern extraction + conversation summary).

#### `session.getMessages(): Promise<Message[]>`

Returns all messages in the session with sentiment data.

## Knowledge Graph

```typescript
import { Neo4jGraph } from '@bitwarelabs/bwmem/graph';

const graph = new Neo4jGraph({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});

const mem = new BwMem({ /* ... */ graph });
```

Facts are automatically synced to Neo4j as schema-constrained entity relationships.

### Relationship Types

| Type | Source Keys | Target Type |
|------|-----------|-------------|
| `NAMED` | name, nickname | name |
| `WORKS_AT` | employer, company | organization |
| `PREVIOUSLY_AT` | past_employer | organization |
| `WORKS_AS` | job_title, role, profession | role |
| `WORKS_ON` | current_project, project | project |
| `LIVES_IN` | location, city, country | place |
| `PREVIOUSLY_IN` | past_location | place |
| `PARTNER_OF` | partner, wife, husband | person |
| `PARENT_OF` | child, daughter, son | person |
| `SIBLING_OF` | sibling, brother, sister | person |
| `COLLEAGUE_OF` | colleague, coworker | person |
| `FRIEND_OF` | friend | person |
| `OWNS` | pet, pet_name | animal |
| `ENJOYS` | interest, hobby, sport | activity |
| `STUDIES` | field, major, degree | field |
| `STUDIES_AT` | university, school | organization |
| `AIMS_FOR` | goal, career_change | goal |
| `RUNS` | business, partner_business | organization |
| `LIKES` / `DISLIKES` | food, favorite / dislike, allergy | thing |

Entity-scoped facts (e.g., `partner_job: chef`) create edges FROM that entity (e.g., `Erik → HAS_ROLE → chef`).

### Entity Validation

Not every fact value becomes a graph entity. The graph pipeline filters out:
- Pure numbers and percentages
- Phrases longer than 6 words
- Descriptive text that isn't a named entity

### Example Graph Output

```
User → NAMED → Frida (name)
User → WORKS_AT → White Arkitekter (organization)
User → WORKS_AS → architect (role)
User → LIVES_IN → Helsingborg (place)
User → PREVIOUSLY_IN → Gothenburg (place)
User → PARTNER_OF → Erik (person)
User → PARENT_OF → Saga (person)
User → COLLEAGUE_OF → Anders (person)
Erik → HAS_ROLE → chef (role)
Erik → RUNS → Salta restaurant (organization)
```

## Consolidation

Three-stage memory consolidation pipeline:

### Episodic (on session end)

When `session.end()` is called:
1. Extracts patterns from the session (themes, mood shifts, key moments, preference signals)
2. Generates a conversation summary with embedding
3. Stores patterns in `episodic_patterns` table

### Daily (cron or manual)

Runs at 2 AM by default:
1. Aggregates recent episodic patterns into semantic knowledge
2. Merges with existing knowledge (preferences, known facts, behavioral baselines)
3. Expires old behavioral observations

### Weekly (cron or manual)

Runs at 3 AM Sundays by default:
1. Reviews all semantic knowledge for consistency
2. Cross-references with stored facts
3. Prunes outdated or low-confidence entries
4. Syncs to knowledge graph (if enabled)

## Database

The SDK auto-creates all tables on `initialize()` via migrations. Tables are prefixed with `bwmem_` by default.

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
| `emotional_moments` | High-emotion messages with descriptive tags |
| `contradiction_signals` | Behavioral and factual contradictions |
| `behavioral_observations` | Behavioral pattern observations |

**Consolidation:**
| Table | Purpose |
|---|---|
| `consolidation_runs` | Audit log of all consolidation jobs |
| `episodic_patterns` | Patterns extracted per session |
| `semantic_knowledge` | Long-term aggregated knowledge |

**API layer (v0.2.0):**
| Table | Purpose |
|---|---|
| `api_tenants` | Tenant accounts with API keys and tier limits |
| `api_usage` | Per-tenant usage tracking |

## Security (API layer)

- API key auth with HMAC-SHA256 hashing and server-side pepper
- Timing-safe admin key comparison
- Tenant data isolation via userId prefixing
- Per-tenant rate limiting (Redis-backed, tier-aware)
- Bounded auth cache with automatic invalidation
- Rate limiter fails closed on Redis failure
- CORS allowlist in production, Swagger disabled in production
- Request body size limit (1MB), session cap per tenant
- Non-root Docker container, localhost-only DB ports
- Security headers via nginx (HSTS, CSP, X-Frame-Options)

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
           ├── Fact extraction (every 3 msgs) → dedup → store facts
           ├── LLM contradiction detection → flag conflicts
           ├── Emotional moment capture → descriptive tagging
           ├── Graph sync → entities + relationships → Neo4j
           └── Update session centroid

Session.end()
    │
    └──▶ Episodic consolidation (BullMQ job)
           ├── Extract patterns (themes, moments, preferences)
           └── Generate conversation summary with embedding

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
           └── Graph context (Neo4j)
           │
           ▼
         MemoryContext.formatted → inject into LLM system prompt
```

## Testing

```bash
npm test              # Unit tests (no external services needed)
npm run build         # TypeScript compilation
npm run start:api     # Start the REST API server
```

## License

AGPL-3.0-only
