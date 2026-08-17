/**
 * Pre-flight risk preview.
 *
 * Runs the identical risk engine the routing endpoint runs, with `commit: false`
 * so nothing is reserved. The user sees every check, its observed value and its
 * limit, *before* submitting — a limit a user only discovers by tripping it is a
 * failure of the interface, not of the user.
 *
 * This endpoint can never route an order: it has no broker call at all.
 */

import { z } from 'zod';
import { ApiError, clickProvenanceSchema, correlationId, handler, ok, parseBody } from '@/lib/api/respond';
import { buildOrderContext } from '@/lib/api/orderContext';
import { currentUser, entitlement } from '@/lib/auth/session';
import {
  RISK_LIMIT_DESCRIPTORS,
  evaluateOrder,
  maxQuantityForAdv,
  notionalReferencePrice,
  orderNotionalUsd,
} from '@/lib/risk';
import type { OrderIntent } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  /** Nullable on purpose: the preview must be able to say "type a quantity". */
  quantity: z.number().int().nullable(),
  notional: z.number().nullable().optional(),
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit', '']),
  limitPrice: z.number().nullable().optional(),
  stopPrice: z.number().nullable().optional(),
  timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok']).default('day'),
  account: z.enum(['paper', 'live']),
  signalId: z.string().max(120).nullable().optional(),
  click: clickProvenanceSchema.nullable().optional(),
});

export const POST = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to preview an order.', 401);

  const body = await parseBody(request, bodySchema);
  const correlation = correlationId();
  const symbol = body.symbol.toUpperCase();

  const intent: OrderIntent = {
    symbol,
    side: body.side,
    // An unselected order type is passed through as-is so the engine can report
    // MISSING_ORDER_TYPE rather than the route silently defaulting to market —
    // defaulting the order type is explicitly prohibited.
    type: (body.orderType === '' ? undefined : body.orderType) as OrderIntent['type'],
    quantity: body.quantity,
    notional: body.notional ?? null,
    limitPrice: body.limitPrice ?? null,
    stopPrice: body.stopPrice ?? null,
    timeInForce: body.timeInForce,
    account: body.account,
    signalId: body.signalId ?? null,
  };

  const built = await buildOrderContext({
    user,
    intent,
    click: body.click ?? null,
    // The preview never presents a token: it reports what would happen, and the
    // token is minted only at the moment of the Execute click.
    intentToken: null,
    idempotencyKey: null,
    correlationId: correlation,
    commit: false,
  });

  const decision = evaluateOrder(intent, built.context);
  // The notional is measured against the price the order would actually reach the
  // book at: the user's own limit or stop price for priced types, the last trade
  // for a market order.
  const reference = notionalReferencePrice(intent, built.quote);
  const notional = reference === null ? null : orderNotionalUsd(intent, reference);
  const gate = entitlement(user);

  return ok(
    {
      allowed: decision.approved,
      checks: decision.checks,
      firstFailure: decision.rejection,
      evaluatedAt: decision.evaluatedAt,
      elapsedMs: decision.elapsedMs,
      spiffeId: decision.spiffeId,
      notionalUsd: notional,
      notionalReferencePrice: reference,
      quote: built.quote,
      adv30: built.adv30,
      maxQuantityForAdv: maxQuantityForAdv(built.adv30),
      buyingPower: built.account?.buyingPower ?? null,
      equity: built.account?.equity ?? null,
      accountError: built.accountError,
      entitlement: gate,
      limits: RISK_LIMIT_DESCRIPTORS,
      /**
       * Restated on every preview: the platform will not size the order. The
       * quantity field stays blank until the user types one.
       */
      sizingNotice:
        'Aurelius does not suggest a quantity, notional value, or allocation. Enter the size you intend to trade.',
    },
    { correlation },
  );
});
