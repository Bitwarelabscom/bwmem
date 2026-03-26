-- bwmem consolidation: run tracking, episodic patterns, semantic knowledge

-- Consolidation run audit log
CREATE TABLE IF NOT EXISTS ${prefix}consolidation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type VARCHAR(20) NOT NULL CHECK (run_type IN ('episodic', 'daily', 'weekly')),
  user_id VARCHAR(255),
  session_id UUID,
  status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  patterns_extracted INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_${prefix}consolidation_runs_user
  ON ${prefix}consolidation_runs(user_id, started_at DESC);

-- Episodic patterns extracted from sessions
CREATE TABLE IF NOT EXISTS ${prefix}episodic_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  session_id UUID,
  consolidation_run_id UUID REFERENCES ${prefix}consolidation_runs(id),
  pattern_type VARCHAR(50),
  pattern TEXT NOT NULL,
  confidence REAL DEFAULT 0.7,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}episodic_user
  ON ${prefix}episodic_patterns(user_id, created_at DESC);

-- Long-term semantic knowledge consolidated from episodic patterns
CREATE TABLE IF NOT EXISTS ${prefix}semantic_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  entry_type VARCHAR(50) NOT NULL,
  theme VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.7,
  source_count INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}semantic_user
  ON ${prefix}semantic_knowledge(user_id, entry_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}semantic_unique
  ON ${prefix}semantic_knowledge(user_id, entry_type, theme);
