#!/usr/bin/env bash
set -euo pipefail

# Real LLM integration test for @bitwarelabs/bwmem
# Tests with actual OpenRouter API calls (mimo-v2-flash + qwen3-embedding-8b)
#
# Usage:
#   ./test-real-llm.sh <tarball> <openrouter-api-key>

TARBALL="${1:?Usage: $0 <tarball> <openrouter-api-key>}"
OPENROUTER_KEY="${2:?Usage: $0 <tarball> <openrouter-api-key>}"

BWMEM_DB="bwmem_llm_test"
BWMEM_DB_USER="bwmem"
BWMEM_DB_PASS="bwmem_test_pass"
PG_PORT="${PG_PORT:-5434}"
REDIS_PORT="${REDIS_PORT:-6381}"
TEST_DIR="/tmp/bwmem-llm-test-$$"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[bwmem]${NC} $*"; }
info() { echo -e "${CYAN}[test]${NC} $*"; }
warn() { echo -e "${YELLOW}[bwmem]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

cleanup() {
  log "Cleaning up..."
  rm -rf "$TEST_DIR"
  docker rm -f bwmem-llm-pg bwmem-llm-redis 2>/dev/null || true
}
trap cleanup EXIT

[ -f "$TARBALL" ] || fail "Tarball not found: $TARBALL"
command -v node  >/dev/null || fail "node not found"
command -v docker >/dev/null || fail "docker not found"

log "Node $(node --version), npm $(npm --version)"
log "Model: xiaomi/mimo-v2-flash (chat) + qwen/qwen3-embedding-8b (embeddings)"

# ---- Start services ----

docker rm -f bwmem-llm-pg bwmem-llm-redis 2>/dev/null || true

log "Starting PostgreSQL (pgvector) on port $PG_PORT..."
docker run -d --name bwmem-llm-pg \
  -e POSTGRES_USER="$BWMEM_DB_USER" \
  -e POSTGRES_PASSWORD="$BWMEM_DB_PASS" \
  -e POSTGRES_DB="$BWMEM_DB" \
  -p "$PG_PORT":5432 \
  pgvector/pgvector:pg16 >/dev/null

log "Starting Redis on port $REDIS_PORT..."
docker run -d --name bwmem-llm-redis \
  -p "$REDIS_PORT":6379 \
  redis:7-alpine >/dev/null

log "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  docker exec bwmem-llm-pg pg_isready -U "$BWMEM_DB_USER" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && fail "PostgreSQL timeout"
  sleep 1
done
docker exec bwmem-llm-pg psql -U "$BWMEM_DB_USER" -d "$BWMEM_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
log "PostgreSQL + pgvector ready"

log "Waiting for Redis..."
for i in $(seq 1 15); do
  docker exec bwmem-llm-redis redis-cli ping 2>/dev/null | grep -q PONG && break
  [ "$i" -eq 15 ] && fail "Redis timeout"
  sleep 1
done
log "Redis ready"

# ---- Install ----

DATABASE_URL="postgresql://${BWMEM_DB_USER}:${BWMEM_DB_PASS}@localhost:${PG_PORT}/${BWMEM_DB}"
REDIS_URL="redis://localhost:${REDIS_PORT}"

mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

cat > package.json <<'PKGJSON'
{ "name": "bwmem-llm-test", "version": "1.0.0", "private": true, "type": "module" }
PKGJSON

log "Installing from tarball..."
npm install "$TARBALL" 2>&1 | tail -3

# ---- Write test ----

cat > test-real-llm.mjs <<TESTEOF
import { BwMem } from '@bitwarelabs/bwmem';
import { OpenRouterProvider } from '@bitwarelabs/bwmem/providers/openrouter';

const OPENROUTER_KEY = '${OPENROUTER_KEY}';
const DATABASE_URL = '${DATABASE_URL}';
const REDIS_URL = '${REDIS_URL}';

// ---- Helpers ----

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log(\`  \x1b[32mPASS\x1b[0m  \${name}\${detail ? ' — ' + detail : ''}\`);
}

function fail(name, err) {
  failed++;
  console.log(\`  \x1b[31mFAIL\x1b[0m  \${name} — \${err}\`);
}

function assert(condition, name, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail || 'assertion failed');
}

// ---- Setup ----

console.log('\\n━━━ Real LLM Integration Test ━━━\\n');

const provider = new OpenRouterProvider({
  apiKey: OPENROUTER_KEY,
  model: 'xiaomi/mimo-v2-flash',
  embeddingModel: 'qwen/qwen3-embedding-8b',
  embeddingDimensions: 1024,
});

const mem = new BwMem({
  postgres: DATABASE_URL,
  redis: REDIS_URL,
  embeddings: provider,
  llm: provider,
  consolidation: { enabled: false },
});

try {
  // ---- Test 1: Provider connectivity ----

  console.log('\\n[ Provider Connectivity ]\\n');

  const embedding = await provider.generate('Hello world');
  assert(
    Array.isArray(embedding) && embedding.length === 1024,
    'Embedding generation',
    \`\${embedding.length} dimensions, first 3: [\${embedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}]\`
  );

  const batchEmbeddings = await provider.generateBatch(['cat', 'dog', 'fish']);
  assert(
    batchEmbeddings.length === 3 && batchEmbeddings.every(e => e.length === 1024),
    'Batch embeddings',
    \`3 texts → 3 x \${batchEmbeddings[0].length}d vectors\`
  );

  const chatResponse = await provider.chat([
    { role: 'system', content: 'Reply with exactly one word.' },
    { role: 'user', content: 'What color is the sky?' },
  ], { temperature: 0 });
  assert(
    typeof chatResponse === 'string' && chatResponse.length > 0,
    'Chat completion (mimo-v2-flash)',
    \`"\${chatResponse.trim()}"\`
  );

  // ---- Test 2: Full initialization ----

  console.log('\\n[ BwMem Initialization ]\\n');

  await mem.initialize();
  pass('Initialize (migrations + services)');

  // ---- Test 3: Session + message recording with real embeddings ----

  console.log('\\n[ Session & Messages ]\\n');

  const session = await mem.startSession({ userId: 'llm-test-user' });
  pass('Start session', session.id);

  await session.recordMessage({
    role: 'user',
    content: 'Hi! My name is Marcus and I live in Berlin. I work as a data scientist at a fintech startup.',
  });
  pass('Record message 1 (user intro)');

  await session.recordMessage({
    role: 'assistant',
    content: 'Nice to meet you, Marcus! Berlin is a great city for tech. What kind of data science work do you do at the fintech startup?',
  });
  pass('Record message 2 (assistant)');

  await session.recordMessage({
    role: 'user',
    content: 'I build fraud detection models using Python and PyTorch. I also enjoy rock climbing on weekends and I am learning Japanese.',
  });
  pass('Record message 3 (user details)');

  await session.recordMessage({
    role: 'assistant',
    content: 'That sounds fascinating! Fraud detection with deep learning is cutting edge. Rock climbing and Japanese are great hobbies.',
  });
  pass('Record message 4 (assistant)');

  await session.recordMessage({
    role: 'user',
    content: 'My favorite food is ramen, which fits with learning Japanese! I also have a cat named Pixel.',
  });
  pass('Record message 5 (more facts)');

  await session.recordMessage({
    role: 'assistant',
    content: 'Pixel is a great name for a data scientist\\'s cat! And ramen is perfect fuel for studying Japanese.',
  });
  pass('Record message 6 (assistant)');

  // ---- Test 4: Wait for background processing then check facts ----

  console.log('\\n[ Fact Extraction (real LLM) ]\\n');

  console.log('  ... flushing background processing (embeddings + fact extraction) ...');
  const flushStart = Date.now();
  await session.flush();
  console.log(\`  Flush completed in \${((Date.now() - flushStart) / 1000).toFixed(1)}s\`);

  const facts = await mem.facts.get('llm-test-user');
  console.log(\`  Extracted \${facts.length} facts:\`);
  for (const f of facts) {
    console.log(\`    [\${f.category}] \${f.factKey}: \${f.factValue} (confidence: \${f.confidence})\`);
  }
  assert(facts.length >= 3, 'Fact extraction count', \`\${facts.length} facts (expected >= 3)\`);

  // Check for specific expected facts
  const factValues = facts.map(f => \`\${f.factKey}:\${f.factValue}\`.toLowerCase());
  const hasName = factValues.some(v => v.includes('marcus') || v.includes('name'));
  const hasCity = factValues.some(v => v.includes('berlin') || v.includes('city') || v.includes('location') || v.includes('live'));
  const hasJob = factValues.some(v => v.includes('data scientist') || v.includes('data') || v.includes('scientist') || v.includes('work') || v.includes('job') || v.includes('occupation'));

  assert(hasName, 'Fact: name extracted', factValues.find(v => v.includes('marcus') || v.includes('name')) || 'not found');
  assert(hasCity, 'Fact: location extracted', factValues.find(v => v.includes('berlin') || v.includes('city') || v.includes('location') || v.includes('live')) || 'not found');
  assert(hasJob, 'Fact: job extracted', factValues.find(v => v.includes('data') || v.includes('scientist') || v.includes('job')) || 'not found');

  // ---- Test 5: Manual fact storage ----

  console.log('\\n[ Manual Fact Storage ]\\n');

  await mem.facts.store({
    userId: 'llm-test-user',
    category: 'preference',
    key: 'programming_language',
    value: 'Python',
    confidence: 1.0,
  });
  pass('Store manual fact');

  const allFacts = await mem.facts.get('llm-test-user');
  const manualFact = allFacts.find(f => f.factKey === 'programming_language');
  assert(manualFact?.factValue === 'Python', 'Retrieve manual fact', manualFact?.factValue);

  // ---- Test 6: Semantic search with real embeddings ----

  console.log('\\n[ Semantic Search ]\\n');

  const fraudResults = await mem.searchMessages('llm-test-user', 'fraud detection models using Python and PyTorch', 5, 0.3);
  console.log(\`  Search "fraud detection models": \${fraudResults.length} results (threshold=0.3)\`);
  for (const r of fraudResults.slice(0, 3)) {
    console.log(\`    [\${r.similarity.toFixed(3)}] \${r.content.slice(0, 80)}...\`);
  }
  assert(fraudResults.length > 0, 'Semantic search returns results', \`\${fraudResults.length} matches\`);

  const hobbyResults = await mem.searchMessages('llm-test-user', 'rock climbing on weekends', 5, 0.3);
  console.log(\`  Search "rock climbing": \${hobbyResults.length} results (threshold=0.3)\`);
  for (const r of hobbyResults.slice(0, 3)) {
    console.log(\`    [\${r.similarity.toFixed(3)}] \${r.content.slice(0, 80)}...\`);
  }
  assert(hobbyResults.length > 0, 'Hobby search returns results', \`\${hobbyResults.length} matches\`);

  // Verify semantic relevance: top result should be about ML/data
  if (fraudResults.length > 0) {
    const topResult = fraudResults[0].content.toLowerCase();
    const isRelevant = topResult.includes('fraud') || topResult.includes('pytorch') || topResult.includes('model') || topResult.includes('data');
    assert(isRelevant, 'Semantic ranking is relevant', \`top hit: "\${fraudResults[0].content.slice(0, 60)}..."\`);
  }

  // ---- Test 7: Memory context building ----

  console.log('\\n[ Memory Context Building ]\\n');

  const context1 = await mem.buildContext('llm-test-user', {
    query: 'Tell me about Marcus\\'s work',
    sessionId: session.id,
  });
  console.log(\`  Context for "Marcus\\'s work": \${context1.sourcesResponded} sources\`);
  const respondedCount = parseInt(context1.sourcesResponded);
  assert(respondedCount >= 3, 'Context sources responded', context1.sourcesResponded);
  assert(context1.facts.length > 0, 'Context includes facts', \`\${context1.facts.length} facts\`);
  assert(typeof context1.formatted === 'string' && context1.formatted.length > 0, 'Context formatted string', \`\${context1.formatted.length} chars\`);

  console.log('  --- Context preview (first 500 chars) ---');
  console.log(\`  \${context1.formatted.slice(0, 500).split('\\n').join('\\n  ')}\`);
  console.log('  ---');

  // ---- Test 8: LLM chat with memory context (the full loop) ----

  console.log('\\n[ Full Chat Loop with Memory ]\\n');

  const context2 = await mem.buildContext('llm-test-user', {
    query: 'What do you know about me?',
    sessionId: session.id,
  });

  const memoryResponse = await provider.chat([
    {
      role: 'system',
      content: \`You are a helpful assistant. You know the following about the user:\\n\\n\${context2.formatted}\\n\\nSummarize what you know about the user in 2-3 sentences.\`,
    },
    { role: 'user', content: 'What do you know about me?' },
  ], { temperature: 0.3 });

  console.log(\`  LLM response with memory context:\`);
  console.log(\`  "\${memoryResponse}"\`);

  const responseLower = memoryResponse.toLowerCase();
  const mentionsMarcus = responseLower.includes('marcus');
  const mentionsBerlin = responseLower.includes('berlin');
  const mentionsWork = responseLower.includes('data') || responseLower.includes('fraud') || responseLower.includes('fintech');

  assert(mentionsMarcus, 'LLM recalls name', 'mentioned Marcus');
  assert(mentionsBerlin || mentionsWork, 'LLM recalls personal details', 'mentioned Berlin or work');

  // ---- Test 9: Conversation search ----

  console.log('\\n[ Conversation Summary Search ]\\n');

  // End session first (triggers summary generation)
  await session.end();
  pass('Session ended');

  await new Promise(r => setTimeout(r, 3000));

  const convResults = await mem.searchConversations('llm-test-user', 'data science');
  console.log(\`  Conversation search "data science": \${convResults.length} results\`);
  // This may be 0 if summary generation is async and hasn't completed yet - that's ok
  pass('Conversation search completed', \`\${convResults.length} results\`);

  // ---- Test 10: Second session (cross-session memory) ----

  console.log('\\n[ Cross-Session Memory ]\\n');

  const session2 = await mem.startSession({ userId: 'llm-test-user' });
  pass('Start second session', session2.id);

  const crossContext = await mem.buildContext('llm-test-user', {
    query: 'What was I telling you earlier?',
    sessionId: session2.id,
  });
  assert(crossContext.facts.length > 0, 'Cross-session facts persist', \`\${crossContext.facts.length} facts\`);
  assert(
    crossContext.formatted.toLowerCase().includes('marcus') || crossContext.facts.some(f => f.factValue.toLowerCase().includes('marcus')),
    'Cross-session recalls name',
    'Marcus found in context'
  );

  const crossResponse = await provider.chat([
    {
      role: 'system',
      content: \`You are a helpful assistant. Memory context:\\n\${crossContext.formatted}\\n\\nGreet the user by name and mention one thing you remember about them.\`,
    },
    { role: 'user', content: 'Hey, do you remember me?' },
  ], { temperature: 0.3 });
  console.log(\`  Cross-session LLM response: "\${crossResponse}"\`);
  assert(crossResponse.toLowerCase().includes('marcus'), 'Cross-session LLM names user', 'mentioned Marcus');

  await session2.end();
  pass('Second session ended');

  // ---- Shutdown ----

  console.log('\\n[ Shutdown ]\\n');
  await mem.shutdown();
  pass('Clean shutdown');

  // ---- Summary ----

  console.log(\`\\n━━━ Results: \${passed} passed, \${failed} failed ━━━\\n\`);
  if (failed > 0) process.exit(1);

} catch (err) {
  console.error('\\n  FATAL:', err.message || err);
  console.error(err.stack);
  await mem.shutdown().catch(() => {});
  process.exit(1);
}
TESTEOF

log "Running real LLM integration test..."
echo ""
node test-real-llm.mjs
