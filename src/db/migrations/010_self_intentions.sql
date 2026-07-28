-- bwmem 010: self-intentions — held things-to-do with daily surfacing
--
-- A primitive for "the agent (or a user, if you expose it that way) names
-- something they mean to do, and the system mirrors it back one a day until
-- it lands or is let go." Explicitly NOT a gate or a guilt trip — silence
-- between surfaces is fine. After DEFER_LIMIT deferrals the "not now" option
-- disappears: do-or-let-go, because the honest move is to stop pretending
-- it will happen.
--
-- API:
--   saveIntention(userId, intention, note?)          — deliberate capture.
--   resolveIntention(userId, 'done'|'let_go', opts?) — close out.
--   listOpen(userId)                                  — review/management.
--   getIntentionForPrompt(userId, tz)                 — surface event with
--     side effects: bumps defer_count after the first surface, marks
--     last_surfaced_at. Call once per day from the wake/idle loop.

CREATE TABLE IF NOT EXISTS ${prefix}self_intentions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            VARCHAR(255) NOT NULL,
  intention          TEXT NOT NULL,
  note               TEXT,
  status             TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'done' | 'let_go'
  defer_count        INTEGER NOT NULL DEFAULT 0,
  first_surfaced_at  TIMESTAMPTZ,
  last_surfaced_at   TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolution         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}self_intentions_open
  ON ${prefix}self_intentions (user_id, status, created_at);
