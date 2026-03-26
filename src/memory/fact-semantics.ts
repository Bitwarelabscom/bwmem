/**
 * Maps fact keys to semantic types and concept tokens.
 * Used by contradiction detection and graph enrichment.
 */

export interface FactSemantics {
  semanticType: string;
  subType?: string;
  conceptTokens: string[];
}

const PET_ACTIVITY_TOKENS = [
  'pet', 'animal', 'feed', 'fed', 'gave', 'food', 'treat', 'treats', 'bowl',
  'vet', 'collar', 'toy', 'toys', 'cuddle', 'belly', 'paw', 'paws', 'sleeping',
  'fur', 'fluffy', 'adopted', 'rescue', 'shelter', 'snuggle', 'playful',
];

const CAT_TOKENS = [
  'cat', 'cats', 'kitten', 'kitty', 'meow', 'purr', 'purring', 'litter',
  'scratch', 'scratching', 'catnip', 'mouse', 'yarn', 'tuna', 'whiskers',
  ...PET_ACTIVITY_TOKENS,
];

const DOG_TOKENS = [
  'dog', 'dogs', 'puppy', 'bark', 'barking', 'fetch', 'walk', 'walked',
  'walking', 'leash', 'bone', 'woof', 'tail', 'sniff', 'canine',
  ...PET_ACTIVITY_TOKENS,
];

const CORE_SEMANTICS: Record<string, FactSemantics> = {
  pet_name:     { semanticType: 'pet', conceptTokens: [...CAT_TOKENS, ...DOG_TOKENS] },
  cat_name:     { semanticType: 'pet', subType: 'cat', conceptTokens: CAT_TOKENS },
  dog_name:     { semanticType: 'pet', subType: 'dog', conceptTokens: DOG_TOKENS },
  partner_name: { semanticType: 'person', subType: 'partner', conceptTokens: [
    'partner', 'wife', 'husband', 'girlfriend', 'boyfriend', 'spouse',
    'love', 'date', 'dating', 'married', 'wedding', 'anniversary',
  ]},
  child_name:   { semanticType: 'person', subType: 'child', conceptTokens: [
    'child', 'kid', 'kids', 'son', 'daughter', 'baby', 'toddler',
    'school', 'homework', 'grade', 'birthday', 'bedtime',
  ]},
  sibling_name: { semanticType: 'person', subType: 'sibling', conceptTokens: [
    'brother', 'sister', 'sibling', 'siblings', 'twin',
  ]},
  parent_name:  { semanticType: 'person', subType: 'parent', conceptTokens: [
    'mom', 'dad', 'mother', 'father', 'parent', 'parents',
    'visit', 'visiting', 'call', 'called',
  ]},
  name:         { semanticType: 'person', conceptTokens: ['name', 'called', 'call'] },
  location:     { semanticType: 'place', conceptTokens: [
    'live', 'lives', 'living', 'city', 'moved', 'move', 'town', 'country',
    'address', 'home', 'apartment', 'house',
  ]},
  company:      { semanticType: 'organization', conceptTokens: [
    'company', 'employer', 'work', 'working', 'job', 'office', 'boss', 'hired',
  ]},
};

function toSnakeCase(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function buildSemantics(): Record<string, FactSemantics> {
  const result: Record<string, FactSemantics> = { ...CORE_SEMANTICS };
  Array.from(Object.entries(CORE_SEMANTICS)).forEach(([key, value]) => {
    const camel = key.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase());
    if (camel !== key) result[camel] = value;
  });
  return result;
}

export const FACT_KEY_SEMANTICS = buildSemantics();

export function getConceptTokens(factKey: string): string[] {
  const direct = FACT_KEY_SEMANTICS[factKey];
  if (direct) return direct.conceptTokens;
  const snake = toSnakeCase(factKey);
  const snakeMatch = FACT_KEY_SEMANTICS[snake];
  if (snakeMatch) return snakeMatch.conceptTokens;
  return toSnakeCase(factKey).split('_');
}

export function getSemantics(factKey: string): FactSemantics | undefined {
  if (!factKey) return undefined;
  const direct = FACT_KEY_SEMANTICS[factKey];
  if (direct) return direct;
  return FACT_KEY_SEMANTICS[toSnakeCase(factKey)];
}
