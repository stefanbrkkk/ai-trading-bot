/**
 * Mints the single-use intent token for one order.
 *
 * Phase 5 §1: "every API call must only be initiated by a verified HTTP request
 * originating from a client-side user session, carrying a unique, time-stamped
 * cryptographic token generated at the exact millisecond the user clicks
 * 'Execute' or 'Confirm Route'."
 *
 * Three properties make this the compliance hinge rather than a formality:
 *
 *   • The token is bound to *one* security and *one* parameter set. A token minted
 *     for 100 AAPL cannot authorise 200 AAPL, and cannot authorise MSFT at all.
 *   • It is single-use. The order route consumes it, so a replayed request is
 *     rejected even with a valid signature.
 *   • It carries the client's own click timestamp, so the ledger can show the
 *     click preceding the transmission rather than asserting it.
 *
 * Because the token is minted from parameters the user has already typed, this
 * route cannot originate an order on its own — there is no code path here that
 * invents a quantity.
 */

import { z } from 'zod';
import { ApiError, clickProvenanceSchema, handler, ok, parseBody } from '@/lib/api/respond';
import { currentUser, entitlement, requestContext } from '@/lib/auth/session';
import { killSwitchShed, mintIntentToken } from '@/lib/risk';
import {
  findIntentToken,
  insertAuditEvent,
  killSwitchState,
  mintIntentToken as recordIntentToken,
} from '@/lib/db';
import { requireSpec } from '@/lib/market/universe';

export const dynamic = 'force-dynamic';

const INTENT_SPIFFE_ID = 'spiffe://aurelius.local/ns/trading/sa/intent-minter';

const bodySchema = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  /**
   * Required and positive. A token cannot be minted for an unspecified quantity —
   * that is what keeps the blank-field mandate meaningful: the user must have
   * typed a number before any authorisation exists.
   */
  quantity: z.number().int().positive(),
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']),
  account: z.enum(['paper', 'live']),
  /** The client's own click instant, in milliseconds. */
  clickTsMs: z.number().int().positive(),
  click: clickProvenanceSchema,
});

export const POST = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in before routing an order.', 401);

  const body = await parseBody(request, bodySchema);
  const symbol = body.symbol.toUpperCase();

  // The kill switch is checked here as well as in the order route: refusing to
  // mint while routing is halted means a client cannot hold a pre-minted token
  // across the halt and spend it the moment it lifts. Both endpoints format the
  // refusal through `killSwitchShed`, so a halt looks the same whichever one the
  // client reaches.
  const shed = killSwitchShed(killSwitchState());
  if (shed !== null) throw new ApiError(shed.code, shed.message, shed.status, shed.details);

  const gate = entitlement(user);
  if (!gate.paper) throw new ApiError('TERMS_NOT_ACCEPTED', gate.reason, 403);
  if (body.account === 'live' && !gate.live) throw new ApiError('SUBSCRIPTION_REQUIRED', gate.reason, 402);

  /**
   * The symbol must be *tradable*, not merely known.
   *
   * `requireSpec` alone accepts the benchmark ETF, which is published for
   * relative-strength reference and is deliberately not in the tradable set. The
   * risk engine rejects it at submission, so minting a token for it produced a
   * token that could never be spent — the user clicked Execute, received an
   * authorisation, and was refused a moment later. Refusing to mint is the honest
   * answer, and it keeps the mint endpoint's contract meaningful: a token exists
   * only where an order could exist.
   */
  let spec;
  try {
    spec = requireSpec(symbol);
  } catch {
    throw new ApiError('UNKNOWN_SYMBOL', `${symbol} is not in the tradable universe.`, 404);
  }
  if (spec.isBenchmark) {
    throw new ApiError(
      'INSTRUMENT_NOT_TRADABLE',
      `${symbol} is published as a reference benchmark and is not tradable on this platform.`,
      422,
    );
  }

  if (!body.click.trusted) {
    throw new ApiError(
      'UNTRUSTED_CLICK',
      'The request did not originate from a physical user gesture, so no intent token was minted.',
      403,
    );
  }

  const minted = mintIntentToken({
    userId: user.id,
    symbol,
    side: body.side,
    quantity: body.quantity,
    orderType: body.orderType,
    clickTsMs: body.clickTsMs,
  });

  /**
   * A token that already exists is a duplicate click, not a server fault.
   *
   * The nonce is derived deterministically from the click parameters and the click
   * millisecond, so two identical submissions in the same millisecond produce the
   * same token — which is the double-submit-under-latency case the single-use rule
   * exists to catch. It was being caught, but by the ledger's UNIQUE constraint,
   * which threw and became a generic 500: "The request could not be completed."
   * The control was working and reporting itself as a platform crash.
   *
   * Checked before the insert so the normal case is a clean 409, and caught around
   * it as well because two concurrent requests can still interleave between the
   * check and the write.
   */
  const duplicate = findIntentToken(minted.token) !== null;
  if (duplicate) {
    throw new ApiError(
      'DUPLICATE_INTENT',
      'This Execute click has already been authorised. Each click authorises exactly one order; click Execute again to route another.',
      409,
    );
  }

  try {
    // The nonce is written to the append-only ledger so single-use is enforced by
    // durable state rather than by process memory.
    recordIntentToken({
      token: minted.token,
      userId: user.id,
      symbol,
      mintedAt: body.clickTsMs,
      expiresAt: minted.expiresAtMs,
      click: body.click,
      correlationId: minted.payload.nonce,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint')) {
      throw new ApiError(
        'DUPLICATE_INTENT',
        'This Execute click has already been authorised. Each click authorises exactly one order; click Execute again to route another.',
        409,
      );
    }
    throw error;
  }

  const ctx = await requestContext();
  insertAuditEvent({
    eventType: 'intent_token_minted',
    userId: user.id,
    sessionToken: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: body.click.clickX,
    clickY: body.click.clickY,
    resource: symbol,
    orderId: null,
    rawPayload: JSON.stringify({
      symbol,
      side: body.side,
      quantity: body.quantity,
      orderType: body.orderType,
      account: body.account,
      clickTsMs: body.clickTsMs,
      viewport: `${body.click.viewportWidth}x${body.click.viewportHeight}`,
      targetId: body.click.targetId,
    }),
    brokerStatus: null,
    brokerBody: null,
    spiffeId: INTENT_SPIFFE_ID,
    correlationId: minted.payload.nonce,
  });

  return ok({
    intentToken: minted.token,
    expiresAtMs: minted.expiresAtMs,
    nonce: minted.payload.nonce,
    /** Echoed so the client can prove the token matches the form it submits. */
    boundTo: {
      symbol,
      side: body.side,
      quantity: body.quantity,
      orderType: body.orderType,
    },
  });
});
