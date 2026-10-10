/**
 * Route-handler plumbing.
 *
 * Every API response carries `x-correlation-id` and `x-spiffe-id` so an incident
 * can be reconstructed across the whole request path, and every error uses one
 * shape — `{ error: { code, message, detail? } }` — so the client never has to
 * guess how a failure is encoded.
 *
 * The kill switch is deliberately **not** enforced here. Phase 5 §2 requires that
 * while it is engaged every incoming *order* request is answered with 503, and
 * this wrapper is applied to every route in the platform — including `/api/health`
 * and `/api/admin/kill-switch`, the endpoint that releases the halt. Shedding
 * centrally would mean a halt could not be lifted through the product that
 * declared it. Enforcement therefore lives in the two endpoints that can lead to a
 * broker — `/api/intent` and `/api/orders/submit` — and both format the refusal
 * through `killSwitchShed` so they cannot answer a halt differently. The risk
 * engine refuses a third time, fail-closed, from the ledger.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError } from '@/lib/auth/session';

export const GATEWAY_SPIFFE_ID = 'spiffe://aurelius.local/ns/platform/sa/api-gateway';

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export function correlationId(): string {
  return `cor_${randomUUID()}`;
}

function withHeaders(response: NextResponse, correlation: string): NextResponse {
  response.headers.set('x-correlation-id', correlation);
  response.headers.set('x-spiffe-id', GATEWAY_SPIFFE_ID);
  response.headers.set('cache-control', 'no-store');
  return response;
}

export function ok<T>(data: T, init: { status?: number; correlation?: string } = {}): NextResponse {
  const correlation = init.correlation ?? correlationId();
  return withHeaders(NextResponse.json(data, { status: init.status ?? 200 }), correlation);
}

export function fail(
  code: string,
  message: string,
  init: { status?: number; detail?: unknown; correlation?: string } = {},
): NextResponse {
  const correlation = init.correlation ?? correlationId();
  const body: ApiErrorBody = {
    error: init.detail === undefined ? { code, message } : { code, message, detail: init.detail },
  };
  return withHeaders(NextResponse.json(body, { status: init.status ?? 400 }), correlation);
}

/**
 * A capability that needs a setup step run before it can answer.
 *
 * There is exactly one of these on the platform: no ensemble has been trained, so
 * the signal endpoints have nothing to serve. It is answered `200` rather than
 * `503` because it is neither a fault nor a transient outage — it is a documented
 * state a fresh deployment is in until `npm run seed` completes, and the pages
 * already render a notice saying precisely that. The browser logs a console error
 * for every response over 400, so a 503 made five pages that were working exactly
 * as designed look broken to anyone with devtools open. The same reasoning already
 * governs the portfolio page's deferred requests, which exist so that a signed-out
 * visit does not log two 401s.
 *
 * `setupRequired` marks the body unambiguously so the client can raise it as an
 * error despite the 200; `isErrorBody` alone would be too loose a test to apply to
 * a success response.
 */
export function pendingSetup(code: string, message: string): NextResponse {
  const body: ApiErrorBody & { setupRequired: true } = {
    error: { code, message },
    setupRequired: true,
  };
  return withHeaders(NextResponse.json(body, { status: 200 }), correlationId());
}

/**
 * A resource the caller asked for by name that does not exist.
 *
 * Answered `200` for the same reason `pendingSetup` is, and the reasoning is
 * worth repeating because the two look like different situations and are not.
 * `/terminal/NOTREAL` is a URL a person reaches by mistyping, by following a
 * stale link, or by opening one shared before the universe changed. The page
 * handles it: it renders "NOTREAL is not in the tradable universe" and offers a
 * way back. Nothing is broken. But the browser logs a console error for every
 * response over 400, so the one page in the product that was behaving perfectly
 * — explaining the mistake in plain words — was also the one page that looked
 * broken to anyone with devtools open, and the platform's own E2E asserts a
 * clean console on every route.
 *
 * `notFound` marks the body, exactly as `setupRequired` does, so the client can
 * still raise it as an error and the page still shows its notice. The only thing
 * that changes is that a handled state stops being reported as a fault.
 */
