-- 014: the temporal event index — make ordering questions a SORT.
--
-- Semantic search cannot answer "who did I meet first, Mark and Sarah or Tom?".
-- One query embedding cannot sit near three different events at once, so no
-- value of k retrieves them all, and decomposing the question into per-entity
-- searches measures WORSE: narrow sub-queries fall under the similarity floor.
-- Benchmarked on LongMemEval: session recall 96.5% @k=25 while accuracy on
-- ordering and elapsed-time questions stalled around 70%.
--
-- The fix is structural. Extract (subject, predicate, occurred_on) at
-- consolidation time so those questions become ORDER BY instead of a search.
-- Measured +11.4pp on that question class, no change to any other.
--
-- The load-bearing column is `occurred_on`: WHEN THE EVENT HAPPENED, not when
-- it was mentioned. "Emma graduated yesterday", said on 2023-05-20, stores
-- 2023-05-19. Conflating the two is the single easiest way to make an ordering
-- index useless — it reduces to "sort by when we talked about it".

CREATE TABLE IF NOT EXISTS ${prefix}temporal_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT        NOT NULL,
  session_id    TEXT,

  subject       TEXT        NOT NULL,
  predicate     TEXT        NOT NULL,
  object        TEXT,
  summary       TEXT        NOT NULL,

  -- NULL when the date genuinely could not be resolved. Never guessed, and
  -- never defaulted to the conversation date: a wrong date sorts wrongly and
  -- is worse than an absent one, which can at least be filtered.
  occurred_on   DATE,
  precision     TEXT        NOT NULL DEFAULT 'unknown'
                  CHECK (precision IN ('day', 'month', 'year', 'unknown')),

  -- When it was SAID, kept alongside so "how long ago did I tell you" and
  -- "how long ago did it happen" stay answerable separately.
  mentioned_on  DATE,
  is_range_end  BOOLEAN     NOT NULL DEFAULT FALSE,
  confidence    REAL        NOT NULL DEFAULT 0.5,

  embedding     vector(${dimensions}),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The ordering read.
CREATE INDEX IF NOT EXISTS idx_${prefix}temporal_user_date
  ON ${prefix}temporal_events (user_id, occurred_on);

-- Entity lookup. lower() because a subject arrives however the speaker wrote it.
CREATE INDEX IF NOT EXISTS idx_${prefix}temporal_user_subject
  ON ${prefix}temporal_events (user_id, lower(subject));

CREATE INDEX IF NOT EXISTS idx_${prefix}temporal_session
  ON ${prefix}temporal_events (session_id);

-- Select semantically THEN sort. Sorting first and truncating returns the
-- oldest events rather than the relevant ones.
CREATE INDEX IF NOT EXISTS idx_${prefix}temporal_embedding
  ON ${prefix}temporal_events USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Re-consolidating a session must not double the timeline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}temporal_dedup
  ON ${prefix}temporal_events (
    user_id, lower(subject), lower(predicate),
    COALESCE(occurred_on, DATE '0001-01-01'),
    md5(summary)
  );

COMMENT ON COLUMN ${prefix}temporal_events.occurred_on IS
  'When the event HAPPENED, resolved against the conversation date. NULL when undeterminable — never guessed.';
COMMENT ON COLUMN ${prefix}temporal_events.mentioned_on IS
  'When it was said. Kept separate from occurred_on so both elapsed-time questions stay answerable.';
