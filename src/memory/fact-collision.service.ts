// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cross-key collisions — the guard every other check in this SDK is blind to.
 *
 * Everything that watches facts compares a NEW value against the OLD value of
 * the SAME fact_key: the contradiction gate, the paraphrase gate, the merge
 * gate, the key-axis merge, the pruner. All of them keyed on fact_key. So two
 * rows under DIFFERENT keys can each be internally coherent, each be marked
 * active, and flatly contradict one another, and nothing ever looks.
 *
 * The shape that motivated it: a pet named Gaia filed as `cat_name_gaia='Gaia'`
 * and `cat_names='Nalla, Gaia, Max'` while also filed as `dog_names='Nalla and
 * Gaia'` and `dog_behavior_gaia='Gaia is the troublemaker'` — every row active,
 * for weeks. The assistant called her a cat or a dog depending on which row
 * retrieval happened to surface, and no guard could see it.
 *
 * WHAT THIS DOES NOT DO. It never merges, never deletes, never rewrites a fact
 * and never picks a winner. Which of two coherent rows is wrong is a judgement
 * the store has no evidence for — both were asserted in good faith. This raises
 * the pair; `facts.store` / `facts.remove` are how a caller acts on it, and
 * `settle` is how they close it.
 *
 * SETTLING IS A DECISION, NOT A MUTE. The first version of this closed a
 * collision by identity — the sorted key list — and both halves of that went
 * wrong in the same week:
 *
 *   - Settling with only a NOTE muted the flag while every losing-side row
 *     stayed active and retrievable. One such settle claimed the wrong rows had
 *     been corrected; they had not, and five live wrong rows stayed in context
 *     for 23 hours with the surface showing nothing.
 *   - Because identity is the key LIST, CORRECTING a fact changed the signature
 *     and minted a fresh open row. Acting on a clash made it come back; doing
 *     nothing made it disappear forever. Exactly backwards.
 *
 * So settling records WHICH SIDE WAS KEPT, and from then on the sweep raises no
 * clash for that name at all — it surfaces the RESIDUE, the still-active facts
 * that contradict the decision, and says nothing once that list is empty.
 *
 * The detection rules are pure functions on purpose: a false alarm here is not
 * free. A flag that comes back every hour after someone has looked at it is
 * worse than one that occasionally misses.
 */
import type { Logger } from '../types.js';
import type { PgClient } from '../db/postgres.js';

// ============================================================
// What counts as mutually exclusive
// ============================================================

export interface ExclusiveFamily {
  /** What these categories are alternatives OF, so a row reads as a sentence. */
  name: string;
  /** category -> the fact_key tokens that mean it. */
  members: Record<string, string[]>;
}

/**
 * Deliberately narrow, and worth staying narrow when you extend it.
 *
 * 'pet' is NOT a member of the species family — a dog IS a pet, so pet_*
 * against dog_* is not a contradiction and a check that shouted about it would
 * be wrong every single pass. Only genuine ALTERNATIVES belong here: values
 * where one name cannot be both at once without one row being false.
 *
 * Pass your own via the constructor if your domain has different axes
 * (subscription tiers, employment status, device ownership). The aliases are
 * plain key tokens, so add translations of them if your users' fact keys are
 * not all in English.
 */
export const DEFAULT_EXCLUSIVE_FAMILIES: ExclusiveFamily[] = [
  {
    name: 'species',
    members: {
      cat: ['cat', 'cats', 'kitten', 'kittens'],
      dog: ['dog', 'dogs', 'puppy', 'puppies'],
    },
  },
];

/**
 * Capitalised words that are not names. A stray "Monday" or "The" grouped as a
 * subject produces a collision nobody can act on or make sense of.
 */
const NAME_STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'there', 'their', 'they', 'them',
  'and', 'but', 'not', 'yes', 'his', 'her', 'hers', 'him', 'she', 'when',
  'what', 'who', 'why', 'how', 'has', 'have', 'had', 'was', 'were', 'are',
  'both', 'each', 'every', 'also', 'still', 'from', 'with', 'for', 'one', 'two',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/** Key tokens that mean "this fact is naming things", e.g. `cat_names`. */
const NAMING_TOKENS = new Set(['name', 'names', 'named', 'called']);

// ============================================================
// Detection — pure functions
// ============================================================

