# @bitwarelabs/bwmem

[![npm](https://img.shields.io/npm/v/@bitwarelabs/bwmem?logo=npm)](https://www.npmjs.com/package/@bitwarelabs/bwmem)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%2B%20pgvector-4169E1?logo=postgresql&logoColor=white)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

Memory SDK for AI chatbots. Gives your bot persistent, per-user memory: bi-temporal facts, semantic search, emotional capture, contradiction detection, quality scoring, session-texture carryover, held intentions, knowledge graph, and multi-stage consolidation.

Drop it into any chatbot — record messages, build context, inject into your LLM prompt. The SDK handles fact extraction, embeddings, sentiment analysis, response quality scoring, and long-term memory consolidation in the background.

**v0.9.1 — retrieval defaults are now the measured best, and four features that
looked finished were not.** Building a benchmark harness that drives this package
through its own public API surfaced things no amount of reading the code would
have: the temporal index had **no write path at all**, so `[Timeline]` could only
ever render nothing; every timeline date was **one day early**; every message was
**embedded twice**; and `recordMessage` could not carry a timestamp, so importing
history collapsed a whole corpus onto the import instant.

Also in this line: retrieval defaults set to the configuration that scored highest
on LongMemEval rather than to cautious round numbers (recall depth 5 → 25, cosine
floor 0.25 → 0.5, the hardcoded 300-character clip off), and a `bulkImport` session
mode for backfilling history that cuts LLM calls per message roughly 4×.

Run migration 017. See [What's new in 0.9.0](#whats-new-in-090),
[0.8.0](#whats-new-in-080) and [0.7.0](#whats-new-in-070).

**Earlier:** 0.7.0 gave contradictions a lifecycle they can actually leave and made
truncated LLM output an error rather than a silently-parsed prefix. 0.6.0 added
cross-key collision detection and made `temporary` facts actually expire. 0.5.x
added same-claim merge gates on the key and value axes, contradiction signals that
count the disagreement rather than the mentions, a timeline index, and per-channel
session texture — and fixed intent scoping, which was a filter that silently hid
every scoped fact from the context the SDK exists to build.

## Features

- **Bi-temporal facts** — facts track both *valid-time* (when something was true in the world) and *transaction-time* (when we believed it). Lets you answer "what did we believe on date Y about state on date X?" not just "what was true on date Y."
- **Fact extraction** — automatically extracts structured facts from conversations (name, job, preferences, relationships, career signals)
- **Semantic dedup** — exact-key dedup + embedding-based similarity collapse for autonomous save paths that re-emit the same idea under different keys
- **Volatile/ephemeral guards** — fact keys like `current_*`, schedules, sleep/wake times, and speaker references are caught structurally so they cannot bleed across sessions or generate spurious contradiction signals
- **Semantic search** — find similar messages and conversations via pgvector embeddings
- **Emotional capture** — detects high-emotion moments using VAD (Valence-Arousal-Dominance) analysis with specific descriptive tags
- **Contradiction detection** — both async (on fact supersession) and **inline** (real-time, zero-I/O scan during message ingestion), with stopword and volatile-key filtering to dampen false positives
- **Contradiction lifecycle** — open / held / resolved, where a resolve must name which value won and a hold lapses when the underlying fact moves. Replaces a display flag that no code path could ever turn into a resolution (0.7.0)
- **Benchmarked retrieval defaults** — recall depth, cosine floor, clipping and ordering are set to the configuration that scored highest on LongMemEval, not to cautious round numbers. All overridable per call (0.8.0)
- **Bulk import** — `startSession({ bulkImport: true })` for backfilling existing history: ~4x fewer LLM calls per message, with per-turn timestamps so imported conversations keep their real dates (0.9.0)
- **Truncation is an error** — providers read `finish_reason` and refuse to hand back a cut-off completion, instead of returning a prefix that regex-and-`JSON.parse` will happily store as a finished answer (0.7.0)
- **Quality scoring** — per-response scoring split into `output_integrity` (the agent's own quality: relevance, coherence, memory fidelity, generativity, completeness) and `interaction_vitality` (engagement: reply speed, length, feedback class). Engagement noise no longer drags down the agent's self-score.
- **Session texture** — captures the *throughline* (what was being worked through) and *emotional register* of a session at close; surfaces as an anchor on the next session in the same (mode, speaker) pair. Hands the next session momentum, not just facts.
- **Self-intentions** — held things-to-do with deliberate save, daily surfacing, and a 3-deferral do-or-let-go ceiling. Mirror, not gate.
- **Memory consolidation** — episodic (per-session), daily, and weekly consolidation pipelines
- **Conversation summaries** — auto-generated summaries with topic extraction
- **Context builder** — aggregates 11 memory sources into a single formatted prompt injection
- **Same-claim gates** — decision-compatibility adjudication on the key and value axes (0.5.0)
- **Timeline index** — ordering and elapsed-time questions become a sort, not a search (0.5.0)
- **Cross-key collisions** — the guard every other check is blind to: one subject filed under two categories that cannot both be true, each row internally coherent (0.6.0)
- **Knowledge graph** — Neo4j integration with schema-constrained entity relationships (27 types), entity-to-entity edges, and entity-scoped subgraphs
- **Provider-agnostic** — works with OpenAI, Ollama, OpenRouter, or any custom provider
- **REST API** — Fastify-based multi-tenant API with API key auth, rate limiting, usage tracking, and Swagger docs

## Benchmark

Memory systems are easy to describe and hard to verify, so the system bwmem was
extracted from is measured against
[LongMemEval](https://github.com/xiaowu0162/LongMemEval), the standard
long-term-memory benchmark.

| System | Reader | k | Score |
|---|---|---|---|
| **bwmem (this package)** | deepseek-v4-flash-0731 | 25 | **71.7%** ‡ |
| **bwmem's parent stack** | deepseek-v4-pro | 25 | **81.7%** |
| **bwmem's parent stack** | gpt-4o | 25 | **78.3%** |
| **bwmem's parent stack** | deepseek-v4-flash | 25 | **70.0%** † |
| bwmem's parent stack | gpt-4o | 8 | 65.0% |
| bwmem's parent stack | deepseek-v4-flash | 8 | 60.0% |
| Zep *(self-reported)* | — | — | 63.8–71.2% |
| Full-context gpt-4o *(published)* | — | — | ~60% |
| mem0 *(self-reported)* | — | — | ~49% |

**‡ This is the first row that is actually bwmem.** Every other row is the parent
stack. It was produced by driving this package through its own public API —
`startSession` / `recordMessage` / `session.end()` / `buildContext()`, installed
from npm, no direct SQL — with its shipped defaults and nothing hand-tuned for the
benchmark. 60 questions, 29,568 turns ingested, 0 empty answers, 0 truncated.

It is **not** a like-for-like win over the 70.0% below it. Read against that run's
corrected figure (80.8% over the answers it actually produced) bwmem is *behind*,
and 43-vs-42 is one question — inside the ±2 point error bar either way. The
readers are also near-neighbours rather than identical, so treat the headline
numbers as "same range".

The category split is the part worth reading, because it is not noise:

| | bwmem | parent stack |
|---|---|---|
| temporal-reasoning | **81.2%** | 62.5% |
| multi-session | 37.5% | **56.2%** |
| knowledge-update | 66.7% | 66.7% |
| single-session (all) | 100% / 100% / 75% | 100% / 100% / 50% |

bwmem is **much better at temporal questions** — that is the `[Timeline]` block,
which the parent-stack run reached through a hand-written query in the harness and
bwmem now emits itself. It is **much worse at multi-session questions**, where the
answer has to be assembled from several conversations. That is the honest weak
spot: retrieval over per-message embeddings finds the right *turns* but does not
gather a *conversation*, and it is the obvious next thing to work on.

**† That 70.0% is wrong, and it is wrong in our favour to leave uncorrected.**
Re-examining the run, **8 of 60 answers came back completely empty** and all 8 were
judged incorrect. Over the answers the model actually produced the score is
**42/52 = 80.8%**. The cause was the harness, not the memory layer: it capped
answers at 300 tokens and discarded `finish_reason`, and deepseek-v4-flash is
reasoning-first — reasoning tokens are emitted before any content and consume the
same budget, so the reader spent the cap thinking and returned nothing. The empty
responses were still billed. The other two readers had zero empties, which is why
only this row looked bad. The harness now escalates the cap and reports empty and
truncated counts separately from the score.

Run conditions: a 60-question stratified subset of LongMemEval_S (cleaned), judged
by the official `gpt-4o-2024-08-06` judge, seed `20260803`. That is **not** the
full set, and the baselines are full-set numbers — so this is indicative, not
like-for-like. The honest reading is "same league as Zep," not "beats Zep."

The top three rows are a clean reader comparison: all three received
**byte-identical retrieved context on all 60 questions** — same retrieval, same
questions, only the reading model changed. That isolates the memory layer from
model quality, which is the number worth having. It also means the open-weights
reader beat gpt-4o on the same context for roughly a quarter of the cost
(**$0.09 vs $0.32** across the 60 questions).

**The error bar is about ±2 points.** Re-running the 81.7% configuration unchanged
produced 83.3% — one question different. Any single run of anything on this
benchmark, ours included, should be read with that in mind.

### Why the caveats are in the README and not in a footnote

Most of the high scores on this benchmark come from arXiv preprints. They are
**self-reported, not peer-reviewed, and — as far as we can find — never
independently replicated.** Run the benchmark yourself against those systems and
you tend to get a different number than the one on the chart. Treat every
published memory-benchmark score, including this one, as a claim about a specific
harness rather than a property of the system.

What we can say about ours: we ran it, on our own hardware, and the harness,
seed, judge and subset are stated above so it can be checked.

**Benchmark numbers move a lot.** From our own runs — same 60 questions, same
judge, same afternoon — scores ranged from **55.0% to 85.0%**, varying only by
reader model and retrieval configuration. Recall depth alone (k from 8 to 25) is
worth 13 points. An earlier run of the identical harness scored **15.0%**; that
turned out to be three bugs, not an architecture — the episodic tier was silently
dropping conversational text, retrieval was recency-only because nothing ever
wrote the embeddings it was supposed to rank by, and entity extraction was a regex
that promoted words like "Remember" to entities. A number without its harness
tells you very little.

### What was measured, precisely

bwmem is extracted from a full, running AI agent, and the score above was measured
on that agent's memory layer — same retrieval architecture (pgvector + bge-m3
cosine recall over consolidated episodic content), same fact model, same
consolidation staging. bwmem should land in the same range for that reason.

**bwmem has now been put through the harness as a package** — see the 71.7% row and
its footnote. The adapter that does it drives only the public API, so what it
measures is what `npm install @bitwarelabs/bwmem` gives you, defaults included.
The remaining rows are still the parent stack's.

## Requirements

- Node.js >= 18
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension
- Redis
- Neo4j (optional, for knowledge graph)

## Install

```bash
npm install @bitwarelabs/bwmem
```

## Quick Start

```typescript
import { BwMem } from '@bitwarelabs/bwmem';
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

const mem = new BwMem({
  postgres: 'postgresql://localhost/myapp',
  redis: 'redis://localhost:6379',
  embeddings: provider,
  llm: provider,
});

await mem.initialize();

// Start a conversation
const session = await mem.startSession({ userId: 'user-123' });

// Record messages (fact extraction + embeddings run in background)
await session.recordMessage({ role: 'user', content: 'I live in Tokyo and work at SakuraTech.' });
await session.recordMessage({ role: 'assistant', content: 'Nice! What do you do there?' });
await session.recordMessage({ role: 'user', content: 'I lead the ML perception team.' });

// Build memory context for your LLM prompt
const context = await mem.buildContext('user-123', { query: 'Tell me about yourself' });

const response = await provider.chat([
  { role: 'system', content: `You are helpful.\n\n${context.formatted}` },
  { role: 'user', content: 'What do you know about me?' },
]);

// End session (triggers episodic consolidation + texture capture)
await session.end();
await mem.textures.capture(session.id); // anchor for the next session

await mem.shutdown();
```

## What's new in 0.9.0

### `bulkImport` — backfilling history is a different shape from a live chat

The per-message pipeline assumes a live conversation, where one extra LLM call per
turn is invisible. Importing a corpus runs that same work thousands of times in a
burst, and then the LLM calls — not the database — set the wall clock. Measured
against LongMemEval, a live-mode import ran at **0.42 messages/sec**, about six days
for that corpus.

```typescript
const session = await mem.startSession({ userId, bulkImport: true });
```

| kept | skipped |
|---|---|
| embeddings, session centroid, fact extraction, direct-correction contradiction signals, end-of-session episodic + temporal passes | per-message sentiment, emotional-moment capture, LLM behavioural contradiction detection |

Roughly a **4× cut in LLM calls per message** (measured 0.42 → 3.20 msg/s on the
same corpus and hardware). Sentiment is the one that matters: it ran on *every*
message and nothing in retrieval reads it — it exists to gate emotional-moment
capture, which an import skips too.

The cost, stated rather than buried: imported messages carry no sentiment scores and
record no emotional moments, so a context built over import-only history has an empty
"Recent Emotional Moments" block. That is the right trade for a backfill and the
wrong one for a live session, which is why it is per-session and defaults to `false`.

### Messages can carry their own timestamp

```typescript
await session.recordMessage({ role: 'user', content: '...', timestamp: '2023-05-14T09:30:00Z' });
```

Required for importing history. Without it every backfilled message is dated at
import time, which collapses the corpus onto one instant — recall ordering, the
timeline, and every "when did I…" question then answer about the import run rather
than about the conversation.

### The temporal index had no write path

`extract()` and `store()` were public methods on the temporal service and **nothing
in the package called either one**. `temporal_events` stayed empty forever, so the
`[Timeline]` block could only ever render nothing. The feature was configurable,
documented, and structurally inert. Events are now extracted on `session.end()`, and
`temporalIndex` defaults to **on** — opt-in to a feature with no write path was a
distinction without a difference.

### Timeline dates were all one day early

`occurred_on` is a `DATE`. node-postgres parses `DATE` to *local* midnight, and the
renderer did `new Date(...).toISOString().slice(0,10)`, which converts to UTC — so
anywhere east of Greenwich every event displayed one day before the date actually
stored. The database was right and the prompt was wrong. Rendered with `to_char` in
SQL now.

### Every message was embedded twice

`storeMessageEmbedding()` generated an embedding and returned `void`; the next
statement called `generate()` again on the identical string to update the session
centroid. Two paid embeddings per message to recompute a value already in hand.

### Fact extraction had an unbounded input (0.9.1)

The prompt asks for *all* facts, so output length tracks input length — and the input
was every user message in the batch, joined, at any size. On a corpus with long turns
that produced 28,000 characters of JSON against an 8,000-token ceiling and truncated
every time. Raising the cap cannot fix an unbounded input; the input is now bounded
too (12,000 characters, newest kept).

## What's new in 0.8.0

### Retrieval defaults are now the ones that scored highest

The defaults were conservative round numbers. They are now the benchmarked
configuration, because a memory SDK whose defaults are worse than its own
measured best is shipping the wrong thing.

| Setting | Was | Now | Why |
|---|---|---|---|
| `maxSimilarMessages` (recall depth) | 5 | **25** | k=8 scored 65.0%, k=25 scored 78.3% — same reader, same corpus. Depth alone was worth 13 points, and 5 is below even the losing arm. |
| `similarityThreshold` | 0.25 | **0.5** | At depth 25 a loose floor spends the budget on weak matches. The floor is what makes depth pay off instead of adding noise. |
| clipping of recalled text | 300 chars, hardcoded | **off** (`clipRecalledChars: 0`) | 58% of stored passages are longer than 300 chars, so most of what retrieval found was cut before the model saw it — and the ellipsis reads like a summary rather than a loss. |
| ordering of recalled text | by similarity | **oldest-first** (`chronologicalRecall`) | Similarity order scatters one conversation across the prompt. Chronological order is what lets a reader tell which of two conflicting values came later. |
| `[Timeline]` block | not wired in | **on** (`includeTimeline`) | The temporal index existed but was never reachable from `buildContext`. |

Each is overridable per call. If you were relying on the old behaviour, set
`{ maxSimilarMessages: 5, similarityThreshold: 0.25, clipRecalledChars: 300, chronologicalRecall: false }`.

Recalled messages now carry their date inline (`- [2024-03-05] "..."`), since a
reader cannot order what it cannot see.

### Session expansion is available and off, and that is a measured result

Pulling every turn of the sessions your top hits landed in is an appealing idea —
vector search returns isolated turns, and "who graduated first, Emma or Rachel"
needs the conversation around each hit. On LongMemEval it **lost 6.6 points**
(78.3% → 71.7%) while making the prompt 5.7× larger and 5× more expensive. The
extra turns crowd out the ranked evidence.

It is exposed as `expandSessions: N` because it may still pay off on corpora with
much shorter sessions than the benchmark's. Measure before trusting it.

### The timeline block is wired into `buildContext`

`[Timeline]` selects events semantically, then sorts them chronologically —
sorting first and taking the top N returns the *oldest* N, which on a real corpus
is dominated by incidental world facts and evicts the personal events the question
is about. It self-gates on whether the query looks temporal, so it costs one
embedding call only on questions that can use it.

In the benchmark's best run this is where the points were: temporal-reasoning
**93.8%** and knowledge-update **100%**, against 62.5% and 66.7% on a run without
it.

## What's new in 0.7.0

### Contradictions could never be resolved

The `contradiction_signals` table had exactly one piece of state: `surfaced BOOLEAN`. It was flipped true once a signal had been **displayed** in two sessions:

```sql
surfaced = CASE WHEN array_length(surfaced_session_ids, 1) >= 2 THEN TRUE ...
```

So "shown twice" was the only way a contradiction ever left the queue. Nobody ever decided anything. Every reader — the dedup index, the retrieval filter, the partial index added in 0.5.0 — treated `surfaced = FALSE` as "still outstanding" and therefore `surfaced = TRUE` as "dealt with". Migration 012's own comment says it out loud: *"the index is partial on surfaced = FALSE, so a **resolved** signal never blocks a genuine recurrence later."* There was no resolved signal, and no way to make one: the public API exposed `getUnsurfaced()` and nothing else, so a consumer could read the queue and could never close anything on it.

The counts that followed weren't slightly wrong, they were structurally impossible. "Resolved contradictions" could only ever be zero, and a signal looked at twice and ignored was indistinguishable from one that had actually been settled.

There are three states now, and `surfaced` goes back to meaning only what it measures:

| State | Meaning |
|-------|---------|
| `open` | Outstanding. Nobody has decided. |
| `held` | Deliberately set aside. **Not** a decision, and it **lapses** — see below. |
| `resolved` | Decided, with the decision recorded. |

```typescript
// Read the queue
const open = await mem.contradictions.getOpen(userId, sessionId);

// Close one — `decision` is required
await mem.contradictions.resolve(userId, id, 'user_stated', 'they moved in June');

// Or set it aside without deciding
await mem.contradictions.hold(userId, id, 'ask them in person');

await mem.contradictions.counts(userId); // { open: 3, held: 1, resolved: 7 }
```

`getUnsurfaced()` still works and delegates to `getOpen()`. The old name described the filter it applied, and that filter was the bug.

### A resolve has to say which value won

`decision` is required, and that's the design: `'user_stated' | 'stored' | 'neither'` names which value won, so something downstream can act on the outcome. This is the same lesson 0.6.0 wrote into fact collisions — a close-out carrying only a free-text note is a **mute dressed as a decision**, because nothing can read prose. The note is optional and is where the prose goes.

### A hold lapses when the fact moves

A hold is pinned to the value it was taken against (`held_at_value`). Once the live fact no longer says what it said when the row was held, the reason for holding is gone and the signal returns to `open` on its own. Without that, a hold would be indistinguishable from a resolve — both make the row disappear, and only one of them was a decision. The sweep runs on the read path, so a caller cannot forget it.

Upgrading from 0.6.x, every previously-surfaced row becomes **held**, never resolved. Resolving them would be inventing a decision nobody made — the exact failure this release exists to correct. And because holds lapse, any of them still live against a fact that has since moved will come back on their own rather than staying buried.

### Truncated LLM output is no longer silently parsed

Every provider ended `chat()` with `?? ''` and discarded the finish reason, so a completion that hit its token ceiling came back as a valid-looking prefix and got `JSON.parse`d as if it were whole. See [Truncation is an error, not a value](#truncation-is-an-error-not-a-value) and [Reasoning models and small token budgets](#reasoning-models-and-small-token-budgets).

## What's new in 0.6.0

### A bug that made "temporary" meaningless

A fact typed `temporary` with no `valid_until` was **immortal**. Both expiry
paths required `valid_until IS NOT NULL`, and only present-tense `current_*`
keys ever get a TTL stamped on write — while the extraction prompt tells the
model to type a fact `temporary` whenever a state is transient, and to leave
`validUntil` unset when the state has no clear end ("doing evenings for a
while"). So every transient fact whose key was not present-tense-shaped lived
forever.

On the install this was found on: **579 active `temporary` rows, zero carrying a
TTL, 400 of them older than fourteen days** — including eighteen mutually
exclusive vacation states, all active, all believed at once ("on vacation" from
February sitting beside "no more vacation" from July).

Expiry now has a second branch, tunable and reversible:

```typescript
await mem.facts.expireTemporary();      // 30 days untended, the default
await mem.facts.expireTemporary(7);     // stricter
await mem.facts.expireTemporary(Infinity); // old behaviour: valid_until only
```

Age is measured from `COALESCE(last_mentioned, updated_at, created_at)`.
`last_mentioned` bumps on re-assertion and never on read, so a state still being
said out loud stays live and is not swept. Note the trade this makes: the type
is set by the extractor and is sometimes wrong, so this **will** expire a
durable fact that was mistyped. That is a status flip, never a delete.

### Cross-key collisions

Every guard in this SDK compares a new value against the old value of the **same
`fact_key`** — the contradiction gate, the paraphrase gate, the merge gate, the
key-axis merge, the pruner. So two rows under *different* keys can each be
internally coherent, both be marked active, and flatly contradict one another,
and nothing ever looks.

The shape that motivated it: a pet named Gaia filed as `cat_name_gaia='Gaia'`
and `cat_names='Nalla, Gaia, Max'` while also filed as `dog_names='Nalla and
Gaia'` and `dog_behavior_gaia='Gaia is the troublemaker'` — every row active, for
weeks. The assistant called her a cat or a dog depending on which row retrieval
happened to surface.

```typescript
const { open, residues } = await mem.collisions.refresh(userId);
// open[0]  -> "Gaia is filed as a cat and as a dog", with both sides' rows

await mem.collisions.settle(userId, 'Gaia', 'They are dogs.', 'dog');
// -> { settled: 1, family: 'species', residue: [cat_names, cat_name_gaia] }
```

**Nothing here writes to your facts table.** It never merges, never deletes and
never picks a winner — which of two coherent rows is wrong is a judgement the
store has no evidence for, since both were asserted in good faith. It raises the
pair; `facts.store` / `facts.remove` are how you act on it.

**Settling requires the side you kept, and that is the design.** A settle that
records only a note is a *mute*: it suppresses the flag while every losing-side
row stays active and retrievable. One such settle claimed the wrong rows had
been corrected — they had not, and five wrong rows stayed live for 23 hours with
the surface showing nothing. And because a collision's identity is its key list,
*correcting* a fact changed the signature and minted a fresh alarm: acting on a
clash brought it back, doing nothing made it vanish forever. Exactly backwards.

With a decision on record the clash is never re-raised. What surfaces instead is
the **residue** — the still-active facts that contradict the decision — which
shrinks as you correct them and drops off the surface on its own. `settle`
returns that residue as measured at the moment you settled, so a settle can no
longer quietly hide anything.

The default axis (cat vs dog) is a demonstration, not your domain. Supply your
own:

```typescript
const mem = new BwMem({
  ...,
  exclusiveFamilies: [{
    name: 'employment',
    members: { employed: ['employer', 'employed'], retired: ['retired', 'retirement'] },
  }],
});
```

Keep any family **narrow**. Members must be genuine alternatives — one subject
cannot be both without one row being false. Categories that merely differ
(`pet` vs `dog`; a dog *is* a pet) produce a flag that is wrong on every pass,
and a surface that cries wolf is worse than no surface at all.

### The merge gate says *which kind* of separation

`compatible: false` has always meant two different things at once, and a
contradiction surface reading only that flag cannot tell them apart. The gate now
also returns `separation`:

- `different_question` — the new statement answers something the key never asked
  (a role where the key names a company). Nothing is being contradicted, and the
  paraphrase gate reports it on its own `gate_different_question` path.
- `conflicting_answer` — both statements answer the key and disagree. A real
  value swap.

`null` means the model did not say, and null never suppresses: an older model, a
truncated reply or a prompt regression must not be able to discount a
contradiction by omission.

## What's new in 0.5.0

### Two bugs from earlier releases

**Duplicate active facts.** `storeFact` scoped its dedup lookup to
`(user_id, category, fact_key, intent_id, fact_type)`. Any of those changing
between two mentions of the same claim missed the lookup and inserted a parallel
"currently believed" row. Measured on a production install: **51% of active rows
were duplicates**, with one key holding 25 concurrent values. Identity is now
`(user_id, fact_key)` alone, enforced by a partial unique index. Migration 011
collapses existing duplicates — it supersedes rather than deletes, so the
bi-temporal history survives.

**`detectInline` over-fired.** It paired every concept-matching fact with the
first capitalized word anywhere in the message: no proximity rule, no cap, no
dedup. One message produced **35 phantom contradictions**. It now requires the
candidate to sit within a clause of the concept token, emits at most three, never
repeats a key — and is **opt-in**, because it remains a heuristic with no model
behind it:

```typescript
const mem = new BwMem({ ..., inlineContradictions: true });
```

### Same-claim merge gates

Cosine similarity cannot decide whether two statements are the same claim.
Measured on a 1024-dim embedder: a paraphrase pair scored **0.80**, while a
negation ("likes the quiet" / "is afraid of the quiet") scored **0.85** and a
value swap scored **0.87**. Real contradictions sit *above* paraphrases —
embeddings are negation-blind, so no threshold separates them.

So cosine only prunes, and an LLM gate decides, using decision-compatibility
(DeMem, arXiv 2605.10870): two statements may share a fact slot iff treating them
as one could never change what the assistant should do or say.

One gate governs both axes:

- **value axis** — is this supersession real drift, or the same thing reworded?
  Stops the contradiction counter climbing on a stable memory.
- **key axis** — has the extractor minted a *new key* for a claim already held?
  (`learning_style_visual`, then `visual_learning`, then …) Measured: 129 active
  keys sharing one prefix in a single day.

Both fail **open**: embedder down, LLM down, timeout, unparseable — the write
proceeds as it did before. A duplicate row is recoverable; a dropped fact is not.

```typescript
const mem = new BwMem({ ..., factKeyMerge: true });  // default
```

### Contradiction signals carry provenance

One open row per `(user, fact_key, stored_value)`; a repeat bumps `repeat_count`
instead of filing a new alarm. `created_at` stays the **first** sighting, so
"this has been wrong since Tuesday" remains answerable.

Each signal records *why* it fired — `gate_path`, `gate_similarity`,
`gate_reason`. "The model judged these separate" and "the model never answered in
time" both let a signal through, and only one is evidence about memory.

### Timeline index for ordering questions

Semantic search structurally cannot answer *"who did I meet first, Mark and Sarah
or Tom?"* — one query embedding cannot sit near three events at once, and
decomposing into per-entity searches measures **worse** (narrow sub-queries fall
under the similarity floor).

Extracting `(subject, predicate, occurred_on)` at consolidation makes those
questions an `ORDER BY`. Measured **+11.4pp** on that question class.

The load-bearing rule: `occurred_on` is when the event **happened**, resolved
against the conversation date — not when it was mentioned. Conflating them
reduces the index to "sort by when we talked about it".

```typescript
const mem = new BwMem({ ..., temporalIndex: true });  // off by default: one LLM call per session
```

### Session texture is per channel

How a conversation felt over voice does not carry to text. `channel` is now part
of the relationship key, and the write is a single upsert — the old
DELETE-then-INSERT was not atomic, so a concurrent read between them saw no
texture at all and opened the next session cold.

## What's new in 0.3.0

### Bi-temporal facts

Every fact now carries two time axes:

- `validFrom` / `validUntil` — when the fact was true in the world (existing)
- `recordedAt` — when we first wrote this belief
- `supersededAt` — when we stopped believing it (NULL while believed)

```typescript
// "What did we believe at txn time about state at valid time?"
const past = await mem.facts.getAsOf(
  'user-123',
  new Date('2026-03-01'),  // asOfValidTime
  new Date('2026-04-01'),  // asOfTxnTime
);
```

The supersession path stamps `supersededAt = NOW()` and writes a row to `fact_corrections` — an append-only audit log of every belief change.

### Semantic dedup + volatile guards

```typescript
// Embedding-based dedup for autonomous loops that re-save the same idea.
const match = await mem.facts.findSimilar('user-123', 'I prefer dark mode in my editor');
if (match) {
  await mem.facts.touchMention(match.id);   // collapse the new write
} else {
  await mem.facts.store({ /* ... */ });      // genuinely new
}
```

Three structural guards run before storage:

```typescript
import { isSpeakerFact, isEphemeralFactKey, isVolatileFactKey } from '@bitwarelabs/bwmem';

isSpeakerFact('current_speaker')       // true — drop, never persist
isEphemeralFactKey('current_drink')    // true — force to 12h temporary
isVolatileFactKey('work_schedule')     // true — store but no contradiction signal
```

### Inline contradiction detection

A pure-synchronous, zero-I/O scan during message ingestion. **Opt-in since
0.5.0** — see the 0.5.0 notes for why.

```typescript
const mem = new BwMem({ ..., inlineContradictions: true });
const facts = await mem.facts.get('user-123');
const inlines = mem.contradictions.detectInline(message.content, facts);
// inlines[0] = { factKey: 'partner_name', storedValue: 'Alice', suspectedValue: 'Beth' }
```

A stopword filter excludes sentence-initial words ("I", "My", "The", "Hey", …),
volatile keys are skipped, the candidate must sit within a clause of the concept
token, and at most three are returned.

### Quality scoring

Per-response scoring split into two honest numbers:

```typescript
// Phase 1: deterministic floor at message save
await mem.quality.scoreResponse({
  messageId, userId, sessionId, mode, responseContent,
});

// Phase 2: interaction vitality at user reply
await mem.quality.resolveFollowup({
  userId, sessionId,
  previousAssistantMessageId, previousAssistantCreatedAt,
  nextUserContent, nextUserCreatedAt,
});

// Phase 3: periodic LLM self-check (cron)
await mem.quality.runSelfCheck(8);

// Aggregate
const stats = await mem.quality.getStats('user-123', { since });
// → { averageOutputIntegrity: 0.83, averageInteractionVitality: 0.41, ... }
```

`output_integrity` is the agent's own quality (relevance, coherence, memory_fidelity, generativity, completeness_honesty). `interaction_vitality` is engagement (reply speed, length, feedback class). Reply latency never touches integrity.

### Session texture

Captures the throughline + emotional register of a session at close, surfaces it as an anchor on the next session in the same (mode, speaker) pair.

```typescript
// On session end:
await mem.textures.capture(sessionId, { mode: 'companion', speaker: 'user' });

// On next session open (or inside buildContext with includeSessionTexture):
const anchor = await mem.textures.getForPrompt('user-123', {
  mode: 'companion', speaker: 'user',
});
// → "Where you left off (companion session, 3h ago):
//      Throughline: figuring out whether to push the launch by a week
//      Emotional register: tense, problem-solving, edging toward decisive"
```

Captures are fire-and-forget — they never block a session ending. 72h freshness taper.

### Self-intentions

Held things-to-do with daily surfacing and a 3-deferral do-or-let-go ceiling.

```typescript
await mem.intentions.save('user-123', 'Reach out to old mentor', 'After the launch settles');

// Once per day in your wake/idle loop (SIDE EFFECT: bumps defer_count):
const prompt = await mem.intentions.getPrompt('user-123', { timezone: 'Europe/Stockholm' });

await mem.intentions.resolve('user-123', 'done');     // or 'let_go' — same dignity
const open = await mem.intentions.listOpen('user-123');
```

## REST API

v0.5.0 retains the multi-tenant REST API layer.

### Running the API

```bash
docker compose up -d
# or
npm run start:api
```

### Configuration

```env
PORT=3420
DATABASE_URL=postgresql://bwmem:password@localhost:5432/bwmem
REDIS_URL=redis://:password@localhost:6379
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-large
OPENROUTER_CHAT_MODEL=anthropic/claude-3.5-haiku
OPENROUTER_EMBEDDING_DIMENSIONS=1536
ADMIN_API_KEY=your-admin-key-min-32-chars
API_KEY_PEPPER=your-secret-pepper
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password
```

### Endpoints

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer <key>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/sessions` | Start a session |
| `POST` | `/sessions/:id/end` | End a session |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `POST` | `/messages` | Record a message |
| `GET` | `/context?userId=&query=` | Build memory context |
| `GET` | `/search?userId=&query=&type=` | Semantic search |
| `GET` | `/facts/:userId` | Get facts (`?asOfTxnTime=&asOfValidTime=` for bi-temporal) |
| `POST` | `/facts` | Store a fact |
| `DELETE` | `/facts/:factId` | Delete a fact |
| `GET` | `/facts/:userId/search?query=` | Search facts |
| `GET` | `/emotions/:userId` | Emotional moments |
| `GET` | `/contradictions/:userId` | Open contradictions |
| `GET` | `/contradictions/:userId/counts` | Open / held / resolved counts |
| `POST` | `/contradictions/:userId/:id/resolve` | Close with a decision (required) |
| `POST` | `/contradictions/:userId/:id/hold` | Set aside without deciding |
| `POST` | `/quality/score` | Score a response (phase 1) |
| `POST` | `/quality/followup` | Resolve followup (phase 2) |
| `GET` | `/quality/:userId/stats` | Quality aggregates |
| `GET` | `/textures/:userId` | Latest session texture row |
| `GET` | `/textures/:userId/prompt` | Texture as prompt anchor |
| `POST` | `/textures` | Capture texture for a session |
| `GET` | `/intentions/:userId` | List open intentions |
| `GET` | `/intentions/:userId/all` | List all intentions |
| `GET` | `/intentions/:userId/prompt` | Surface oldest open (side effect) |
| `POST` | `/intentions` | Save a new intention |
| `POST` | `/intentions/resolve` | Resolve (done / let_go) |
| `DELETE` | `/intentions/:id` | Resolve as let_go |
| `POST` | `/consolidate` | Trigger consolidation (admin) |
| `GET` | `/summary/:sessionId` | Conversation summary |
| `GET` | `/graph/:userId` | Knowledge graph |
| `POST` | `/admin/tenants` | Create tenant (admin) |
| `GET` | `/admin/tenants` | List tenants (admin) |
| `PATCH` | `/admin/tenants/:id` | Update tenant (admin) |

### Usage Tiers

| Tier | Users | Embeddings/mo | Rate limit | Price |
|------|-------|--------------|-----------|-------|
| Tester | 1 | 1,500 | 10 req/min | Free |
| Hobby | 1 | 30,000 | 30 req/min | $4/mo |
| Builder | 10 | 300,000 | 60 req/min | $29/mo |
| Enterprise | Custom | Custom | Custom | Contact us |

### Response Format

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "message", "code": "ERROR_CODE" }
```

Embedding quota headers on every response:
- `X-Embedding-Limit` — monthly embedding quota
- `X-Embedding-Remaining` — remaining embeddings this month

### Example

```bash
# Create a tenant
curl -X POST https://api.bitwarelabs.com/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "email": "dev@example.com", "tier": "builder"}'

# Use the returned API key
curl -X POST https://api.bitwarelabs.com/api/v1/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1"}'

curl -X POST https://api.bitwarelabs.com/api/v1/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "role": "user", "content": "My name is Vera and I live in Gothenburg"}'

# Bi-temporal query
curl "https://api.bitwarelabs.com/api/v1/facts/user-1?asOfTxnTime=2026-04-01T00:00:00Z" \
  -H "Authorization: Bearer $API_KEY"

# Quality stats
curl "https://api.bitwarelabs.com/api/v1/quality/user-1/stats" \
  -H "Authorization: Bearer $API_KEY"
```

## Providers

All three bundled providers implement both `EmbeddingProvider` and `LLMProvider`, so a single instance handles both. The OpenRouter provider includes exponential backoff retry for 429/5xx errors.

### OpenAI

```typescript
import { OpenAIProvider } from '@bitwarelabs/bwmem/providers/openai';

const provider = new OpenAIProvider({
  apiKey: 'sk-...',
  model: 'gpt-4o-mini',                    // default
  embeddingModel: 'text-embedding-3-small', // default
  embeddingDimensions: 1024,                // default
});
```

### Ollama (local, free)

```typescript
import { OllamaProvider } from '@bitwarelabs/bwmem/providers/ollama';

const provider = new OllamaProvider({
  baseUrl: 'http://localhost:11434',  // default
  model: 'llama3',                    // default
  embeddingModel: 'nomic-embed-text', // default
  embeddingDimensions: 768,           // default
});
```

### OpenRouter (200+ models)

```typescript
import { OpenRouterProvider } from '@bitwarelabs/bwmem/providers/openrouter';

const provider = new OpenRouterProvider({
  apiKey: 'sk-or-...',
  model: 'anthropic/claude-3.5-haiku',        // default
  embeddingModel: 'qwen/qwen3-embedding-8b',  // default
  embeddingDimensions: 1024,                   // default
  reasoning: false,                            // default — see below
});
```

### Truncation is an error, not a value

Every provider used to end `chat()` with `?? ''` and throw the finish reason away. That is silent data loss with a very specific shape, and it is worth describing because the same shape will be in your own provider if you wrote one.

A completion that hits its token ceiling comes back as a **prefix** — valid-looking, just cut off — with HTTP 200, a populated `content`, and no error field anywhere. `finish_reason: 'length'` is the only signal the model was still talking. Thirteen call sites in this package run `JSON.parse` on the result, and four of those pull a fragment out with a regex first. A regex is perfectly happy to find a complete-looking object inside an abandoned draft, so a half-finished thought parses clean and gets stored as a finished answer. Nothing errors, and the bad value is now indistinguishable from a good one.

As of 0.7.0 all three providers check the finish reason and throw `TruncatedCompletionError` instead of returning the prefix:

```typescript
import { TruncatedCompletionError } from '@bitwarelabs/bwmem';

try {
  await provider.chat(messages, { maxTokens: 200 });
} catch (err) {
  if (err instanceof TruncatedCompletionError) {
    err.partialContent; // what the model managed before it was cut off
    err.finishReason;   // 'length' | 'max_tokens' | ...
    err.maxTokens;      // the cap that was hit
  }
}
```

The error is deliberately **not** retryable — the same request with the same cap truncates identically. Raise `maxTokens` or shorten the prompt.

### Reasoning models and small token budgets

Reasoning tokens are emitted **before** any content and count against the same `max_tokens`. Every internal caller here asks for a small, deliberate budget — 30 tokens for an emotion label, 120 for a merge gate, 200 for a quality score — which is correct and cheap on a normal model and produces **nothing at all** on a reasoning one: the budget is spent thinking, and you get `''` with `finish_reason: 'length'`.

None of this package's prompts benefit from reasoning; they are extraction and classification with a fixed output shape. So:

- **OpenRouter** sends `reasoning: { enabled: false }` by default. Much of its free tier is reasoning-first, which is where this bites hardest. Pass `reasoning: true` to opt back in.
- **Ollama** sends `think` only when you set it explicitly, because Ollama rejects the field on models that do not support thinking. Set `think: false` on a thinking model (deepseek-r1, qwen3, ...).

### Custom provider

```typescript
import type { EmbeddingProvider, LLMProvider } from '@bitwarelabs/bwmem';
import { assertComplete } from '@bitwarelabs/bwmem';

const myProvider: EmbeddingProvider & LLMProvider = {
  dimensions: 1024,
  async generate(text) { /* return number[] */ },
  async generateBatch(texts) { /* return number[][] */ },
  async chat(messages, options?) {
    // ... call your API ...
    // Run the same guard the bundled providers use: a provider that returns
    // truncated text silently reintroduces the bug for every caller above it.
    return assertComplete({
      provider: 'MyProvider',
      content: choice.message.content ?? '',
      finishReason: choice.finish_reason,
      maxTokens: options?.maxTokens,
    });
  },
};
```

## API Reference

### `BwMem`

#### `new BwMem(config)`

```typescript
const mem = new BwMem({
  postgres: 'postgresql://localhost/mydb',
  redis: 'redis://localhost:6379',
  embeddings: provider,          // EmbeddingProvider (required)
  llm: provider,                 // LLMProvider (required)
  graph: neo4jGraph,             // GraphPlugin (optional)
  consolidation: {
    enabled: true,               // default: true
    daily: '0 2 * * *',         // default: 2 AM daily
    weekly: '0 3 * * 0',        // default: 3 AM Sundays
  },
  session: {
    inactivityTimeoutMs: 300_000, // default: 5 minutes
  },
  tablePrefix: 'bwmem_',         // default
  logger: console,               // default: built-in console logger
});
```

#### `mem.initialize()`

Connects to PostgreSQL and Redis, runs migrations (creates tables + pgvector extension), starts the consolidation scheduler if enabled.

#### `mem.startSession(config): Promise<Session>`

```typescript
const session = await mem.startSession({
  userId: 'user-123',
  metadata: { source: 'web' },
});
```

#### `mem.buildContext(userId, options?): Promise<MemoryContext>`

Aggregates 11 sources in parallel, each guarded by a per-source timeout.

```typescript
const context = await mem.buildContext('user-123', {
  query: 'What does the user do for work?',
  sessionId: session.id,        // exclude current session from similar-message search
  maxFacts: 30,
  maxSimilarMessages: 5,
  similarityThreshold: 0.25,
  timeoutMs: 5000,
  mode: 'companion',             // session-texture selector
  speaker: 'user',
  includeSessionTexture: true,   // default true
  includeIntentionPrompt: false, // default false — surfacing has side effects
  timezone: 'Europe/Stockholm',  // for the intention daily gate
});

// context.formatted — ready to inject into your system prompt
// context.facts — array of Fact objects
// context.sessionTexture — anchor block, if any
// context.intentionPrompt — daily surface, if requested and due
// context.sourcesResponded — e.g. "11/11"
```

#### `mem.facts`

```typescript
const facts = await mem.facts.get('user-123', { category: 'work', limit: 30 });

const asOf = await mem.facts.getAsOf(
  'user-123',
  new Date('2026-03-01'),  // valid time
  new Date('2026-04-01'),  // txn time (default: now)
);

await mem.facts.store({
  userId: 'user-123', category: 'preference',
  key: 'editor', value: 'VS Code',
  intentId: null,        // unscoped fact (default)
});

const match = await mem.facts.findSimilar('user-123', 'I love VS Code', { threshold: 0.9 });
if (match) await mem.facts.touchMention(match.id);

const results = await mem.facts.search('user-123', 'programming tools');
await mem.facts.remove(factId);

// Sweep temporaries: past valid_until, plus untimed ones untended for N days
// (default 30). Without that second branch an untimed temporary never expires.
await mem.facts.expireTemporary();
```

**Fact categories:** `personal`, `work`, `preference`, `hobby`, `relationship`, `goal`, `context`

#### `mem.collisions`

One subject filed under two categories that cannot both be true. Reads facts;
never writes them.

```typescript
// Detect, file and close in one pass. Run it on a schedule.
const { open, raised, resolved, residues } = await mem.collisions.refresh('user-123');

const clashes = await mem.collisions.list('user-123');          // open only
const all     = await mem.collisions.list('user-123', true);    // including closed
const n       = await mem.collisions.countOpen('user-123');

// Closing one REQUIRES the side you kept — a note alone is a mute, not a
// decision. Returns what still contradicts it, measured right then.
const { residue, error } = await mem.collisions.settle(
  'user-123', 'Gaia', 'They are dogs; the cat rows are wrong.', 'dog',
);

// Every decision on record, measured against the facts as they are now.
const standing = await mem.collisions.residues('user-123');
```

`settle` returns `error` instead of recording anything when the category is not
one of your configured families — a typo would otherwise mint a decision whose
residue is every row on the subject, which reads like a repair list and is
nothing of the kind.

#### `mem.contradictions`

```typescript
// Persisted (async, written on supersession)
const signals = await mem.contradictions.getUnsurfaced('user-123', sessionId);

// Inline (real-time, zero-I/O)
const inlines = mem.contradictions.detectInline(currentMessage, await mem.facts.get('user-123'));
```

#### `mem.quality`

```typescript
await mem.quality.scoreResponse({ messageId, userId, sessionId, mode, responseContent });
await mem.quality.resolveFollowup({
  userId, sessionId,
  previousAssistantMessageId, previousAssistantCreatedAt,
  nextUserContent, nextUserCreatedAt,
});
await mem.quality.runSelfCheck(8); // periodic
const stats = await mem.quality.getStats('user-123', { since });
```

#### `mem.textures`

```typescript
await mem.textures.capture(sessionId, { mode: 'companion', speaker: 'user' });
const prompt = await mem.textures.getForPrompt('user-123', { mode: 'companion', speaker: 'user' });
const latest = await mem.textures.getLatest('user-123', { mode: 'companion', speaker: 'user' });
```

#### `mem.intentions`

```typescript
const id = await mem.intentions.save('user-123', 'Reach out to old mentor');
const prompt = await mem.intentions.getPrompt('user-123', { timezone: 'Europe/Stockholm' });
await mem.intentions.resolve('user-123', 'done');
const open = await mem.intentions.listOpen('user-123');
const all = await mem.intentions.listAll('user-123');
```

#### `mem.emotions`

```typescript
const moments = await mem.emotions.getRecent('user-123', 7, 10); // last 7 days, max 10
```

#### `mem.behavioral`

```typescript
const observations = await mem.behavioral.getActive('user-123');
```

#### `mem.summaries`

```typescript
const summary = await mem.summaries.getForSession(sessionId);
```

#### `mem.searchMessages(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchMessages('user-123', 'machine learning', 5, 0.25);
```

#### `mem.searchConversations(userId, query, limit?, threshold?)`

```typescript
const results = await mem.searchConversations('user-123', 'work discussion', 3, 0.2);
```

#### `mem.triggerConsolidation(type)`

```typescript
await mem.triggerConsolidation('daily');
await mem.triggerConsolidation('weekly');
```

#### `mem.shutdown()`

Closes all connections and stops the consolidation scheduler.

### `Session`

#### `session.recordMessage(input): Promise<Message>`

Records a message and triggers background processing:

```typescript
const msg = await session.recordMessage({
  role: 'user',
  content: 'I just moved to Berlin.',
});
```

**Background processing** (fire-and-forget):
- Embedding generation + storage
- Sentiment analysis (VAD model)
- Fact extraction (every 3 user messages) with semantic dedup
- LLM contradiction detection against all stored facts
- Emotional moment capture with descriptive tagging
- Session centroid update
- Knowledge graph sync (entities + relationships)

#### `session.flush(): Promise<void>`

Wait for all pending background processing to complete.

#### `session.end(): Promise<void>`

Ends the session and triggers episodic consolidation (pattern extraction + conversation summary).

#### `session.getMessages(): Promise<Message[]>`

Returns all messages in the session with sentiment data.

## Knowledge Graph

```typescript
import { Neo4jGraph } from '@bitwarelabs/bwmem/graph';

const graph = new Neo4jGraph({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});

const mem = new BwMem({ /* ... */ graph });
```

Facts are automatically synced to Neo4j as schema-constrained entity relationships.

### Relationship Types

| Type | Source Keys | Target Type |
|------|-----------|-------------|
| `NAMED` | name, nickname | name |
| `WORKS_AT` | employer, company | organization |
| `PREVIOUSLY_AT` | past_employer | organization |
| `WORKS_AS` | job_title, role, profession | role |
| `WORKS_ON` | current_project, project | project |
| `LIVES_IN` | location, city, country | place |
| `PREVIOUSLY_IN` | past_location | place |
| `PARTNER_OF` | partner, wife, husband | person |
| `PARENT_OF` | child, daughter, son | person |
| `SIBLING_OF` | sibling, brother, sister | person |
| `COLLEAGUE_OF` | colleague, coworker | person |
| `FRIEND_OF` | friend | person |
| `OWNS` | pet, pet_name | animal |
| `ENJOYS` | interest, hobby, sport | activity |
| `STUDIES` | field, major, degree | field |
| `STUDIES_AT` | university, school | organization |
| `AIMS_FOR` | goal, career_change | goal |
| `RUNS` | business, partner_business | organization |
| `LIKES` / `DISLIKES` | food, favorite / dislike, allergy | thing |

Entity-scoped facts (e.g., `partner_job: chef`) create edges FROM that entity (e.g., `Erik → HAS_ROLE → chef`).

### Entity Validation

Not every fact value becomes a graph entity. The graph pipeline filters out:
- Pure numbers and percentages
- Phrases longer than 6 words
- Descriptive text that isn't a named entity

## Consolidation

Three-stage memory consolidation pipeline:

### Episodic (on session end)

When `session.end()` is called:
1. Extracts patterns from the session (themes, mood shifts, key moments, preference signals)
2. Generates a conversation summary with embedding
3. Stores patterns in `episodic_patterns` table

### Daily (cron or manual)

Runs at 2 AM by default:
1. Aggregates recent episodic patterns into semantic knowledge
2. Merges with existing knowledge (preferences, known facts, behavioral baselines)
3. Expires old behavioral observations

### Weekly (cron or manual)

Runs at 3 AM Sundays by default:
1. Reviews all semantic knowledge for consistency
2. Cross-references with stored facts
3. Prunes outdated or low-confidence entries
4. Syncs to knowledge graph (if enabled)

## Database

The SDK auto-creates all tables on `initialize()` via migrations. Tables are prefixed with `bwmem_` by default.

**Core (mig 001):**
| Table | Purpose |
|---|---|
| `sessions` | Session tracking with active/ended state |
| `messages` | Messages with pgvector embeddings and VAD sentiment |
| `facts` | Structured facts with full bi-temporal lifecycle |
| `conversation_summaries` | Auto-generated session summaries with embeddings |

**Resonant (mig 002):**
| Table | Purpose |
|---|---|
| `emotional_moments` | High-emotion messages with descriptive tags |
| `contradiction_signals` | Behavioral and factual contradictions |
| `behavioral_observations` | Behavioral pattern observations |

**Consolidation (mig 003):**
| Table | Purpose |
|---|---|
| `consolidation_runs` | Audit log of all consolidation jobs |
| `episodic_patterns` | Patterns extracted per session |
| `semantic_knowledge` | Long-term aggregated knowledge |

**API layer (mig 004-006):**
| Table | Purpose |
|---|---|
| `api_tenants` | Tenant accounts with API keys and tier limits |
| `api_usage` | Per-tenant usage tracking |

**Bi-temporal + audit (mig 007, v0.3.0):**
| Column / Table | Purpose |
|---|---|
| `facts.recorded_at` | Transaction-time start (when we first wrote this row) |
| `facts.superseded_at` | Transaction-time end (NULL while believed) |
| `facts.intent_id` | Optional intent scope (same key, different values per conversation) |
| `fact_corrections` | Append-only audit log of every supersession |

**Quality scoring (mig 008, v0.3.0):**
| Table | Purpose |
|---|---|
| `message_quality` | Per-response `output_integrity` + `interaction_vitality` |

**Fact dedup, contradiction provenance, texture channel, timeline (migs 011-014, v0.5.0):**

| Migration | What it does |
|---|---|
| `011_fact_dedup` | collapses duplicate active facts; `(user_id, fact_key)` unique-active index |
| `012_contradiction_dedup` | `repeat_count` / `last_seen_at`; gate verdict columns; open-signal dedup index |
| `013_session_texture_channel` | adds `channel` to the relationship key |
| `014_temporal_events` | the timeline index |

**Session texture + intentions (mig 009-010, v0.3.0):**
| Table | Purpose |
|---|---|
| `session_textures` | Throughline + emotional register at session close |
| `self_intentions` | Held things-to-do with daily surfacing and defer ceiling |

## Security (API layer)

- API key auth with HMAC-SHA256 hashing and server-side pepper
- Timing-safe admin key comparison
- Tenant data isolation via userId prefixing
- Per-tenant rate limiting (Redis-backed, tier-aware)
- Bounded auth cache with automatic invalidation
- Rate limiter fails closed on Redis failure
- CORS allowlist in production, Swagger disabled in production
- Request body size limit (1MB), session cap per tenant
- Non-root Docker container, localhost-only DB ports
- Security headers via nginx (HSTS, CSP, X-Frame-Options)

## Architecture

```
User Message
    │
    ▼
Session.recordMessage()
    │
    ├──▶ Store message in PostgreSQL
    │
    ├──▶ Inline contradiction scan (sync, zero-I/O)
    │
    └──▶ Background processing (fire-and-forget)
           ├── Generate embedding → store with pgvector
           ├── Sentiment analysis (VAD) → store scores
           ├── Fact extraction → dedup (exact + semantic) → store facts
           │     ├── Drop speaker / current_* / volatile keys
           │     └── Stamp supersession audit row on belief change
           ├── LLM contradiction detection → flag conflicts
           ├── Emotional moment capture → descriptive tagging
           ├── Graph sync → entities + relationships → Neo4j
           └── Update session centroid

assistant message saved
    │
    └──▶ quality.scoreResponse() — output_integrity floor (hedging, refusal,
           relevance via embedding, coherence via contradiction count)

next user message
    │
    └──▶ quality.resolveFollowup() — interaction_vitality (speed, length,
           feedback class)

Session.end()
    │
    ├──▶ Episodic consolidation (BullMQ job)
    │     ├── Extract patterns
    │     └── Generate conversation summary with embedding
    │
    └──▶ textures.capture()  (caller-driven, fire-and-forget)
          └── Distill throughline + emotional register → row per (mode, speaker)

next session open
    │
    └──▶ buildContext()
          └──▶ 11 sources in parallel (5s timeout each)
                 ├── Facts (priority-aware, intent-aware)
                 ├── Similar messages (pgvector)
                 ├── Similar conversations (pgvector)
                 ├── Emotional moments
                 ├── Contradictions (per-fact_key dedup)
                 ├── Behavioral observations
                 ├── Episodic patterns
                 ├── Semantic knowledge
                 ├── Graph context (Neo4j)
                 ├── Session texture (72h freshness taper)
                 └── Intention prompt (opt-in; side-effect: defer bump)
                 │
                 ▼
               MemoryContext.formatted → inject into LLM system prompt
```

## Testing

```bash
npm test              # Unit tests (no external services needed)
npm run typecheck     # TypeScript checks
npm run build         # TypeScript compilation
npm run start:api     # Start the REST API server
```

## License

AGPL-3.0-only
