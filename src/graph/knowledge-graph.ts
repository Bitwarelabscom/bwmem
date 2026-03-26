import type { Neo4jClient } from './neo4j-client.js';
import type { Logger, Fact } from '../types.js';

/** Sync a fact to the Neo4j knowledge graph. */
export async function syncFact(client: Neo4jClient, userId: string, fact: Fact, logger: Logger): Promise<void> {
  try {
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
  } catch (error) {
    logger.warn('Failed to sync fact to Neo4j', { error: (error as Error).message, factId: fact.id });
  }
}

/** Get graph context for a user - returns formatted string. */
export async function getContext(client: Neo4jClient, userId: string, logger: Logger): Promise<string | null> {
  try {
    // Get top entities with most connections
    const entities = await client.readQuery<{
      label: string;
      type: string;
      connections: number;
    }>(
      `MATCH (e:BwMemEntity {userId: $userId})-[r]-()
       WITH e, COUNT(r) as connections
       ORDER BY connections DESC
       LIMIT $limit
       RETURN e.label as label, e.type as type, connections`,
      { userId, limit: 10 }
    );

    // Get fact categories
    const factCategories = await client.readQuery<{
      category: string;
      count: number;
    }>(
      `MATCH (f:BwMemFact {userId: $userId, factStatus: 'active'})
       RETURN f.category as category, COUNT(f) as count
       ORDER BY count DESC`,
      { userId }
    );

    // Get co-occurrences
    const cooccurrences = await client.readQuery<{
      entity1: string;
      entity2: string;
      weight: number;
    }>(
      `MATCH (e1:BwMemEntity {userId: $userId})-[r:CO_OCCURS_WITH]-(e2:BwMemEntity)
       WHERE r.weight > 1
       RETURN e1.label as entity1, e2.label as entity2, r.weight as weight
       ORDER BY r.weight DESC
       LIMIT $limit`,
      { userId, limit: 10 }
    );

    const sections: string[] = [];

    if (entities.length > 0) {
      const entityList = entities.map(e => `${e.label} (${e.type}, ${e.connections} connections)`).join(', ');
      sections.push(`Key entities: ${entityList}`);
    }

    if (factCategories.length > 0) {
      const catList = factCategories.map(c => `${c.category}: ${c.count}`).join(', ');
      sections.push(`Fact categories: ${catList}`);
    }

    if (cooccurrences.length > 0) {
      const coList = cooccurrences.map(c => `${c.entity1} <-> ${c.entity2}`).join(', ');
      sections.push(`Connections: ${coList}`);
    }

    return sections.length > 0 ? sections.join('\n') : null;
  } catch (error) {
    logger.warn('getContext failed', { error: (error as Error).message });
    return null;
  }
}
