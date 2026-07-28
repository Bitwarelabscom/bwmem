-- bwmem 007: bi-temporal facts + intent scoping + fact-correction audit log
--
-- The facts table already has valid_from / valid_until (when a fact was true in
-- the world) and supersedes_id (lineage). What was missing is the second time
-- axis — WHEN WE CHANGED OUR BELIEF — distinct from when something was true.
-- Without this you can't honestly answer "what did we believe about X on date
-- Y" — you can only answer "what was true on date Y."
--
-- After this migration:
--   - valid_from / valid_until = "when this was true in the world"
--   - recorded_at = "when we first wrote this row"  (transaction-time start)
--   - superseded_at = "when we stopped believing this row" (transaction-time end)
--   - existing supersedes_id = lineage (unchanged)
--
-- A bi-temporal query then becomes:
--   "what we believed at txn_time about state at valid_time" =
--   WHERE valid_from <= valid_time
--     AND (valid_until IS NULL OR valid_until > valid_time)
--     AND recorded_at <= txn_time
--     AND (superseded_at IS NULL OR superseded_at > txn_time)
--
-- Also adds:
--   - intent_id: optional scope so the same fact key can hold different values
--     in different conversation threads (e.g., a multi-turn task with its own
--     facts that should not bleed into the user's general facts).
--   - fact_corrections: append-only audit log of every supersession, so you
--     can answer "how did we come to believe what we believe."

ALTER TABLE ${prefix}facts
  ADD COLUMN IF NOT EXISTS recorded_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intent_id      UUID;

UPDATE ${prefix}facts
   SET recorded_at = created_at
 WHERE recorded_at IS NULL;

ALTER TABLE ${prefix}facts
  ALTER COLUMN recorded_at SET NOT NULL,
  ALTER COLUMN recorded_at SET DEFAULT now();

UPDATE ${prefix}facts
   SET superseded_at = updated_at
 WHERE superseded_at IS NULL
   AND fact_status IN ('superseded', 'overridden', 'expired');

-- Currently-believed lookup (the hot path) + as-of queries.
CREATE INDEX IF NOT EXISTS idx_${prefix}facts_currently_believed
  ON ${prefix}facts (user_id, category, fact_key)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_${prefix}facts_superseded_at
  ON ${prefix}facts (user_id, superseded_at)
  WHERE superseded_at IS NOT NULL;

-- Intent-scoped uniqueness: the old unique index keyed on
-- (user_id, category, fact_key, fact_type) with WHERE fact_status='active' must
-- now include intent_id so two intents can each carry their own value.
DROP INDEX IF EXISTS idx_${prefix}facts_unique_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}facts_unique_active
  ON ${prefix}facts (
    user_id, category, fact_key,
    COALESCE(fact_type, 'permanent'),
    COALESCE(intent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE fact_status = 'active';

-- Append-only audit log: every supersession, override, or correction lands
-- here. Lets you answer "show me how this belief evolved" and "what was the
-- reason a given correction fired."
CREATE TABLE IF NOT EXISTS ${prefix}fact_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         VARCHAR(255) NOT NULL,
  fact_key        VARCHAR(255) NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  correction_type VARCHAR(40),
  reason          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}fact_corrections_user
  ON ${prefix}fact_corrections (user_id, created_at DESC);
