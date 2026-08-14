-- 017: `surfaced` was a display counter that the whole codebase read as a decision.
--
-- The table had exactly one piece of state: `surfaced BOOLEAN`. It was flipped
-- true by markSurfaced once a signal had been DISPLAYED in two sessions:
--
--     surfaced = CASE WHEN array_length(surfaced_session_ids, 1) >= 2 THEN TRUE ...
--
-- So "shown twice" was the only way a contradiction ever left the queue. Nobody
-- ever decided anything. Every reader — the dedup index, the retrieval filter,
-- the partial index from 012 — treated `surfaced = FALSE` as "still outstanding"
-- and therefore `surfaced = TRUE` as "dealt with", and 012's own comment says so
-- out loud: "the index is partial on surfaced = FALSE, so a RESOLVED signal never
-- blocks a genuine recurrence later." There was no resolved signal. There was no
-- way to make one: the public API exposed getUnsurfaced() and nothing else, so a
-- consumer could read the queue and could never close anything on it.
--
-- The counts that followed were not slightly wrong, they were structurally
-- impossible: "resolved contradictions" could only ever be zero, and a signal
-- that got looked at twice and ignored was indistinguishable from one that was
-- actually settled.
--
-- Three states now, and `surfaced` goes back to meaning only what it measures.
--
--   open     - outstanding. Nobody has decided.
--   held     - deliberately set aside. NOT a decision, and it LAPSES: when the
--              underlying fact moves off the value that was held, the row
--              returns to open on its own. A hold is about right now.
--   resolved - decided, and the decision is recorded. See the CHECK below.

ALTER TABLE ${prefix}contradiction_signals
  ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS decision    TEXT,
  ADD COLUMN IF NOT EXISTS resolution  TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  -- The stored_value as it was when the hold was taken. This is the whole
  -- mechanism behind a lapsing hold: compare it to the fact's live value and a
  -- hold that has been overtaken by events reopens itself.
  ADD COLUMN IF NOT EXISTS held_at_value TEXT;

-- DROP-then-ADD rather than a DO/EXCEPTION block: `splitStatements` in the
-- migrator says in its own doc comment that it handles no PL/pgSQL bodies, and
-- it would cut a `DO $$ ... $$` in half at the first inner semicolon. It only
-- runs on files containing CONCURRENTLY, so a DO block here would be fine today
-- and would break the day someone adds a concurrent index to this file.
ALTER TABLE ${prefix}contradiction_signals
  DROP CONSTRAINT IF EXISTS ck_${prefix}contradiction_status;
ALTER TABLE ${prefix}contradiction_signals
  ADD CONSTRAINT ck_${prefix}contradiction_status
  CHECK (status IN ('open', 'held', 'resolved'));

-- A resolve must say WHICH VALUE WON. This is the same lesson migration 016
-- wrote down for fact collisions: a close-out that records only a free-text note
-- is a mute, not a decision — nothing can read it, so nothing downstream changes
-- and the row is merely hidden. `resolution` stays free text for the human
-- reason; `decision` is the part a machine can act on.
--
--   user_stated - what the user said now was right; the stored fact was wrong
--   stored      - the stored fact was right; the user misspoke or misremembered
--   neither     - both wrong, or the question dissolved
ALTER TABLE ${prefix}contradiction_signals
  DROP CONSTRAINT IF EXISTS ck_${prefix}contradiction_decision;
ALTER TABLE ${prefix}contradiction_signals
  ADD CONSTRAINT ck_${prefix}contradiction_decision
  CHECK (decision IS NULL OR decision IN ('user_stated', 'stored', 'neither'));

ALTER TABLE ${prefix}contradiction_signals
  DROP CONSTRAINT IF EXISTS ck_${prefix}contradiction_resolved_has_decision;
ALTER TABLE ${prefix}contradiction_signals
  ADD CONSTRAINT ck_${prefix}contradiction_resolved_has_decision
  CHECK (status <> 'resolved' OR decision IS NOT NULL);

-- Backfill. Every previously-surfaced row becomes HELD, never resolved.
--
-- Resolving them would be inventing a decision nobody made — the exact failure
-- this migration exists to correct, committed one last time on the way out. What
-- actually happened to these rows is that they were shown twice and muted, so
-- `held` is the truthful state, and because a hold lapses, any of them still
-- live against a fact that has since moved will come back on its own instead of
-- staying buried.
UPDATE ${prefix}contradiction_signals
   SET status        = 'held',
       held_at       = COALESCE(last_seen_at, created_at),
       hold_reason   = 'auto:pre-0.7.0 display suppression (shown twice, never decided)',
       held_at_value = stored_value
 WHERE surfaced = TRUE
   AND status = 'open';

-- The dedup guard from 012 keyed on `surfaced = FALSE`, which meant a signal
-- dropped out of the guard as soon as it had been displayed twice and the next
-- sighting opened a duplicate row. Keyed on status, an open disagreement keeps
-- collapsing into one row and bumping its counter for as long as it is open —
-- which is what "count the disagreement, not the mentions" was supposed to mean.
DROP INDEX IF EXISTS idx_${prefix}contradiction_open_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}contradiction_open_dedup
  ON ${prefix}contradiction_signals (user_id, fact_key, md5(stored_value))
  WHERE status = 'open';

DROP INDEX IF EXISTS idx_${prefix}contradictions_unsurfaced;
CREATE INDEX IF NOT EXISTS idx_${prefix}contradictions_open
  ON ${prefix}contradiction_signals (user_id, created_at DESC)
  WHERE status = 'open';

-- The lapse sweep runs on the read path, so it has to be an index probe rather
-- than a scan of every signal the user ever generated.
CREATE INDEX IF NOT EXISTS idx_${prefix}contradictions_held
  ON ${prefix}contradiction_signals (user_id, fact_key)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS idx_${prefix}contradictions_resolved
  ON ${prefix}contradiction_signals (user_id, resolved_at DESC)
  WHERE status = 'resolved';

COMMENT ON COLUMN ${prefix}contradiction_signals.status IS
  'open | held | resolved. Lifecycle state. NOT the same axis as `surfaced`.';
COMMENT ON COLUMN ${prefix}contradiction_signals.surfaced IS
  'DISPLAY bookkeeping only: has this been shown to the user. Never read this as "dealt with" — that is `status`, and conflating the two is what 017 fixed.';
COMMENT ON COLUMN ${prefix}contradiction_signals.decision IS
  'user_stated | stored | neither. Which value won. Required to resolve, so a close-out cannot be a mute.';
COMMENT ON COLUMN ${prefix}contradiction_signals.held_at_value IS
  'stored_value at the moment of holding. A hold lapses when the live fact no longer matches it.';
