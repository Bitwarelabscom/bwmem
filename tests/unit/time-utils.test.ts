import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../../src/utils/time-utils.js';

describe('formatRelativeTime', () => {
  it('returns empty string for null', () => {
    expect(formatRelativeTime(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('');
  });

  it('returns "just now" for recent dates', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes ago', () => {
    const date = new Date(Date.now() - 15 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('15 minutes ago');
  });

  it('returns hours ago', () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('3 hours ago');
  });

  it('returns "yesterday"', () => {
    const date = new Date(Date.now() - 26 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('yesterday');
  });

  it('returns days ago', () => {
    const date = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('4 days ago');
  });

  it('returns weeks ago', () => {
    const date = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('2 weeks ago');
  });

  it('handles string dates', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(date)).toBe('5 minutes ago');
  });
});
