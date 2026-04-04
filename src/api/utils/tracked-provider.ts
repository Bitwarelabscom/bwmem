// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import type { EmbeddingProvider, LLMProvider, ChatMessage, LLMOptions } from '../../types.js';
import type { PgClient } from '../../db/postgres.js';
import type { Logger } from '../../types.js';
import { tenantStore } from './tenant-scope.js';

interface UsageRecord {
  tenantId: string;
  embeddingTokens: number;
  timestamp: Date;
}

/**
 * Wraps an EmbeddingProvider to track per-tenant embedding usage via AsyncLocalStorage.
 * Token estimation: text.length / 4 (rough but sufficient for quota enforcement).
 */
export class TrackedEmbeddingProvider implements EmbeddingProvider {
  private buffer: UsageRecord[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  readonly dimensions: number;

  constructor(
    private inner: EmbeddingProvider,
    private pg: PgClient,
    private tablePrefix: string,
    private logger: Logger,
  ) {
    this.dimensions = inner.dimensions;
    this.flushInterval = setInterval(() => this.flush(), 30_000);
  }

  async generate(text: string): Promise<number[]> {
    this.recordUsage(estimateTokens(text));
    return this.inner.generate(text);
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const totalTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    this.recordUsage(totalTokens);
    return this.inner.generateBatch(texts);
  }

  private recordUsage(tokens: number): void {
    const ctx = tenantStore.getStore();
    if (!ctx) return;
    this.buffer.push({ tenantId: ctx.tenantId, embeddingTokens: tokens, timestamp: new Date() });
    if (this.buffer.length >= 100) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const records = this.buffer.splice(0);

    // Aggregate by tenant
    const byTenant = new Map<string, number>();
    for (const r of records) {
      byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? 0) + r.embeddingTokens);
    }

    for (const [tenantId, tokens] of byTenant) {
      try {
        await this.pg.query(
          `INSERT INTO ${this.tablePrefix}api_usage (tenant_id, endpoint, method, embedding_tokens)
           VALUES ($1, 'embedding', 'INTERNAL', $2)`,
          [tenantId, tokens],
        );
      } catch (err) {
        this.logger.error('Failed to flush embedding usage', { tenantId, error: (err as Error).message });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    await this.flush();
  }
}

/**
 * Wraps an LLMProvider — purely for pass-through.
 * LLM token tracking can be added later if needed.
 */
export class TrackedLLMProvider implements LLMProvider {
  constructor(private inner: LLMProvider) {}

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    return this.inner.chat(messages, options);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
