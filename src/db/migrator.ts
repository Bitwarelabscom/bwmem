import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgClient } from './postgres.js';
import type { Logger } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Auto-migrator that runs SQL migrations on initialize().
 * Tracks applied migrations in a `{prefix}migrations` table.
 * Substitutes ${prefix} and ${dimensions} in SQL files.
 */
export class Migrator {
  private pg: PgClient;
  private prefix: string;
  private dimensions: number;
  private logger: Logger;

  constructor(pg: PgClient, prefix: string, dimensions: number, logger: Logger) {
    this.pg = pg;
    this.prefix = prefix;
    this.dimensions = dimensions;
    this.logger = logger;
  }

  async run(): Promise<void> {
    // Create migrations tracking table
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS ${this.prefix}migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const applied = await this.pg.query<{ name: string }>(
      `SELECT name FROM ${this.prefix}migrations ORDER BY id`
    );
    const appliedSet = new Set(applied.map(r => r.name));

    // Read migration files sorted by name
    let files: string[];
    try {
      files = readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
    } catch {
      // If running from dist/, migrations are in src/db/migrations
      // Package.json includes src/db/migrations in files
      const altDir = join(__dirname, '..', '..', 'src', 'db', 'migrations');
      files = readdirSync(altDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
      // Override for reading below
      Object.defineProperty(this, '_migrationsDir', { value: altDir });
    }

    const migrationsDir = (this as unknown as { _migrationsDir?: string })._migrationsDir ?? MIGRATIONS_DIR;

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      this.logger.info(`Running migration: ${file}`);

      let sql = readFileSync(join(migrationsDir, file), 'utf-8');

      // Template substitution
      sql = sql.replace(/\$\{prefix\}/g, this.prefix);
      sql = sql.replace(/\$\{dimensions\}/g, String(this.dimensions));

      await this.pg.query(sql);
      await this.pg.query(
        `INSERT INTO ${this.prefix}migrations (name) VALUES ($1)`,
        [file]
      );

      this.logger.info(`Migration applied: ${file}`);
    }
  }
}
