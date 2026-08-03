// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { TemporalEventsService } from '../../src/memory/temporal-events.service.js';
import { MockPgClient, mockLogger } from '../fixtures/mock-providers.js';

const embeddings = {
  generate: async () => [1, 0],
  generateBatch: async (texts: string[]) => texts.map(() => [1, 0]),
  dimensions: 2,
};

const llm = (reply: string) => ({ chat: async () => reply });

function service(reply: string, enabled = true) {
  return new TemporalEventsService(
    new MockPgClient() as never, 'bwmem_', llm(reply), embeddings, mockLogger, enabled,
  );
}

describe('isTemporalQuestion', () => {
  it('recognises ordering and elapsed-time questions', () => {
    for (const q of [
      'who did I meet first, Mark or Tom?',
      'how many days ago did I meet Emma?',
      'what happened before the move?',
      'when did I start the new job',
    ]) {
      expect(TemporalEventsService.isTemporalQuestion(q)).toBe(true);
    }
  });

  it('leaves ordinary questions alone', () => {
    // The timeline is only better than semantic recall for ordering questions;
    // running it on every turn spends latency to append a block nothing uses.
    expect(TemporalEventsService.isTemporalQuestion('what is my cat called?')).toBe(false);
    expect(TemporalEventsService.isTemporalQuestion('do I like coffee')).toBe(false);
  });
});

describe('extract', () => {
  it('returns [] when disabled, without calling the model', async () => {
    const svc = service('{"events":[{"subject":"Emma","predicate":"graduated","summary":"s"}]}', false);
    expect(await svc.extract('anything', '2023-05-20')).toEqual([]);
  });

  it('keeps a well-formed event', async () => {
    const svc = service(JSON.stringify({
      events: [{
        subject: 'Emma', predicate: 'graduated', object: 'university',
        summary: 'Emma graduated', occurred_on: '2023-05-19',
        precision: 'day', confidence: 0.9,
      }],
    }));
    const [e] = await svc.extract('transcript', '2023-05-20');

    expect(e.subject).toBe('Emma');
    // The date is the day it HAPPENED, not the day it was mentioned.
    expect(e.occurredOn).toBe('2023-05-19');
    expect(e.precision).toBe('day');
  });

  it('drops a malformed date rather than coercing it', async () => {
    // A wrong date sorts wrongly, which is worse than an absent one: absent can
    // be filtered, wrong is silently believed.
    const svc = service(JSON.stringify({
      events: [{
        subject: 'Emma', predicate: 'graduated', summary: 'Emma graduated',
        occurred_on: 'last tuesday', precision: 'day',
      }],
    }));
    const [e] = await svc.extract('transcript', '2023-05-20');

    expect(e.occurredOn).toBeNull();
    expect(e.precision).toBe('unknown');
  });

  it('drops events missing a subject or predicate', async () => {
    const svc = service(JSON.stringify({
      events: [
        { subject: '', predicate: 'graduated', summary: 'x' },
        { subject: 'Emma', predicate: '', summary: 'x' },
        { subject: 'Emma', predicate: 'graduated', summary: '' },
      ],
    }));
    expect(await svc.extract('transcript', '2023-05-20')).toEqual([]);
  });

  it('returns [] on an unparseable reply instead of throwing', async () => {
    // Consolidation must survive a bad extraction — this is an enrichment.
    expect(await service('not json at all').extract('t', '2023-05-20')).toEqual([]);
  });

  it('returns [] rather than hanging when the model stalls', async () => {
    const svc = new TemporalEventsService(
      new MockPgClient() as never, 'bwmem_',
      { chat: () => new Promise(() => {}) },
      embeddings, mockLogger, true, 10,
    );
    expect(await svc.extract('transcript', '2023-05-20')).toEqual([]);
  });

  it('caps how many events one session can contribute', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      subject: `P${i}`, predicate: 'did', summary: `s${i}`,
      occurred_on: '2023-05-19', precision: 'day', confidence: 0.5,
    }));
    const events = await service(JSON.stringify({ events: many })).extract('t', '2023-05-20');
    expect(events).toHaveLength(25);
  });
});

describe('forPrompt', () => {
  it('says nothing for a non-temporal question', async () => {
    expect(await service('{}').forPrompt('u', 'what is my cat called?')).toBe('');
  });
});
