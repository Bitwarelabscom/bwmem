-- 016: the cross-key collision — two memories, each internally tidy, about the
-- same thing, and mutually exclusive.
--
-- Every guard this SDK has compares a NEW value against the OLD value of the
-- SAME fact_key: the contradiction gate, the paraphrase gate, the merge gate,
-- the key-axis merge, the pruner. All of them keyed on fact_key. So two rows
-- under DIFFERENT keys can each be internally coherent, each be marked active,
-- and flatly contradict one another, and nothing ever looks.
--
-- The shape that motivated it, from the system this was extracted from: a pet
-- named Gaia was filed as `cat_name_gaia='Gaia'` and `cat_names='Nalla, Gaia,
-- Max'` while also being filed as `dog_names='Nalla and Gaia'` and
-- `dog_behavior_gaia='Gaia is the troublemaker'` — all fact_status='active' at
-- once, for weeks, and the assistant called her a cat and a dog on alternate
-- days depending on which row retrieval surfaced.
--
-- WHAT THIS TABLE IS NOT. Nothing here ever writes to the facts table. It never
-- merges, never deletes, never picks a winner. Which of two coherent rows is
-- wrong is a judgement — the store has no evidence either way, both rows were
-- asserted in good faith — so this raises the pair and leaves acting on it to
-- the caller.
--
-- Deliberately not folded into contradiction_signals. That table's shape is
-- (fact_key, stored_value, user_stated, gate_path): one key, one thing newly
-- said, one gate verdict. A collision has no "newly said" and no gate behind
-- it, so every column would be a lie — and consumers count unresolved signals
-- there as recall drift, which collisions would inflate.

CREATE TABLE IF NOT EXISTS ${prefix}fact_category_collisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR(255) NOT NULL,
  -- The proper noun both sides claim, spelled as the facts spell it ('Gaia').
  subject       text NOT NULL,
  -- What the categories are alternatives OF ('species'), so the row reads as a
  -- sentence rather than as a pair of prefixes.
  family        text NOT NULL,
  -- Sorted, so {cat,dog} and {dog,cat} are one collision and not two.
  categories    text[] NOT NULL,
  -- The colliding rows AS THEY WERE when this was raised. Kept because it may
  -- be read hours later, after the underlying rows have moved on.
  fact_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Sorted fact_keys, joined: the identity of this collision. Settle it without
  -- changing anything (two genuinely different Gaias) and re-detection finds
  -- the same signature and stays quiet. A new colliding fact changes the
  -- signature and opens a fresh row — a new thing to look at, not a repeat.
  signature     text NOT NULL,
  -- open     — raised, waiting on a human
  -- settled  — closed by hand, with the side that was kept
  -- resolved — the underlying facts stopped colliding, so it closed itself
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'settled', 'resolved')),
  -- Which side was kept, in the family's vocabulary ('dog'). Set only by
  -- settleCollision. Required there, and the reason is the whole design:
  --
  --   A settle that records only a NOTE is a mute, not a decision. The refresh
  --   pass is gated on status='open', so a settled row with an unchanged key
  --   set never re-raises — even while every losing-side row stays active and
  --   keeps being retrieved. One settle whose note claimed the cat rows "had
  --   been corrected" (they had not) hid five live wrong rows for 23 hours.
  --
  --   And because identity is the key LIST, correcting a fact CHANGES the
  --   signature and mints a brand-new open row. So acting on a clash brought
  --   the flag back, and doing nothing made it vanish forever. Exactly
  --   backwards.
  --
  -- With a decision on record the sweep stops re-raising the clash and surfaces
  -- the RESIDUE instead: the still-active facts that contradict the decision. A
  -- list that shrinks as it is corrected and drops off the surface on its own.
  decided_category text,
  decided_at       timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at  timestamptz NOT NULL DEFAULT NOW(),
  seen_count    integer NOT NULL DEFAULT 1,
  closed_at     timestamptz,
  settled_note  text
);

-- One row per (subject, signature) per user, forever — including after it
-- closes. That is what makes a settled collision stay settled rather than
-- re-raising on every pass: the upsert collides with the closed row and does
-- nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}fact_collisions_identity
  ON ${prefix}fact_category_collisions (user_id, subject, signature);

CREATE INDEX IF NOT EXISTS idx_${prefix}fact_collisions_open
  ON ${prefix}fact_category_collisions (user_id, last_seen_at DESC)
  WHERE status = 'open';

-- The lookup the refresh does on every pass: is there a standing decision for
-- this (subject, family)? Subject is compared case-insensitively everywhere in
-- the module, so the index is too.
CREATE INDEX IF NOT EXISTS idx_${prefix}fact_collisions_decision
  ON ${prefix}fact_category_collisions (user_id, family, lower(subject), decided_at DESC)
  WHERE decided_category IS NOT NULL;
