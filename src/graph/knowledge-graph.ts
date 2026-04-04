import type { Neo4jClient } from './neo4j-client.js';
import type { Logger, Fact } from '../types.js';

/** Relationship schema: each type has valid source keys and a target entity type */
const RELATIONSHIP_SCHEMA: Record<string, { keys: string[]; targetType: string }> = {
  NAMED:            { keys: ['name', 'first_name', 'nickname'], targetType: 'name' },
  WORKS_AT:         { keys: ['employer', 'company', 'workplace', 'organization'], targetType: 'organization' },
  PREVIOUSLY_AT:    { keys: ['past_employer', 'former_employer', 'ex_employer'], targetType: 'organization' },
  WORKS_AS:         { keys: ['job', 'role', 'job_title', 'position', 'profession', 'occupation'], targetType: 'role' },
  WORKS_ON:         { keys: ['current_project', 'project'], targetType: 'project' },
  LIVES_IN:         { keys: ['location', 'city', 'country', 'address', 'residence'], targetType: 'place' },
  PREVIOUSLY_IN:    { keys: ['past_location', 'previous_city', 'former_location'], targetType: 'place' },
  FROM:             { keys: ['hometown', 'birthplace', 'origin'], targetType: 'place' },
  PARTNER_OF:       { keys: ['partner', 'wife', 'husband', 'spouse', 'girlfriend', 'boyfriend'], targetType: 'person' },
  PARENT_OF:        { keys: ['child', 'daughter', 'son'], targetType: 'person' },
  CHILD_OF:         { keys: ['parent', 'mother', 'father'], targetType: 'person' },
  SIBLING_OF:       { keys: ['sibling', 'brother', 'sister'], targetType: 'person' },
  FRIEND_OF:        { keys: ['friend', 'best_friend'], targetType: 'person' },
  COLLEAGUE_OF:     { keys: ['colleague', 'coworker'], targetType: 'person' },
  KNOWS:            { keys: ['roommate', 'ex_partner', 'acquaintance'], targetType: 'person' },
  OWNS:             { keys: ['pet', 'pet_name', 'dog', 'cat', 'pet_type'], targetType: 'animal' },
  LIKES:            { keys: ['favorite_food', 'food', 'favorite'], targetType: 'thing' },
  DISLIKES:         { keys: ['dislike', 'allergy', 'aversion'], targetType: 'thing' },
  ENJOYS:           { keys: ['interest', 'hobby', 'sport', 'activity', 'passion'], targetType: 'activity' },
  STUDIES_AT:       { keys: ['university', 'school', 'college'], targetType: 'organization' },
  STUDIES:          { keys: ['field', 'major', 'degree', 'subject'], targetType: 'field' },
  AIMS_FOR:         { keys: ['goal', 'ambition', 'aspiration', 'career_change'], targetType: 'goal' },
  RUNS:             { keys: ['partner_business', 'business', 'own_business'], targetType: 'organization' },
  HAS_ROLE:         { keys: ['partner_job', 'partner_role', 'child_job', 'child_role', 'sibling_job'], targetType: 'role' },
  LOCATED_IN:       { keys: ['partner_business_location', 'business_location'], targetType: 'place' },
  FEELS:            { keys: ['feeling', 'mood', 'emotional_state'], targetType: 'state' },
  SPEAKS:           { keys: ['language', 'native_language'], targetType: 'language' },
  INTERNS_AT:       { keys: ['child_internship', 'internship', 'sibling_internship'], targetType: 'organization' },
};

// Entity-scoped keys: when a factKey has a prefix like "child_university", strip the entity
// prefix and look up the base key. E.g., child_university → university → STUDIES_AT
// This is handled in getBaseKey + the entity prefix routing in syncFact.

// Build a reverse lookup: normalizedKey → { relType, targetType }
const KEY_TO_REL = new Map<string, { relType: string; targetType: string }>();
for (const [relType, schema] of Object.entries(RELATIONSHIP_SCHEMA)) {
  for (const key of schema.keys) {
    KEY_TO_REL.set(key, { relType, targetType: schema.targetType });
  }
}

