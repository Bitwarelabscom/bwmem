import type {
  Fact,
  SimilarMessage,
  SimilarConversation,
  LLMProvider,
  DecisionProvider,
  NoulQuestion,
  Logger,
} from '../types.js';
import type { CuratorRejectionService, DroppedMemoryItem } from './curator-rejection.service.js';
import { parseGateJson } from './fact-merge-gate.service.js';

export interface ComplexityScore {
  score: number;
  isTrivial: boolean;
}

export interface MemoryCandidates {
  facts: Fact[];
  similarMessages: SimilarMessage[];
  similarConversations: SimilarConversation[];
  learnings?: string[];
}

export interface CurationResult {
  skipped: boolean;
  facts: Fact[];
  similarMessages: SimilarMessage[];
  similarConversations: SimilarConversation[];
  learnings?: string[];
  curatorRing?: string;
  reasoning?: string;
}

const PERSONAL_KEYWORDS = new Set([
  'feel', 'feeling', 'remember', 'always', 'never', 'worried', 'afraid',
  'love', 'hate', 'miss', 'wish', 'hope', 'dream', 'believe', 'think about',
  'my life', 'my family', 'growing up', 'childhood', 'relationship',
  'struggle', 'anxious', 'happy', 'sad', 'angry', 'confused', 'grateful',
]);

const TOPIC_DEPTH_KEYWORDS = new Set([
  'project', 'help me', 'advice', 'problem', 'explain', 'how do',
  'what should', 'recommend', 'compare', 'difference between', 'strategy',
  'plan', 'design', 'implement', 'build', 'create', 'debug', 'fix',
  'analyze', 'understand', 'learn about', 'teach me',
]);

/**
 * Score message complexity using pure heuristics (no LLM call, ~0ms).
 */
export function scoreMessageComplexity(message: string): ComplexityScore {
  if (!message || message.trim().length === 0) {
    return { score: 0, isTrivial: true };
  }

  const lower = message.toLowerCase();
  const words = message.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  let score = 0;

  // Word count factor (up to 0.35)
  if (wordCount <= 5) {
    score += wordCount * 0.02; // max 0.10
  } else if (wordCount <= 20) {
    score += 0.10 + (wordCount - 5) * 0.0167; // max ~0.35
  } else {
    score += 0.35;
  }

  // Question mark (0.10)
  if (message.includes('?')) {
    score += 0.10;
  }

  // Personal/emotional keywords (0.15)
  for (const keyword of PERSONAL_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += 0.15;
      break;
    }
  }

  // Topic depth keywords (0.15)
  for (const keyword of TOPIC_DEPTH_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += 0.15;
      break;
    }
  }

  // Multi-sentence (0.10)
  const sentences = message.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length >= 2) {
    score += 0.10;
  }

  score = Math.min(1.0, score);

  return {
    score,
    isTrivial: score < 0.25,
  };
}

const CURATION_SYSTEM_PROMPT = `You are a memory curator for an AI system. Given the user's current message, select which candidate memories are genuinely relevant to include in context.

Rules:
- For deep personal/emotional topics: select up to 12 items total
- For casual conversation: select 2-4 items total
- For technical/task-oriented: select 4-8 items total
- Prefer recent memories over old ones when relevance is similar
- Exclude memories that would clutter context without adding value

Output ONLY a JSON object:
{
  "selectedFacts": [0, 2],
  "selectedMessages": [1],
  "selectedConversations": [0],
  "reasoning": "Brief 1-sentence explanation"
}

Use array indices (0-based) to reference items from each candidate list.`;

export class MemoryCurationService {
  constructor(
    private llm: LLMProvider,
    private decisionProvider?: DecisionProvider,
    private rejectionLedger?: CuratorRejectionService,
    private logger?: Logger,
  ) {}

