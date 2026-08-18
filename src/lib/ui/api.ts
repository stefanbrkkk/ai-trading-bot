/**
 * The browser's side of the API contract.
 *
 * One place where a fetch is constructed, one error shape, one loading state.
 * That matters more here than in a typical app because of a constraint the
 * research is explicit about: the React runtime performs **zero mathematical
 * aggregation**. Every number a page renders was computed server-side, so the
 * client's only job is to move a payload to a component — and a client whose only
 * job is transport should have exactly one implementation of it.
 *
 * The hook deliberately does not cache across mounts. A signal, a quote and a risk
 * decision are all time-sensitive, and a stale conviction score rendered as
 * current is a materially misleading number. Refresh is explicit: the caller polls
 * or the user acts.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** The error envelope every route returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  return typeof candidate === 'object' && candidate !== null && 'code' in candidate && 'message' in candidate;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Extra headers; `content-type` is set automatically when a body is present. */
  headers?: Record<string, string>;
}

/**
 * Issues one request.
 *
 * A non-2xx response with a well-formed error envelope becomes an
 * `ApiRequestError` carrying the server's own code and message. That is what lets
 * the UI render the *mandated* copy for a risk rejection rather than inventing its
 * own wording — the compliance requirement is that specific error strings appear
 * verbatim, so the client must never compose them.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    // Same-origin credentials so the session cookie travels; the cookie is
    // httpOnly, so this is the only way the client can be authenticated at all.
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const response = await fetch(`/api${path}`, init);

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A body-less response (or an HTML error page from a crashed process) must not
    // surface as "Unexpected token < in JSON" — that tells the user nothing.
    if (!response.ok) {
      throw new ApiRequestError(
        'UNREADABLE_RESPONSE',
        `The server returned ${response.status} with no readable body.`,
        response.status,
      );
    }
    return null as T;
  }

  if (!response.ok) {
    if (isErrorBody(payload)) {
      throw new ApiRequestError(payload.error.code, payload.error.message, response.status, payload.error.detail);
    }
    throw new ApiRequestError('REQUEST_FAILED', `The request failed with status ${response.status}.`, response.status);
  }

  /*
   * A 200 that says a setup step is outstanding.
   *
   * `pendingSetup` on the server answers "no ensemble has been trained" with a 200
   * because it is a documented state rather than a fault, and a 503 made the
   * browser log a console error on five pages that were rendering their notice
   * correctly. The state still has to reach the caller as an error — the page has
   * no data to draw — so it is raised here. The `setupRequired` marker is what
   * makes that safe to do on a success response: an `error`-shaped field alone
   * appears in perfectly healthy payloads (`/api/account` carries a broker
   * message, `/api/positions` carries null).
   */
  if (
    typeof payload === 'object' &&
    payload !== null &&
    ((payload as { setupRequired?: unknown }).setupRequired === true ||
      // Same contract, different documented state: a resource that does not
      // exist. See `resourceNotFound` for why it is answered 200.
      (payload as { notFound?: unknown }).notFound === true) &&
    isErrorBody(payload)
  ) {
    throw new ApiRequestError(payload.error.code, payload.error.message, response.status, payload.error.detail);
  }

  return payload as T;
}

export interface AsyncState<T> {
  data: T | null;
  error: ApiRequestError | null;
  loading: boolean;
  /** Re-runs the request. Safe to call from an event handler. */
  reload: () => void;
}

/**
 * Loads a GET endpoint.
 *
 * `path` doubles as the dependency: passing null defers the request, which is what
 * a page does while it waits for a symbol or a session. The in-flight request is
 * aborted on unmount and on a path change, so a slow response for a symbol the
 * user has navigated away from cannot overwrite the current one — the classic
 * out-of-order-response bug, and a genuinely dangerous one here, because it would
 * render one security's conviction score under another's name.
 */
export function useApi<T>(path: string | null, options: { pollMs?: number } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  // Guards against a resolved promise from a previous path writing state.
  const activePath = useRef(path);
  activePath.current = path;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    request<T>(path, { signal: controller.signal })
      .then((payload) => {
        if (cancelled || activePath.current !== path) return;
        setData(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(
          cause instanceof ApiRequestError
            ? cause
            : new ApiRequestError('NETWORK', cause instanceof Error ? cause.message : String(cause), 0),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [path, nonce]);

  useEffect(() => {
    const interval = options.pollMs;
    if (interval === undefined || interval <= 0 || path === null) return;
    const timer = setInterval(reload, interval);
    return () => clearInterval(timer);
  }, [options.pollMs, path, reload]);

  return { data, error, loading, reload };
}

/**
 * Click provenance for a mutating request.
 *
 * Six of the mandated audit fields come from the DOM event, not from the server,
 * so they have to be captured at the moment of the click and travel with the
 * payload. `isTrusted` is the load-bearing one: it is false for any
 * script-dispatched event, which is what distinguishes a physical gesture from an
 * automated one and is why an order cannot be originated in software.
 *
 * `clickX`/`clickY` fall back to -1 rather than 0 for a keyboard-activated button:
 * 0,0 is a real coordinate and would misrepresent a keypress as a click in the
 * corner of the viewport.
 */
export interface ClickProvenance {
  clickX: number;
  clickY: number;
  viewportWidth: number;
  viewportHeight: number;
  clickedAt: number;
  trusted: boolean;
  targetId: string;
}

export function clickProvenance(
  event: { clientX?: number; clientY?: number; isTrusted?: boolean; detail?: number },
  targetId: string,
): ClickProvenance {
  // detail === 0 means the activation came from the keyboard, where clientX/Y are
  // 0 by specification rather than by measurement.
  const keyboard = event.detail === 0;
  return {
    clickX: keyboard ? -1 : Math.round(event.clientX ?? -1),
    clickY: keyboard ? -1 : Math.round(event.clientY ?? -1),
    viewportWidth: typeof window === 'undefined' ? 1 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 1 : window.innerHeight,
    clickedAt: Date.now(),
    trusted: event.isTrusted === true,
    targetId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Response shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  now: number;
  marketOpen: boolean;
  marketPhase: string;
  provider: string;
  providerLive: boolean;
  providerReason: string;
  degradedFeeds: string[];
  aiProvider: string;
  aiLive: boolean;
  aiReason: string;
  dbMode: string;
  engineReady: boolean;
  engineReason: string | null;
  modelVersion: string;
  modelPresent: boolean;
  modelReason: string | null;
  killSwitch: boolean;
  killSwitchReason: string | null;
}

export interface EntitlementView {
  paper: boolean;
  live: boolean;
  reason: string;
  trialEndsAt: number | null;
  trialDaysRemaining: number | null;
  status: string;
  priceUsdPerMonth: number;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'trader' | 'admin';
  createdAt: number;
  subscription: {
    status: string;
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    priceUsdPerMonth: number;
    provider: string | null;
    externalId: string | null;
  };
  liveTradingUnlocked: boolean;
  tosAcceptedAt: number | null;
  tosVersion: string | null;
}

export interface MeResponse {
  user: SessionUser | null;
  entitlement: EntitlementView;
}
