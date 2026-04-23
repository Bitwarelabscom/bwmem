import { Neo4jClient } from './neo4j-client.js';
import { initializeSchema } from './schema.js';
import * as knowledgeGraph from './knowledge-graph.js';
import * as entityGraph from './entity-graph.js';
import type { GraphPlugin, GraphPluginContext, Fact, EntityNode, GraphStats, Logger } from '../types.js';
import { consoleLogger } from '../config.js';

interface Neo4jGraphConfig {
  uri: string;
  user?: string;
  password?: string;
  logger?: Logger;
}

/**
 * Neo4j graph plugin for bwmem.
 *
 * Usage:
 *   import { Neo4jGraph } from '@bitwarelabs/bwmem/graph'
 *   const graph = new Neo4jGraph({ uri: 'bolt://localhost:7687', password: '...' })
 *   const mem = new BwMem({ graph, ... })
 */
export class Neo4jGraph implements GraphPlugin {
  private client: Neo4jClient;
  private logger: Logger;

  constructor(config: Neo4jGraphConfig) {
    this.logger = config.logger ?? consoleLogger;
    this.client = new Neo4jClient(
      { uri: config.uri, user: config.user, password: config.password },
      this.logger,
    );
  }

  async initialize(): Promise<void> {
    await this.client.connect();
    await initializeSchema(this.client, this.logger);
  }

  async shutdown(): Promise<void> {
    await this.client.close();
  }

  // Neo4jGraph accepts — but does not yet require — an explicit tenantId.
  // Node/edge keys currently derive from the scoped userId (t_{tid}:{uid}),
  // which is safe today but makes the tenant scope implicit. Accepting a
  // context here is forward-compatible for a future migration that stores
  // tenantId as a first-class property.
  async syncFact(userId: string, fact: Fact, _ctx?: GraphPluginContext): Promise<void> {
    await knowledgeGraph.syncFact(this.client, userId, fact, this.logger);
  }

  async syncEntity(userId: string, entity: EntityNode, _ctx?: GraphPluginContext): Promise<void> {
    await entityGraph.syncEntity(this.client, userId, entity, this.logger);
  }

  async getContext(userId: string, _ctx?: GraphPluginContext): Promise<string | null> {
    return knowledgeGraph.getContext(this.client, userId, this.logger);
  }

  async getStats(userId: string, _ctx?: GraphPluginContext): Promise<GraphStats | null> {
    try {
      const nodeResult = await this.client.readQuery<{ count: number }>(
        `MATCH (n {userId: $userId}) RETURN COUNT(n) as count`, { userId }
      );
      const edgeResult = await this.client.readQuery<{ count: number }>(
        `MATCH ({userId: $userId})-[r]-() RETURN COUNT(r) as count`, { userId }
      );
      const topEntities = await this.client.readQuery<{
        label: string; type: string; connections: number;
      }>(
        `MATCH (e:BwMemEntity {userId: $userId})-[r]-()
         WITH e, COUNT(r) as connections
         ORDER BY connections DESC LIMIT $limit
         RETURN e.label as label, e.type as type, connections`,
        { userId, limit: 5 }
      );

      return {
        nodeCount: nodeResult[0]?.count ?? 0,
        edgeCount: edgeResult[0]?.count ?? 0,
        topEntities,
      };
    } catch (error) {
      this.logger.warn('getStats failed', { error: (error as Error).message });
      return null;
    }
  }

  /** Record a co-occurrence between two entities. */
  async recordCooccurrence(userId: string, entity1: string, entity2: string): Promise<void> {
    await entityGraph.recordCooccurrence(this.client, userId, entity1, entity2, this.logger);
  }
}
