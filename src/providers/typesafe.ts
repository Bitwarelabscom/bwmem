import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from '../types.js';

export interface TypeSafeProviderConfig {
  apiKey: string;
  url?: string;         // default: 'https://api.typesafe.ai/v1'
  model?: string;       // default: 'jev-latest'
  timeoutMs?: number;   // default: 3000
}

/**
 * Direct TypeSafe AI provider for System One decision models (Jev).
 * Evaluates typed questions (noul, choice, score) in 70-500ms with calibrated probabilities.
 */
export class TypeSafeProvider implements DecisionProvider {
  private apiKey: string;
  private url: string;
  private model: string;
  private defaultTimeoutMs: number;

  constructor(config: TypeSafeProviderConfig) {
    if (!config.apiKey) {
      throw new Error('TypeSafeProvider requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.url = (config.url ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
    this.model = config.model ?? 'jev-latest';
    this.defaultTimeoutMs = config.timeoutMs ?? 3000;
  }

  async decide(
    request: DecisionRequest,
    options?: { timeoutMs?: number },
  ): Promise<DecisionResponse> {
    const endpoint = `${this.url}/systemone`;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: request.state,
          model: request.model ?? this.model,
          questions: request.questions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`TypeSafe API failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as DecisionResponse;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
