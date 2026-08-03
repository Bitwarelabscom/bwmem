// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { shouldConsultGate, cosineSimilarity, ParaphraseGate } from '../../src/memory/paraphrase-gate.service.js';
import { FactMergeGate, parseGateJson } from '../../src/memory/fact-merge-gate.service.js';
import { mockLogger } from '../fixtures/mock-providers.js';

const embeddings = (vectors: number[][]) => ({
  generate: async () => vectors[0],
  generateBatch: async () => vectors,
  dimensions: vectors[0].length,
});

const llm = (reply: string | (() => Promise<string>)) => ({
  chat: typeof reply === 'string' ? async () => reply : reply,
});

describe('shouldConsultGate', () => {
  it('consults above the cosine floor', () => {
    expect(shouldConsultGate(0.85, 'works from home', 'works at the office')).toBe(true);
  });

  it('does not spend an LLM call on a genuine topic shift', () => {
    // Topic shifts measure ~0.27. This is the case the floor exists for.
    expect(shouldConsultGate(0.27,
      'has a golden retriever called Sam who came from a shelter last spring',
      'prefers tea over coffee every afternoon and never drinks either after six')).toBe(false);
  });

  it('consults on short values regardless of cosine', () => {
    // The live false alarm: 'C1' vs 'C1 level according to the tutor' scored
    // 0.6518 — below the floor — and fired in BOTH directions, one value
    // thrashing between two spellings of itself. Cosine is length-asymmetry
    // biased, so the floor fails open exactly where it is least reliable.
    expect(shouldConsultGate(0.65, 'C1', 'C1 level according to the tutor')).toBe(true);
  });

  it('consults on containment pairs below the floor', () => {
    expect(shouldConsultGate(0.5,
      'plays guitar and piano and also sings in a choir on weekends',
      'plays guitar and piano and also sings in a choir on weekends every week')).toBe(true);
  });

  it('consults when one value is the other with a word split', () => {
    expect(shouldConsultGate(0.4,
      'is a trouble maker at school according to every teacher there',
      'is a troublemaker at school according to every teacher there')).toBe(true);
  });

  it('does not match a short word inside a longer one', () => {
    // ' art ' must not match inside 'start'.
    const a = 'art is the whole point of the exercise for him personally now';
    const b = 'start is the whole point of the exercise for him personally now';
    expect(shouldConsultGate(0.1, a, b)).toBe(false);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 rather than NaN on a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 on a length mismatch instead of throwing', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe('parseGateJson', () => {
  it('reads a bare object', () => {
    expect(parseGateJson('{"compatible":true}')).toEqual({ compatible: true });
  });

  it('reads through fences, prose and think blocks', () => {
    const raw = '<think>weighing it up</think>\nSure:\n```json\n{"compatible":false}\n```\nhope that helps';
    expect(parseGateJson(raw)).toEqual({ compatible: false });
  });

  it('returns null rather than throwing on a stop-token-only reply', () => {
    // A reasoning model that spends its whole budget thinking returns exactly
    // this. Throwing here would surface on the write path.
    expect(parseGateJson('<｜end▁of▁sentence｜>')).toBeNull();
  });
});

describe('ParaphraseGate', () => {
  const same = [[1, 0], [1, 0]];       // cosine 1 — above the floor
  const different = [[1, 0], [0, 1]];  // cosine 0 — below it

  it('suppresses the signal when the gate says same claim', async () => {
    const gate = new ParaphraseGate(
      embeddings(same),
      new FactMergeGate(llm('{"compatible":true,"reason":"same claim reworded"}'), mockLogger),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k', 'a', 'b');
    expect(v.paraphrase).toBe(true);
    expect(v.path).toBe('gate_paraphrase');
    expect(v.reason).toBe('same claim reworded');
  });

  it('lets the signal through when the gate says separate', async () => {
    const gate = new ParaphraseGate(
      embeddings(same),
      new FactMergeGate(llm('{"compatible":false,"reason":"different scope"}'), mockLogger),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k', 'a', 'b');
    expect(v.paraphrase).toBe(false);
    expect(v.path).toBe('gate_separate');
  });

  it('skips the LLM entirely below the floor', async () => {
    let called = 0;
    const gate = new ParaphraseGate(
      embeddings(different),
      new FactMergeGate(llm(async () => { called++; return '{}'; }), mockLogger),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k',
      'has a golden retriever called Sam who came from a shelter last spring',
      'prefers tea over coffee every afternoon and never drinks either after six');

    expect(v.path).toBe('below_floor');
    expect(called).toBe(0);
  });

  it('FAILS OPEN when the embedder is down', async () => {
    // An outage of the noise filter must never suppress a real signal.
    const broken = {
      generate: async () => { throw new Error('embedder down'); },
      generateBatch: async () => { throw new Error('embedder down'); },
      dimensions: 2,
    };
    const gate = new ParaphraseGate(
      broken,
      new FactMergeGate(llm('{"compatible":true}'), mockLogger),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k', 'a', 'b');

    expect(v.paraphrase).toBe(false);
    expect(v.path).toBe('gate_error');
    expect(v.similarity).toBe(-1);
  });

  it('FAILS OPEN when the gate reply is unparseable', async () => {
    const gate = new ParaphraseGate(
      embeddings(same),
      new FactMergeGate(llm('I think they are the same, roughly'), mockLogger),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k', 'a', 'b');

    expect(v.paraphrase).toBe(false);
    expect(v.path).toBe('gate_error');
  });

  it('suppresses only a repeated timeout on near-identical values', async () => {
    // Twice stalled on values this close is the check's own latency. Filing a
    // misremember here would report that latency as memory drifting.
    const gate = new ParaphraseGate(
      embeddings(same), // cosine 1, above TIMEOUT_HIGH_SIMILARITY
      new FactMergeGate(llm(() => new Promise(() => {})), mockLogger, 10),
      mockLogger,
    );
    const v = await gate.isSemanticParaphrase('k',
      '12 years of school English', '12 years school English');

    expect(v.path).toBe('timeout_high_sim');
    expect(v.paraphrase).toBe(true);
  });
});
