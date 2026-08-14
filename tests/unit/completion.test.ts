import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertComplete, TruncatedCompletionError } from '../../src/providers/completion.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { OllamaProvider } from '../../src/providers/ollama.js';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';

/** Minimal fetch stub returning one JSON body with HTTP 200. */
function stubFetch(body: unknown) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The shape an OpenAI-dialect chat completion comes back in. */
function chatBody(content: string | null, finishReason: string | null) {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('assertComplete', () => {
  it('passes content through when the model stopped on its own', () => {
    expect(assertComplete({ provider: 'X', content: '{"a":1}', finishReason: 'stop' })).toBe('{"a":1}');
  });

  it.each(['length', 'max_tokens', 'MAX_TOKENS'])('throws on finish_reason=%s', reason => {
    expect(() => assertComplete({ provider: 'X', content: 'partial', finishReason: reason }))
      .toThrow(TruncatedCompletionError);
  });

  it('treats an absent finish reason as complete', () => {
    // Providers differ and some omit the field. Refusing those would break
    // working setups to guard a case we cannot detect.
    expect(assertComplete({ provider: 'X', content: 'ok' })).toBe('ok');
    expect(assertComplete({ provider: 'X', content: 'ok', finishReason: null })).toBe('ok');
  });

  it('treats an unknown finish reason as complete', () => {
    expect(assertComplete({ provider: 'X', content: 'ok', finishReason: 'tool_calls' })).toBe('ok');
  });

  it('keeps the partial output on the error instead of discarding it', () => {
    try {
      assertComplete({ provider: 'X', content: '{"mood":"anx', finishReason: 'length', maxTokens: 30 });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as TruncatedCompletionError;
      expect(e).toBeInstanceOf(TruncatedCompletionError);
      expect(e.partialContent).toBe('{"mood":"anx');
      expect(e.finishReason).toBe('length');
      expect(e.maxTokens).toBe(30);
      expect(e.provider).toBe('X');
    }
  });

  it('names the reasoning-model case when nothing came back at all', () => {
    // An empty string with finish_reason=length is what a reasoning model does
    // to a small budget. The message has to say so, or it reads as a network fault.
    const err = (() => {
      try { assertComplete({ provider: 'X', content: '', finishReason: 'length', maxTokens: 30 }); }
      catch (e) { return e as TruncatedCompletionError; }
    })()!;
    expect(err.message).toMatch(/reasoning/i);
    expect(err.message).toContain('maxTokens=30');
  });

  it('is not retryable — it carries no HTTP status for the retry path to match', () => {
    const err = new TruncatedCompletionError({ provider: 'X', finishReason: 'length', partialContent: '' });
    expect((err as unknown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

describe('provider truncation handling', () => {
  it('OpenAI: throws rather than returning a prefix that would parse clean', async () => {
    // The regression in one line. Before this, `chat` returned the prefix, a
    // caller regex-matched {"sentiment":"positive"} out of it, and stored a
    // verdict the model never finished making.
    stubFetch(chatBody('{"sentiment":"positive"}{"con', 'length'));
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    await expect(p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 100 }))
      .rejects.toThrow(TruncatedCompletionError);
  });

  it('OpenAI: returns content normally on finish_reason=stop', async () => {
    stubFetch(chatBody('{"sentiment":"positive"}', 'stop'));
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('{"sentiment":"positive"}');
  });

  it('OpenRouter: throws on truncation', async () => {
    stubFetch(chatBody('', 'length'));
    const p = new OpenRouterProvider({ apiKey: 'or-test' });
    await expect(p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 30 }))
      .rejects.toThrow(TruncatedCompletionError);
  });

  it('OpenRouter: falls back to native_finish_reason when the normalised one is absent', async () => {
    stubFetch({ choices: [{ message: { content: 'partial' }, native_finish_reason: 'length' }] });
    const p = new OpenRouterProvider({ apiKey: 'or-test' });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(TruncatedCompletionError);
  });

  it('OpenRouter: does not retry a truncation', async () => {
    // Retrying an identical request with an identical cap truncates identically.
    const spy = stubFetch(chatBody('', 'length'));
    const p = new OpenRouterProvider({ apiKey: 'or-test' });
    await expect(p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 30 })).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Ollama: throws on done_reason=length', async () => {
    stubFetch({ message: { content: 'partial' }, done_reason: 'length' });
    const p = new OllamaProvider();
    await expect(p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 }))
      .rejects.toThrow(TruncatedCompletionError);
  });

  it('Ollama: returns content on done_reason=stop', async () => {
    stubFetch({ message: { content: 'hello' }, done_reason: 'stop' });
    const p = new OllamaProvider();
    await expect(p.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('hello');
  });
});

describe('reasoning suppression', () => {
  it('OpenRouter disables reasoning by default', async () => {
    const spy = stubFetch(chatBody('ok', 'stop'));
    const p = new OpenRouterProvider({ apiKey: 'or-test' });
    await p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 30 });

    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body);
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('OpenRouter sends the flag explicitly when reasoning is opted into', async () => {
    const spy = stubFetch(chatBody('ok', 'stop'));
    const p = new OpenRouterProvider({ apiKey: 'or-test', reasoning: true });
    await p.chat([{ role: 'user', content: 'hi' }]);

    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body);
    expect(body.reasoning).toEqual({ enabled: true });
  });

  it('Ollama omits `think` unless it is set — the field errors on non-thinking models', async () => {
    const spy = stubFetch({ message: { content: 'ok' }, done_reason: 'stop' });
    await new OllamaProvider().chat([{ role: 'user', content: 'hi' }]);

    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body);
    expect(body).not.toHaveProperty('think');
  });

  it('Ollama sends `think` when set', async () => {
    const spy = stubFetch({ message: { content: 'ok' }, done_reason: 'stop' });
    await new OllamaProvider({ think: false }).chat([{ role: 'user', content: 'hi' }]);

    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body);
    expect(body.think).toBe(false);
  });
});
