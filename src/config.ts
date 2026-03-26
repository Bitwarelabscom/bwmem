import { z } from 'zod';
import type { BwMemConfig, Logger } from './types.js';

const DEFAULT_TABLE_PREFIX = 'bwmem_';
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_DAILY_CRON = '0 2 * * *';
const DEFAULT_WEEKLY_CRON = '0 3 * * 0';

// Zod schema for validating the parts of config that are plain data.
// Provider objects (embeddings, llm, graph) are validated by duck-typing at runtime.
const configSchema = z.object({
  tablePrefix: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
});

export interface ResolvedConfig {
  postgres: string | import('./types.js').PostgresConfig;
  redis: string | import('./types.js').RedisConfig;
  embeddings: BwMemConfig['embeddings'];
  llm: BwMemConfig['llm'];
  graph?: BwMemConfig['graph'];
  tablePrefix: string;
  consolidation: {
    enabled: boolean;
    daily: string;
    weekly: string;
  };
  session: {
    inactivityTimeoutMs: number;
  };
  logger: Logger;
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const consoleLogger: Logger = {
  debug(msg, meta) { console.debug(`[bwmem] ${msg}`, meta ?? ''); },
  info(msg, meta) { console.info(`[bwmem] ${msg}`, meta ?? ''); },
  warn(msg, meta) { console.warn(`[bwmem] ${msg}`, meta ?? ''); },
  error(msg, meta) { console.error(`[bwmem] ${msg}`, meta ?? ''); },
};

export function resolveConfig(input: BwMemConfig): ResolvedConfig {
  // Validate plain-data fields
  if (input.tablePrefix) {
    configSchema.parse({ tablePrefix: input.tablePrefix });
  }

  // Validate providers exist
  if (!input.embeddings || typeof input.embeddings.generate !== 'function') {
    throw new Error('bwmem: config.embeddings must implement EmbeddingProvider (generate, generateBatch, dimensions)');
  }
  if (!input.llm || typeof input.llm.chat !== 'function') {
    throw new Error('bwmem: config.llm must implement LLMProvider (chat)');
  }

  return {
    postgres: input.postgres,
    redis: input.redis,
    embeddings: input.embeddings,
    llm: input.llm,
    graph: input.graph,
    tablePrefix: input.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    consolidation: {
      enabled: input.consolidation?.enabled ?? true,
      daily: input.consolidation?.daily ?? DEFAULT_DAILY_CRON,
      weekly: input.consolidation?.weekly ?? DEFAULT_WEEKLY_CRON,
    },
    session: {
      inactivityTimeoutMs: input.session?.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
    },
    logger: input.logger ?? consoleLogger,
  };
}

export { noopLogger, consoleLogger };
