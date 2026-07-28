import type { PgClient } from '../db/postgres.js';
import type { LLMProvider, Logger, SessionTexture } from '../types.js';

/**
 * Session texture carryover (mig 009).
 *
 * Memory hands the agent FACTS across sessions but not MOMENTUM — every
 * reopen is a cold start of the felt sense. This captures the THROUGHLINE
 * (what was being worked through) and the EMOTIONAL REGISTER (the felt tone)
 * at session close, surfaces it as an anchor on the next open in the same
 * (mode, speaker) pair.
 *
 *   capture(sessionId)  — fire-and-forget on session end. Swallows its own
 *     errors. "No texture" is always a valid state.
 *
 *   getForPrompt(...)   — RAW anchor block for the next open. Deliberately
 *     NOT written in the agent's voice; the agent responds to it naturally.
 *     A 72h freshness taper drops anything older — a stale texture
 *     pretending to be fresh is worse than none.
 */

const FRESH_HOURS = 24;
const STALE_HOURS = 72;
const MIN_USER_TURNS = 2;
const MIN_ASSISTANT_TURNS = 2;
const SUBSTANTIVE_CHARS = 12;
const MAX_TRANSCRIPT_MSGS = 40;
const MAX_MSG_CHARS = 600;
const RETAIN_DAYS = 30;

interface SessionRow { user_id: string; metadata: Record<string, unknown> | null }
interface MsgRow { role: 'user' | 'assistant' | 'system'; content: string }

export class SessionTextureService {
  private pg: PgClient;
  private llm: LLMProvider;
  private prefix: string;
  private logger: Logger;

  constructor(pg: PgClient, llm: LLMProvider, prefix: string, logger: Logger) {
    this.pg = pg;
    this.llm = llm;
    this.prefix = prefix;
    this.logger = logger;
  }

