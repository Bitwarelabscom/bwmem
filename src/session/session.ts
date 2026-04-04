import { v4 as uuidv4 } from 'uuid';
import type { PgClient } from '../db/postgres.js';
import type { EmbeddingService } from '../memory/embedding.service.js';
import type { SentimentService } from '../memory/sentiment.service.js';
import type { CentroidService } from '../memory/centroid.service.js';
import type { FactsService } from '../memory/facts.service.js';
import type { EmotionalMomentsService } from '../memory/emotional-moments.service.js';
import type { ContradictionService } from '../memory/contradiction.service.js';
import type { ConsolidationScheduler } from '../consolidation/scheduler.js';
import type { LLMProvider, Logger, Message, RecordMessageInput, Fact, ExtractedFact } from '../types.js';

export class Session {
  readonly id: string;
  readonly userId: string;
  readonly metadata: Record<string, unknown>;

  private pg: PgClient;
  private embedding: EmbeddingService;
  private sentiment: SentimentService;
  private centroid: CentroidService;
  private facts: FactsService;
  private emotionalMoments: EmotionalMomentsService;
  private contradictions: ContradictionService;
  private llm: LLMProvider;
  private scheduler: ConsolidationScheduler | null;
  private prefix: string;
  private logger: Logger;
  private messageBuffer: Array<{ role: string; content: string }> = [];
  private ended = false;
  private _pending: Set<Promise<void>> = new Set();

  constructor(
    id: string, userId: string, metadata: Record<string, unknown>,
    pg: PgClient, embedding: EmbeddingService, sentiment: SentimentService,
    centroid: CentroidService, facts: FactsService,
    emotionalMoments: EmotionalMomentsService, contradictions: ContradictionService,
    llm: LLMProvider, scheduler: ConsolidationScheduler | null,
    prefix: string, logger: Logger,
  ) {
    this.id = id;
    this.userId = userId;
    this.metadata = metadata;
    this.pg = pg;
    this.embedding = embedding;
    this.sentiment = sentiment;
    this.centroid = centroid;
    this.facts = facts;
    this.emotionalMoments = emotionalMoments;
    this.contradictions = contradictions;
    this.llm = llm;
    this.scheduler = scheduler;
    this.prefix = prefix;
    this.logger = logger;
  }

