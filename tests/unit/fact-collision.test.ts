import { describe, it, expect } from 'vitest';
import {
  findCollisions, residueFor, categoriseKey, familyOfCategory,
  knownCategories, keyTokens, properNounsIn, describeCollision,
  DEFAULT_EXCLUSIVE_FAMILIES,
  type ActiveFactRow, type ExclusiveFamily,
} from '../../src/memory/fact-collision.service.js';

const fact = (factKey: string, factValue: string, id = factKey): ActiveFactRow =>
  ({ id, factKey, factValue, updatedAt: null });

describe('keyTokens', () => {
  it('splits on every non-alphanumeric and lowercases', () => {
    expect(keyTokens('dog_personality_Gaia')).toEqual(['dog', 'personality', 'gaia']);
    expect(keyTokens('cat-name.Nalla')).toEqual(['cat', 'name', 'nalla']);
  });

  it('keeps letters outside ASCII whole', () => {
    // \p{L}, not [a-z] — a key written in the user's own language must not be
    // shredded into single letters, which would match every alias by accident.
    expect(keyTokens('hund_namn_Gaia')).toEqual(['hund', 'namn', 'gaia']);
  });
});

describe('categoriseKey', () => {
  it('reads the side a key claims', () => {
    expect(categoriseKey('cat_names')).toEqual({ family: 'species', category: 'cat' });
    expect(categoriseKey('dog_breed')).toEqual({ family: 'species', category: 'dog' });
  });

  it('ignores a key that claims neither side', () => {
    expect(categoriseKey('favourite_colour')).toBeNull();
  });

  it('skips a key naming BOTH members — it is inclusive, not a claim', () => {
    // 'cats_and_dogs' is not evidence for either side, and counting it as
    // evidence for one would invent a collision out of a single row.
    expect(categoriseKey('cats_and_dogs')).toBeNull();
    expect(categoriseKey('pets_cat_dog')).toBeNull();
  });

  it('matches on whole tokens only', () => {
    // 'catalogue' contains 'cat'. A substring rule would file it as a species
    // claim and collide it with anything canine in the same sentence.
    expect(categoriseKey('catalogue_preference')).toBeNull();
    expect(categoriseKey('dogma_notes')).toBeNull();
  });
});

describe('familyOfCategory', () => {
  it('resolves the family so a caller never supplies one', () => {
    expect(familyOfCategory('dog')).toBe('species');
    expect(familyOfCategory('  DOG  ')).toBe('species');
  });

  it('refuses a category it does not know', () => {
    // This is the validation behind settle(): a typo'd category would otherwise
    // mint a decision whose residue is every row on the subject.
    expect(familyOfCategory('doge')).toBeNull();
    expect(familyOfCategory('')).toBeNull();
  });

  it('lists what may be decided, for the error message', () => {
    expect(knownCategories()).toEqual(['cat', 'dog']);
  });
});

describe('properNounsIn', () => {
  it('takes capitalised words of three or more letters', () => {
    expect(properNounsIn('Gaia is the troublemaker')).toEqual(['Gaia']);
  });

  it('drops sentence furniture that happens to be capitalised', () => {
    expect(properNounsIn('Monday The Their')).toEqual([]);
  });
});

