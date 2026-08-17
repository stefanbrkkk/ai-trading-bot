/**
 * The AI subsystem's public surface.
 *
 * `complete()` is the single entry point. It never rejects and it never returns
 * an unusable response: a vendor failure, a timeout, a malformed reply or a
 * missing credential all resolve to a deterministic completion carrying the
 * reason in `fallbackReason`. Callers therefore have no error branch to forget,
 * and the platform's behaviour with keys and without keys differs in prose
 * quality alone.
 *
 * One guarantee is worth stating explicitly because it is structural rather than
 * documented: this module imports nothing from `@/lib/risk`, `@/lib/broker` or
 * the order routes. A completion cannot, by construction, place an order,
 * change a limit or clear a rejection.
 */

import { LLM_TIMEOUT_MS, configuredProviders, resolveProvider } from '@/lib/ai/config';
import { DETERMINISTIC_MODEL, DETERMINISTIC_PROVIDER, deterministicComplete } from '@/lib/ai/deterministic';
import { createProvider } from '@/lib/ai/providers';
import type { AiStatus, LlmProvider, LlmRequest, LlmResponse } from '@/lib/ai/types';

export type {
  AiStatus,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmRole,
  LlmTask,
  LlmUsage,
} from '@/lib/ai/types';
export { LlmError } from '@/lib/ai/types';
export type { ProviderId } from '@/lib/ai/config';
export { PROVIDER_IDS, configuredProviders, requestedProvider } from '@/lib/ai/config';
export { DETERMINISTIC_MODEL, DETERMINISTIC_PROVIDER, extractiveSummary, splitSentences, tokenise } from '@/lib/ai/deterministic';

/**
 * The adapter is cached because provider resolution reads the environment, and
 * a route handler that completes four times per request should not re-resolve
 * four times. The cache key is the resolution's identity, so changing a key in
 * a long-running dev server takes effect on the next call rather than requiring
 * a restart.
 */
let cached: { key: string; provider: LlmProvider } | null = null;

function activeProvider(): LlmProvider | null {
  const resolution = resolveProvider();
  if (resolution.credentials === null) {
    cached = null;
    return null;
  }
  const key = `${resolution.credentials.id}:${resolution.credentials.model}:${resolution.credentials.apiKey.length}`;
  if (cached?.key === key) return cached.provider;
  const provider = createProvider(resolution.credentials);
  cached = { key, provider };
  return provider;
}

/** Discards the cached adapter. Used by the tests and after a config change. */
export function resetAiProvider(): void {
  cached = null;
}

/** True when a live vendor is selected and credentialed. */
export function aiLive(): boolean {
  return resolveProvider().credentials !== null;
}

export function aiStatus(): AiStatus {
  const resolution = resolveProvider();
  return {
    provider: resolution.credentials?.id ?? DETERMINISTIC_PROVIDER,
    model: resolution.credentials?.model ?? DETERMINISTIC_MODEL,
    live: resolution.credentials !== null,
    configuredProviders: configuredProviders(),
    reason: resolution.reason,
  };
}

/**
 * Runs a completion.
 *
 * An empty reply from a live vendor is treated as a failure rather than passed
 * through: a surface that renders a signal's narrative must show text, and an
 * empty string would present as a rendering bug rather than as the vendor
 * problem it is.
 */
export async function complete(request: LlmRequest): Promise<LlmResponse> {
  const startedAt = Date.now();
  const provider = activeProvider();
  if (provider === null) return deterministicComplete(request, startedAt);

  try {
    const response = await provider.complete(request);
    if (response.text.length === 0) {
      return degrade(request, startedAt, `${provider.name} returned an empty completion.`);
    }
    if (request.jsonSchemaHint !== undefined && response.json === null) {
      return degrade(request, startedAt, `${provider.name} did not return parseable JSON.`);
    }
    return response;
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === 'AbortError' || error.name === 'TimeoutError'
          ? `${provider.name} did not respond within ${LLM_TIMEOUT_MS}ms.`
          : error.message
        : String(error);
    return degrade(request, startedAt, reason);
  }
}

function degrade(request: LlmRequest, startedAt: number, reason: string): LlmResponse {
  // Logged, not swallowed: an operator who supplied a key needs to know it is
  // not being used, and the reason belongs in the server log next to the
  // correlation id rather than only in a response field nobody reads.
  console.warn(`[ai] falling back to the deterministic engine — ${reason}`);
  const fallback = deterministicComplete(request, startedAt);
  return { ...fallback, fallbackReason: reason };
}

/**
 * A convenience wrapper for the common single-turn case.
 *
 * `requestedProvider()` is re-exported alongside it so a surface can say
 * "configured for anthropic, serving deterministic" rather than the less useful
 * "deterministic".
 */
export async function completeText(
  task: LlmRequest['task'],
  system: string,
  prompt: string,
  options: { maxTokens?: number; temperature?: number; correlationId?: string; signal?: AbortSignal } = {},
): Promise<LlmResponse> {
  return complete({
    task,
    system,
    messages: [{ role: 'user', content: prompt }],
    ...options,
  });
}
