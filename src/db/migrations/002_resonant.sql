-- bwmem resonant memory: emotional moments, contradictions, behavioral observations

-- Emotional moments captured when VAD thresholds are crossed
CREATE TABLE IF NOT EXISTS ${prefix}emotional_moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  session_id UUID NOT NULL,
  raw_text TEXT,
  moment_tag TEXT,
  valence REAL,
  arousal REAL,
  dominance REAL,
  context_topic TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}emotional_user
  ON ${prefix}emotional_moments(user_id, created_at DESC);

-- Contradiction signals between user statements and stored facts
CREATE TABLE IF NOT EXISTS ${prefix}contradiction_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  session_id UUID,
  fact_key VARCHAR(255),
  user_stated TEXT,
  stored_value TEXT,
  signal_type VARCHAR(20) CHECK (signal_type IN ('correction', 'misremember')),
  surfaced BOOLEAN DEFAULT FALSE,
  surfaced_session_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}contradictions_unsurfaced
  ON ${prefix}contradiction_signals(user_id, created_at DESC)
  WHERE surfaced = FALSE;

-- Behavioral pattern shift observations
CREATE TABLE IF NOT EXISTS ${prefix}behavioral_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  observation_type VARCHAR(50),
  observation TEXT,
  evidence_summary TEXT,
  severity REAL,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  expired BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}behavioral_active
  ON ${prefix}behavioral_observations(user_id, created_at DESC)
  WHERE expired = FALSE;
