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

  /**
   * Entity arm of hybrid recall: entities named by the query, plus what they
   * are connected to.
   *
   * The query is tokenised and matched case-insensitively against entity
   * labels rather than embedded. Entity labels are short proper nouns, which is
   * precisely the class where a vector match is weakest and an exact string
   * match is strongest — embedding "Biscuit" to find the dog named Biscuit is
   * the wrong tool.
   *
   * One hop out, not a full traversal. Two hops on a well-connected graph
   * returns most of it, which is a preamble again rather than a signal.
   */
  async searchEntities(
    userId: string, query: string, limit = 10, _ctx?: GraphPluginContext,
  ): Promise<string | null> {
    const terms = Array.from(new Set(
      (query.match(/[a-zA-Zà-ÿ0-9]{3,}/g) ?? []).map(t => t.toLowerCase()),
    )).slice(0, 25);
    if (terms.length === 0) return null;

    try {
      const rows = await this.client.readQuery<{
        label: string; type: string; neighbour: string | null;
        rel: string | null; weight: number | null;
      }>(
        `MATCH (e:BwMemEntity {userId: $userId})
          WHERE toLower(e.label) IN $terms
             OR ANY(t IN $terms WHERE toLower(e.label) CONTAINS t)
         OPTIONAL MATCH (e)-[r]-(n:BwMemEntity {userId: $userId})
         WITH e, n, r
         ORDER BY COALESCE(r.weight, 0) DESC
         RETURN e.label AS label, e.type AS type,
                n.label AS neighbour, type(r) AS rel, r.weight AS weight
         LIMIT $limit`,
        { userId, terms, limit },
      );
      if (rows.length === 0) return null;

      // Grouped by entity so the block reads as "this thing, and what it is
      // connected to" rather than a flat edge list.
      const byEntity = new Map<string, { type: string; links: string[] }>();
      for (const r of rows) {
        const entry = byEntity.get(r.label) ?? { type: r.type, links: [] };
        if (r.neighbour && r.rel) {
          entry.links.push(`${r.rel.toLowerCase().replace(/_/g, ' ')} ${r.neighbour}`);
        }
        byEntity.set(r.label, entry);
      }

      const lines = Array.from(byEntity.entries()).map(([label, e]) =>
        e.links.length > 0
          ? `- ${label} (${e.type}): ${e.links.slice(0, 5).join('; ')}`
          : `- ${label} (${e.type})`);

      return `[Entities]\n${lines.join('\n')}`;
    } catch (error) {
      // An arm, not the whole of retrieval: degrade rather than fail the read.
      this.logger.warn('searchEntities failed', { error: (error as Error).message });
      return null;
    }
  }

  /** Record a co-occurrence between two entities. */
  async recordCooccurrence(userId: string, entity1: string, entity2: string): Promise<void> {
    await entityGraph.recordCooccurrence(this.client, userId, entity1, entity2, this.logger);
  }
}