/**
 * Strip multi-valued key slug to get the base key.
 * e.g., "child:saga" → "child", "job_title:architect" → "job_title", "interest:energy_efficiency" → "interest"
 */
function getBaseKey(factKey: string): string {
  const colonIdx = factKey.indexOf(':');
  if (colonIdx === -1) return factKey;
  return factKey.slice(0, colonIdx);
}

/** Values that should NOT become entities */
function isValidEntity(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 100) return false;
  // Reject pure numbers or percentages
  if (/^\d+(%|\s*percent)?$/i.test(v)) return false;
  // Reject phrases starting with a number (e.g., "40 percent", "6 years old")
  if (/^\d+\s/.test(v)) return false;
  // Reject very long descriptive phrases (>6 words — allows project names and business names)
  if (v.split(/\s+/).length > 6) return false;
  // Reject common non-entity values
  if (/^(yes|no|true|false|none|unknown|n\/a)$/i.test(v)) return false;
  // Reject emotional states / adjectives as entities (these are metadata, not entities)
  if (/^(imposter syndrome|anxious|stressed|happy|sad|tired|overwhelmed)$/i.test(v)) return false;
  return true;
}

/** Sync a fact to the Neo4j knowledge graph. */
export async function syncFact(client: Neo4jClient, userId: string, fact: Fact, logger: Logger): Promise<void> {
  try {
    // 1. Always upsert the fact node
    await client.writeQuery(
      `MERGE (f:BwMemFact {id: $id})
       ON CREATE SET
         f.userId = $userId,
         f.category = $category,
         f.factKey = $factKey,
         f.factValue = $factValue,
         f.confidence = $confidence,
         f.factStatus = $factStatus,
         f.mentionCount = $mentionCount,
         f.createdAt = datetime()
       ON MATCH SET
         f.factValue = $factValue,
         f.confidence = $confidence,
         f.factStatus = $factStatus,
         f.mentionCount = $mentionCount,
         f.updatedAt = datetime()`,
      {
        id: fact.id,
        userId,
        category: fact.category,
        factKey: fact.factKey,
        factValue: fact.factValue,
        confidence: fact.confidence,
        factStatus: fact.factStatus,
        mentionCount: fact.mentionCount,
      }
    );

    // 2. Resolve the base key (strip multi-valued slug like child:saga → child)
    let baseKey = getBaseKey(fact.factKey).toLowerCase().replace(/[_\-\s]+/g, '_');
    let mapping = KEY_TO_REL.get(baseKey);

    // If no direct mapping, try stripping entity prefix (child_university → university)
    if (!mapping) {
      const entityPrefixList = ['partner_', 'child_', 'sibling_', 'colleague_', 'friend_'];
      for (const prefix of entityPrefixList) {
        if (baseKey.startsWith(prefix)) {
          const stripped = baseKey.slice(prefix.length);
          mapping = KEY_TO_REL.get(stripped);
          if (mapping) {
            baseKey = stripped;
            break;
          }
        }
      }
    }

    if (!mapping) {
      logger.debug('Graph: no relationship mapping for key', { factKey: fact.factKey, baseKey });
      return;
    }

    // 3. Validate the entity value
    const targetLabel = fact.factValue.trim();
    if (!isValidEntity(targetLabel)) {
      logger.debug('Graph: skipping non-entity value', { factKey: fact.factKey, value: targetLabel });
      return;
    }

    // 4. Ensure user "self" entity exists
    await client.writeQuery(
      `MERGE (u:BwMemEntity {userId: $userId, label: 'self'})
       ON CREATE SET u.type = 'person', u.confidence = 1.0, u.createdAt = datetime(), u.lastActivated = datetime()
       ON MATCH SET u.lastActivated = datetime()`,
      { userId }
    );

    // 5. Determine the source node
    // Usually "self", but entity-scoped facts (partner_, child_, sibling_, colleague_ prefix)
    // describe relationships OF that entity, not of the user
    let sourceLabel = 'self';
    const entityPrefixes: Record<string, string> = {
      partner_: 'PARTNER_OF',
      child_: 'PARENT_OF',
      sibling_: 'SIBLING_OF',
      colleague_: 'COLLEAGUE_OF',
      friend_: 'FRIEND_OF',
    };

    for (const [prefix, relType] of Object.entries(entityPrefixes)) {
      if (baseKey.startsWith(prefix)) {
        // Find the referenced entity via relationship
        const related = await client.readQuery<{ label: string }>(
          `MATCH (u:BwMemEntity {userId: $userId, label: 'self'})-[:${relType}]->(p:BwMemEntity)
           RETURN p.label as label LIMIT 1`,
          { userId }
        );
        if (related.length > 0) {
          sourceLabel = related[0].label;
        }
        break;
      }
    }

    // 6. Create target entity and relationship
    await client.writeQuery(
      `MERGE (target:BwMemEntity {userId: $userId, label: $targetLabel})
       ON CREATE SET
         target.type = $targetType,
         target.confidence = $confidence,
         target.createdAt = datetime(),
         target.lastActivated = datetime()
       ON MATCH SET
         target.lastActivated = datetime()
       WITH target
       MATCH (source:BwMemEntity {userId: $userId, label: $sourceLabel})
       MERGE (source)-[r:` + mapping.relType + `]->(target)
       ON CREATE SET r.factId = $factId, r.createdAt = datetime(), r.source = $category
       ON MATCH SET r.updatedAt = datetime()`,
      {
        userId,
        targetLabel,
        targetType: mapping.targetType,
        confidence: fact.confidence,
        factId: fact.id,
        category: fact.category,
        sourceLabel,
      }
    );

    logger.debug('Graph: synced relationship', {
      source: sourceLabel, relType: mapping.relType, target: targetLabel,
    });
  } catch (error) {
    logger.warn('Failed to sync fact to Neo4j', { error: (error as Error).message, factId: fact.id });
  }
}

