-- 013: texture is per RELATIONSHIP, and the channel is part of that.
--
-- Textures were keyed (user_id, mode, speaker) and appended, with a freshness
-- taper deciding what surfaced. Two problems that only show up in use:
--
--   * the same person over a different channel is a different register. How a
--     conversation felt over voice does not carry to text, and blending them
--     produces a throughline that matches neither.
--   * append-only means the taper is doing retention's job. Rows accumulate
--     forever and the "latest" read walks history it will never use.
--
-- Adding `channel` to the key and keeping exactly one row per relationship
-- makes the read a single indexed lookup and the retention rule explicit.

ALTER TABLE ${prefix}session_textures
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'default';

-- Collapse to the newest row per (user_id, mode, speaker, channel).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, mode, speaker, channel
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM ${prefix}session_textures
)
DELETE FROM ${prefix}session_textures t
USING ranked
WHERE t.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}session_textures_relationship
  ON ${prefix}session_textures (user_id, mode, speaker, channel);

COMMENT ON COLUMN ${prefix}session_textures.channel IS
  'Surface the exchange happened on (web/voice/telegram/...). Part of the relationship key: the same person over a different channel is a different register.';
