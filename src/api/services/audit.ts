// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { PgClient } from '../../db/postgres.js';
import type { Logger } from '../../types.js';

export interface AuditEvent {
  tenantId: string | null;
  eventType: string;
  ip: string | null;
  userAgent: string | null;
  details?: Record<string, unknown>;
}

export interface AuditService {
  log(event: AuditEvent): void;
  shutdown(): Promise<void>;
}

/** Critical event types that must be written synchronously */
const CRITICAL_EVENTS = new Set([
  'login_failed', 'key_rotate', 'admin_create_tenant',
  'admin_update_tenant', 'register', 'verify_email',
]);

export function createAuditService(pg: PgClient, tablePrefix: string, logger: Logger): AuditService {
  const buffer: AuditEvent[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  flushTimer = setInterval(() => void flushBuffer(), 10_000);
  flushTimer.unref();

  async function writeEvent(event: AuditEvent): Promise<void> {
    // Use null for admin/system events to satisfy FK constraint
    const tenantId = event.tenantId === '__admin__' ? null : event.tenantId;
    await pg.query(
      `INSERT INTO ${tablePrefix}auth_audit_log (tenant_id, event_type, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, event.eventType, event.ip, event.userAgent, JSON.stringify(event.details ?? {})],
    );
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;
    const records = buffer.splice(0);

    try {
      const values: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      for (const r of records) {
        const tenantId = r.tenantId === '__admin__' ? null : r.tenantId;
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
        params.push(tenantId, r.eventType, r.ip, r.userAgent, JSON.stringify(r.details ?? {}));
        idx += 5;
      }

      await pg.query(
        `INSERT INTO ${tablePrefix}auth_audit_log (tenant_id, event_type, ip_address, user_agent, details)
         VALUES ${values.join(', ')}`,
        params,
      );
    } catch (err) {
      logger.error('Failed to flush audit buffer', { error: (err as Error).message });
    }
  }

  function log(event: AuditEvent): void {
    // Write critical security events synchronously to prevent data loss
    if (CRITICAL_EVENTS.has(event.eventType)) {
      void writeEvent(event).catch(err => {
        logger.error('Failed to write critical audit event', { eventType: event.eventType, error: (err as Error).message });
      });
      return;
    }
    buffer.push(event);
    if (buffer.length >= 50) {
      void flushBuffer();
    }
  }

  async function shutdown(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer);
    await flushBuffer();
  }

  return { log, shutdown };
}