describe('findCollisions', () => {
  it('finds one name filed under two mutually exclusive categories', () => {
    const collisions = findCollisions([
      fact('cat_names', 'Nalla, Gaia, Max'),
      fact('dog_names', 'Nalla and Gaia'),
      fact('dog_behavior_gaia', 'Gaia is the troublemaker'),
    ]);
    const gaia = collisions.find(c => c.subject === 'Gaia');
    expect(gaia).toBeDefined();
    expect(gaia!.family).toBe('species');
    expect(gaia!.categories).toEqual(['cat', 'dog']);
    expect(gaia!.facts).toHaveLength(3);
  });

  it('says nothing when only one side is present', () => {
    expect(findCollisions([
      fact('cat_names', 'Nalla, Gaia, Max'),
      fact('cat_behavior', 'Gaia is the troublemaker'),
    ])).toEqual([]);
  });

  it('will not raise a name that is only ever mentioned, never named', () => {
    // The owner's own name appears in fact values constantly. It is not keyed
    // on and no naming key introduces it, so it clears neither bar. Inventing a
    // collision costs trust in the surface; missing one costs a later noticing.
    const collisions = findCollisions([
      fact('cat_feeding', 'Henrik feeds them at seven'),
      fact('dog_walking', 'Henrik walks them after work'),
    ]);
    expect(collisions).toEqual([]);
  });

  it('raises a name that is keyed on even with no naming key anywhere', () => {
    const collisions = findCollisions([
      fact('cat_behavior_gaia', 'sleeps on the shelf, this one is Gaia'),
      fact('dog_behavior_gaia', 'Gaia is the troublemaker'),
    ]);
    expect(collisions.map(c => c.subject)).toEqual(['Gaia']);
  });

  it('gives {cat,dog} and {dog,cat} one identity, not two', () => {
    const a = findCollisions([
      fact('cat_names', 'Gaia'), fact('dog_names', 'Gaia'),
    ])[0];
    const b = findCollisions([
      fact('dog_names', 'Gaia'), fact('cat_names', 'Gaia'),
    ])[0];
    expect(a.categories).toEqual(b.categories);
    expect(a.signature).toBe(b.signature);
  });

  it('changes signature when a new colliding fact arrives', () => {
    // A genuinely new thing to look at opens a fresh row rather than silently
    // updating a decided one.
    const before = findCollisions([
      fact('cat_names', 'Gaia'), fact('dog_names', 'Gaia'),
    ])[0];
    const after = findCollisions([
      fact('cat_names', 'Gaia'), fact('dog_names', 'Gaia'),
      fact('dog_breed', 'Gaia is a pitbull'),
    ])[0];
    expect(after.signature).not.toBe(before.signature);
  });

  it('honours a caller-supplied family', () => {
    const families: ExclusiveFamily[] = [{
      name: 'employment',
      members: { employed: ['employer', 'employed'], retired: ['retired', 'retirement'] },
    }];
    const collisions = findCollisions([
      fact('employer_name', 'Sofia works at Acme'),
      fact('retired_since', 'Sofia retired in 2021'),
      fact('employed_names', 'Sofia'),
    ], families);
    expect(collisions[0]?.subject).toBe('Sofia');
    expect(collisions[0]?.categories).toEqual(['employed', 'retired']);
  });

  it('does not fire across two different families', () => {
    const families: ExclusiveFamily[] = [
      { name: 'species', members: DEFAULT_EXCLUSIVE_FAMILIES[0].members },
      { name: 'employment', members: { employed: ['employer'], retired: ['retired'] } },
    ];
    // One claim in each family is not a contradiction — nothing says a cat
    // cannot also be retired.
    expect(findCollisions([
      fact('cat_names', 'Gaia'),
      fact('retired_since', 'Gaia retired in 2021'),
    ], families)).toEqual([]);
  });
});

describe('residueFor', () => {
  const facts = [
    fact('cat_names', 'Nalla, Gaia, Max'),
    fact('cat_name_gaia', 'Gaia'),
    fact('dog_names', 'Nalla and Gaia'),
    fact('favourite_colour', 'green'),
  ];

  it('returns what still contradicts the decision, and nothing else', () => {
    const residue = residueFor(facts, 'Gaia', 'species', 'dog');
    expect(residue.map(f => f.factKey)).toEqual(['cat_name_gaia', 'cat_names']);
  });

  it('keeps the kept side out of the residue', () => {
    expect(residueFor(facts, 'Gaia', 'species', 'dog').some(f => f.category === 'dog'))
      .toBe(false);
  });

  it('empties as the losing rows are corrected', () => {
    const corrected = facts.filter(f => !f.factKey.startsWith('cat_'));
    expect(residueFor(corrected, 'Gaia', 'species', 'dog')).toEqual([]);
  });

  it('still reports a lone survivor after the other side is gone', () => {
    // The reason this is NOT derived from findCollisions: that returns a group
    // only when two sides are present. Once 'dog' is decided and the last dog
    // row is superseded, a surviving cat row is not "no longer colliding" — it
    // is the whole of what is left to fix.
    const onlyCat = [fact('cat_names', 'Nalla, Gaia, Max')];
    expect(findCollisions(onlyCat)).toEqual([]);
    expect(residueFor(onlyCat, 'Gaia', 'species', 'dog').map(f => f.factKey))
      .toEqual(['cat_names']);
  });

  it('is case-insensitive about the subject but exact about the word', () => {
    expect(residueFor(facts, 'gaia', 'species', 'dog')).toHaveLength(2);
    // 'Gaian' must not match 'Gaia'.
    expect(residueFor([fact('cat_names', 'Gaian')], 'Gaia', 'species', 'dog')).toEqual([]);
  });

  it('returns nothing for an empty subject rather than everything', () => {
    expect(residueFor(facts, '   ', 'species', 'dog')).toEqual([]);
  });
});

describe('describeCollision', () => {
  it('reads as a sentence', () => {
    expect(describeCollision({ subject: 'Gaia', family: 'species', categories: ['cat', 'dog'] }))
      .toBe('Gaia is filed as a cat and as a dog');
  });
});
