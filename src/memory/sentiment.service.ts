import type { LLMProvider, Logger, SentimentResult } from '../types.js';

/**
 * Per-message VAD sentiment analysis.
 * Uses emoji heuristics for fast path, falls back to LLM for complex cases.
 */
export class SentimentService {
  private llm: LLMProvider;
  private logger: Logger;

  constructor(llm: LLMProvider, logger: Logger) {
    this.llm = llm;
    this.logger = logger;
  }

  /** Analyze sentiment of a message, returning Valence-Arousal-Dominance scores. */
  async analyze(content: string): Promise<SentimentResult> {
    // Fast path: emoji-based heuristics
    const emojiResult = this.analyzeEmojis(content);
    if (emojiResult) return emojiResult;

    // Short messages with no strong signals - return neutral
    if (content.length < 20) {
      return { valence: 0, arousal: 0.3, dominance: 0.5 };
    }

    // LLM-based analysis for complex messages
    try {
      const response = await this.llm.chat([
        {
          role: 'system',
          content: `Analyze the emotional content of the message. Return JSON with:
- valence: -1.0 (very negative) to 1.0 (very positive)
- arousal: 0.0 (calm) to 1.0 (excited/intense)
- dominance: 0.0 (submissive/helpless) to 1.0 (dominant/in control)

Return only {"valence": N, "arousal": N, "dominance": N}`,
        },
        { role: 'user', content: content.slice(0, 500) },
      ], { temperature: 0.1, maxTokens: 100, json: true });

      const parsed = JSON.parse(response);
      return {
        valence: this.clamp(parsed.valence ?? 0, -1, 1),
        arousal: this.clamp(parsed.arousal ?? 0.3, 0, 1),
        dominance: this.clamp(parsed.dominance ?? 0.5, 0, 1),
      };
    } catch (error) {
      this.logger.debug('Sentiment analysis failed, returning neutral', {
        error: (error as Error).message,
      });
      return { valence: 0, arousal: 0.3, dominance: 0.5 };
    }
  }

  private analyzeEmojis(content: string): SentimentResult | null {
    const positiveEmojis = content.match(/[😊😄😃🥰❤️💕😍🎉✨👍💪🔥]/g);
    const negativeEmojis = content.match(/[😢😭😞😠😡💔😤😰😱]/g);
    const excitedEmojis = content.match(/[🎉🔥⚡🚀💥😱🤩]/g);

    if (!positiveEmojis && !negativeEmojis && !excitedEmojis) return null;

    const posCount = positiveEmojis?.length ?? 0;
    const negCount = negativeEmojis?.length ?? 0;
    const excCount = excitedEmojis?.length ?? 0;

    if (posCount === 0 && negCount === 0 && excCount === 0) return null;

    const valence = Math.max(-1, Math.min(1, (posCount - negCount) * 0.3));
    const arousal = Math.min(1, 0.3 + excCount * 0.2 + (posCount + negCount) * 0.1);

    return { valence, arousal, dominance: 0.5 };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
