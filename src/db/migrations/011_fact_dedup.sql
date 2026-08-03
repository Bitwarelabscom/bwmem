-- 011: collapse duplicate active facts and narrow the dedup key.
--
-- storeFact looked for an existing active row scoped to
-- (user_id, category, fact_key, intent_id, fact_type). Any of those changing
-- between two mentions of the SAME claim missed the lookup and fell through to
-- a plain INSERT, so the store accumulated parallel "currently believed" rows
-- for one key. Measured on a production install: 218 keys across 804 active
-- rows — 51% duplicates — with a single key holding 25 concurrent values.
--
-- The category is an extractor's opinion about a claim, not part of its
-- identity; scoping identity by it means a re-classified extraction becomes a
-- second truth rather than a correction. storeFact now dedups on
-- (user_id, fact_key) alone.
--
-- Idempotent: re-running finds nothing to change.

-- 1. Repair status drift: rows marked active but already stamped superseded_at.
--    Readers filter on superseded_at IS NULL so these are invisible, but they
--    still occupy the unique-active index and block future inserts.
UPDATE ${prefix}facts
SET fact_status = 'superseded', updated_at = NOW()
WHERE fact_status = 'active' AND superseded_at IS NOT NULL;

-- 2. Collapse duplicate active rows to one winner per (user_id, fact_key):
--    highest override_priority first (a temporary override outranks a
--    permanent), then the most recently recorded belief. Everything else is
--    superseded rather than deleted — the bi-temporal history is the point.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, fact_key
           ORDER BY override_priority DESC,
                    COALESCE(recorded_at, created_at) DESC,
                    id DESC
         ) AS rn
  FROM ${prefix}facts
  WHERE fact_status = 'active'
)
UPDATE ${prefix}facts f
SET fact_status = 'superseded',
    superseded_at = COALESCE(f.superseded_at, NOW()),
    updated_at = NOW()
FROM ranked
WHERE f.id = ranked.id AND ranked.rn > 1;

-- 3. Enforce it going forward. Partial, so superseded history is unconstrained.
--    Deliberately NOT keyed on category/intent/fact_type: that width is exactly
--    what produced the duplicates.
DROP INDEX IF EXISTS idx_${prefix}facts_unique_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}facts_active_by_key
  ON ${prefix}facts (user_id, fact_key)
  WHERE fact_status = 'active';

COMMENT ON INDEX idx_${prefix}facts_active_by_key IS
  'One active row per (user_id, fact_key). Widening this key reintroduces the duplicate-active bug fixed in migration 011.';
