-- bwmem 008: response quality scoring
--
-- Per-response scoring with cheap deterministic signals plus an optional
-- periodic LLM self-check. The metric is deliberately SPLIT into two numbers
-- so engagement noise (how fast the user replies, how long their reply is)
-- does not drag down the agent's self-score:
--
--   output_integrity     — the agent's own quality: relevance, coherence,
--                          memory_fidelity, generativity, completeness_honesty.
--                          A response can score 1.0 here even if the user goes
--                          silent for an hour.
--
--   interaction_vitality — engagement signal (mostly the user's): reply speed,
--                          reply length, feedback class. Real signal — but not
--                          a quality score and never written in the agent's
--                          voice as "you did poorly."
--
-- composite_score is kept for back-compat and mirrors output_integrity.
--
-- scoreResponse() fires when an assistant message is saved (the deterministic
-- floor). resolveFollowup() fills in the vitality side when the user replies.
-- runQualitySelfCheck() periodically samples recent responses and asks a
-- light LLM the questions that only the agent can be graded on
-- (memory_fidelity / generativity / completeness_honesty).

CREATE TABLE IF NOT EXISTS ${prefix}message_quality (
  message_id            UUID PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  session_id            UUID NOT NULL,
  mode                  TEXT,
  scored_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  followup_resolved_at  TIMESTAMPTZ,
  scores                JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_integrity      NUMERIC(4,3),
  interaction_vitality  NUMERIC(4,3),
  composite_score       NUMERIC(4,3),
  self_check_at         TIMESTAMPTZ,
  explicit_feedback     TEXT
);

CREATE INDEX IF NOT EXISTS idx_${prefix}message_quality_user_scored
  ON ${prefix}message_quality (user_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_${prefix}message_quality_session
  ON ${prefix}message_quality (session_id, scored_at DESC);

-- Sampling target for the periodic self-check job: rows that have a
-- deterministic floor but no LLM self-check yet.
CREATE INDEX IF NOT EXISTS idx_${prefix}message_quality_selfcheck
  ON ${prefix}message_quality (user_id, scored_at DESC)
  WHERE output_integrity IS NOT NULL AND self_check_at IS NULL;
