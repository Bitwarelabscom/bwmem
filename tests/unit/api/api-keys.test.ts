import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey, isValidKeyFormat } from '../../../src/api/utils/api-keys.js';

describe('api-keys', () => {
  describe('generateApiKey', () => {
    it('returns key with bwm_sk_ prefix', () => {
      const { key } = generateApiKey();
      expect(key.startsWith('bwm_sk_')).toBe(true);
    });

    it('returns a 12-char prefix', () => {
      const { prefix } = generateApiKey();
      expect(prefix.length).toBe(12);
    });

    it('hash is deterministic for same key', () => {
      const { key, hash } = generateApiKey();
      expect(hashApiKey(key)).toBe(hash);
    });

    it('generates unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateApiKey().key);
      }
      expect(keys.size).toBe(100);
    });
  });

  describe('isValidKeyFormat', () => {
    it('accepts valid keys', () => {
      const { key } = generateApiKey();
      expect(isValidKeyFormat(key)).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isValidKeyFormat('')).toBe(false);
    });

    it('rejects wrong prefix', () => {
      expect(isValidKeyFormat('sk_test_abc123')).toBe(false);
    });

    it('rejects too-short keys', () => {
      expect(isValidKeyFormat('bwm_sk_short')).toBe(false);
    });
  });
});