  /**
   * Curate candidate memories using TypeSafe System One (fast path, ~200-500ms)
   * or background LLM fallback.
   */
  async curateMemory(options: {
    message: string;
    candidates: MemoryCandidates;
    complexityScore?: number;
    sessionId?: string;
    timeoutMs?: number;
  }): Promise<CurationResult> {
    const {
      message,
      candidates,
      sessionId,
      timeoutMs = 4000,
    } = options;

    const complexity = options.complexityScore ?? scoreMessageComplexity(message).score;

    const totalCandidates =
      candidates.facts.length +
      candidates.similarMessages.length +
      candidates.similarConversations.length +
      (candidates.learnings?.length ?? 0);

    if (totalCandidates === 0) {
      const curatorRing = '[Curator: 0 evaluated — storage returned no candidate memories]';
      return {
        skipped: false,
        facts: [],
        similarMessages: [],
        similarConversations: [],
        learnings: [],
        curatorRing,
        reasoning: 'Storage returned no candidate memories',
      };
    }

    // 1. Try fast System One decision model if available
    if (this.decisionProvider) {
      const typeSafeResult = await this.curateWithTypeSafe(
        message,
        candidates,
        complexity,
        sessionId,
        timeoutMs,
      );
      if (typeSafeResult) {
        return typeSafeResult;
      }
      this.logger?.debug('Decision-based curation fell back to LLM completion');
    }

    // 2. Generative LLM fallback
    return this.curateWithLlm(message, candidates, complexity, sessionId, timeoutMs);
  }

  private async curateWithTypeSafe(
    message: string,
    candidates: MemoryCandidates,
    complexityScore: number,
    sessionId?: string,
    timeoutMs = 3000,
  ): Promise<CurationResult | null> {
    if (!this.decisionProvider) return null;

    const questions: Record<string, NoulQuestion> = {};
    const droppedItems: DroppedMemoryItem[] = [];

    // Facts
    candidates.facts.forEach((f, i) => {
      questions[`F${i}`] = {
        type: 'noul',
        instructions: `Is this fact relevant context to answer or converse about the user's message? Fact: "${f.category}/${f.factKey}: ${f.factValue}"`,
        criteria: {
          true: 'Directly relates to the topic, entities, questions, or context in the message.',
          false: 'Unrelated background fact or distracting trivia.',
        },
      };
    });

    // Similar messages
    candidates.similarMessages.forEach((m, i) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const preview = m.content.slice(0, 150) + (m.content.length > 150 ? '...' : '');
      questions[`M${i}`] = {
        type: 'noul',
        instructions: `Is this past message relevant context to include for the conversation? Message: "[${role}]: ${preview}"`,
        criteria: {
          true: 'Directly relates to the ongoing topic, discussion, or issue.',
          false: 'Unrelated past topic or irrelevant banter.',
        },
      };
    });

    // Similar conversations
    candidates.similarConversations.forEach((c, i) => {
      const topics = c.topics ? ` (Topics: ${c.topics.join(', ')})` : '';
      questions[`C${i}`] = {
        type: 'noul',
        instructions: `Is this past conversation relevant context? Summary: "${c.summary}${topics}"`,
        criteria: {
          true: 'Past discussion directly relevant to the current user message.',
          false: 'Unrelated past conversation.',
        },
      };
    });

    // Learnings
    const learningLines = candidates.learnings ?? [];
    learningLines.forEach((l, i) => {
      questions[`L${i}`] = {
        type: 'noul',
        instructions: `Is this behavioral insight relevant to how the assistant should respond? Insight: "${l.trim()}"`,
        criteria: {
          true: 'Applies directly to the interaction or topic.',
          false: 'Not applicable to this turn.',
        },
      };
    });

    if (Object.keys(questions).length === 0) return null;

