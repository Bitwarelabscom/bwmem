import { describe, it, expect, beforeEach } from 'vitest';
import { CentroidService } from '../../src/memory/centroid.service.js';
import { MockRedisClient, mockLogger } from '../fixtures/mock-providers.js';

describe('CentroidService', () => {
  let redis: MockRedisClient;
  let service: CentroidService;

  beforeEach(() => {
    redis = new MockRedisClient();
    service = new CentroidService(redis as never, mockLogger);
  });

  describe('update', () => {
    it('sets initial centroid to the first embedding', async () => {
      const embedding = [1.0, 0.5, -0.3, 0.8];
      const result = await service.update('session-1', embedding);
      expect(result).toEqual(embedding);
    });

    it('applies EMA blending on subsequent updates', async () => {
      const first = [1.0, 0.0, 0.0, 0.0];
      await service.update('session-1', first);

      const second = [0.0, 1.0, 0.0, 0.0];
      const result = await service.update('session-1', second);

      // With alpha=0.3: new = 0.3 * second + 0.7 * first
      expect(result[0]).toBeCloseTo(0.7, 1);
      expect(result[1]).toBeCloseTo(0.3, 1);
    });
  });

  describe('get', () => {
    it('returns null for non-existent session', async () => {
      const result = await service.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns current centroid', async () => {
      await service.update('session-1', [1.0, 0.5, -0.3, 0.8]);
      const result = await service.get('session-1');
      expect(result).toEqual([1.0, 0.5, -0.3, 0.8]);
    });
  });

  describe('clear', () => {
    it('removes centroid from redis', async () => {
      await service.update('session-1', [1.0, 0.5, -0.3, 0.8]);
      await service.clear('session-1');
      const result = await service.get('session-1');
      expect(result).toBeNull();
    });
  });
});