  /** Record a message in this session. Triggers embedding, sentiment, and fact extraction in background. */
  async recordMessage(input: RecordMessageInput): Promise<Message> {
    if (this.ended) throw new Error('Session has ended');

    const messageId = uuidv4();
    const { role, content } = input;

    // Insert message (without embedding - that's async)
    await this.pg.query(
      `INSERT INTO ${this.prefix}messages (id, session_id, user_id, role, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, this.id, this.userId, role, content]
    );

    this.messageBuffer.push({ role, content });

    // Background: embedding + sentiment + fact extraction + emotional moments
    const task = this.processMessageBackground(messageId, role, content).catch(err =>
      this.logger.error('Background message processing failed', { error: (err as Error).message })
    );
    this._pending.add(task);
    task.then(() => this._pending.delete(task), () => this._pending.delete(task));

    return {
      id: messageId,
      sessionId: this.id,
      userId: this.userId,
      role,
      content,
      createdAt: new Date(),
    };
  }

  /** Wait for all pending background processing (embeddings, fact extraction, etc.) to complete. */
  async flush(): Promise<void> {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }

  /** End this session. Triggers episodic consolidation. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    // Mark session as ended
    await this.pg.query(
      `UPDATE ${this.prefix}sessions SET ended_at = NOW(), is_active = FALSE WHERE id = $1`,
      [this.id]
    );

    // Clear centroid
    await this.centroid.clear(this.id);

    // Trigger episodic consolidation
    if (this.scheduler && this.messageBuffer.length > 0) {
      await this.scheduler.addEpisodicJob(this.userId, this.id);
    }

    this.logger.info('Session ended', { sessionId: this.id, messages: this.messageBuffer.length });
  }

  /** Get all messages in this session. */
  async getMessages(): Promise<Message[]> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, session_id, user_id, role, content, embedding IS NOT NULL as has_embedding,
              sentiment_valence, sentiment_arousal, sentiment_dominance, created_at
       FROM ${this.prefix}messages
       WHERE session_id = $1
       ORDER BY created_at`,
      [this.id]
    );

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      sentimentValence: row.sentiment_valence as number | undefined,
      sentimentArousal: row.sentiment_arousal as number | undefined,
      sentimentDominance: row.sentiment_dominance as number | undefined,
      createdAt: row.created_at as Date,
    }));
  }

  private async processMessageBackground(messageId: string, role: string, content: string): Promise<void> {
    // Generate sentiment
    const sentimentResult = await this.sentiment.analyze(content);

    // Store embedding + sentiment
    await this.embedding.storeMessageEmbedding(
      messageId, this.userId, this.id, content, role,
      sentimentResult.valence, sentimentResult.arousal, sentimentResult.dominance,
    );

    // Update session centroid
    try {
      const emb = await this.embedding.generate(content);
      await this.centroid.update(this.id, emb);
    } catch { /* non-critical */ }

    // For user messages: extract facts + check emotional moments + contradictions
    if (role === 'user') {
      // Fact extraction every 3 messages (batched to reduce LLM calls and avoid upstream rate limits)
      if (this.messageBuffer.length % 3 === 0) {
        const recentMessages = this.messageBuffer.slice(-6);
        const extracted = await this.facts.extractFromMessages(recentMessages, this.userId, this.id);
        if (extracted.length > 0) {
          // Snapshot existing facts BEFORE storing new ones (for contradiction comparison)
          const existingFacts = await this.facts.getUserFacts(this.userId);

          await this.facts.storeExtractedFacts(this.userId, extracted, this.id);

          // Check for contradictions against the PRE-STORE snapshot
          if (existingFacts.length > 0) {
            for (const ef of extracted) {
              // Direct correction (same BASE key, different value)
              // Strip multi-valued slugs for comparison (child:saga → child)
              if (ef.isCorrection) {
                const newBase = ef.factKey.split(':')[0];
                const existing = existingFacts.find(f => {
                  const existBase = f.factKey.split(':')[0];
                  return existBase === newBase && f.category === ef.category;
                });
                if (existing && existing.factValue !== ef.factValue) {
                  // Skip if the keys have different slugs (multi-valued, not a correction)
                  const existSlug = existing.factKey.includes(':') ? existing.factKey.split(':')[1] : '';
                  const newSlug = ef.factKey.includes(':') ? ef.factKey.split(':')[1] : '';
                  if (existSlug && newSlug && existSlug !== newSlug) continue;

                  await this.contradictions.createSignal(
                    this.userId, this.id, ef.factKey,
                    ef.factValue, existing.factValue,
                    'correction'
                  );
                }
              }
            }

            // Behavioral contradiction detection via LLM
            await this.detectBehavioralContradictions(extracted, existingFacts);
          }
        }
      }

      // Emotional moment capture
      if (Math.abs(sentimentResult.valence) > 0.5 || sentimentResult.arousal > 0.6) {
        await this.emotionalMoments.capture(
          this.userId, this.id, content,
          sentimentResult.valence, sentimentResult.arousal, sentimentResult.dominance,
        );
      }
    }
  }

  /** Detect behavioral contradictions via LLM — catches semantic conflicts across different fact keys. */
  private async detectBehavioralContradictions(
    newFacts: ExtractedFact[], existingFacts: Fact[],
  ): Promise<void> {
    // Only run if there are enough facts to potentially conflict
    if (newFacts.length === 0 || existingFacts.length === 0) return;

    const existingList = existingFacts
      .slice(0, 20)
      .map(f => `${f.category}/${f.factKey}: ${f.factValue}`)
      .join('\n');
    const newList = newFacts
      .map(f => `${f.category}/${f.factKey}: ${f.factValue}`)
      .join('\n');

    try {
      const response = await this.llm.chat([
        { role: 'system', content: `You detect contradictions between a user's existing facts and newly stated facts.
A contradiction is when a new fact GENUINELY conflicts with or reverses an existing fact.

CRITICAL — these are NOT contradictions:
- Different employers (current vs previous job — people change jobs)
- Two employers at once (people have side jobs, past jobs, consulting)
- Same person in multiple relationship categories (e.g., brother AND colleague — people can be both)
- "friend:X" and "sibling:X" for same person — not a contradiction, they're both
- Different locations at different times (lives in X now, lived in Y before)
- Multiple hobbies, interests, skills, or friends
- Facts with "past_" or "previous_" prefix — these are historical, not current
- Any fact that ADDS information without negating existing facts

ONLY flag as contradictions:
- Direct reversals: "I'm vegetarian" then "I ate steak for dinner"
- Explicit negations: "I don't have pets" then "I have a dog"
- Mutually exclusive states: "I've never left Sweden" then "I lived in Tokyo"

Return a JSON array. Be VERY conservative — most fact pairs are NOT contradictions:
[{"existingFact": "category/key: value", "newFact": "category/key: value", "reason": "brief explanation"}]

Return [] if no contradictions. When in doubt, return [].` },
        { role: 'user', content: `Existing facts:\n${existingList}\n\nNew facts:\n${newList}` },
      ], { temperature: 0.1, maxTokens: 500, json: true });

      // Parse response — handle array, wrapped array, or single object
      let contradictions: Array<{ existingFact: string; newFact: string; reason: string }>;
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        contradictions = JSON.parse(arrayMatch[0]);
      } else {
        try {
          const parsed = JSON.parse(response);
          if (Array.isArray(parsed)) {
            contradictions = parsed;
          } else {
            const arrayVal = Object.values(parsed).find(v => Array.isArray(v));
            contradictions = (arrayVal as typeof contradictions) ?? [];
          }
        } catch {
          return;
        }
      }

      for (const c of contradictions) {
        if (!c.existingFact || !c.newFact) continue;

        // Extract the key portions for the signal
        const existingKey = c.existingFact.split(':')[0]?.trim() ?? c.existingFact;
        const newKey = c.newFact.split(':')[0]?.trim() ?? c.newFact;
        const existingValue = c.existingFact.split(':').slice(1).join(':').trim() || c.existingFact;
        const newValue = c.newFact.split(':').slice(1).join(':').trim() || c.newFact;

        await this.contradictions.createSignal(
          this.userId, this.id,
          `${existingKey} vs ${newKey}`,
          newValue,
          existingValue,
          'misremember',
        );

        this.logger.info('Behavioral contradiction detected', {
          existing: c.existingFact,
          new: c.newFact,
          reason: c.reason,
        });
      }
    } catch (error) {
      this.logger.error('Behavioral contradiction detection failed', {
        error: (error as Error).message,
      });
    }
  }
}
