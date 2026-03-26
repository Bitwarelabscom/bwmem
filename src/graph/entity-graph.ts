import type { Neo4jClient } from './neo4j-client.js';
import type { Logger, EntityNode } from '../types.js';

/** Sync an entity to the Neo4j graph. */
export async function syncEntity(
  client: Neo4jClient, userId: string, entity: EntityNode, logger: Logger,
): Promise<void> {
  try {
    await client.writeQuery(
      `MERGE (e:BwMemEntity {userId: $userId, label: $label})
       ON CREATE SET
         e.type = $type,
         e.confidence = $confidence,
         e.metadata = $metadata,
         e.createdAt = datetime(),
         e.lastActivated = datetime()
       ON MATCH SET
         e.confidence = CASE WHEN $confidence > e.confidence THEN $confidence ELSE e.confidence END,
         e.lastActivated = datetime()`,
      {
        userId,
        label: entity.label,
        type: entity.type,
        confidence: entity.confidence,
        metadata: JSON.stringify(entity.metadata ?? {}),
      }
    );
  } catch (error) {
    logger.warn('Failed to sync entity to Neo4j', { error: (error as Error).message, label: entity.label });
  }
}

/** Record a co-occurrence between two entities. */
export async function recordCooccurrence(
  client: Neo4jClient, userId: string, entity1: string, entity2: string, logger: Logger,
): Promise<void> {
  try {
    await client.writeQuery(
      `MATCH (e1:BwMemEntity {userId: $userId, label: $entity1})
       MATCH (e2:BwMemEntity {userId: $userId, label: $entity2})
       MERGE (e1)-[r:CO_OCCURS_WITH]-(e2)
       ON CREATE SET r.weight = 1, r.createdAt = datetime()
       ON MATCH SET r.weight = r.weight + 1, r.lastSeen = datetime()`,
      { userId, entity1, entity2 }
    );
  } catch (error) {
    logger.debug('recordCooccurrence failed', { error: (error as Error).message });
  }
}