/** Get graph context for a user - returns formatted string for LLM injection. */
export async function getContext(client: Neo4jClient, userId: string, logger: Logger): Promise<string | null> {
  try {
    // Get all relationships (not just from self)
    const relationships = await client.readQuery<{
      source: string;
      relType: string;
      target: string;
      targetType: string;
    }>(
      `MATCH (src:BwMemEntity {userId: $userId})-[r]->(tgt:BwMemEntity {userId: $userId})
       RETURN src.label as source, type(r) as relType, tgt.label as target, tgt.type as targetType
       ORDER BY r.createdAt DESC
       LIMIT $limit`,
      { userId, limit: 30 }
    );

    const entities = await client.readQuery<{
      label: string;
      type: string;
      connections: number;
    }>(
      `MATCH (e:BwMemEntity {userId: $userId})-[r]-()
       WHERE e.label <> 'self'
       WITH e, COUNT(r) as connections
       ORDER BY connections DESC
       LIMIT $limit
       RETURN e.label as label, e.type as type, connections`,
      { userId, limit: 15 }
    );

    const sections: string[] = [];

    if (relationships.length > 0) {
      const relList = relationships.map(r => {
        const src = r.source === 'self' ? 'User' : r.source;
        return `${src} → ${r.relType} → ${r.target} (${r.targetType})`;
      }).join(', ');
      sections.push(`Relationships: ${relList}`);
    }

    if (entities.length > 0) {
      const entityList = entities.map(e => `${e.label} (${e.type})`).join(', ');
      sections.push(`Key entities: ${entityList}`);
    }

    return sections.length > 0 ? sections.join('\n') : null;
  } catch (error) {
    logger.warn('getContext failed', { error: (error as Error).message });
    return null;
  }
}