export interface ActiveFactRow {
  id: string;
  factKey: string;
  factValue: string;
  updatedAt: Date | null;
}

export interface CollisionFact {
  id: string;
  factKey: string;
  factValue: string;
  category: string;
  updatedAt: Date | null;
}

export interface CategoryCollision {
  /** The proper noun both sides claim, spelled as the facts spell it. */
  subject: string;
  family: string;
  /** Sorted, so {cat,dog} and {dog,cat} are one collision and not two. */
  categories: string[];
  facts: CollisionFact[];
  /** Sorted fact_keys joined — the stable identity of this collision. */
  signature: string;
}

/** Lowercased word tokens of a fact_key: 'dog_personality_Gaia' -> dog, personality, gaia. */
export function keyTokens(factKey: string): string[] {
  return factKey.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Which side of which family this key claims, or null.
 *
 * A key naming TWO members of one family ('cats_and_dogs', 'pets_cat_dog') is
 * an inclusive key, not a claim about one category — it is skipped for that
 * family rather than counted as evidence for either side.
 */
export function categoriseKey(
  factKey: string, families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
): { family: string; category: string } | null {
  const tokens = new Set(keyTokens(factKey));
  for (const family of families) {
    const hits: string[] = [];
    for (const [category, aliases] of Object.entries(family.members)) {
      if (aliases.some(alias => tokens.has(alias))) hits.push(category);
    }
    if (hits.length === 1) return { family: family.name, category: hits[0] };
    // hits.length > 1 -> inclusive for THIS family; another family may still match.
  }
  return null;
}

/**
 * Which family a category belongs to, or null if it is not a category at all.
 *
 * This is what makes `decidedCategory` self-scoping: the caller says "dog" and
 * the family follows, so settling never has to guess which family was meant and
 * can never close a different one by accident. It is also the validation — a
 * typo'd category would otherwise mint a decision whose residue is every row on
 * the subject, which reads like a repair list and is nothing of the kind.
 */
export function familyOfCategory(
  category: string, families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
): string | null {
  const wanted = category.trim().toLowerCase();
  for (const family of families) {
    if (Object.prototype.hasOwnProperty.call(family.members, wanted)) return family.name;
  }
  return null;
}

/** Every category that may be decided for — for error messages and prompts. */
export function knownCategories(
  families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
): string[] {
  return families.flatMap(f => Object.keys(f.members)).sort();
}

/** Capitalised words of 3+ characters that aren't sentence furniture. */
export function properNounsIn(text: string): string[] {
  const found = text.match(/\p{Lu}\p{Ll}{2,}/gu) ?? [];
  return found.filter(word => !NAME_STOPWORDS.has(word.toLowerCase()));
}

const wordRe = (word: string): RegExp =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu');

/**
 * Group active facts by the proper nouns in their key or value, and return the
 * groups whose keys carry mutually exclusive category prefixes.
 *
 * A capitalised word is only treated as a SUBJECT when there is real evidence
 * it names something, not merely that it happened to be capitalised: it must
 * appear capitalised in some value AND either be keyed on directly somewhere
 * (`dog_behavior_gaia`) or appear in a fact whose key says it is naming
 * (`cat_names`). A user's own name scattered through fact values clears
 * neither bar; "Gaia" clears both.
 *
 * Missing a real collision costs a later noticing. Inventing one costs trust in
 * the surface, which is the more expensive of the two.
 */
export function findCollisions(
  facts: ActiveFactRow[], families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
): CategoryCollision[] {
  const categorised: Array<ActiveFactRow & { family: string; category: string }> = [];
  for (const fact of facts) {
    const cat = categoriseKey(fact.factKey, families);
    if (cat) categorised.push({ ...fact, ...cat });
  }
  if (categorised.length === 0) return [];

  // Pass 1 — build the name vocabulary out of the categorised facts only.
  const spelling = new Map<string, string>();   // lower -> as the facts spell it
  const keyedOn = new Set<string>();            // appears as a token in some fact_key
  const namedIn = new Set<string>();            // appears in a value under a naming key
  for (const fact of categorised) {
    const tokens = keyTokens(fact.factKey);
    const isNamingKey = tokens.some(t => NAMING_TOKENS.has(t));
    for (const noun of properNounsIn(fact.factValue)) {
      const lower = noun.toLowerCase();
      if (!spelling.has(lower)) spelling.set(lower, noun);
      if (isNamingKey) namedIn.add(lower);
    }
    for (const token of tokens) keyedOn.add(token);
  }
  const subjects = Array.from(spelling.keys()).filter(n => keyedOn.has(n) || namedIn.has(n));
  if (subjects.length === 0) return [];

  // Pass 2 — which facts mention which subject, on which side.
  const collisions: CategoryCollision[] = [];
  for (const subject of subjects.sort()) {
    const matcher = wordRe(subject);
    const byFamily = new Map<string, Map<string, CollisionFact[]>>();
    for (const fact of categorised) {
      const mentions = keyTokens(fact.factKey).includes(subject) || matcher.test(fact.factValue);
      if (!mentions) continue;
      const sides = byFamily.get(fact.family) ?? new Map<string, CollisionFact[]>();
      const side = sides.get(fact.category) ?? [];
      side.push({
        id: fact.id,
        factKey: fact.factKey,
        factValue: fact.factValue,
        category: fact.category,
        updatedAt: fact.updatedAt,
      });
      sides.set(fact.category, side);
      byFamily.set(fact.family, sides);
    }
    Array.from(byFamily.entries()).forEach(([family, sides]) => {
      if (sides.size < 2) return; // one side only — nothing is disagreeing
      const collisionFacts = Array.from(sides.values()).flat()
        .sort((a, b) => a.category.localeCompare(b.category) || a.factKey.localeCompare(b.factKey));
      collisions.push({
        subject: spelling.get(subject) ?? subject,
        family,
        categories: Array.from(sides.keys()).sort(),
        facts: collisionFacts,
        signature: collisionFacts.map(f => f.factKey).sort().join('|'),
      });
    });
  }
  return collisions;
}

/**
 * What still contradicts a decision that has already been made.
 *
 * Deliberately NOT derived from findCollisions. That function only returns a
 * group when TWO sides are present, which is right for raising a clash and
 * wrong here: once "dog" is decided and the last dog row happens to be
 * superseded, a lone surviving cat row is not "no longer colliding" — it is the
 * whole of what is left to fix. So this walks the active facts directly with
 * the same two matching rules findCollisions uses, and keeps what the decision
 * rules out.
 *
 * The subject arrives from the decision rather than from the name vocabulary,
 * so the "is this actually a name" bar does not apply: someone already said it
 * is one.
 */
export function residueFor(
  facts: ActiveFactRow[], subject: string, family: string, decidedCategory: string,
  families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
): CollisionFact[] {
  const wanted = subject.trim().toLowerCase();
  if (!wanted) return [];
  const matcher = wordRe(wanted);
  const residue: CollisionFact[] = [];
  for (const fact of facts) {
    const cat = categoriseKey(fact.factKey, families);
    if (!cat || cat.family !== family || cat.category === decidedCategory) continue;
    const mentions = keyTokens(fact.factKey).includes(wanted) || matcher.test(fact.factValue);
    if (!mentions) continue;
    residue.push({
      id: fact.id,
      factKey: fact.factKey,
      factValue: fact.factValue,
      category: cat.category,
      updatedAt: fact.updatedAt,
    });
  }
  return residue.sort((a, b) => a.category.localeCompare(b.category) || a.factKey.localeCompare(b.factKey));
}

// ============================================================
// The stored surface
// ============================================================

export interface StoredCollision {
  id: string;
  subject: string;
  family: string;
  categories: string[];
  facts: CollisionFact[];
  status: 'open' | 'settled' | 'resolved';
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  closedAt: Date | null;
  settledNote: string | null;
  /** The side that was kept. NULL on rows closed without a decision — a mute. */
  decidedCategory: string | null;
  decidedAt: Date | null;
}

/**
 * A decision on record, and what still stands against it.
 *
 * An empty `residue` means clean — the decision holds and nothing needs
 * surfacing. It stays on record either way: a decision is not spent by being
 * satisfied, and a new contradicting row arriving later must land as residue
 * against the decision already made rather than as a fresh clash to think
 * through again.
 */
export interface DecisionResidue {
  subject: string;
  family: string;
  decidedCategory: string;
  decidedAt: Date;
  note: string | null;
  residue: CollisionFact[];
}

export interface SettleResult {
  settled: number;
  subjects: string[];
  family: string | null;
  /** What still contradicts the decision, measured the instant it was made. */
  residue: CollisionFact[];
  /** True when the decision was attached to an already-closed row. */
  recordedOnClosed: boolean;
  /** Set instead of settling when the named category is not a known one. */
  error?: string;
}

/**
 * Separator for the (subject, signature) identity used in the resolve sweep.
 * U+001F (unit separator) because it cannot occur in a fact_key or in a name,
 * so no subject can be crafted whose concatenation collides with another
 * pair's. Written as an escape on purpose: a raw control character in source
 * is invisible and does not survive every editor.
 */
const ID_SEP = '\u001f';

interface CollisionRow {
  id: string; subject: string; family: string; categories: string[];
  fact_snapshot: CollisionFact[] | string; status: string;
  first_seen_at: Date; last_seen_at: Date; seen_count: number;
  closed_at: Date | null; settled_note: string | null;
  decided_category: string | null; decided_at: Date | null;
}

interface DecisionRow {
  subject: string; family: string;
  decided_category: string; decided_at: Date; settled_note: string | null;
}

function toStored(row: CollisionRow): StoredCollision {
  const snapshot = typeof row.fact_snapshot === 'string'
    ? JSON.parse(row.fact_snapshot) as CollisionFact[]
    : row.fact_snapshot;
  return {
    id: row.id,
    subject: row.subject,
    family: row.family,
    categories: row.categories ?? [],
    facts: snapshot ?? [],
    status: row.status as StoredCollision['status'],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    closedAt: row.closed_at,
    settledNote: row.settled_note,
    decidedCategory: row.decided_category,
    decidedAt: row.decided_at,
  };
}

/** The identity a decision is keyed on: one subject, one family, case-folded. */
const decisionKey = (subject: string, family: string): string =>
  `${subject.trim().toLowerCase()}${ID_SEP}${family}`;

export class FactCollisionService {
  private table: string;

  constructor(
    private pg: PgClient,
    private prefix: string,
    private logger: Logger,
    private families: ExclusiveFamily[] = DEFAULT_EXCLUSIVE_FAMILIES,
  ) {
    this.table = `${this.prefix}fact_category_collisions`;
  }

  private async readActiveFacts(userId: string): Promise<ActiveFactRow[]> {
    const rows = await this.pg.query<{
      id: string; fact_key: string; fact_value: string; updated_at: Date | null;
    }>(
      `SELECT id, fact_key, fact_value, updated_at
         FROM ${this.prefix}facts
        WHERE user_id = $1 AND fact_status = 'active'`,
      [userId],
    );
    return rows.map(r => ({
      id: r.id, factKey: r.fact_key, factValue: r.fact_value, updatedAt: r.updated_at,
    }));
  }

  /**
   * Standing decisions — the latest per (subject, family).
   *
   * Only rows with a decided_category count. A row closed without one is not
   * treated as a decision: there is no record of which side was kept, so there
   * is nothing to measure a residue against, and inferring one from the note
   * would be putting words in someone's mouth. Those stay muted, exactly as
   * before, until the name is settled again.
   */
  private async readDecisions(userId: string): Promise<Map<string, DecisionRow>> {
    const rows = await this.pg.query<DecisionRow>(
      `SELECT DISTINCT ON (lower(subject), family)
              subject, family, decided_category, decided_at, settled_note
         FROM ${this.table}
        WHERE user_id = $1 AND decided_category IS NOT NULL
        ORDER BY lower(subject), family, decided_at DESC, id`,
      [userId],
    );
    const byKey = new Map<string, DecisionRow>();
    for (const row of rows) byKey.set(decisionKey(row.subject, row.family), row);
    return byKey;
  }

  /**
   * Detect, file, and close. Returns what is open afterwards, plus the residue
   * standing against each decision already made.
   *
   * `raised` counts collisions that were NEW this pass. Three different things
   * stop a clash being raised, and they are not the same:
   *
   *  - The name has been DECIDED. The clash is not filed at all — a decided
   *    name never occupies the open surface again however the key list moves,
   *    which is what stops a user's own corrections minting a fresh alarm. What
   *    comes back instead is the residue. Any row still open for that name is
   *    stamped with the decision rather than left to rot.
   *  - It was settled without a side recorded. The insert collides with the
   *    closed row and the DO UPDATE is gated on status='open', so it stays
   *    quiet — the old mute, kept only for rows that predate decisions.
   *  - The facts stopped colliding, so it closes itself as 'resolved'.
   *
   * Those closes and the decision stamp are the only automatic writes in this
   * module, and every one of them touches this table alone. No fact moves here.
   */
  async refresh(userId: string): Promise<{
    open: StoredCollision[]; raised: number; resolved: number; residues: DecisionResidue[];
  }> {
    try {
      const facts = await this.readActiveFacts(userId);
      const collisions = findCollisions(facts, this.families);
      const decisions = await this.readDecisions(userId);

      // A decision supersedes any flag still open on the same name: close it
      // under that decision, carrying the original decided_at so the surface
      // keeps saying when it was decided rather than drifting to today. Not
      // 'resolved' — the rows may well still collide; it is the QUESTION that
      // is answered, not the pile.
      if (decisions.size > 0) {
        await this.pg.query(
          `UPDATE ${this.table} c
              SET status = 'settled',
                  closed_at = NOW(),
                  decided_category = d.decided_category,
                  decided_at = d.decided_at,
                  settled_note = COALESCE(c.settled_note, d.settled_note)
             FROM (SELECT DISTINCT ON (lower(subject), family)
                          subject, family, decided_category, decided_at, settled_note
                     FROM ${this.table}
                    WHERE user_id = $1 AND decided_category IS NOT NULL
                    ORDER BY lower(subject), family, decided_at DESC, id) d
            WHERE c.user_id = $1 AND c.status = 'open'
              AND lower(c.subject) = lower(d.subject) AND c.family = d.family`,
          [userId],
        );
      }

      const undecided = collisions.filter(c => !decisions.has(decisionKey(c.subject, c.family)));

      let raised = 0;
      for (const c of undecided) {
        const rows = await this.pg.query<{ inserted: boolean }>(
          `INSERT INTO ${this.table}
             (user_id, subject, family, categories, fact_snapshot, signature)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, subject, signature) DO UPDATE
             SET last_seen_at  = NOW(),
                 seen_count    = ${this.table}.seen_count + 1,
                 fact_snapshot = EXCLUDED.fact_snapshot
           WHERE ${this.table}.status = 'open'
           RETURNING (xmax = 0) AS inserted`,
          [userId, c.subject, c.family, c.categories, JSON.stringify(c.facts), c.signature],
        );
        if (rows[0]?.inserted === true) raised += 1;
      }

      const live = undecided.map(c => `${c.subject}${ID_SEP}${c.signature}`);
      const closed = await this.pg.query<{ id: string }>(
        `UPDATE ${this.table}
            SET status = 'resolved', closed_at = NOW()
          WHERE user_id = $1 AND status = 'open'
            AND (subject || $2 || signature) <> ALL($3::text[])
          RETURNING id`,
        [userId, ID_SEP, live],
      );

      return {
        open: await this.list(userId, false),
        raised,
        resolved: closed.length,
        residues: this.residuesFor(facts, decisions),
      };
    } catch (error) {
      this.logger.error('collision refresh failed', { error: (error as Error).message });
      return { open: [], raised: 0, resolved: 0, residues: [] };
    }
  }

  /** Measure every standing decision against the facts as they are right now. */
  private residuesFor(facts: ActiveFactRow[], decisions: Map<string, DecisionRow>): DecisionResidue[] {
    return Array.from(decisions.values())
      .map(d => ({
        subject: d.subject,
        family: d.family,
        decidedCategory: d.decided_category,
        decidedAt: d.decided_at,
        note: d.settled_note,
        residue: residueFor(facts, d.subject, d.family, d.decided_category, this.families),
      }))
      .sort((a, b) => b.residue.length - a.residue.length || a.subject.localeCompare(b.subject));
  }

  /**
   * The same measurement, for a reading surface. Every decision comes back,
   * clean ones included — the caller decides which are worth showing.
   */
  async listDecisionResidues(userId: string): Promise<DecisionResidue[]> {
    try {
      const [facts, decisions] = await Promise.all([
        this.readActiveFacts(userId), this.readDecisions(userId),
      ]);
      return this.residuesFor(facts, decisions);
    } catch (error) {
      this.logger.error('listDecisionResidues failed', { error: (error as Error).message });
      return [];
    }
  }

  async list(userId: string, includeClosed = false): Promise<StoredCollision[]> {
    try {
      const rows = await this.pg.query<CollisionRow>(
        `SELECT * FROM ${this.table}
          WHERE user_id = $1 ${includeClosed ? '' : "AND status = 'open'"}
          ORDER BY last_seen_at DESC`,
        [userId],
      );
      return rows.map(toStored);
    } catch (error) {
      this.logger.error('list collisions failed', { error: (error as Error).message });
      return [];
    }
  }

  async countOpen(userId: string): Promise<number> {
    try {
      const rows = await this.pg.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${this.table} WHERE user_id = $1 AND status = 'open'`,
        [userId],
      );
      return parseInt(rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  /**
   * Close a collision by recording which side was kept, and why. Writes no fact
   * and deletes nothing.
   *
   * Two properties are load-bearing, and both were absent from the first
   * version:
   *
   * It is SCOPED BY FAMILY. Matching on subject alone closes every open row for
   * that name, which with more than one family in play silently settles a
   * question nobody was asked. The family follows from the category named, so
   * a caller never supplies it and it can never be the wrong one.
   *
   * And it ANSWERS WITH THE RESIDUE. A settle whose note claims the wrong rows
   * were fixed used to be believed by nothing and checked by nothing, so this
   * measures the decision against the live facts on the spot and hands back
   * what still stands against it. A settle can no longer quietly hide a thing.
   *
   * When nothing is open for that name the decision is recorded on the most
   * recently settled row instead. That is the repair path for a mute: a
   * collision closed without a side recorded cannot re-raise, so without this
   * there would be no way back to it short of editing the table by hand.
   */
  async settle(
    userId: string, subject: string, note: string, decidedCategory: string,
  ): Promise<SettleResult> {
    const decided = decidedCategory.trim().toLowerCase();
    const family = familyOfCategory(decided, this.families);
    if (!family) {
      return {
        settled: 0, subjects: [], family: null, residue: [], recordedOnClosed: false,
        error: `"${decidedCategory}" is not a category this check knows. Use one of: `
             + `${knownCategories(this.families).join(', ')}.`,
      };
    }

    const name = subject.trim();
    try {
      let recordedOnClosed = false;
      let rows = await this.pg.query<{ subject: string }>(
        `UPDATE ${this.table}
            SET status = 'settled', closed_at = NOW(), settled_note = $3,
                decided_category = $4, decided_at = NOW()
          WHERE user_id = $1 AND status = 'open'
            AND lower(subject) = lower($2) AND family = $5
          RETURNING subject`,
        [userId, name, note.trim(), decided, family],
      );

      if (rows.length === 0) {
        rows = await this.pg.query<{ subject: string }>(
          `UPDATE ${this.table}
              SET settled_note = $3, decided_category = $4, decided_at = NOW()
            WHERE id = (SELECT id FROM ${this.table}
                         WHERE user_id = $1 AND status = 'settled'
                           AND lower(subject) = lower($2) AND family = $5
                         ORDER BY closed_at DESC NULLS LAST, last_seen_at DESC
                         LIMIT 1)
            RETURNING subject`,
          [userId, name, note.trim(), decided, family],
        );
        recordedOnClosed = rows.length > 0;
      }

      const residue = rows.length > 0
        ? residueFor(
            await this.readActiveFacts(userId), rows[0]?.subject ?? name,
            family, decided, this.families,
          )
        : [];
      return {
        settled: rows.length,
        subjects: rows.map(r => r.subject),
        family,
        residue,
        recordedOnClosed,
      };
    } catch (error) {
      this.logger.error('settle collision failed', { error: (error as Error).message });
      return { settled: 0, subjects: [], family, residue: [], recordedOnClosed: false,
               error: (error as Error).message };
    }
  }
}

/** "Gaia is filed as a cat and as a dog" — one row's headline, in words. */
export function describeCollision(
  c: { subject: string; family: string; categories: string[] },
): string {
  const list = c.categories.length === 2
    ? `${c.categories[0]} and as a ${c.categories[1]}`
    : c.categories.join(', ');
  return `${c.subject} is filed as a ${list}`;
}

/** "Gaia was decided: dog" — a decision's headline. */
export function describeDecision(
  d: { subject: string; family: string; decidedCategory: string },
): string {
  return `${d.subject} was decided: ${d.decidedCategory} (${d.family})`;
}
