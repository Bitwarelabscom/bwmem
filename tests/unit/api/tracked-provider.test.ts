import { describe, it, expect, beforeEach } from 'vitest';
import { TrackedEmbeddingProvider } from '../../../src/api/utils/tracked-provider.js';
import { tenantStore } from '../../../src/api/utils/tenant-scope.js';
import { MockEmbeddingProvider, MockPgClient, mockLogger } from '../../fixtures/mock-providers.js';

describe('TrackedEmbeddingProvider', () => {
  let inner: MockEmbeddingProvider;
  let pg: MockPgClient;
  let tracked: TrackedEmbeddingProvider;

  beforeEach(() => {
    inner = new MockEmbeddingProvider();
    pg = new MockPgClient();
    tracked = new TrackedEmbeddingProvider(inner, pg as any, 'bwmem_', mockLogger);
  });

  it('delegates generate() to inner provider', async () => {
    const result = await tracked.generate('hello');
    expect(result).toHaveLength(4); // MockEmbeddingProvider uses 4 dimensions
    expect(inner.generateCalls).toContain('hello');
  });

  it('delegates generateBatch() to inner provider', async () => {
    const result = await tracked.generateBatch(['a', 'b']);
    expect(result).toHaveLength(2);
    expect(inner.generateCalls).toEqual(['a', 'b']);
  });

  it('exposes same dimensions as inner', () => {
    expect(tracked.dimensions).toBe(inner.dimensions);
  });

  it('records usage when tenant context is set', async () => {
    await tenantStore.run({ tenantId: 'tenant_1' }, async () => {
      await tracked.generate('hello world');
      // Force flush
      await tracked.flush();
    });

    // Should have inserted usage
    expect(pg.queries.some(q => q.text.includes('api_usage'))).toBe(true);
  });

  it('does not record usage without tenant context', async () => {
    await tracked.generate('hello');
    await tracked.flush();
    // No usage query should be made (only embedding calls)
    expect(pg.queries.filter(q => q.text.includes('api_usage'))).toHaveLength(0);
  });

  it('shutdown clears interval and flushes', async () => {
    await tracked.shutdown();
    // Should not throw
  });
});
