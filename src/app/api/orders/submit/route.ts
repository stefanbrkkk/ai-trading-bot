/**
 * The order routing endpoint.
 *
 * This is the **only** code path in the platform that can reach a broker. It is
 * reachable exclusively by an HTTP POST carrying a valid, unexpired, single-use
 * intent token minted at the millisecond of a physical Execute click. There is no
 * scheduler, no cron, no event listener and no model-completion hook that can
 * invoke it — Phase 5 §1 forbids all of those, and the absence is structural: the
 * function is a route handler with no other caller in the codebase, which the
 * test suite asserts.
 *
 * Order of operations, and why:
 *
 *   1. authenticate                — an anonymous request cannot route.
 *   2. kill switch (Control 6)     — shed with 503 before any other work. The risk
 *                                    engine also refuses while the switch is
 *                                    engaged, but it answers 422 (a *decision*
 *                                    about an order), and the published limits
 *                                    descriptor promises 503 (the platform is not
 *                                    accepting orders at all). Both are needed:
 *                                    the engine check is the fail-closed backstop,
 *                                    this one is the contract.
 *   3. rate limit (5/s/user)       — Control 5, applied before any work so a
 *                                    repeated Submit under network latency cannot
 *                                    flood the downstream broker.
 *   4. risk engine (commit: true)  — Controls 1–4 and the intent-token check. The
 *                                    token is *consumed* here, so a replay fails
 *                                    even with a valid signature.
 *   5. persist the pending order   — before dispatch, so a crash mid-flight still
 *                                    leaves evidence the order was authorised.
 *   6. dispatch to the broker      — the raw payload and the exact HTTP status and
 *                                    body are captured whatever happens.
 *   7. telemetry                   — all six mandatory audit fields, including the
 *                                    click coordinates and the click → API →
 *                                    broker-ACK timestamp array.
 *
 * A broker failure is never thrown. It is recorded and returned, because
 * distinguishing "the broker returned 503" from "the platform malfunctioned" is
 * the whole point of the audit trail.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, clickProvenanceSchema, correlationId, handler, ok, parseBody } from '@/lib/api/respond';
import { buildOrderContext, quotaNotionalUsd } from '@/lib/api/orderContext';
import { currentSessionToken, currentUser, requestContext } from '@/lib/auth/session';
import {
  ORDER_MESSAGES_PER_SECOND_PER_USER,
  RATE_LIMIT_WINDOW_MS,
  evaluateOrder,
  killSwitchShed,
  notionalReferencePrice,
  orderNotionalUsd,
} from '@/lib/risk';
import { getBroker } from '@/lib/broker';
import {
  consumeIntentToken,
  hitRateLimit,
  insertAuditEvent,
  insertOrder,
  insertOrderTelemetry,
  insertRiskDecision,
  killSwitchState,
  updateOrderExecution,
} from '@/lib/db';
import { ERROR_COPY } from '@/lib/compliance/disclosures';
import type { Order, OrderIntent, OrderTelemetry } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const ROUTER_SPIFFE_ID = 'spiffe://aurelius.local/ns/trading/sa/order-router';

const bodySchema = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().int().nullable(),
  notional: z.number().nullable().optional(),
  /** Empty string is accepted so the engine can reject MISSING_ORDER_TYPE. */
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit', '']),
  limitPrice: z.number().nullable().optional(),
  stopPrice: z.number().nullable().optional(),
  timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok']).default('day'),
  account: z.enum(['paper', 'live']),
  signalId: z.string().max(120).nullable().optional(),
  intentToken: z.string().min(8).max(2048),
  click: clickProvenanceSchema,
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export const POST = handler(async (request: Request) => {
  const serverReceived = Date.now();
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in before routing an order.', 401);

  const body = await parseBody(request, bodySchema);
  const correlation = request.headers.get('x-correlation-id') ?? correlationId();
  /*
   * Null when the caller supplied no key, and null is the honest value.
   *
   * This used to fall back to `randomUUID()`. A fresh random key can never
   * collide with a stored one, so the DUPLICATE_ORDER control was armed with a
   * value guaranteed to pass, and every routed order wrote a key row that
   * nothing could ever match. The terminal's ticket sends no key at all — its
   * protection against a double submission is the single-use intent token burnt
   * below — so that was every order the product itself sends.
   *
   * Passing null through means the engine reports the control as unarmed rather
   * than as passed, and a caller that does supply a key (an API client retrying
   * a POST whose response it never saw) gets the control it asked for.
   */
  const idempotencyKey = request.headers.get('idempotency-key') ?? body.idempotencyKey ?? null;
  const symbol = body.symbol.toUpperCase();
  const ctx = await requestContext();
  const sessionToken = await currentSessionToken();

  // ── 2. Kill switch — Control 6 ───────────────────────────────────────────
  /*
   * Shed here, and shed with 503.
   *
   * A stockpiled token is the case this covers. `/api/intent` refuses to mint
   * while the switch is engaged, so in the ordinary flow a client never reaches
   * this route during a halt. But a token minted a second before the halt is
   * still signed, still unexpired and still unspent, and reaching the risk engine
   * with it produced a 422 — the status the platform uses for "this order was
   * assessed and refused", when the truth is that no order is being assessed at
   * all. The published KILL_SWITCH_STATUS descriptor says 503, and this is the
   * endpoint that descriptor is about.
   */
  const halt = killSwitchState();
  const shed = killSwitchShed(halt);
  if (shed !== null) {
    insertAuditEvent({
      eventType: 'order_shed_kill_switch',
      userId: user.id,
      sessionToken,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      clickX: body.click.clickX,
      clickY: body.click.clickY,
      resource: symbol,
      orderId: null,
      rawPayload: JSON.stringify({ reason: halt.reason, engagedAt: halt.engagedAt, engagedBy: halt.engagedBy }),
      brokerStatus: null,
      brokerBody: null,
      spiffeId: ROUTER_SPIFFE_ID,
      correlationId: correlation,
    });
    throw new ApiError(shed.code, shed.message, shed.status, shed.details);
  }

  // ── 3. Rate limit ────────────────────────────────────────────────────────
  const verdict = hitRateLimit(`orders:${user.id}`, {
    limit: ORDER_MESSAGES_PER_SECOND_PER_USER,
    windowMs: RATE_LIMIT_WINDOW_MS,
    now: serverReceived,
  });
  if (!verdict.allowed) {
    insertAuditEvent({
      eventType: 'order_rate_limited',
      userId: user.id,
      sessionToken,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      clickX: body.click.clickX,
      clickY: body.click.clickY,
      resource: symbol,
      orderId: null,
      rawPayload: JSON.stringify({
        limit: ORDER_MESSAGES_PER_SECOND_PER_USER,
        hits: verdict.hits,
        resetAt: verdict.resetAt,
      }),
      brokerStatus: null,
      brokerBody: null,
      spiffeId: ROUTER_SPIFFE_ID,
      correlationId: correlation,
    });
    throw new ApiError('RATE_LIMITED', ERROR_COPY.rateLimited, 429, {
      retryAfterMs: Math.max(0, verdict.resetAt - serverReceived),
      limit: verdict.limit,
    });
  }

  const intent: OrderIntent = {
    symbol,
    side: body.side,
    type: (body.orderType === '' ? undefined : body.orderType) as OrderIntent['type'],
    quantity: body.quantity,
    notional: body.notional ?? null,
    limitPrice: body.limitPrice ?? null,
    stopPrice: body.stopPrice ?? null,
    timeInForce: body.timeInForce,
    account: body.account,
    signalId: body.signalId ?? null,
  };

  // ── 4. Risk engine — consumes the intent token ───────────────────────────
  const built = await buildOrderContext({
    user,
    intent,
    click: body.click,
    intentToken: body.intentToken,
    idempotencyKey,
    correlationId: correlation,
    commit: true,
    now: serverReceived,
  });
  const decision = evaluateOrder(intent, built.context);
  const riskCompleted = Date.now();

  /*
   * A rejected order records its decision here; an approved one records it once
   * the order id exists, a few lines below.
   *
   * Recording unconditionally at this point and again after persistence wrote two
   * rows per routed order — same correlation id, one with a null order id — so
   * /control's audit table listed every order twice and its rejection counters
   * double-counted.
   */
  if (!decision.approved) {
    insertRiskDecision(decision, {
      orderId: null,
      userId: user.id,
      symbol,
      correlationId: correlation,
    });
    const rejection = decision.rejection;
    insertAuditEvent({
      eventType: 'order_rejected_by_risk',
      userId: user.id,
      sessionToken,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      clickX: body.click.clickX,
      clickY: body.click.clickY,
      resource: symbol,
      orderId: null,
      rawPayload: JSON.stringify({ intent, code: rejection?.code, check: rejection?.check }),
      brokerStatus: null,
      brokerBody: null,
      spiffeId: ROUTER_SPIFFE_ID,
      correlationId: correlation,
    });
    // A risk rejection is a well-formed answer, not a server error: 422 with the
    // exact code so the UI can render the mandated copy verbatim.
    return ok(
      {
        routed: false,
        code: rejection?.code ?? 'REJECTED',
        message: rejection?.message ?? 'The order was rejected.',
        check: rejection?.check ?? null,
        observed: rejection?.observed ?? null,
        limit: rejection?.limit ?? null,
        checks: decision.checks,
        spiffeId: decision.spiffeId,
      },
      { status: 422, correlation },
    );
  }

  // ── 5. Burn the click, then persist the authorised order before dispatch ──
  const quantity = intent.quantity as number;
  const reference = notionalReferencePrice(intent, built.quote);
  /*
   * Two figures, and they are not interchangeable.
   *
   * `reference` prices what the user is shown: their own limit or stop, or the
   * last trade for a market order. It must not move — someone who entered a
   * limit of 271.56 is owed a notional computed at 271.56, and that is what this
   * endpoint returns as `notionalUsd` below.
   *
   * `quotaUsd` is what the order costs its user's daily allowance, measured in
   * the currency the risk engine tests every ceiling in. See `quotaNotionalUsd`
   * for why the two differ and what it cost to conflate them.
   */
  const quotaUsd = quotaNotionalUsd(intent, built.quote);
  const orderId = `ord_${randomUUID()}`;

  /*
   * One click authorises one order, and this is where that is enforced.
   *
   * `consumeIntentToken` is an atomic `UPDATE … WHERE consumed_at IS NULL`, so
   * two concurrent submissions of the same click can never both succeed. Its
   * verdict used to be discarded — called for its side effect, after the order
   * had already been inserted, and never read — which left the guarantee resting
   * entirely on `verifyIntentToken`'s nonce store. That store defaults to an
   * in-process `Map`, so a token could be replayed once per worker inside its
   * 30-second life: any clustered deployment, or a restart between the mint and
   * the submit, and one click routes several real orders.
   *
   * Burning before the insert also means a refused burn leaves nothing behind.
   */
  const burn = consumeIntentToken(body.intentToken, {
    userId: user.id,
    symbol,
    now: riskCompleted,
    orderId,
  });
  if (!burn.ok) {
    insertAuditEvent({
      eventType: 'order_intent_replayed',
      userId: user.id,
      sessionToken,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      clickX: body.click.clickX,
      clickY: body.click.clickY,
      resource: symbol,
      orderId: null,
      rawPayload: JSON.stringify({ intent, reason: burn.reason }),
      brokerStatus: null,
      brokerBody: null,
      spiffeId: ROUTER_SPIFFE_ID,
      correlationId: correlation,
    });
    return ok(
      {
        routed: false,
        code: 'INTENT_TOKEN_SPENT',
        message:
          burn.reason === 'already_consumed'
            ? 'This authorisation has already routed an order. Press Execute again to authorise a new one.'
            : 'This authorisation is no longer valid. Run pre-flight and press Execute again.',
        check: 'click provenance',
        observed: burn.reason,
        limit: null,
        checks: decision.checks,
        spiffeId: decision.spiffeId,
      },
      { status: 422, correlation },
    );
  }
  const pending: Order = {
    id: orderId,
    userId: user.id,
    symbol,
    side: intent.side,
    type: intent.type,
    quantity,
    limitPrice: intent.limitPrice,
    stopPrice: intent.stopPrice,
    timeInForce: intent.timeInForce,
    account: intent.account,
    status: 'pending_risk',
    filledQuantity: 0,
    averageFillPrice: null,
    createdAt: serverReceived,
    updatedAt: riskCompleted,
    signalId: intent.signalId,
    riskDecision: decision,
    brokerRequest: null,
    brokerStatus: null,
    brokerResponse: null,
    brokerOrderId: null,
  };
  insertOrder(pending, {
    intentToken: body.intentToken,
    correlationId: correlation,
    ...(quotaUsd === null ? {} : { notionalCents: Math.round(quotaUsd * 100) }),
  });

  // ── 6. Dispatch ──────────────────────────────────────────────────────────
  const broker = getBroker();
  const brokerDispatched = Date.now();
  const result = await broker.submitOrder(
    {
      // The platform's own order id when the caller named no key: unique per
      // submission, and traceable back to a row rather than to nothing.
      clientOrderId: idempotencyKey ?? orderId,
      symbol,
      side: intent.side,
      type: intent.type,
      quantity,
      limitPrice: intent.limitPrice,
      stopPrice: intent.stopPrice,
      timeInForce: intent.timeInForce,
      account: intent.account,
    },
    { correlationId: correlation, userId: user.id, dispatchedAt: brokerDispatched },
  );
  const brokerAcknowledged = Date.now();

  const ack = result.data;
  const status: Order['status'] = result.ok && ack ? ack.status : 'broker_error';
  updateOrderExecution(orderId, {
    status,
    filledQuantity: ack?.filledQuantity ?? 0,
    averageFillPrice: ack?.averageFillPrice ?? null,
    brokerOrderId: ack?.brokerOrderId ?? null,
    brokerStatus: result.status,
    brokerResponse: result.body,
    updatedAt: brokerAcknowledged,
  });

  // ── 7. Forensic telemetry ────────────────────────────────────────────────
  const telemetry: OrderTelemetry = {
    orderId,
    timestamps: {
      clientClick: body.click.clickedAt,
      serverReceived,
      riskCompleted,
      brokerDispatched,
      brokerAcknowledged: result.ok ? brokerAcknowledged : null,
    },
    spiffeId: ROUTER_SPIFFE_ID,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    click: body.click,
    rawPayload: result.rawRequest ?? JSON.stringify(intent),
    brokerStatus: result.status,
    brokerBody: result.body === null ? null : JSON.stringify(result.body),
  };
  insertOrderTelemetry(telemetry);

  insertAuditEvent({
    eventType: result.ok ? 'order_routed' : 'order_broker_error',
    userId: user.id,
    sessionToken,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: body.click.clickX,
    clickY: body.click.clickY,
    resource: symbol,
    orderId,
    rawPayload: telemetry.rawPayload,
    brokerStatus: result.status,
    brokerBody: telemetry.brokerBody,
    spiffeId: ROUTER_SPIFFE_ID,
    correlationId: correlation,
  });

  if (!result.ok) {
    // The presentation of this error to the user is itself an auditable event, so
    // the message the client will display is fixed here rather than composed
    // client-side.
    return ok(
      {
        routed: false,
        orderId,
        code: 'BROKER_ERROR',
        message: ERROR_COPY.brokerError,
        brokerStatus: result.status,
        brokerBody: result.body,
        brokerError: result.error,
        latencyMs: result.latencyMs,
        timestamps: telemetry.timestamps,
      },
      { status: 502, correlation },
    );
  }

  return ok(
    {
      routed: true,
      orderId,
      brokerOrderId: ack?.brokerOrderId ?? null,
      status,
      filledQuantity: ack?.filledQuantity ?? 0,
      averageFillPrice: ack?.averageFillPrice ?? null,
      brokerStatus: result.status,
      latencyMs: result.latencyMs,
      notionalUsd: reference === null ? null : orderNotionalUsd(intent, reference),
      timestamps: telemetry.timestamps,
      spiffeId: ROUTER_SPIFFE_ID,
      correlationId: correlation,
    },
    { status: 201, correlation },
  );
});
