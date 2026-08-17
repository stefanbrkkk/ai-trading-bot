/**
 * Provider selection.
 *
 * The rule is deliberately blunt: a provider is *available* only when its
 * credential is a non-empty string after trimming. There is no default key, no
 * bundled key and no "demo" key — an unset variable and an empty variable are
 * the same thing, which is what lets `.env.example` ship with every key blank
 * and still describe a working system.
 *
 * `AURELIUS_LLM_PROVIDER` selects between credentials when more than one is
 * present. Naming a provider whose key is missing does not fail the process; it
 * degrades to the deterministic engine and says so in the status reason, because
 * a misconfigured key must never take the platform down.
 */

export type ProviderId = 'deterministic' | 'anthropic' | 'openai' | 'deepseek';

export const PROVIDER_IDS: readonly ProviderId[] = ['deterministic', 'anthropic', 'openai', 'deepseek'];

export interface ProviderCredentials {
  id: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const DEFAULT_MODELS: Record<Exclude<ProviderId, 'deterministic'>, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4.1',
  deepseek: 'deepseek-reasoner',
};

const DEFAULT_BASE_URLS: Record<Exclude<ProviderId, 'deterministic'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
};

/** Trimmed value, or '' for unset/blank/whitespace. */
function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function keyFor(id: Exclude<ProviderId, 'deterministic'>): string {
  switch (id) {
    case 'anthropic':
      return env('ANTHROPIC_API_KEY');
    case 'openai':
      return env('OPENAI_API_KEY');
    case 'deepseek':
      return env('DEEPSEEK_API_KEY');
  }
}

function modelFor(id: Exclude<ProviderId, 'deterministic'>): string {
  switch (id) {
    case 'anthropic':
      return env('ANTHROPIC_MODEL') || DEFAULT_MODELS.anthropic;
    case 'openai':
      return env('OPENAI_MODEL') || DEFAULT_MODELS.openai;
    case 'deepseek':
      return env('DEEPSEEK_MODEL') || DEFAULT_MODELS.deepseek;
  }
}

function baseUrlFor(id: Exclude<ProviderId, 'deterministic'>): string {
  switch (id) {
    case 'anthropic':
      return env('ANTHROPIC_BASE_URL') || DEFAULT_BASE_URLS.anthropic;
    case 'openai':
      return env('OPENAI_BASE_URL') || DEFAULT_BASE_URLS.openai;
    case 'deepseek':
      return env('DEEPSEEK_BASE_URL') || DEFAULT_BASE_URLS.deepseek;
  }
}

/** Every provider whose credential is present, in declaration order. */
export function configuredProviders(): ProviderId[] {
  const found: ProviderId[] = [];
  for (const id of PROVIDER_IDS) {
    if (id === 'deterministic') continue;
    if (keyFor(id).length > 0) found.push(id);
  }
  return found;
}

/** The requested provider, whether or not it is usable. */
export function requestedProvider(): ProviderId {
  const raw = env('AURELIUS_LLM_PROVIDER').toLowerCase();
  if (raw.length === 0) return 'deterministic';
  return (PROVIDER_IDS as readonly string[]).includes(raw) ? (raw as ProviderId) : 'deterministic';
}

export interface Resolution {
  id: ProviderId;
  credentials: ProviderCredentials | null;
  /** Human-readable explanation of the choice, shown on the transparency page. */
  reason: string;
}

/**
 * Resolves the provider actually in force.
 *
 * The precedence is: an explicit request that has a key wins; an explicit
 * request without a key degrades and explains; with no request, a single present
 * key is adopted automatically (so dropping one key in during final testing is
 * enough), and several present keys with no selection stay deterministic rather
 * than guessing which one the operator meant to spend money on.
 */
export function resolveProvider(): Resolution {
  const requested = requestedProvider();
  const available = configuredProviders();

  if (requested !== 'deterministic') {
    const apiKey = keyFor(requested);
    if (apiKey.length === 0) {
      return {
        id: 'deterministic',
        credentials: null,
        reason: `AURELIUS_LLM_PROVIDER names "${requested}" but no credential is present, so the deterministic engines are serving. Set the matching API key to switch to live inference.`,
      };
    }
    return {
      id: requested,
      credentials: { id: requested, apiKey, model: modelFor(requested), baseUrl: baseUrlFor(requested) },
      reason: `Live inference through ${requested} (${modelFor(requested)}).`,
    };
  }

  if (available.length === 1) {
    const id = available[0] as Exclude<ProviderId, 'deterministic'>;
    return {
      id,
      credentials: { id, apiKey: keyFor(id), model: modelFor(id), baseUrl: baseUrlFor(id) },
      reason: `Live inference through ${id} (${modelFor(id)}), adopted because it is the only credential present.`,
    };
  }

  if (available.length > 1) {
    return {
      id: 'deterministic',
      credentials: null,
      reason: `Credentials are present for ${available.join(', ')} but AURELIUS_LLM_PROVIDER does not name one, so the deterministic engines are serving rather than picking a vendor on your behalf.`,
    };
  }

  return {
    id: 'deterministic',
    credentials: null,
    reason:
      'The deterministic narrative, grading and query engines are serving. Add a provider key to switch to live inference; nothing else changes.',
  };
}

/** Request timeout for a live call. Beyond this the deterministic engine answers. */
export const LLM_TIMEOUT_MS = 20_000;

/** Default generation ceiling. Adapters clamp to this when unspecified. */
export const LLM_MAX_TOKENS = 1400;
