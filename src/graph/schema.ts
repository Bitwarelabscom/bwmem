import type { Neo4jClient } from './neo4j-client.js';
import type { Logger } from '../types.js';

/** Create Neo4j constraints and indexes for bwmem graph schema. */
export async function initializeSchema(client: Neo4jClient, logger: Logger): Promise<void> {
  const commands = [
    // Constraints
    'CREATE CONSTRAINT bwmem_entity_unique IF NOT EXISTS FOR (e:BwMemEntity) REQUIRE (e.userId, e.label) IS UNIQUE',
    'CREATE CONSTRAINT bwmem_fact_unique IF NOT EXISTS FOR (f:BwMemFact) REQUIRE f.id IS UNIQUE',
    'CREATE CONSTRAINT bwmem_topic_unique IF NOT EXISTS FOR (t:BwMemTopic) REQUIRE (t.userId, t.name) IS UNIQUE',

    // Indexes
    'CREATE INDEX bwmem_entity_user IF NOT EXISTS FOR (e:BwMemEntity) ON (e.userId, e.type)',
    'CREATE INDEX bwmem_fact_user IF NOT EXISTS FOR (f:BwMemFact) ON (f.userId, f.category)',
  ];

  for (const cmd of commands) {
    try {
      await client.writeQuery(cmd);
    } catch (error) {
      // Constraints may already exist
      logger.debug('Schema command skipped (may already exist)', { error: (error as Error).message });
    }
  }

  logger.info('Neo4j schema initialized');
}