    const startedAt = Date.now();
    try {
      const response = await this.decisionProvider.decide(
        {
          state: `User message: "${message}"`,
          questions,
        },
        { timeoutMs },
      );

      if (!response || !response.answers) return null;

      const durationMs = Date.now() - startedAt;

      // Relevance thresholds calibrated for calibrated decision models:
      // True positive relevance >= 0.45; noise <= 0.15
      const FACT_THRESHOLD = 0.45;
      const MSG_THRESHOLD = 0.50;
      const CONV_THRESHOLD = 0.50;
      const LEARNING_THRESHOLD = 0.50;

      const maxFacts = complexityScore > 0.6 ? 12 : (complexityScore > 0.3 ? 8 : 4);
      const maxMsgs = complexityScore > 0.6 ? 5 : 3;
      const maxConvs = 2;
      const maxLearnings = 3;

      // Scored facts
      const scoredFacts = candidates.facts
        .map((f, i) => {
          const ans = response.answers[`F${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          return { fact: f, score };
        })
        .filter(item => item.score >= FACT_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxFacts);

      const selectedFacts = scoredFacts.map(s => s.fact);
      const selectedFactSet = new Set(selectedFacts);

      // Track dropped facts
      candidates.facts.forEach((f, i) => {
        if (!selectedFactSet.has(f)) {
          const ans = response.answers[`F${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          droppedItems.push({
            type: 'fact',
            key: `${f.category}/${f.factKey}`,
            content: f.factValue,
            score,
            timestamp: Date.now(),
          });
        }
      });

      // Scored messages
      const scoredMsgs = candidates.similarMessages
        .map((m, i) => {
          const ans = response.answers[`M${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          return { msg: m, score };
        })
        .filter(item => item.score >= MSG_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxMsgs);

      const selectedMsgs = scoredMsgs.map(s => s.msg);
      const selectedMsgSet = new Set(selectedMsgs);

      // Track dropped messages
      candidates.similarMessages.forEach((m, i) => {
        if (!selectedMsgSet.has(m)) {
          const ans = response.answers[`M${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          droppedItems.push({
            type: 'message',
            key: m.role,
            content: m.content.slice(0, 300),
            score,
            timestamp: Date.now(),
          });
        }
      });

      // Scored conversations
      const scoredConvs = candidates.similarConversations
        .map((c, i) => {
          const ans = response.answers[`C${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          return { conv: c, score };
        })
        .filter(item => item.score >= CONV_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxConvs);

      const selectedConvs = scoredConvs.map(s => s.conv);
      const selectedConvSet = new Set(selectedConvs);

      // Track dropped conversations
      candidates.similarConversations.forEach((c, i) => {
        if (!selectedConvSet.has(c)) {
          const ans = response.answers[`C${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          droppedItems.push({
            type: 'conversation',
            key: c.topics ? c.topics.join(', ') : '',
            content: c.summary,
            score,
            timestamp: Date.now(),
          });
        }
      });

      // Scored learnings
      const scoredLearnings = learningLines
        .map((l, i) => {
          const ans = response.answers[`L${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          return { learning: l, score };
        })
        .filter(item => item.score >= LEARNING_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxLearnings);

      const selectedLearnings = scoredLearnings.map(s => s.learning);
      const selectedLearningSet = new Set(selectedLearnings);

      learningLines.forEach((l, i) => {
        if (!selectedLearningSet.has(l)) {
          const ans = response.answers[`L${i}`];
          const score = ans && 'noul' in ans ? (ans.noul ?? 0) : 0;
          droppedItems.push({
            type: 'learning',
            key: '',
            content: l.trim(),
            score,
            timestamp: Date.now(),
          });
        }
      });

      // Persist dropped items to Rejection Ledger
      if (sessionId && this.rejectionLedger && droppedItems.length > 0) {
        void this.rejectionLedger.recordDroppedMemories(sessionId, droppedItems);
      }

      const totalCandidates =
        candidates.facts.length +
        candidates.similarMessages.length +
        candidates.similarConversations.length +
        learningLines.length;

      const totalSelected =
        selectedFacts.length +
        selectedMsgs.length +
        selectedConvs.length +
        selectedLearnings.length;

      const totalDropped = totalCandidates - totalSelected;

      // In-band curator ring seen at token 0
      let curatorRing = '';
      if (totalCandidates === 0) {
        curatorRing = '[Curator: 0 evaluated — storage returned no candidate memories]';
      } else if (totalSelected === 0) {
        curatorRing = `[Curator: ${totalCandidates} evaluated, 0 kept, ${totalDropped} dropped — all candidates scored below relevance threshold]`;
      } else {
        curatorRing = `[Curator: ${totalCandidates} evaluated, ${totalSelected} kept, ${totalDropped} dropped]`;
      }

      return {
        skipped: false,
        facts: selectedFacts,
        similarMessages: selectedMsgs,
        similarConversations: selectedConvs,
        learnings: selectedLearnings,
        curatorRing,
        reasoning: `Decision model curated ${totalSelected}/${totalCandidates} memories in ${durationMs}ms`,
      };
    } catch (err) {
      this.logger?.debug('Decision curation failed', { error: (err as Error).message });
      return null;
    }
  }

  private async curateWithLlm(
    message: string,
    candidates: MemoryCandidates,
    complexityScore: number,
    sessionId?: string,
    timeoutMs = 4000,
  ): Promise<CurationResult> {
    const candidateLines: string[] = [];

    if (candidates.facts.length > 0) {
      candidateLines.push('## FACTS');
      candidates.facts.forEach((f, i) => {
        candidateLines.push(`[${i}] ${f.category}/${f.factKey}: ${f.factValue}`);
      });
    }

    if (candidates.similarMessages.length > 0) {
      candidateLines.push('\n## SIMILAR PAST MESSAGES');
      candidates.similarMessages.forEach((m, i) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        candidateLines.push(`[${i}] [${role}]: ${m.content.slice(0, 150)}`);
      });
    }

    if (candidates.similarConversations.length > 0) {
      candidateLines.push('\n## SIMILAR PAST CONVERSATIONS');
      candidates.similarConversations.forEach((c, i) => {
        candidateLines.push(`[${i}] ${c.summary}`);
      });
    }

    if (candidateLines.length === 0) {
      const curatorRing = '[Curator: 0 evaluated — storage returned no candidate memories]';
      return {
        skipped: false,
        facts: [],
        similarMessages: [],
        similarConversations: [],
        curatorRing,
      };
    }

    const prompt = `Current message: "${message}"\nComplexity: ${complexityScore.toFixed(2)}\n\nCandidates:\n${candidateLines.join('\n')}`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = this.llm.chat(
        [
          { role: 'system', content: CURATION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.1, maxTokens: 400, json: true },
      );

      const timeoutPromise = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });

      const raw = await Promise.race([call, timeoutPromise]);
      if (!raw) {
        return {
          skipped: true,
          facts: candidates.facts,
          similarMessages: candidates.similarMessages,
          similarConversations: candidates.similarConversations,
          learnings: candidates.learnings,
        };
      }

      const parsed = parseGateJson<{
        selectedFacts?: number[];
        selectedMessages?: number[];
        selectedConversations?: number[];
        reasoning?: string;
      }>(raw);

      if (!parsed) {
        return {
          skipped: true,
          facts: candidates.facts,
          similarMessages: candidates.similarMessages,
          similarConversations: candidates.similarConversations,
          learnings: candidates.learnings,
        };
      }

      const selectedFactIdxs = new Set(parsed.selectedFacts ?? []);
      const selectedMsgIdxs = new Set(parsed.selectedMessages ?? []);
      const selectedConvIdxs = new Set(parsed.selectedConversations ?? []);

      const selectedFacts = candidates.facts.filter((_, i) => selectedFactIdxs.has(i));
      const selectedMsgs = candidates.similarMessages.filter((_, i) => selectedMsgIdxs.has(i));
      const selectedConvs = candidates.similarConversations.filter((_, i) => selectedConvIdxs.has(i));

      // Record dropped memories
      const droppedItems: DroppedMemoryItem[] = [];
      candidates.facts.forEach((f, i) => {
        if (!selectedFactIdxs.has(i)) {
          droppedItems.push({
            type: 'fact',
            key: `${f.category}/${f.factKey}`,
            content: f.factValue,
            score: 0,
            timestamp: Date.now(),
          });
        }
      });
      candidates.similarMessages.forEach((m, i) => {
        if (!selectedMsgIdxs.has(i)) {
          droppedItems.push({
            type: 'message',
            key: m.role,
            content: m.content.slice(0, 300),
            score: 0,
            timestamp: Date.now(),
          });
        }
      });
      candidates.similarConversations.forEach((c, i) => {
        if (!selectedConvIdxs.has(i)) {
          droppedItems.push({
            type: 'conversation',
            key: c.topics ? c.topics.join(', ') : '',
            content: c.summary,
            score: 0,
            timestamp: Date.now(),
          });
        }
      });

      if (sessionId && this.rejectionLedger && droppedItems.length > 0) {
        void this.rejectionLedger.recordDroppedMemories(sessionId, droppedItems);
      }

      const totalCandidates =
        candidates.facts.length +
        candidates.similarMessages.length +
        candidates.similarConversations.length;
      const totalSelected = selectedFacts.length + selectedMsgs.length + selectedConvs.length;
      const totalDropped = totalCandidates - totalSelected;

      let curatorRing = '';
      if (totalSelected === 0) {
        curatorRing = `[Curator: ${totalCandidates} evaluated, 0 kept, ${totalDropped} dropped — all candidates scored below relevance threshold]`;
      } else {
        curatorRing = `[Curator: ${totalCandidates} evaluated, ${totalSelected} kept, ${totalDropped} dropped]`;
      }

      return {
        skipped: false,
        facts: selectedFacts,
        similarMessages: selectedMsgs,
        similarConversations: selectedConvs,
        learnings: candidates.learnings,
        curatorRing,
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      this.logger?.debug('LLM curation failed', { error: (err as Error).message });
      return {
        skipped: true,
        facts: candidates.facts,
        similarMessages: candidates.similarMessages,
        similarConversations: candidates.similarConversations,
        learnings: candidates.learnings,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