export function resourceNotFound(code: string, message: string): NextResponse {
  const body: ApiErrorBody & { notFound: true } = {
    error: { code, message },
    notFound: true,
  };
  return withHeaders(NextResponse.json(body, { status: 200 }), correlationId());
}

/** Thrown by handlers to short-circuit with a specific status. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Reject browser mutations initiated by another origin, including sibling sites. */
function assertMutationOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get('origin');
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== new URL(request.url).origin)
  ) {
    throw new ApiError('FORBIDDEN_ORIGIN', 'This action must originate from this application.', 403);
  }
}

/**
 * Wraps a handler so every thrown error becomes a well-formed response.
 *
 * A route must never leak a stack trace or an internal message to the client, and
 * must never return a 200 with a broken body — the E2E suite asserts on both.
 */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<NextResponse>,
): (...args: A) => Promise<NextResponse> {
  return async (...args: A): Promise<NextResponse> => {
    const correlation = correlationId();
    try {
      const request = args[0];
      if (request instanceof Request) assertMutationOrigin(request);
      const response = await fn(...args);
      if (!response.headers.has('x-correlation-id')) {
        response.headers.set('x-correlation-id', correlation);
        response.headers.set('x-spiffe-id', GATEWAY_SPIFFE_ID);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.code, error.message, { status: error.status, detail: error.detail, correlation });
      }
      if (error instanceof AuthError) {
        /*
         * 401 and 403 are different answers and need different codes.
         *
         * Both mapped to `UNAUTHENTICATED`, so a signed-in trader hitting an admin
         * route received 403 UNAUTHENTICATED — telling a client that has a valid
         * session that it has no session. A client cannot distinguish "sign in"
         * from "you may not do this" by code, which is the only field a client
         * should have to branch on.
         */
        return fail(error.status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED', error.message, {
          status: error.status,
          correlation,
        });
      }
      if (error instanceof z.ZodError) {
        return fail('INVALID_REQUEST', 'The request body did not match the expected shape.', {
          status: 422,
          detail: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          correlation,
        });
      }
      // Anything unexpected: report a generic message to the client, and put the
      // real one on the server console where an operator can find it.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[api] unhandled error (${correlation}): ${message}`);
      return fail('INTERNAL', 'The request could not be completed.', { status: 500, correlation });
    }
  };
}

/** Parses and validates a JSON body. */
export async function parseBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S>> {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.', 415);
  }
  // Bound bytes before parsing: a schema's string limits do not bound an incoming stream.
  const maxBytes = 64 * 1024;
  const tooLarge = (): ApiError => new ApiError('PAYLOAD_TOO_LARGE', 'The request body exceeds 64 KiB.', 413);
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw tooLarge();

  let raw: unknown;
  try {
    if (request.body === null) throw new Error('Missing JSON body.');
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('INVALID_JSON', 'The request body was not valid JSON.', 400);
  }
  return schema.parse(raw) as z.infer<S>;
}

/** Reads and validates query parameters from a URL. */
export function parseQuery<S extends z.ZodTypeAny>(request: Request, schema: S): z.infer<S> {
  const url = new URL(request.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    raw[key] = values.length > 1 ? values : (values[0] as string);
  }
  return schema.parse(raw) as z.infer<S>;
}

/** Comma-separated query list → string[]. */
export const csvList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s.length > 0));

export const numeric = z.coerce.number().finite();
export const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));

/**
 * Click provenance. Required on every order and on clickwrap acceptance: the
 * coordinates of the physical click are one of the six mandatory audit fields,
 * and `trusted` mirrors the DOM event's `isTrusted`, which is what distinguishes
 * a human gesture from a scripted dispatch.
 */
export const clickProvenanceSchema = z.object({
  clickX: z.number().int().min(-1),
  clickY: z.number().int().min(-1),
  viewportWidth: z.number().int().positive(),
  viewportHeight: z.number().int().positive(),
  clickedAt: z.number().int().positive(),
  trusted: z.boolean(),
  targetId: z.string().min(1).max(120),
});
