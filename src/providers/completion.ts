/**
 * Truncation detection shared by every LLM provider.
 *
 * Why this exists:
 *
 * Every provider used to end `chat()` with `?? ''` and throw the finish reason
 * away. That is silent data loss with a very specific shape. A completion that
 * hit its token ceiling comes back as a PREFIX — valid-looking, just cut off —
 * and the callers here do not treat it as suspect. Thirteen call sites run
 * `JSON.parse` on the result and four of those excavate a fragment with a regex
 * first (`jsonMatch[0]`, `arrayMatch[0]`, `m[0]`). A regex is perfectly happy to
 * pull a complete-looking object out of an abandoned draft, so a half-finished
 * thought parses clean and gets stored as a finished answer. Nothing errors.
 *
 * The trap is that `finish_reason: 'length'` LOOKS like success: HTTP 200, a
 * populated `content`, no error field anywhere. It is the only signal that the
 * model was still talking, and it was the one field nobody read.
 *
 * This is worse on reasoning models, which is now most of them. Reasoning tokens
 * are emitted before any content and count against the same budget, so a small
 * cap is spent entirely on thinking and the caller gets `''` with
 * `finish_reason: 'length'`. Every internal call site here passes a small cap on
 * purpose (30 tokens for an emotion label, 120 for a merge gate), which is
 * correct and cheap for a non-reasoning model and produces nothing at all on a
 * reasoning one.
 *
 * So: truncation is an error, never a value. A caller that wants the partial
 * text can read it off the error.
 */

/** Finish reasons that mean "the model was cut off", across provider dialects. */
const TRUNCATED_REASONS = new Set([
  'length',       // OpenAI, OpenRouter, Ollama (done_reason)
  'max_tokens',   // Anthropic-style upstreams proxied by OpenRouter
  'MAX_TOKENS',   // Google-style upstreams proxied by OpenRouter
]);

/**
 * A completion that stopped because it ran out of room, not because it was done.
 *
 * Deliberately NOT retryable: the same request with the same cap truncates
 * again. Raise the cap or shorten the prompt.
 */
export class TruncatedCompletionError extends Error {
  readonly provider: string;
  readonly finishReason: string;
  /** What the model managed to emit before it was cut off. Never trust it as a complete answer. */
  readonly partialContent: string;
  readonly maxTokens: number | undefined;

  constructor(opts: {
    provider: string;
    finishReason: string;
    partialContent: string;
    maxTokens?: number;
  }) {
    const cap = opts.maxTokens === undefined ? 'no maxTokens set' : `maxTokens=${opts.maxTokens}`;
    const got = opts.partialContent.length === 0
      // The empty case is worth calling out by name — it is what a reasoning
      // model does to a small budget, and "returned nothing" sends people
      // hunting for a network fault instead of a token ceiling.
      ? 'returned no content at all (typical when a reasoning model spends the whole budget on reasoning tokens)'
      : `returned ${opts.partialContent.length} chars of partial output`;

    super(
      `${opts.provider} completion was truncated (finish_reason=${opts.finishReason}, ${cap}): ${got}. ` +
      `Partial output is not safe to parse; raise maxTokens or shorten the prompt.`
    );

    this.name = 'TruncatedCompletionError';
    this.provider = opts.provider;
    this.finishReason = opts.finishReason;
    this.partialContent = opts.partialContent;
    this.maxTokens = opts.maxTokens;
  }
}

/**
 * Throw if the completion was cut off. Call this before returning content from
 * any provider's `chat()`.
 *
 * An unknown or absent finish reason is treated as complete: providers differ
 * and some omit the field entirely, so refusing those would break working
 * setups to guard against a case we cannot detect anyway.
 */
export function assertComplete(opts: {
  provider: string;
  content: string;
  finishReason?: string | null;
  maxTokens?: number;
}): string {
  const reason = opts.finishReason;

  if (reason && TRUNCATED_REASONS.has(reason)) {
    throw new TruncatedCompletionError({
      provider: opts.provider,
      finishReason: reason,
      partialContent: opts.content,
      maxTokens: opts.maxTokens,
    });
  }

  return opts.content;
}
