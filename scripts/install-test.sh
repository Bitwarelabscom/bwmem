#!/usr/bin/env bash
set -euo pipefail

# Install and test @bitwarelabs/bwmem on a fresh machine.
# Spins up PostgreSQL (with pgvector) + Redis via Docker,
# installs the package from a tarball, and runs a smoke test.
#
# Usage:
#   ./install-test.sh                          # looks for .tgz in script dir
#   ./install-test.sh /path/to/bwmem-0.1.0.tgz  # explicit tarball path

BWMEM_DB="bwmem_test"
BWMEM_DB_USER="bwmem"
BWMEM_DB_PASS="bwmem_test_pass"
PG_PORT="${PG_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
TEST_DIR="/tmp/bwmem-install-test-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve tarball path
if [ -n "${1:-}" ] && [ -f "$1" ]; then
  TARBALL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  TARBALL="$(ls "$SCRIPT_DIR"/../bitwarelabs-bwmem-*.tgz 2>/dev/null | head -1 || true)"
  [ -z "$TARBALL" ] && TARBALL="$(ls "$SCRIPT_DIR"/bitwarelabs-bwmem-*.tgz 2>/dev/null | head -1 || true)"
fi
[ -z "$TARBALL" ] || [ ! -f "$TARBALL" ] && { echo "Usage: $0 [path/to/bitwarelabs-bwmem-*.tgz]"; exit 1; }

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[bwmem]${NC} $*"; }
warn() { echo -e "${YELLOW}[bwmem]${NC} $*"; }
fail() { echo -e "${RED}[bwmem]${NC} $*" >&2; exit 1; }

cleanup() {
  log "Cleaning up..."
  rm -rf "$TEST_DIR"
  docker rm -f bwmem-test-pg bwmem-test-redis 2>/dev/null || true
}

trap cleanup EXIT

# ---- Pre-flight checks ----

command -v node  >/dev/null || fail "node not found"
command -v npm   >/dev/null || fail "npm not found"
command -v docker >/dev/null || fail "docker not found"

NODE_MAJOR=$(node -e "console.log(process.version.split('.')[0].slice(1))")
[ "$NODE_MAJOR" -ge 18 ] || fail "Node >= 18 required (got $(node --version))"

log "Node $(node --version), npm $(npm --version), Docker $(docker --version | cut -d' ' -f3)"
log "Tarball: $TARBALL"

# ---- Start services ----

log "Starting PostgreSQL (pgvector) on port $PG_PORT..."
docker rm -f bwmem-test-pg 2>/dev/null || true
docker run -d \
  --name bwmem-test-pg \
  -e POSTGRES_USER="$BWMEM_DB_USER" \
  -e POSTGRES_PASSWORD="$BWMEM_DB_PASS" \
  -e POSTGRES_DB="$BWMEM_DB" \
  -p "$PG_PORT":5432 \
  pgvector/pgvector:pg16 >/dev/null

log "Starting Redis on port $REDIS_PORT..."
docker rm -f bwmem-test-redis 2>/dev/null || true
docker run -d \
  --name bwmem-test-redis \
  -p "$REDIS_PORT":6379 \
  redis:7-alpine >/dev/null

# Wait for PostgreSQL to be ready
log "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker exec bwmem-test-pg pg_isready -U "$BWMEM_DB_USER" >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && fail "PostgreSQL did not start in time"
  sleep 1
done
log "PostgreSQL ready"

# Enable pgvector extension
docker exec bwmem-test-pg psql -U "$BWMEM_DB_USER" -d "$BWMEM_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
log "pgvector extension enabled"

# Wait for Redis
log "Waiting for Redis..."
for i in $(seq 1 15); do
  if docker exec bwmem-test-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  [ "$i" -eq 15 ] && fail "Redis did not start in time"
  sleep 1
done
log "Redis ready"

# ---- Install package ----

DATABASE_URL="postgresql://${BWMEM_DB_USER}:${BWMEM_DB_PASS}@localhost:${PG_PORT}/${BWMEM_DB}"
REDIS_URL="redis://localhost:${REDIS_PORT}"

mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

