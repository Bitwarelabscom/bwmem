// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { PgClient } from '../db/postgres.js';
import type { Logger } from '../types.js';
import { valuesAreSimilar } from './facts.service.js';

export interface FactTombstone {
  id: string;
  userId: string;
  factKey: string;
  factValue: string;
  valueHash: string;
  reason?: string;
  sourceFactId?: string;
  createdAt: Date;
}

export interface RecordTombstoneInput {
  userId: string;
  factKey: string;
  factValue: string;
  reason?: string;
  sourceFactId?: string;
}

export interface QueryExecutor {
  query<T = unknown>(text: string, params?: unknown[]): Promise<T[] | { rows: T[] }>;
}

/**
 * Deterministic hash of normalized fact value.
 */
export function hashFactValue(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Tombstone Service
 *
 * Provides a durable, value-keyed record of rejected facts.
 * Ensures that once a fact value is rejected or deleted by the user/system,
 * subsequent automated extraction passes over conversation history
 * will not silently re-assert it.
 */
export class TombstoneService {
  constructor(
    private pg: PgClient,
    private prefix: string,
    private logger: Logger,
  ) {}

  private async runQuery<T>(executor: QueryExecutor, text: string, params?: unknown[]): Promise<T[]> {
    const res = await executor.query<T>(text, params);
    return Array.isArray(res) ? res : (res?.rows ?? []);
  }

  /**
   * Record a rejected-value tombstone. Idempotent per (user_id, fact_key, value_hash).
   */
  async recordTombstone(
    input: RecordTombstoneInput,
    executor?: QueryExecutor,
  ): Promise<FactTombstone> {
    const exec = executor ?? this.pg;
    const { userId, factKey, factValue, reason, sourceFactId } = input;
    const valueHash = hashFactValue(factValue);

    const rows = await this.runQuery<{
      id: string;
      user_id: string;
      fact_key: string;
      fact_value: string;
      value_hash: string;
      reason: string | null;
      source_fact_id: string | null;
      created_at: string | Date;
    }>(
      exec,
      `INSERT INTO ${this.prefix}fact_tombstones
        (user_id, fact_key, fact_value, value_hash, reason, source_fact_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, fact_key, value_hash)
       DO UPDATE SET
         reason = COALESCE(EXCLUDED.reason, ${this.prefix}fact_tombstones.reason),
         created_at = NOW()
       RETURNING *`,
      [userId, factKey, factValue, valueHash, reason ?? null, sourceFactId ?? null],
    );

    const row = rows[0];
    this.logger.debug('Recorded fact tombstone', {
      userId, factKey, valueHash, reason,
    });

    return {
      id: row.id,
      userId: row.user_id,
      factKey: row.fact_key,
      factValue: row.fact_value,
      valueHash: row.value_hash,
      reason: row.reason ?? undefined,
      sourceFactId: row.source_fact_id ?? undefined,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Check whether a fact value has been tombstoned for this user and key.
   * Checks both exact hash match and normalized string similarity.
   */
  async isTombstoned(
    userId: string,
    factKey: string,
    factValue: string,
    executor?: QueryExecutor,
  ): Promise<boolean> {
    const exec = executor ?? this.pg;
    const valueHash = hashFactValue(factValue);

    const rows = await this.runQuery<{ fact_value: string; value_hash: string }>(
      exec,
      `SELECT fact_value, value_hash FROM ${this.prefix}fact_tombstones
       WHERE user_id = $1 AND fact_key = $2`,
      [userId, factKey],
    );

    if (rows.length === 0) return false;
    return rows.some(
      row => row.value_hash === valueHash || valuesAreSimilar(row.fact_value, factValue),
    );
  }

  /**
   * Batch load tombstones for a list of candidate keys.
   * Used by extraction pipelines to check multiple extracted facts in a single round-trip.
   */
  async loadTombstonesForKeys(
    userId: string,
    factKeys: string[],
    executor?: QueryExecutor,
  ): Promise<Map<string, FactTombstone[]>> {
    const result = new Map<string, FactTombstone[]>();
    if (factKeys.length === 0) return result;

    const exec = executor ?? this.pg;
    const uniqueKeys = Array.from(new Set(factKeys));
    const rows = await this.runQuery<{
      id: string;
      user_id: string;
      fact_key: string;
      fact_value: string;
      value_hash: string;
      reason: string | null;
      source_fact_id: string | null;
      created_at: string | Date;
    }>(
      exec,
      `SELECT * FROM ${this.prefix}fact_tombstones
       WHERE user_id = $1 AND fact_key = ANY($2::text[])
       ORDER BY created_at DESC`,
      [userId, uniqueKeys],
    );

    for (const row of rows) {
      const t: FactTombstone = {
        id: row.id,
        userId: row.user_id,
        factKey: row.fact_key,
        factValue: row.fact_value,
        valueHash: row.value_hash,
        reason: row.reason ?? undefined,
        sourceFactId: row.source_fact_id ?? undefined,
        createdAt: new Date(row.created_at),
      };
      const arr = result.get(row.fact_key);
      if (arr) arr.push(t);
      else result.set(row.fact_key, [t]);
    }

    return result;
  }

  /**
   * Query tombstones for a user, optionally filtered by key.
   */
  async getTombstones(
    userId: string,
    opts?: { factKey?: string; limit?: number },
    executor?: QueryExecutor,
  ): Promise<FactTombstone[]> {
    const exec = executor ?? this.pg;
    const limit = opts?.limit ?? 50;
    const params: (string | number)[] = [userId];
    let whereClause = 'WHERE user_id = $1';

    if (opts?.factKey) {
      params.push(opts.factKey);
      whereClause += ` AND fact_key = $${params.length}`;
    }

    params.push(limit);
    const limitIdx = params.length;

    const rows = await this.runQuery<{
      id: string;
      user_id: string;
      fact_key: string;
      fact_value: string;
      value_hash: string;
      reason: string | null;
      source_fact_id: string | null;
      created_at: string | Date;
    }>(
      exec,
      `SELECT * FROM ${this.prefix}fact_tombstones
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitIdx}`,
      params,
    );

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      factKey: row.fact_key,
      factValue: row.fact_value,
      valueHash: row.value_hash,
      reason: row.reason ?? undefined,
      sourceFactId: row.source_fact_id ?? undefined,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Remove a tombstone (e.g. if a previously rejected fact is re-allowed).
   */
  async removeTombstone(userId: string, id: string, executor?: QueryExecutor): Promise<boolean> {
    const exec = executor ?? this.pg;
    const rows = await this.runQuery<{ id: string }>(
      exec,
      `DELETE FROM ${this.prefix}fact_tombstones
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  }
}

/**
 * Format a tombstone for prompts or provenance display.
 */
export function formatTombstoneForPrompt(tombstone: FactTombstone): string {
  const dateStr = tombstone.createdAt.toISOString().slice(0, 10);
  const reasonStr = tombstone.reason ? ` Reason: ${tombstone.reason}.` : '';
  return `[TOMBSTONE] "${tombstone.factKey}: ${tombstone.factValue}" was rejected on ${dateStr}.${reasonStr}`;
}
