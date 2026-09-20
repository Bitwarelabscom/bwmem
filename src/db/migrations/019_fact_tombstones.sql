-- 019: rejected-value tombstones
--
-- When a user or system rejects, deletes, or corrects a fact, setting
-- fact_status = 'expired' or 'superseded' marks that specific row.
-- But the extraction pipeline re-reading conversation messages or session
-- transcripts produces brand-new candidate records. When it sees no active row
-- for (user_id, fact_key), it inserts the new record, silently re-asserting
-- the very claim that was previously deleted.
--
-- A rejected-value tombstone is a durable record keyed on the rejected value
-- (user_id, fact_key, value_hash), so subsequent extraction passes and write
-- calls cannot re-assert what was already rejected.
--
-- Preserves the audit trail of what was rejected, when, and why, while
-- ensuring that deletions and rejections survive subsequent extraction passes.

CREATE TABLE IF NOT EXISTS ${prefix}fact_tombstones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         VARCHAR(255) NOT NULL,
  fact_key        VARCHAR(255) NOT NULL,
  fact_value      TEXT NOT NULL,
  value_hash      VARCHAR(64) NOT NULL,
  reason          TEXT,
  source_fact_id  UUID REFERENCES ${prefix}facts(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent by user, key, and value hash:
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}fact_tombstones_unique
  ON ${prefix}fact_tombstones (user_id, fact_key, value_hash);

-- Fast lookup during extraction and storeFact writes:
CREATE INDEX IF NOT EXISTS idx_${prefix}fact_tombstones_lookup
  ON ${prefix}fact_tombstones (user_id, fact_key);

-- Chronological lookup for audit and provenance:
CREATE INDEX IF NOT EXISTS idx_${prefix}fact_tombstones_user_time
  ON ${prefix}fact_tombstones (user_id, created_at DESC);
