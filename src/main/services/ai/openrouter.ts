/**
 * The OpenRouter API (https://openrouter.ai/docs), used only for reading supplier bills. Requests
 * go through `fetch` given by the Electron layer: a session that can reach nothing but OpenRouter.
 * Every failure becomes a message a shop owner can act on.
 */
import { AppError, ErrorCodes } from '@shared/errors';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** The only addresses the AI session may reach: OpenRouter's API, and a local stand-in in tests. */
export function isAllowedAiUrl(url: string, testBaseUrl?: string | null): boolean {
  if (url.startsWith(`${OPENROUTER_BASE}/`)) return true;
  return !!testBaseUrl && url.startsWith(`${testBaseUrl.replace(/\/$/, '')}/`);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelInfo {
  id: string;
  name: string;
  inputModalities: string[];
  supportedParameters: string[];
}

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** US dollars, when OpenRouter reports it. */
  cost: number | null;
}

const fail = (message: string, detail?: string) => new AppError(ErrorCodes.IO, message, detail ? { detail } : undefined);

function messageForStatus(status: number, apiMessage: string): string {
  switch (status) {
    case 400:
      return `OpenRouter did not accept the request: ${apiMessage || 'bad request'}. The model may not read this kind of file.`;
    case 401:
      return 'OpenRouter did not accept the API key. Check the key in Backup & Settings → AI assistant.';
    case 402:
      return 'Your OpenRouter account has no credit left. Add credit at openrouter.ai, then try again.';
    case 403:
      return `OpenRouter refused this request: ${apiMessage || 'not allowed'}.`;
    case 404:
      return 'OpenRouter does not know the chosen model. Check the model name in Backup & Settings → AI assistant.';
    case 408:
      return 'The AI model took too long to answer. Try again, or try a clearer photo.';
    case 413:
      return 'The bill file is too large for OpenRouter. Use a smaller photo.';
    case 429:
      return 'Too many requests to OpenRouter just now. Wait a minute and try again.';
    case 502:
    case 503:
      return 'The AI model is not available right now. Try again in a few minutes, or choose another model.';
    default:
      return `OpenRouter answered with an error (${status})${apiMessage ? `: ${apiMessage}` : ''}.`;
  }
}

export class OpenRouterClient {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly apiKey: string,
    private readonly baseUrl = OPENROUTER_BASE,
  ) {}

  private async request(path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number }): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // Shown on the owner's OpenRouter activity page.
          'X-Title': 'Hardware Shop Manager',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw fail('The AI model took too long to answer. Try again, or try a clearer or smaller photo.');
      }
      if (/BLOCKED/i.test(err.message)) throw fail('The request was blocked: only OpenRouter may be contacted.', err.message);
      throw fail('Could not reach OpenRouter. Check that this computer is connected to the internet.', err.message);
    }
    const body = await res.text();
    let json: unknown = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      // handled below
    }
    const apiError = (json as { error?: { code?: number; message?: string } } | null)?.error;
    if (!res.ok) throw fail(messageForStatus(res.status, apiError?.message ?? ''), `${res.status} ${body.slice(0, 300)}`);
    // Errors after a provider accepted the request come back with status 200.
    if (apiError) throw fail(messageForStatus(Number(apiError.code) || 500, apiError.message ?? ''), body.slice(0, 300));
    if (json === null) throw fail('OpenRouter sent an answer that could not be read.', body.slice(0, 300));
    return json;
  }

  /** The key's own details; fails with the "key not accepted" message for a wrong key. */
  async keyInfo(): Promise<{ creditLeft: number | null }> {
    const r = (await this.request('/key', { method: 'GET', timeoutMs: 20_000 })) as { data?: { limit_remaining?: number | null } };
    const left = r.data?.limit_remaining;
    return { creditLeft: typeof left === 'number' ? left : null };
  }

  async model(id: string): Promise<ModelInfo | null> {
    const r = (await this.request('/models', { method: 'GET', timeoutMs: 30_000 })) as {
      data?: { id: string; name?: string; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] }[];
    };
    const m = (r.data ?? []).find((x) => x.id === id);
    if (!m) return null;
    return {
      id: m.id,
      name: m.name ?? m.id,
      inputModalities: m.architecture?.input_modalities ?? [],
      supportedParameters: m.supported_parameters ?? [],
    };
  }

  async chat(body: Record<string, unknown>, timeoutMs: number): Promise<ChatResult> {
    const r = (await this.request('/chat/completions', { method: 'POST', body, timeoutMs })) as {
      model?: string;
      choices?: { message?: { content?: string | { type: string; text?: string }[] | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const choice = r.choices?.[0];
    const content = choice?.message?.content;
    const textContent = Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : (content ?? '');
    if (!textContent.trim()) {
      throw fail(
        choice?.finish_reason === 'length'
          ? 'The bill is too long for the model to answer in one go. Try a model that allows longer answers.'
          : 'The AI model returned an empty answer. Try again, or choose another model.',
      );
    }
    return {
      content: textContent,
      model: r.model ?? String(body.model),
      promptTokens: r.usage?.prompt_tokens ?? null,
      completionTokens: r.usage?.completion_tokens ?? null,
      cost: typeof r.usage?.cost === 'number' ? r.usage.cost : null,
    };
  }
}
