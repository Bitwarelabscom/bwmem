-- 018: keyword search over messages, so retrieval stops being vector-only.
--
-- Recall was a single signal: cosine similarity over message embeddings. That
-- has a specific and measurable failure — embeddings are good at topic and bad
-- at rare literal tokens. A question naming a proper noun, a model number, an
-- amount or a spelling the user coined once is exactly the case where lexical
-- search wins and vectors return "things that feel related".
--
-- The measured symptom was a precision/recall bind with no good answer. Tighten
-- the cosine floor and multi-session questions starve; loosen it and the
-- prompt fills with loosely-related turns and single-turn questions degrade.
-- Both arms of that trade are a consequence of ranking by ONE signal, and
-- neither is fixed by tuning the floor.
--
-- Facts have had this since migration 015. Messages — the primary recall
-- substrate — never got it.

-- The unweighted expression is what the GIN index can serve, and the query has
-- to use the identical expression or the planner will not use the index. Keep
-- these two in sync; migration 015 has the same constraint for facts.
CREATE INDEX IF NOT EXISTS idx_${prefix}messages_fts
  ON ${prefix}messages
  USING GIN (to_tsvector('english', content));

-- Recall over a user's messages is always user-scoped, and the FTS index alone
-- leaves that filter to a separate scan.
CREATE INDEX IF NOT EXISTS idx_${prefix}messages_user_created
  ON ${prefix}messages (user_id, created_at DESC);

COMMENT ON INDEX idx_${prefix}messages_fts IS
  'Keyword arm of hybrid recall. Query MUST use to_tsvector(''english'', content) verbatim to hit this index.';
