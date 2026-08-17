/**
 * Optional-subsystem resolution.
 *
 * A few subsystems are genuinely optional at runtime — the language-model
 * provider, the retrieval pipeline, the text-to-SQL compiler. A route that
 * depends on one must still answer when it is absent, with an explanation rather
 * than a 500.
 *
 * The specifier is passed as a variable so the bundler treats it as a runtime
 * lookup instead of a hard build-time edge. That is the point: it lets the health
 * endpoint and the feature routes degrade cleanly instead of failing to compile
 * against a module that may not be installed in a given deployment.
 */

const cache = new Map<string, Record<string, unknown> | null>();

export async function optionalModule(specifier: string): Promise<Record<string, unknown> | null> {
  const cached = cache.get(specifier);
  if (cached !== undefined) return cached;
  try {
    const resolved = (await import(specifier)) as Record<string, unknown>;
    cache.set(specifier, resolved);
    return resolved;
  } catch {
    cache.set(specifier, null);
    return null;
  }
}

/** Narrows an export to a callable, or null when it is missing. */
export function moduleFunction<F extends (...args: never[]) => unknown>(
  ns: Record<string, unknown> | null,
  name: string,
): F | null {
  const value = ns?.[name];
  return typeof value === 'function' ? (value as F) : null;
}

/** Narrows an export to an array, or null. */
export function moduleArray<T>(ns: Record<string, unknown> | null, name: string): T[] | null {
  const value = ns?.[name];
  return Array.isArray(value) ? (value as T[]) : null;
}

export interface AiStatus {
  provider: string;
  model: string;
  live: boolean;
  configuredProviders: string[];
  reason: string;
}

const DETERMINISTIC_AI: AiStatus = {
  provider: 'deterministic',
  model: 'aurelius-deterministic',
  live: false,
  configuredProviders: [],
  reason:
    'The deterministic narrative, grading and query engines are serving. Add a provider key to switch to live inference; nothing else changes.',
};

/** The AI subsystem's status, or the deterministic default. */
export async function aiStatus(): Promise<AiStatus> {
  const ns = await optionalModule('@/lib/ai');
  const fn = moduleFunction<() => AiStatus>(ns, 'aiStatus');
  if (!fn) return DETERMINISTIC_AI;
  try {
    return fn();
  } catch {
    return DETERMINISTIC_AI;
  }
}
