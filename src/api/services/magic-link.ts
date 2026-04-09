// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { randomBytes } from 'node:crypto';
import type { PgClient } from '../../db/postgres.js';
import type { RedisClient } from '../../db/redis.js';
import type { Logger } from '../../types.js';
import { hashApiKey } from '../utils/api-keys.js';

const TOKEN_PREFIX = 'bwm_ml_';
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOGIN_TTL_MS = 15 * 60 * 1000;              // 15 minutes
const RATE_LIMIT_WINDOW_SECS = 900;               // 15 minutes
const RATE_LIMIT_MAX = 3;                          // per email per window

export interface MagicLinkService {
  createToken(tenantId: string, purpose: 'login' | 'verify_email', ip: string): Promise<string>;
  verifyToken(rawToken: string): Promise<{ tenantId: string; purpose: string } | null>;
  checkEmailRateLimit(email: string): Promise<boolean>;
  getRecentCount(tenantId: string, windowMinutes: number): Promise<number>;
  cleanupExpired(): Promise<number>;
}

export function createMagicLinkService(
  pg: PgClient,
  redis: RedisClient,
  tablePrefix: string,
  logger: Logger,
): MagicLinkService {

  async function createToken(tenantId: string, purpose: 'login' | 'verify_email', ip: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${raw}`;
    const tokenHash = hashApiKey(token);
    const ttl = purpose === 'verify_email' ? VERIFY_EMAIL_TTL_MS : LOGIN_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl);

    await pg.query(
      `INSERT INTO ${tablePrefix}magic_link_tokens (tenant_id, token_hash, purpose, ip_address, expires_at)
       VALUES ($1, $2, $3, $4::INET, $5)`,
      [tenantId, tokenHash, purpose, ip, expiresAt],
    );

    return token;
  }

  async function verifyToken(rawToken: string): Promise<{ tenantId: string; purpose: string } | null> {
    if (!rawToken.startsWith(TOKEN_PREFIX) || rawToken.length < TOKEN_PREFIX.length + 20) {
      return null;
    }

    const tokenHash = hashApiKey(rawToken);

    // Atomic verify-and-consume to prevent TOCTOU race condition
    const row = await pg.queryOne<{ tenant_id: string; purpose: string }>(
      `UPDATE ${tablePrefix}magic_link_tokens
       SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING tenant_id, purpose`,
      [tokenHash],
    );

    if (!row) return null;

    return { tenantId: row.tenant_id, purpose: row.purpose };
  }

  /** Returns true if rate-limited (should block). */
  async function checkEmailRateLimit(email: string): Promise<boolean> {
    const key = `bwm:ml_rate:${hashApiKey(email).slice(0, 16)}`;
    const count = await redis.client.incr(key);
    if (count === 1) {
      await redis.client.expire(key, RATE_LIMIT_WINDOW_SECS);
    }
    return count > RATE_LIMIT_MAX;
  }

  async function getRecentCount(tenantId: string, windowMinutes: number): Promise<number> {
    const row = await pg.queryOne<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM ${tablePrefix}magic_link_tokens
       WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '1 minute' * $2`,
      [tenantId, windowMinutes],
    );
    return parseInt(row?.cnt ?? '0', 10);
  }

  async function cleanupExpired(): Promise<number> {
    const rows = await pg.query<{ id: string }>(
      `DELETE FROM ${tablePrefix}magic_link_tokens
       WHERE expires_at < NOW() - INTERVAL '7 days'
       RETURNING id`,
    );
    if (rows.length > 0) {
      logger.info('Cleaned up expired magic link tokens', { count: rows.length });
    }
    return rows.length;
  }

  return { createToken, verifyToken, checkEmailRateLimit, getRecentCount, cleanupExpired };
}