  /**
   * Distill and store the texture of a just-closed session. Safe to call
   * fire-and-forget: it swallows its own errors and never throws.
   *
   * `mode` and `speaker` default to 'default' / 'user'; pass explicit values
   * when you have multiple relationship classes (e.g., the user vs an
   * automation agent) that should carry separately.
   */
  async capture(
    sessionId: string,
    opts: { mode?: string; speaker?: string } = {},
  ): Promise<void> {
    const mode = opts.mode || 'default';
    const speaker = opts.speaker || 'user';
    try {
      const session = await this.pg.queryOne<SessionRow>(
        `SELECT user_id, metadata FROM ${this.prefix}sessions WHERE id = $1`,
        [sessionId],
      );
      if (!session) return;

      const msgs = await this.pg.query<MsgRow>(
        `SELECT role, content FROM ${this.prefix}messages
          WHERE session_id = $1 AND role IN ('user','assistant')
          ORDER BY created_at ASC`,
        [sessionId],
      );

      const substantive = (r: MsgRow) => (r.content || '').trim().length >= SUBSTANTIVE_CHARS;
      const userTurns = msgs.filter(m => m.role === 'user' && substantive(m)).length;
      const assistantTurns = msgs.filter(m => m.role === 'assistant' && substantive(m)).length;
      if (userTurns < MIN_USER_TURNS || assistantTurns < MIN_ASSISTANT_TURNS) {
        this.logger.debug('session texture skipped: too thin', { sessionId, userTurns, assistantTurns });
        return;
      }

      const themLabel = speaker === 'user' ? 'User' : capitalize(speaker);
      const transcript = msgs
        .slice(-MAX_TRANSCRIPT_MSGS)
        .map(m => `${m.role === 'assistant' ? 'Assistant' : themLabel}: ${(m.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_CHARS)}`)
        .join('\n');

      const result = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              'Distill the TEXTURE of this finished conversation so the speakers can resume with momentum next time — this is NOT a summary. ' +
              'Output JSON only, no preamble: ' +
              '{"throughline": one concrete sentence of what was actually being worked through (not a topic list), ' +
              '"emotional_register": the felt tone in 3-8 words, e.g. "building toward something warm, unresolved" / "tense, problem-solving" / "light and playful"}.',
          },
          { role: 'user', content: transcript },
        ],
        { temperature: 0.4, maxTokens: 220, json: true },
      );

      const parsed = parseTexture(result);
      if (!parsed) {
        this.logger.warn('session texture: unparseable LLM output', { sessionId });
        return;
      }

      // Latest-per-relationship: drop prior rows for this (user, mode, speaker), then insert.
      await this.pg.query(
        `DELETE FROM ${this.prefix}session_textures
          WHERE user_id = $1 AND mode = $2 AND speaker = $3`,
        [session.user_id, mode, speaker],
      );
      await this.pg.query(
        `INSERT INTO ${this.prefix}session_textures
           (user_id, session_id, mode, speaker, throughline, emotional_register)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session.user_id, sessionId, mode, speaker, parsed.throughline, parsed.emotionalRegister],
      );

      // Bounded retention sweep (best-effort)
      this.pg.query(
        `DELETE FROM ${this.prefix}session_textures
          WHERE created_at < NOW() - INTERVAL '${RETAIN_DAYS} days'`,
      ).catch(() => undefined);

      this.logger.info('session texture captured', {
        sessionId, mode, speaker, throughline: parsed.throughline.slice(0, 80),
      });
    } catch (error) {
      this.logger.warn('captureTexture failed (non-fatal)', { sessionId, error: (error as Error).message });
    }
  }

  /**
   * Raw anchor block for the next session open in the same relationship, or
   * '' if there is nothing fresh enough.
   */
  async getForPrompt(
    userId: string,
    opts: { mode?: string; speaker?: string } = {},
  ): Promise<string> {
    const mode = opts.mode || 'default';
    const speaker = opts.speaker || 'user';
    try {
      const r = await this.pg.queryOne<{ throughline: string; emotional_register: string; created_at: Date }>(
        `SELECT throughline, emotional_register, created_at
           FROM ${this.prefix}session_textures
          WHERE user_id = $1 AND mode = $2 AND speaker = $3
          ORDER BY created_at DESC LIMIT 1`,
        [userId, mode, speaker],
      );
      if (!r) return '';

      const ageHours = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
      if (ageHours >= STALE_HOURS) return '';

      const modeLabel = mode === 'default' ? 'last' : mode;
      let header: string;
      if (ageHours < FRESH_HOURS) {
        header = `Where you left off (${modeLabel} session, ${Math.max(1, Math.round(ageHours))}h ago):`;
      } else {
        const days = Math.round(ageHours / 24);
        header = `Where you left off a few days back (${modeLabel} session, ~${days}d ago — a little stale):`;
      }
      return [
        header,
        `  Throughline: ${r.throughline}`,
        `  Emotional register: ${r.emotional_register}`,
      ].join('\n');
    } catch (error) {
      this.logger.debug('getForPrompt failed', { userId, error: (error as Error).message });
      return '';
    }
  }

  async getLatest(
    userId: string,
    opts: { mode?: string; speaker?: string } = {},
  ): Promise<SessionTexture | null> {
    const mode = opts.mode || 'default';
    const speaker = opts.speaker || 'user';
    try {
      const r = await this.pg.queryOne<Record<string, unknown>>(
        `SELECT id, user_id, session_id, mode, speaker, throughline, emotional_register, created_at
           FROM ${this.prefix}session_textures
          WHERE user_id = $1 AND mode = $2 AND speaker = $3
          ORDER BY created_at DESC LIMIT 1`,
        [userId, mode, speaker],
      );
      if (!r) return null;
      return {
        id: r.id as string,
        userId: r.user_id as string,
        sessionId: r.session_id as string | undefined,
        mode: r.mode as string,
        speaker: r.speaker as string,
        throughline: r.throughline as string,
        emotionalRegister: r.emotional_register as string,
        createdAt: new Date(r.created_at as string),
      };
    } catch (error) {
      this.logger.debug('getLatest texture failed', { userId, error: (error as Error).message });
      return null;
    }
  }
}

function parseTexture(content: string): { throughline: string; emotionalRegister: string } | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { throughline?: unknown; emotional_register?: unknown };
    const throughline = typeof obj.throughline === 'string' ? obj.throughline.trim() : '';
    const emotionalRegister = typeof obj.emotional_register === 'string' ? obj.emotional_register.trim() : '';
    if (!throughline || !emotionalRegister) return null;
    return { throughline: throughline.slice(0, 400), emotionalRegister: emotionalRegister.slice(0, 120) };
  } catch {
    return null;
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