cat > package.json <<'PKGJSON'
{
  "name": "bwmem-install-test",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
PKGJSON

log "Installing @bitwarelabs/bwmem from tarball..."
npm install "$TARBALL" 2>&1 | tail -5

# ---- Test 1: All exports resolve ----

log "Test 1: Verifying all export paths..."
cat > test-exports.mjs <<'EOF'
import { BwMem, formatRelativeTime, safeQuery } from '@bitwarelabs/bwmem';
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';
import { OllamaProvider } from '@bitwarelabs/bwmem/providers/ollama';
import { OpenRouterProvider } from '@bitwarelabs/bwmem/providers/openrouter';
import { Neo4jGraph } from '@bitwarelabs/bwmem/graph';

const checks = [
  ['BwMem', typeof BwMem === 'function'],
  ['formatRelativeTime', typeof formatRelativeTime === 'function'],
  ['safeQuery', typeof safeQuery === 'function'],
  ['OpenAIProvider', typeof OpenAIProvider === 'function'],
  ['OllamaProvider', typeof OllamaProvider === 'function'],
  ['OpenRouterProvider', typeof OpenRouterProvider === 'function'],
  ['Neo4jGraph', typeof Neo4jGraph === 'function'],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}

if (!ok) {
  process.exit(1);
}
console.log('  All exports OK');
EOF

node test-exports.mjs || fail "Export test failed"

# ---- Test 2: Initialize, create session, record message, shutdown ----

log "Test 2: Full lifecycle (init → session → message → facts → context → shutdown)..."
cat > test-lifecycle.mjs <<EOF
import { BwMem } from '@bitwarelabs/bwmem';

// Mock provider - no real LLM needed
const mockProvider = {
  dimensions: 128,
  async generate(text) {
    return Array.from({ length: 128 }, (_, i) => Math.sin(i + text.length) * 0.1);
  },
  async generateBatch(texts) {
    return texts.map(t => Array.from({ length: 128 }, (_, i) => Math.sin(i + t.length) * 0.1));
  },
  async chat(messages) {
    return 'Mock response: I remember you said something interesting!';
  },
};

const mem = new BwMem({
  postgres: '${DATABASE_URL}',
  redis: '${REDIS_URL}',
  embeddings: mockProvider,
  llm: mockProvider,
  consolidation: { enabled: false },
});

try {
  // Initialize (runs migrations)
  await mem.initialize();
  console.log('  PASS  initialize');

  // Start session
  const session = await mem.startSession({ userId: 'test-user' });
  console.log('  PASS  startSession (' + session.id + ')');

  // Record messages
  await session.recordMessage({ role: 'user', content: 'My name is Alice and I work at Acme.' });
  await session.recordMessage({ role: 'assistant', content: 'Nice to meet you, Alice!' });
  await session.recordMessage({ role: 'user', content: 'I love hiking and programming in TypeScript.' });
  console.log('  PASS  recordMessage (3 messages)');

  // Wait for background processing
  await new Promise(r => setTimeout(r, 2000));

  // Check facts
  const facts = await mem.facts.get('test-user');
  console.log('  PASS  facts.get (' + facts.length + ' facts extracted)');
  for (const f of facts) {
    console.log('        [' + f.category + '] ' + f.factKey + ': ' + f.factValue);
  }

  // Store manual fact
  await mem.facts.store({
    userId: 'test-user',
    category: 'preference',
    key: 'editor',
    value: 'VS Code',
    confidence: 1.0,
  });
  console.log('  PASS  facts.store');

  // Build context
  const context = await mem.buildContext('test-user', { query: 'What does Alice do?' });
  console.log('  PASS  buildContext (' + context.sourcesResponded + ' sources)');

  // Search messages
  const similar = await mem.searchMessages('test-user', 'programming');
  console.log('  PASS  searchMessages (' + similar.length + ' results)');

  // End session
  await session.end();
  console.log('  PASS  session.end');

  // Get messages
  const messages = await session.getMessages();
  console.log('  PASS  getMessages (' + messages.length + ' messages)');

  // Shutdown
  await mem.shutdown();
  console.log('  PASS  shutdown');

  console.log('  All lifecycle tests passed');
} catch (err) {
  console.error('  FAIL', err.message);
  await mem.shutdown().catch(() => {});
  process.exit(1);
}
EOF

node test-lifecycle.mjs || fail "Lifecycle test failed"

# ---- Done ----

echo ""
log "==========================================="
log "  All tests passed!"
log "==========================================="
log "  PostgreSQL: $DATABASE_URL"
log "  Redis:      $REDIS_URL"
log "  Test dir:   $TEST_DIR"
echo ""
