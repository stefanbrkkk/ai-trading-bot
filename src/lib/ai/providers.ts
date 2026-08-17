/**
 * Vendor adapters.
 *
 * Three of them, all built on `fetch`, no SDKs. That is a deliberate dependency
 * decision rather than minimalism for its own sake: an SDK would have to be
 * installed and version-pinned for a code path that is inert until an operator
 * supplies a key, and the build contract requires `npm install` to produce a
 * working platform with no vendor packages present at all.
 *
 * Every adapter obeys the same three rules:
 *
 *   1. The credential is read from the resolution, never from the environment
 *      directly, so provider selection has exactly one implementation.
 *   2. A failure raises `LlmError` with the vendor's HTTP status attached. The
 *      caller in `index.ts` converts that into a deterministic completion, so a
 *      vendor outage degrades the prose and nothing else.
 *   3. The request carries an abort signal derived from `LLM_TIMEOUT_MS`, because
 *      a hung vendor connection must not hold a Next.js route handler open.
 */

import { LLM_MAX_TOKENS, type ProviderCredentials } from '@/lib/ai/config';
import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse } from '@/lib/ai/types';

/** Vendor payloads are unknown-shaped; these narrow without `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Parses a JSON reply, tolerating the fenced-code-block wrapper models add even
 * when instructed not to. Returns null rather than throwing: a caller that asked
 * for JSON has a deterministic path to fall back to.
 */
function parseJsonReply(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  if (candidate.length === 0) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // A model sometimes prefixes prose. Recover the outermost JSON value.
    const firstBrace = candidate.search(/[[{]/);
    const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Merges the caller's abort signal with a timeout.
 *
 * `AbortSignal.any` exists on Node 20+, but constructing the composite by hand
 * keeps the timer disposable so a fast reply does not leave a 20-second handle
 * holding the event loop open — which in a serverless runtime shows up as a
 * function that will not return.
 */
function timeoutSignal(request: LlmRequest, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`The provider did not respond within ${timeoutMs}ms.`)), timeoutMs);
  const forward = (): void => controller.abort(request.signal?.reason);
  if (request.signal) {
    if (request.signal.aborted) forward();
    else request.signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forward);
    },
  };
}

/** Non-system turns, in order. Both vendor APIs hoist the system prompt. */
function conversation(request: LlmRequest): LlmMessage[] {
  return request.messages.filter((message) => message.role !== 'system');
}

/** The system prompt plus the JSON instruction, when one was requested. */
function systemPrompt(request: LlmRequest): string {
  if (request.jsonSchemaHint === undefined) return request.system;
  return `${request.system}\n\nReply with a single JSON value and nothing else — no prose, no code fence. It must match this shape:\n${request.jsonSchemaHint}`;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '(the error body could not be read)';
  }
}

function finish(
  request: LlmRequest,
  credentials: ProviderCredentials,
  text: string,
  usage: { promptTokens: number; completionTokens: number },
  startedAt: number,
  httpStatus: number,
): LlmResponse {
  return {
    text,
    json: request.jsonSchemaHint === undefined ? null : parseJsonReply(text),
    provider: credentials.id,
    model: credentials.model,
    live: true,
    usage,
    latencyMs: Math.max(0, Date.now() - startedAt),
    fallbackReason: null,
    httpStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Anthropic — /v1/messages
// ─────────────────────────────────────────────────────────────────────────────

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly live = true;

  constructor(private readonly credentials: ProviderCredentials) {}

  get model(): string {
    return this.credentials.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const { signal, dispose } = timeoutSignal(request, 20_000);
    try {
      const response = await fetch(`${this.credentials.baseUrl}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.credentials.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.credentials.model,
          max_tokens: Math.min(request.maxTokens ?? LLM_MAX_TOKENS, LLM_MAX_TOKENS),
          temperature: request.temperature ?? 0,
          system: systemPrompt(request),
          messages: conversation(request).map((message) => ({ role: message.role, content: message.content })),
        }),
      });

      if (!response.ok) {
        throw new LlmError(`Anthropic returned ${response.status}: ${await readErrorBody(response)}`, response.status);
      }

      const body = asRecord(await response.json());
      // Content is a block array; only `text` blocks are requested here, and a
      // model that returns none has produced an empty completion, not an error.
      const blocks = Array.isArray(body?.content) ? (body.content as unknown[]) : [];
      const text = blocks
        .map((block) => readString(asRecord(block), 'text') ?? '')
        .join('')
        .trim();
      const usage = asRecord(body?.usage);

      return finish(
        request,
        this.credentials,
        text,
        { promptTokens: readNumber(usage, 'input_tokens'), completionTokens: readNumber(usage, 'output_tokens') },
        startedAt,
        response.status,
      );
    } finally {
      dispose();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  OpenAI and DeepSeek — /v1/chat/completions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DeepSeek is wire-compatible with OpenAI's chat-completions endpoint, so one
 * adapter serves both and differs only in base URL and model name. The
 * `response_format` hint is sent for both; DeepSeek's reasoner honours it, and a
 * vendor that does not simply ignores an unknown field.
 */
class ChatCompletionsProvider implements LlmProvider {
  readonly live = true;

  constructor(
    readonly name: string,
    private readonly credentials: ProviderCredentials,
  ) {}

  get model(): string {
    return this.credentials.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const { signal, dispose } = timeoutSignal(request, 20_000);
    try {
      const payload: Record<string, unknown> = {
        model: this.credentials.model,
        max_tokens: Math.min(request.maxTokens ?? LLM_MAX_TOKENS, LLM_MAX_TOKENS),
        temperature: request.temperature ?? 0,
        messages: [
          { role: 'system', content: systemPrompt(request) },
          ...conversation(request).map((message) => ({ role: message.role, content: message.content })),
        ],
      };
      if (request.jsonSchemaHint !== undefined) payload.response_format = { type: 'json_object' };

      const response = await fetch(`${this.credentials.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.credentials.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new LlmError(`${this.name} returned ${response.status}: ${await readErrorBody(response)}`, response.status);
      }

      const body = asRecord(await response.json());
      const choices = Array.isArray(body?.choices) ? (body.choices as unknown[]) : [];
      const message = asRecord(asRecord(choices[0])?.message);
      const text = (readString(message, 'content') ?? '').trim();
      const usage = asRecord(body?.usage);

      return finish(
        request,
        this.credentials,
        text,
        { promptTokens: readNumber(usage, 'prompt_tokens'), completionTokens: readNumber(usage, 'completion_tokens') },
        startedAt,
        response.status,
      );
    } finally {
      dispose();
    }
  }
}

/** Builds the adapter for a resolved credential set. */
export function createProvider(credentials: ProviderCredentials): LlmProvider {
  switch (credentials.id) {
    case 'anthropic':
      return new AnthropicProvider(credentials);
    case 'openai':
      return new ChatCompletionsProvider('openai', credentials);
    case 'deepseek':
      return new ChatCompletionsProvider('deepseek', credentials);
    case 'deterministic':
      throw new LlmError('The deterministic engine is not a vendor adapter.');
  }
}
