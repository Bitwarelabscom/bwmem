import type { Logger } from '../types.js';

// Neo4j driver is a peer dependency - loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let neo4jModule: any = null;

async function getNeo4j() {
  if (!neo4jModule) {
    try {
      neo4jModule = await import('neo4j-driver');
    } catch {
      throw new Error('neo4j-driver is required for graph features. Install it: npm install neo4j-driver');
    }
  }
  return neo4jModule.default ?? neo4jModule;
}

interface Neo4jConfig {
  uri: string;
  user?: string;
  password?: string;
}

export class Neo4jClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private driver: any = null;
  private config: Neo4jConfig;
  private logger: Logger;

  constructor(config: Neo4jConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    const neo4j = await getNeo4j();
    const auth = this.config.user && this.config.password
      ? neo4j.auth.basic(this.config.user, this.config.password)
      : undefined;

    this.driver = neo4j.driver(this.config.uri, auth);
    await this.driver.verifyConnectivity();
    this.logger.info('Neo4j connected', { uri: this.config.uri });
  }

  async readQuery<T extends Record<string, unknown>>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    if (!this.driver) throw new Error('Neo4j not connected');

    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(cypher, this.convertParams(params));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result.records.map((record: any) => {
        const obj: Record<string, unknown> = {};
        record.keys.forEach((key: string) => {
          obj[key] = this.convertValue(record.get(key));
        });
        return obj as T;
      });
    } finally {
      await session.close();
    }
  }

  async writeQuery(cypher: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.driver) throw new Error('Neo4j not connected');

    const session = this.driver.session({ defaultAccessMode: 'WRITE' });
    try {
      await session.run(cypher, this.convertParams(params));
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.logger.info('Neo4j connection closed');
    }
  }

  private convertParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!params || !neo4jModule) return params;
    const neo4j = neo4jModule.default ?? neo4jModule;
    const converted: Record<string, unknown> = {};
    Array.from(Object.entries(params)).forEach(([key, value]) => {
      if (typeof value === 'number' && Number.isInteger(value)) {
        converted[key] = neo4j.int(value);
      } else {
        converted[key] = value;
      }
    });
    return converted;
  }

  private convertValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    const neo4j = neo4jModule?.default ?? neo4jModule;
    if (neo4j && neo4j.isInt && neo4j.isInt(value)) {
      return (value as { toNumber(): number }).toNumber();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof value === 'object' && value !== null && 'properties' in (value as any)) {
      return (value as { properties: Record<string, unknown> }).properties;
    }
    return value;
  }
}
