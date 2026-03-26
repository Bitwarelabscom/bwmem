import { Pool, PoolClient, PoolConfig } from 'pg';
import type { Logger, PostgresConfig } from '../types.js';

export class PgClient {
  private pool: Pool;
  private logger: Logger;

  constructor(config: string | PostgresConfig, logger: Logger) {
    this.logger = logger;

    const poolConfig: PoolConfig = typeof config === 'string'
      ? { connectionString: config, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 }
      : { host: config.host, port: config.port ?? 5432, user: config.user, password: config.password, database: config.database, ssl: config.ssl, max: config.max ?? 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 };

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected PostgreSQL error', { error: err.message });
    });
  }

  async query<T>(text: string, params?: unknown[]): Promise<T[]> {
    const start = Date.now();
    const result = await this.pool.query(text, params);
    const duration = Date.now() - start;
    this.logger.debug('Query executed', { text: text.slice(0, 80), duration, rows: result.rowCount });
    return result.rows as T[];
  }

  async queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.logger.info('PostgreSQL pool closed');
  }
}
