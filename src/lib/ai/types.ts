/**
 * The language-model seam.
 *
 * Every generative surface in the platform — the XAI narrative polish, the
 * InvestGPT text-to-SQL fallback, the RAG synthesis and the FinGround claim
 * grader — speaks to a model through this one interface. Nothing else in the
 * codebase constructs an HTTP request to a model vendor.
 *
 * Two properties matter more than the shape itself:
 *
 *   • The interface is satisfiable *without* a network. The deterministic
 *     provider below is a first-class implementation, not a stub, so the whole
 *     platform runs with a completely empty `.env`. That is the build contract:
 *     the AI keys go in during final testing, and nothing else changes.
 *
 *   • A completion is always *advisory*. `LlmResponse` carries text and
 *     metadata; it carries no authority. No caller may route an order, mutate
 *     the ledger or bypass a risk check on the strength of a model reply — the
 *     order path is reachable only from a physical click (Phase 5 §1), and this
 *     module has no import of the broker or risk engines to make that
 *     structural rather than aspirational.
 */

/** Conversation roles. `system` is hoisted out of the array by each adapter. */
export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** Named so the audit trail records *why* a completion was requested. */
export type LlmTask =
  | 'narrative'
  | 'counter_thesis'
  | 'nl_to_sql'
  | 'rag_synthesis'
  | 'claim_grading'
  | 'summarise';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  messages: LlmMessage[];
  /** Upper bound on generated tokens. Adapters clamp to their own ceiling. */
  maxTokens?: number;
  /** 0 for anything the audit trail must be able to reproduce. */
  temperature?: number;
  /**
   * When set, the provider is asked for JSON only and the reply is parsed
   * before it is returned. A provider that cannot enforce this still gets the
   * instruction in the system prompt, and `json` stays null if parsing fails.
   */
  jsonSchemaHint?: string;
  /** Aborts a live call. The deterministic provider ignores it — it cannot block. */
  signal?: AbortSignal;
  /** Threaded into the completion record so a reply can be traced to a request. */
  correlationId?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResponse {
  text: string;
  /** Parsed body when `jsonSchemaHint` was set and the reply was valid JSON. */
  json: unknown | null;
  provider: string;
  model: string;
  /** False whenever the deterministic engine produced the text. */
  live: boolean;
  usage: LlmUsage;
  latencyMs: number;
  /** Populated when a live call failed and the deterministic engine took over. */
  fallbackReason: string | null;
  /** Vendor HTTP status, or null for the deterministic engine. */
  httpStatus: number | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** True only when a credential is present and the adapter can reach a vendor. */
  readonly live: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** What the health endpoint and the transparency page report. */
export interface AiStatus {
  provider: string;
  model: string;
  live: boolean;
  /** Every provider with a credential present, whether selected or not. */
  configuredProviders: string[];
  reason: string;
}

/** Raised by an adapter when a vendor call fails. Never escapes `complete()`. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
