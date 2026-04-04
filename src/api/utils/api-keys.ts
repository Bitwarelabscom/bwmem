// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { randomBytes, createHmac } from 'node:crypto';

const KEY_PREFIX = 'bwm_sk_';
const PEPPER = process.env.API_KEY_PEPPER ?? 'bwmem-default-pepper';

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString('base64url');
  const key = `${KEY_PREFIX}${raw}`;
  const hash = hashApiKey(key);
  const prefix = key.slice(0, 12);
  return { key, hash, prefix };
}

/** HMAC-SHA256 with server-side pepper (#13) */
export function hashApiKey(key: string): string {
  return createHmac('sha256', PEPPER).update(key).digest('hex');
}

export function isValidKeyFormat(key: string): boolean {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length > KEY_PREFIX.length + 20;
}
