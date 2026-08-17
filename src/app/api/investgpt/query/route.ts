/**
 * The natural-language screening endpoint.
 *
 * Every response carries the SQL, the pruning report and the validator's verdict
 * alongside the rows. That is not debug output left in by accident — it is the
 * substance of the surface. A screening result a user cannot audit is an oracle,
 * and an oracle that cannot be checked is indistinguishable from advice. Showing
 * the statement lets a user verify the question was understood, and showing the
 * pruning report lets them see which of 829 catalog surfaces were considered.
 *
 * The endpoint reads. It is structurally incapable of anything else: the validator
 * rejects every non-SELECT, and the relations it may touch are limited to the
 * impersonal market, feature and signal surfaces. No natural-language question can
 * read another user's account, an order, or the audit ledger.
 */

import { z } from 'zod';
import { handler, ok, parseBody, parseQuery } from '@/lib/api/respond';
import { currentUser, requestContext } from '@/lib/auth/session';
import { EXAMPLE_QUESTIONS, MAX_ROWS, catalogSummary, query, storeReady } from '@/lib/investgpt';
import { aiStatus } from '@/lib/api/optional';
import { hitRateLimit, insertAuditEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

const INVESTGPT_SPIFFE_ID = 'spiffe://aurelius.local/ns/analytics/sa/investgpt';

/**
 * Question length ceiling.
 *
 * 600 characters is far beyond any real screening question and well below the
 * point at which the pruner's O(catalog) scan becomes expensive. The bound exists
 * so a pathological input cannot occupy a route handler.
 */
const bodySchema = z.object({
  question: z.string().min(3).max(600),
  /** Forces the compiler path even when a provider is configured. */
  deterministicOnly: z.boolean().optional(),
  maxRows: z.number().int().min(1).max(MAX_ROWS).optional(),
});

/** Ten questions a second per user: generous for typing, closed to scripting. */
const QUERY_LIMIT = 10;
const QUERY_WINDOW_MS = 1000;

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const user = await currentUser();

  // Rate-limited per user where there is one, per process otherwise. An
  // unauthenticated caller still gets a bucket — the surface is readable without
  // an account, and an open endpoint with no limiter is an invitation.
  const verdict = hitRateLimit(`investgpt:${user?.id ?? 'anonymous'}`, {
    limit: QUERY_LIMIT,
    windowMs: QUERY_WINDOW_MS,
  });
  if (!verdict.allowed) {
    return ok(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many queries in quick succession. Wait a moment and try again.',
        },
        retryAfterMs: Math.max(0, verdict.resetAt - Date.now()),
      },
      { status: 429 },
    );
  }

  const result = await query(body.question, {
    ...(body.deterministicOnly === undefined ? {} : { deterministicOnly: body.deterministicOnly }),
    ...(body.maxRows === undefined ? {} : { maxRows: body.maxRows }),
  });

  /**
   * The question and the statement it produced are both recorded.
   *
   * A generated query is a machine-authored read against the platform's data, and
   * the ledger is where those live. Recording the question as well as the SQL is
   * what makes the entry useful: "which question produced this statement" is the
   * thing an operator reviewing an anomaly actually needs.
   */
  const ctx = await requestContext();
  insertAuditEvent({
    eventType: 'investgpt_query',
    userId: user?.id ?? null,
    sessionToken: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: null,
    clickY: null,
    resource: 'v_equity_snapshot',
    orderId: null,
    rawPayload: JSON.stringify({
      question: body.question,
      sql: result.sql,
      source: result.source,
      rowCount: result.rowCount,
      keptColumns: result.pruning.keptColumns,
      valid: result.validation.valid,
    }),
    brokerStatus: null,
    brokerBody: null,
    spiffeId: INVESTGPT_SPIFFE_ID,
    correlationId: null,
  });

  return ok({
    ...result,
    ai: await aiStatus(),
    spiffeId: INVESTGPT_SPIFFE_ID,
  });
});

/** Surface metadata: what the schema explorer and the empty state need. */
export const GET = handler(async (request: Request) => {
  const q = parseQuery(request, z.object({ examples: z.coerce.boolean().optional() }));
  void q;
  return ok({
    catalog: catalogSummary(),
    examples: EXAMPLE_QUESTIONS,
    store: storeReady(),
    maxRows: MAX_ROWS,
    ai: await aiStatus(),
  });
});
