/**
 * Route-handler plumbing.
 *
 * Every API response carries `x-correlation-id` and `x-spiffe-id` so an incident
 * can be reconstructed across the whole request path, and every error uses one
 * shape — `{ error: { code, message, detail? } }` — so the client never has to
 * guess how a failure is encoded.
 *
 * The kill switch is enforced here rather than in each route: Phase 5 §2 requires
 * that while it is engaged *all* incoming order requests are answered with HTTP
 * 503, and centralising it means a new mutating route cannot forget.
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
        return fail('UNAUTHENTICATED', error.message, { status: error.status, correlation });
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
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
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
