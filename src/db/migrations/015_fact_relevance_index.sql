-- 015: make fact retrieval query-aware.
--
-- getUserFacts orders by mention_count and cuts at `limit`. That ordering is
-- query-INDEPENDENT: the same facts are returned on every turn whether the user
-- asked about their cat or about Docker, and a fact mentioned once or twice can
-- never enter the window however relevant it is right now. An LLM curation pass
-- over the result cannot rescue it either — it only re-ranks the rows it is
-- handed, so it can never reach outside the window.
--
-- searchRelevantFacts() adds facts that lexically overlap the caller's query on
-- top of that core set (additive — the core is never displaced). This index
-- backs its filter.
--
-- Lexical rather than vector on purpose: facts are very short strings ("Max",
-- "06:00", "pitbulls"), cosine over short text is length-biased enough to be
-- unreliable, and it would mean embedding and re-embedding the whole store.
-- Splitting the key's underscores is what makes it work — "cat_name" -> "cat
-- name" is where most of the topic signal lives, because many fact VALUES are
-- bare tokens carrying no topic at all.
--
-- The expression MUST stay character-identical to `filter` in
-- FactsService.searchRelevantFacts, or Postgres will silently seq-scan. Note
-- the ranking there uses a *weighted* (setweight A/B) vector; only this
-- unweighted one is indexed, and only it appears in the WHERE clause.

CREATE INDEX IF NOT EXISTS ${prefix}facts_relevance_fts
  ON ${prefix}facts
  USING GIN (to_tsvector('english', replace(fact_key, '_', ' ') || ' ' || fact_value));

-- Companion for the live-set filter both read paths apply before ranking.
CREATE INDEX IF NOT EXISTS ${prefix}facts_live_by_user
  ON ${prefix}facts (user_id)
  WHERE fact_status = 'active';
