-- bwmem core schema: sessions, messages, facts, conversation summaries
-- Template vars: ${prefix} = table prefix, ${dimensions} = embedding dimensions

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sessions
CREATE TABLE IF NOT EXISTS ${prefix}sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  metadata JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_${prefix}sessions_user
  ON ${prefix}sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${prefix}sessions_active
  ON ${prefix}sessions(user_id) WHERE is_active = TRUE;

-- Messages with embeddings and sentiment
CREATE TABLE IF NOT EXISTS ${prefix}messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ${prefix}sessions(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  embedding vector(${dimensions}),
  sentiment_valence REAL,
  sentiment_arousal REAL,
  sentiment_dominance REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}messages_session
  ON ${prefix}messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_${prefix}messages_user
  ON ${prefix}messages(user_id, created_at DESC);

-- Facts with lifecycle management
CREATE TABLE IF NOT EXISTS ${prefix}facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL,
  fact_key VARCHAR(255) NOT NULL,
  fact_value TEXT NOT NULL,
  confidence REAL DEFAULT 0.8,
  fact_status VARCHAR(20) DEFAULT 'active'
    CHECK (fact_status IN ('active', 'overridden', 'superseded', 'expired')),
  fact_type VARCHAR(20) DEFAULT 'permanent'
    CHECK (fact_type IN ('permanent', 'default', 'temporary')),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  supersedes_id UUID REFERENCES ${prefix}facts(id),
  override_priority INT DEFAULT 0,
  mention_count INT DEFAULT 1,
  last_mentioned TIMESTAMPTZ DEFAULT NOW(),
  source_session_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}facts_user_active
  ON ${prefix}facts(user_id, category) WHERE fact_status = 'active';
CREATE INDEX IF NOT EXISTS idx_${prefix}facts_lifecycle
  ON ${prefix}facts(user_id, fact_status, valid_until);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}facts_unique_active
  ON ${prefix}facts(user_id, category, fact_key, COALESCE(fact_type, 'permanent'))
  WHERE fact_status = 'active';

-- Conversation summaries with embeddings
CREATE TABLE IF NOT EXISTS ${prefix}conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID UNIQUE NOT NULL REFERENCES ${prefix}sessions(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  summary TEXT,
  topics TEXT[],
  key_points TEXT[],
  embedding vector(${dimensions}),
  message_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}summaries_user
  ON ${prefix}conversation_summaries(user_id);
