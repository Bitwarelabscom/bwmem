-- bwmem performance indexes: pgvector IVFFlat + covering indexes
-- Template vars: ${prefix} = table prefix
--
-- All indexes use CREATE INDEX CONCURRENTLY so application traffic is not
-- blocked while they build. CONCURRENTLY cannot run inside a transaction
-- block, so the migrator executes each statement on its own connection.

-- Vector index: messages.embedding
-- pgvector IVFFlat for cosine similarity. lists ≈ sqrt(rows); 100 is a
-- safe default up to ~1M rows. Tune via ALTER INDEX SET (lists = N) as data grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${prefix}messages_embedding
  ON ${prefix}messages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Vector index: conversation_summaries.embedding
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${prefix}summaries_embedding
  ON ${prefix}conversation_summaries USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Sentiment covering index
-- behavioral.service.ts filters by sentiment_valence IS NOT NULL within a
-- recent time window per user. Partial index keeps the index small.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${prefix}messages_sentiment
  ON ${prefix}messages(user_id, created_at DESC)
  WHERE sentiment_valence IS NOT NULL;

-- Facts dedup lookup by (user_id, category, fact_key)
-- Supports the batched dedup query in storeExtractedFacts. Non-partial so
-- the optimizer can use it for both active and historical lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${prefix}facts_user_key
  ON ${prefix}facts(user_id, category, fact_key);
