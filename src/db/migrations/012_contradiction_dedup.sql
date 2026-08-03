-- 012: count the disagreement, not the mentions.
--
-- Every supersession filed a brand-new contradiction signal, so one stale fact
-- that came up eight times in an evening became eight rows. Anything reading
-- the pile as a rate ("recall may be drifting") was reading how often a subject
-- came up, not how much memory was wrong.
--
-- The old guard — one row per (user, key, SESSION) — only suppressed repeats
-- inside a single session, which is the case that matters least.
--
-- One open row per (user_id, fact_key, stored_value). A repeat bumps a counter.
--
-- Two deliberate properties:
--   * created_at STAYS THE FIRST SIGHTING, never touched on a repeat. "This has
--     been wrong since Tuesday" is only visible if the first timestamp survives.
--   * the index is partial on surfaced = FALSE, so a resolved signal never
--     blocks a genuine recurrence later.

ALTER TABLE ${prefix}contradiction_signals
  ADD COLUMN IF NOT EXISTS repeat_count  INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE ${prefix}contradiction_signals
SET last_seen_at = created_at
WHERE last_seen_at IS NULL OR last_seen_at < created_at;

-- Collapse pre-existing open duplicates: keep the OLDEST as the first sighting,
-- fold the group size into its counter, close the rest.
WITH grouped AS (
  SELECT id,
         FIRST_VALUE(id) OVER w AS keep_id,
         COUNT(*)        OVER w AS group_size,
         MAX(created_at) OVER w AS newest
  FROM ${prefix}contradiction_signals
  WHERE surfaced = FALSE
  WINDOW w AS (PARTITION BY user_id, fact_key, md5(stored_value) ORDER BY created_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
)
UPDATE ${prefix}contradiction_signals c
SET repeat_count = grouped.group_size,
    last_seen_at = grouped.newest
FROM grouped
WHERE c.id = grouped.keep_id AND grouped.group_size > 1;

WITH grouped AS (
  SELECT id, FIRST_VALUE(id) OVER w AS keep_id
  FROM ${prefix}contradiction_signals
  WHERE surfaced = FALSE
  WINDOW w AS (PARTITION BY user_id, fact_key, md5(stored_value) ORDER BY created_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
)
UPDATE ${prefix}contradiction_signals c
SET surfaced = TRUE
FROM grouped
WHERE c.id = grouped.id AND c.id <> grouped.keep_id;

-- md5 rather than the raw value: stored_value is sliced to 500 chars on write
-- and a btree tuple caps at 2704 bytes, so multi-byte text can overflow the
-- index on a value that inserted fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}contradiction_open_dedup
  ON ${prefix}contradiction_signals (user_id, fact_key, md5(stored_value))
  WHERE surfaced = FALSE;

-- Why a signal fired. "The model judged these separate claims" and "the model
-- never answered in time" both let a signal through, and only one of them is
-- evidence about memory. Nullable and deliberately NOT backfilled: a pre-
-- migration row genuinely has no verdict behind it, and inventing one would put
-- a lie in the data.
ALTER TABLE ${prefix}contradiction_signals
  ADD COLUMN IF NOT EXISTS gate_path       TEXT,
  ADD COLUMN IF NOT EXISTS gate_similarity NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS gate_reason     TEXT;

COMMENT ON COLUMN ${prefix}contradiction_signals.gate_path IS
  'Which branch decided: below_floor | gate_separate | timeout | gate_error | user_correction. NULL = pre-migration.';
COMMENT ON COLUMN ${prefix}contradiction_signals.gate_similarity IS
  'Cosine between the new and stored value. NOT a same-claim score — embeddings are negation-blind.';
COMMENT ON COLUMN ${prefix}contradiction_signals.repeat_count IS
  'Sightings of this same disagreement. created_at stays the FIRST sighting.';
