-- bwmem 009: session texture carryover
--
-- Memory hands the agent facts across sessions but not MOMENTUM — every reopen
-- is a cold start of the felt sense and replies land competent-but-not-cohesive.
-- This table captures the THROUGHLINE (what was being worked through) and the
-- EMOTIONAL REGISTER (the felt tone) at session close, so the next session in
-- the same relationship can lead with an anchor.
--
-- captureTexture(sessionId) is fire-and-forget on session end. A slow LLM call
-- or a failure never blocks the session ending — "no texture" is always valid.
--
-- getTextureForPrompt(userId, mode, speaker) returns a RAW anchor block (NOT
-- written in the agent's voice — the agent responds to it naturally). A 72h
-- freshness taper drops anything older than that; a stale texture pretending
-- to be fresh is worse than none.
--
-- Keyed by (mode, speaker) so different relationships (e.g., the user vs a
-- maintainer agent) carry separately.

CREATE TABLE IF NOT EXISTS ${prefix}session_textures (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             VARCHAR(255) NOT NULL,
  session_id          UUID,
  mode                TEXT NOT NULL DEFAULT 'default',
  speaker             TEXT NOT NULL DEFAULT 'user',
  throughline         TEXT NOT NULL,
  emotional_register  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}session_textures_recent
  ON ${prefix}session_textures (user_id, mode, speaker, created_at DESC);
