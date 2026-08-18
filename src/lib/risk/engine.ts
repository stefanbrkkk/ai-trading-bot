/**
 * The pre-trade risk engine.
 *
 * The mandate requires "an intermediate validation microservice — a dedicated
 * risk engine — that intercepts and evaluates the user's API request before it
 * is permitted to transmit to the downstream brokerage", with 100% of order
 * traffic routed through it. This module is that engine. It is deliberately pure
 * and synchronous: given an intent and a context it returns a `RiskDecision`,
 * and it performs no network I/O of its own, so the decision that gets written to
 * the ledger is a function of inputs a forensic reviewer can replay exactly.
 *
 * Two principles govern the whole file.
 *
 * FAIL CLOSED. Every check that cannot be evaluated denies. Missing ADV data,
 * an unpriceable order, an absent account snapshot, an absent quote for a limit
 * order — each of these denies rather than waving the order through. The mandate
 * states it explicitly for ADV ("fail closed when ADV data is missing or zero")
 * and the same logic governs the rest: a control that silently degrades to
 * "allow" under a data outage is not a control.
 *
 * SHORT-CIRCUIT, BUT REPORT. Checks run in a fixed order and stop at the first
 * failure, because the first failure is the reason the order was refused and
 * running further checks against parameters already known to be invalid would
 * produce meaningless observations. Every check that *did* run is returned, so
 * the ledger shows exactly how far the evaluation got — which is what makes the
 * decision record reconstructable rather than merely conclusory.
 *
 * The check order itself is not arbitrary. Platform-wide halts come first
 * (nothing routes at all), then entitlement, then proof of human intent, then
 * structural validity of the ticket, then instrument and session, then
 * duplicate/quota controls, and only then the four Rule 15c3-5 quantitative
 * controls, which are the expensive ones and the ones whose observations are
 * only meaningful once the ticket is known to be well-formed.
 */

import type {
  AccountSnapshot,
  ClickProvenance,
  OrderIntent,
  OrderType,
  Quote,
  RiskCheckResult,
  RiskDecision,
  RiskRejectionCode,
  SubscriptionStatus,
  TimeInForce,
} from '@/lib/domain/types';
import { isMarketOpen } from '@/lib/market/calendar';
import { getSpec } from '@/lib/market/universe';
import { isKillSwitchEngaged } from '@/lib/risk/killSwitch';
import {
  ADV_PARTICIPATION_LIMIT,
  KILL_SWITCH_HTTP_STATUS,
  MAINTENANCE_MARGIN_RATE,
  MAX_NOTIONAL_PER_ORDER_USD,
  MAX_NOTIONAL_PER_USER_PER_DAY_USD,
  MAX_OPEN_ORDERS,
  MIN_QUANTITY,
  STOP_PRICE_SANITY_DEVIATION,
  limitPriceTolerance,
} from '@/lib/risk/limits';
import {
  intentTokenFailureMessage,
  type IntentTokenPayload,
  type IntentTokenVerification,
} from '@/lib/risk/intentToken';
import type { DailyNotionalPort, IdempotencyPort, RiskAuditPort } from '@/lib/risk/ports';
import {
  INSUFFICIENT_FUNDS_MESSAGE,
  RISK_ENGINE_SPIFFE_ID,
  SERVICE_UNAVAILABLE_MESSAGE,
  issueSvid,
} from '@/lib/risk/telemetry';

export { RISK_ENGINE_SPIFFE_ID };

/** Runtime tuple for the domain's `OrderType` union, for validating untrusted input. */
const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop', 'stop_limit'];

/**
 * Time-in-force values that can rest until the next session. `ioc` and `fok`
 * require a live book by definition, so they cannot be queued while the market
 * is closed.
 */
const RESTABLE_TIF: readonly TimeInForce[] = ['day', 'gtc'];

// ─────────────────────────────────────────────────────────────────────────────
//  Context
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskInstrumentContext {
  /** False for anything not on the published tradable universe. */
  tradable: boolean;
  /** Mean daily share volume over the trailing 30 sessions; null when unknown. */
  adv30: number | null;
}

export interface RiskSubscriptionContext {
  status: SubscriptionStatus;
  liveTradingUnlocked: boolean;
}

export interface RiskEvaluationContext {
  userId: string;
  /** Shared across every hop of this user action. */
  correlationId: string;
  /** Millisecond-precision evaluation instant. Injected, never read from a clock here. */
  now: number;
  /** Defaults to the process-wide switch. */
  killSwitchEngaged?: boolean;
  /** Defaults to "no subscription", which denies live routing. */
  subscription?: RiskSubscriptionContext;
  /** Click provenance captured at the Execute click. Null denies. */
  click: ClickProvenance | null;
  /** Result of `verifyIntentToken`. Null means the caller verified elsewhere. */
  intentToken?: IntentTokenVerification | null;
  /** Defaults to a lookup against the published universe. */
  instrument?: RiskInstrumentContext;
  /** Defaults to the New York session calendar. */
  marketOpen?: boolean;
  /** Resting orders already open for this user. */
  openOrderCount?: number;
  /** Client-supplied idempotency key for the DUPLICATE_ORDER control. */
  idempotencyKey?: string | null;
  /** NBBO and last trade. Required for market orders and for the price collar. */
  quote?: Quote | null;
  /** Result of the pre-flight GET /v2/account. Null denies (fail closed). */
  account?: AccountSnapshot | null;
  /** Notional already accepted for this user today; overrides the port when set. */
  dayNotionalUsedUsd?: number;
  /** SPIFFE ID of the module asking for the decision. */
  requestingSpiffeId?: string | null;
  /** Monotonic source for `elapsedMs`. Injectable for deterministic tests. */
  monotonic?: () => number;
  audit?: RiskAuditPort;
  idempotency?: IdempotencyPort;
  dailyNotional?: DailyNotionalPort;
  /**
   * When false, an approval reserves nothing — no idempotency key is remembered
   * and no daily notional is consumed. Used by the ticket's live preview, which
   * must be able to show the user what the engine would decide without spending
   * their daily quota on a form they have not submitted.
   */
  commit?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Result helpers
// ─────────────────────────────────────────────────────────────────────────────

function pass(
  check: string,
  message: string,
  observed: number | null = null,
  limit: number | null = null,
): RiskCheckResult {
  return { code: null, passed: true, message, check, observed, limit };
}

function deny(
  code: RiskRejectionCode,
  check: string,
  message: string,
  observed: number | null = null,
  limit: number | null = null,
): RiskCheckResult {
  return { code, passed: false, message, check, observed, limit };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing helpers — exported so the ticket preview and the engine agree
// ─────────────────────────────────────────────────────────────────────────────

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Midpoint of the NBBO, or null when the quote cannot supply one. */
export function nbboMid(quote: Quote | null | undefined): number | null {
  if (!quote) return null;
  if (finitePositive(quote.bid) && finitePositive(quote.ask)) return (quote.bid + quote.ask) / 2;
  if (finitePositive(quote.last)) return quote.last;
  return null;
}

/**
 * Price the notional ceiling is measured against.
 *
 * Follows the mandate's reconstruction exactly: market orders price off the last
 * trade (NBBO mid when no last trade is available), limit and stop-limit orders
 * off the user's limit price, stop orders off the user's stop price. Using the
 * user's own price for priced order types matters — it is the figure they typed,
 * and it is the figure that would reach the book.
 */
export function notionalReferencePrice(
  intent: Pick<OrderIntent, 'type' | 'limitPrice' | 'stopPrice'>,
  quote: Quote | null | undefined,
): number | null {
  switch (intent.type) {
    case 'limit':
    case 'stop_limit':
      return finitePositive(intent.limitPrice) ? intent.limitPrice : null;
    case 'stop':
      return finitePositive(intent.stopPrice) ? intent.stopPrice : null;
    case 'market':
    default: {
      if (quote && finitePositive(quote.last)) return quote.last;
      return nbboMid(quote);
    }
  }
}

/**
 * The price the fat-finger ceiling is tested against.
 *
 * `notionalReferencePrice` answers "what did the user type", which is the right
 * figure to *show* them. It is the wrong figure to size a ceiling with, because
 * a marketable limit fills at the book, not at the limit. Measured: PG bid
 * 288.87 / ask 288.93, sell collar floor 271.54, so SELL 368 @ limit 271.56 is
 * inside the collar and marketable — priced at the limit it is $99,934 against a
 * $100,000 ceiling and passes, and it filled at 288.73 for $106,253. A published
 * ceiling that a legal order can exceed by 6.3% is a number, not a control.
 *
 * The ceiling therefore prices at the worse of the user's price and the
 * aggressive side of the NBBO: a buy can pay up to the ask, a sell can hit down
 * to the bid. When there is no quote it falls back to the user's own price,
 * which is the only figure available.
 */
export function ceilingReferencePrice(
  intent: Pick<OrderIntent, 'type' | 'side' | 'limitPrice' | 'stopPrice'>,
  quote: Quote | null | undefined,
): number | null {
  const stated = notionalReferencePrice(intent, quote);
  if (stated === null) return null;
  if (intent.type === 'market') return stated;
  const aggressive = intent.side === 'buy' ? quote?.ask : quote?.bid;
  if (!finitePositive(aggressive)) return stated;
  // Worse-for-the-user in both directions is simply the higher price: a buy
  // paying the ask, a sell whose shares are worth the bid it hits.
  return Math.max(stated, aggressive);
}

/**
 * Dollar value of the order.
 *
 * When the ticket carries both a share quantity and a typed notional the larger
 * of the two governs. They should agree; if they do not, the platform has no
 * basis for deciding which the user meant, and the conservative reading is the
 * only defensible one for a ceiling control.
 */
export function orderNotionalUsd(
  intent: Pick<OrderIntent, 'quantity' | 'notional'>,
  referencePrice: number,
): number {
  const fromShares = (intent.quantity ?? 0) * referencePrice;
  const typed = finitePositive(intent.notional) ? intent.notional : 0;
  return Math.max(fromShares, typed);
}

/** Largest quantity the ADV participation limit permits. */
export function maxQuantityForAdv(adv30: number): number {
  return Math.floor(ADV_PARTICIPATION_LIMIT * adv30);
}

/** NBBO side a limit price is collared against: the offer for buys, the bid for sells. */
export function priceCollarReference(
  side: OrderIntent['side'],
  quote: Quote | null | undefined,
): number | null {
  if (!quote) return null;
  const aggressive = side === 'buy' ? quote.ask : quote.bid;
  if (finitePositive(aggressive)) return aggressive;
  // The mandate permits the last trade price as the fallback reference.
  return finitePositive(quote.last) ? quote.last : null;
}

/** Signed deviation of a price from its reference, as a decimal fraction. */
export function priceDeviation(price: number, reference: number): number {
  return (price - reference) / reference;
}

/**
 * Capital a fill would consume.
 *
 * A sell that closes an existing long consumes nothing — it releases capital —
 * so only the portion of a sell that would open or extend a short is charged
 * against buying power. Charging the full notional on every sell would block
 * users from exiting positions, which is the one action a risk control must
 * never obstruct.
 */
export function requiredCapitalUsd(
  intent: Pick<OrderIntent, 'side' | 'quantity'>,
  referencePrice: number,
  currentPositionQuantity: number,
): number {
  const quantity = intent.quantity ?? 0;
  if (intent.side === 'buy') return quantity * referencePrice;
  const coveredByLong = Math.max(0, Math.min(quantity, currentPositionQuantity));
  return Math.max(0, quantity - coveredByLong) * referencePrice;
}

function positionQuantity(account: AccountSnapshot | null | undefined, symbol: string): number {
  if (!account) return 0;
  const held = account.positions.find((p) => p.symbol === symbol);
  return held ? held.quantity : 0;
}

function resolveInstrument(
  context: RiskEvaluationContext,
  symbol: string,
): RiskInstrumentContext {
  if (context.instrument) return context.instrument;
  const spec = getSpec(symbol);
  if (!spec) return { tradable: false, adv30: null };
  // The benchmark is published for relative-strength context, not as a ticket
  // destination, so it is excluded from the tradable set exactly as
  // TRADABLE_SYMBOLS excludes it.
  return { tradable: !spec.isBenchmark, adv30: spec.adv30 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Labels for the UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Short labels for each rejection code. Sterile and factual: the mandate bans
 * behavioural nudging, so nothing here urges a retry or softens a refusal.
 */
export const RISK_REJECTION_LABELS: Record<RiskRejectionCode, string> = {
  KILL_SWITCH_ENGAGED: 'Routing halted',
  SUBSCRIPTION_REQUIRED: 'Live routing locked',
  UNTRUSTED_CLICK: 'Order intent unverified',
  INTENT_TOKEN_MISMATCH: 'Order does not match its authorisation',
  INTENT_TOKEN_SPENT: 'Authorisation already used',
  MISSING_ORDER_TYPE: 'Order type not selected',
  INVALID_QUANTITY: 'Quantity invalid',
  MISSING_LIMIT_PRICE: 'Limit price required',
  MISSING_STOP_PRICE: 'Stop price required',
  SYMBOL_NOT_TRADABLE: 'Symbol not tradable',
  MARKET_CLOSED: 'Market closed',
  DUPLICATE_ORDER: 'Duplicate submission',
  MAX_OPEN_ORDERS: 'Open-order limit reached',
  FAT_FINGER_NOTIONAL: 'Notional ceiling exceeded',
  LIQUIDITY_ADV_LIMIT: 'Liquidity participation limit exceeded',
  PRICE_TOLERANCE_NBBO: 'Price outside tolerance',
  INSUFFICIENT_FUNDS: INSUFFICIENT_FUNDS_MESSAGE,
};

// ─────────────────────────────────────────────────────────────────────────────
//  The engine
// ─────────────────────────────────────────────────────────────────────────────

const defaultMonotonic: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/**
 * Evaluates one order intent. Never throws.
 *
 * `RiskDecision.spiffeId` carries the engine's own workload identity so the
 * ledger records which piece of software authorised the payload, per the
 * zero-trust telemetry requirement, and `elapsedMs` records how long the
 * evaluation took — the pre-trade budget is part of the latency accounting the
 * platform publishes.
 */
export function evaluateOrder(
  intent: OrderIntent,
  context: RiskEvaluationContext,
): RiskDecision {
  const monotonic = context.monotonic ?? defaultMonotonic;
  const startedAt = monotonic();
  const checks: RiskCheckResult[] = [];
  const symbol = typeof intent.symbol === 'string' ? intent.symbol.toUpperCase() : '';

  /** Pushes a result and reports whether evaluation must stop. */
  const halted = (result: RiskCheckResult): boolean => {
    checks.push(result);
    return !result.passed;
  };

  const finalise = (): RiskDecision => {
    const rejection = checks.find((c) => !c.passed) ?? null;
    const decision: RiskDecision = {
      approved: rejection === null,
      checks,
      rejection,
      evaluatedAt: context.now,
      spiffeId: RISK_ENGINE_SPIFFE_ID,
      elapsedMs: Math.max(0, monotonic() - startedAt),
    };
    if (context.audit) {
      // SVID issuance is logged alongside the decision so the ledger shows which
      // identity document the authorising workload presented.
      issueSvid('risk-engine', context.now, {
        audit: context.audit,
        correlationId: context.correlationId,
      });
      context.audit.recordRiskDecision({
        correlationId: context.correlationId,
        userId: context.userId,
        symbol,
        spiffeId: RISK_ENGINE_SPIFFE_ID,
        requestingSpiffeId: context.requestingSpiffeId ?? null,
        decision: decision.approved ? 'ALLOW' : 'DENY',
        rejectionCode: rejection === null ? null : rejection.code,
        checks,
        evaluatedAt: context.now,
        elapsedMs: decision.elapsedMs,
        intent,
        click: context.click,
      });
    }
    return decision;
  };

  // ── 1. Global kill switch — nothing routes while it is engaged ────────────
  const engaged = context.killSwitchEngaged ?? isKillSwitchEngaged();
  if (
    halted(
      engaged
        ? deny(
            'KILL_SWITCH_ENGAGED',
            'kill_switch',
            `${SERVICE_UNAVAILABLE_MESSAGE} — order routing is halted platform-wide.`,
            KILL_SWITCH_HTTP_STATUS,
            KILL_SWITCH_HTTP_STATUS,
          )
        : pass('kill_switch', 'Global routing is enabled.'),
    )
  ) {
    return finalise();
  }

  // ── 2. Entitlement — live routing only ───────────────────────────────────
  // Paper routing is deliberately not gated: the sandbox is how a subscriber
  // evaluates the publication, and gating it would make the trial worthless.
  // The `trialing` status covers the 14-day *paper* sandbox, so it does not
  // unlock live routing on its own.
  const subscription = context.subscription ?? { status: 'none', liveTradingUnlocked: false };
  if (intent.account === 'live') {
    const entitled = subscription.liveTradingUnlocked && subscription.status === 'active';
    if (
      halted(
        entitled
          ? pass('subscription', 'Live routing is unlocked for this account.')
          : deny(
              'SUBSCRIPTION_REQUIRED',
              'subscription',
              'Live routing requires an active subscription. Paper routing is unaffected.',
            ),
      )
    ) {
      return finalise();
    }
  } else {
    checks.push(pass('subscription', 'Paper routing does not require a subscription.'));
  }

  // ── 3. Proof of physical human intent ────────────────────────────────────
  // This is the Weiss Research control. An order with no trusted click, or with
  // an intent token that does not verify, is by definition not user-directed and
  // must never be routed — no code in the platform can synthesise one.
  const click = context.click;
  const tokenVerification = context.intentToken ?? null;
  let intentResult: RiskCheckResult;
  if (click === null) {
    intentResult = deny(
      'UNTRUSTED_CLICK',
      'click_provenance',
      'Order carried no click provenance. Every order requires a physical Execute click.',
    );
  } else if (click.trusted !== true) {
    intentResult = deny(
      'UNTRUSTED_CLICK',
      'click_provenance',
      'Execute event was not a trusted user gesture. Order not transmitted.',
    );
  } else if (
    !Number.isFinite(click.clickX) ||
    !Number.isFinite(click.clickY) ||
    !Number.isFinite(click.clickedAt)
  ) {
    intentResult = deny(
      'UNTRUSTED_CLICK',
      'click_provenance',
      'Click coordinates or timestamp missing. Order not transmitted.',
    );
  } else if (tokenVerification === null && context.commit === true) {
    /**
     * A missing verification denies on the routing path.
     *
     * `intentToken: null` means "the caller verified elsewhere", which is true and
     * appropriate on the pre-flight preview — no token exists yet, and the preview
     * transmits nothing. On the *commit* path it means no authorisation was
     * presented at all, and treating that as a pass was a fail-open on the single
     * control the whole Weiss Research posture rests on: a caller that simply
     * omitted the field would have received an approved decision.
     *
     * The `commit` flag is exactly the distinction needed, so the preview keeps
     * working and routing cannot proceed unauthorised.
     */
    intentResult = deny(
      'UNTRUSTED_CLICK',
      'intent_token',
      'No order authorisation token was presented. Order not transmitted.',
    );
  } else if (tokenVerification !== null && !tokenVerification.valid) {
    intentResult = deny(
      tokenVerification.failure === 'REPLAYED'
        ? 'INTENT_TOKEN_SPENT'
        : tokenVerification.failure === 'PARAMETER_MISMATCH'
          ? 'INTENT_TOKEN_MISMATCH'
          : 'UNTRUSTED_CLICK',
      'intent_token',
      tokenVerification.failure === null
        ? 'Order authorisation token rejected. Order not transmitted.'
        : intentTokenFailureMessage(tokenVerification.failure),
    );
  } else if (tokenVerification?.payload != null && tokenBindingMismatch(tokenVerification.payload, intent) !== null) {
    /**
     * The engine re-checks the binding itself rather than trusting `valid`.
     *
     * `verifyIntentToken` already compares the token's payload against the
     * submitted parameters, and `buildOrderContext` feeds it the real intent — so
     * today this is redundant. It is here as defence in depth because this
     * function is the *last* gate before a broker, it holds both the payload and
     * the intent, and a future caller could construct a context pairing a
     * genuinely-valid token with a different order. Verifying what it can verify
     * costs one comparison.
     */
    const field = tokenBindingMismatch(tokenVerification.payload, intent);
    intentResult = deny(
      'INTENT_TOKEN_MISMATCH',
      'intent_token',
      `Order parameters do not match the authorised token (${field}). Order not transmitted.`,
    );
  } else {
    intentResult = pass('click_provenance', 'Trusted Execute click with single-use intent token.');
  }
  if (halted(intentResult)) return finalise();

  // ── 4. Ticket structure ──────────────────────────────────────────────────
  // The order type has no default anywhere in the product, so "unselected"
  // reaches the engine as an absent or unrecognised value and must deny.
  if (
    halted(
      ORDER_TYPES.includes(intent.type)
        ? pass('order_type', `Order type ${intent.type} selected.`)
        : deny('MISSING_ORDER_TYPE', 'order_type', 'Select an order type before routing.'),
    )
  ) {
    return finalise();
  }

  const quantityCheck = validateQuantity(intent.quantity);
  if (halted(quantityCheck.result)) return finalise();
  const shares = quantityCheck.shares;

  const needsLimitPrice = intent.type === 'limit' || intent.type === 'stop_limit';
  if (needsLimitPrice) {
    if (
      halted(
        finitePositive(intent.limitPrice)
          ? pass('limit_price', 'Limit price supplied.', intent.limitPrice)
          : deny(
              'MISSING_LIMIT_PRICE',
              'limit_price',
              'Enter a limit price. The field is never pre-filled.',
            ),
      )
    ) {
      return finalise();
    }
  } else {
    checks.push(pass('limit_price', 'Limit price not applicable to this order type.'));
  }

  const needsStopPrice = intent.type === 'stop' || intent.type === 'stop_limit';
  if (needsStopPrice) {
    if (
      halted(
        finitePositive(intent.stopPrice)
          ? pass('stop_price', 'Stop price supplied.', intent.stopPrice)
          : deny('MISSING_STOP_PRICE', 'stop_price', 'Enter a stop price.'),
      )
    ) {
      return finalise();
    }
  } else {
    checks.push(pass('stop_price', 'Stop price not applicable to this order type.'));
  }

  // ── 5. Instrument and session ────────────────────────────────────────────
  const instrument = resolveInstrument(context, symbol);
  if (
    halted(
      instrument.tradable
        ? pass('symbol', `${symbol} is in the tradable universe.`)
        : deny(
            'SYMBOL_NOT_TRADABLE',
            'symbol',
            `${symbol.length === 0 ? 'Symbol' : symbol} is not available for routing.`,
          ),
    )
  ) {
    return finalise();
  }

  const marketOpen = context.marketOpen ?? isMarketOpen(context.now);
  let sessionResult: RiskCheckResult;
  if (marketOpen) {
    sessionResult = pass('market_session', 'Regular session is open.');
  } else if (intent.type === 'market') {
    // A market order outside the session has no reference price and would fill at
    // whatever the opening auction produces — the definition of an erroneous
    // order the price-parameter control exists to prevent.
    sessionResult = deny(
      'MARKET_CLOSED',
      'market_session',
      'Regular session is closed. Market orders are not accepted outside session hours.',
    );
  } else if (!RESTABLE_TIF.includes(intent.timeInForce)) {
    sessionResult = deny(
      'MARKET_CLOSED',
      'market_session',
      'Regular session is closed. Immediate-or-cancel and fill-or-kill require an open book.',
    );
  } else {
    sessionResult = pass(
      'market_session',
      'Regular session is closed; the order will rest until the next session.',
    );
  }
  if (halted(sessionResult)) return finalise();

  // ── 6. Duplicate submission ──────────────────────────────────────────────
  // Repeated Execute clicks under network latency are the mandate's named
  // failure mode. The intent token's nonce stops an identical replay; the
  // idempotency key stops a re-submission that acquired a fresh token.
  const idempotencyKey = context.idempotencyKey ?? null;
  let duplicateResult: RiskCheckResult;
  if (idempotencyKey === null || context.idempotency === undefined) {
    duplicateResult = pass('idempotency', 'No prior submission recorded for this order.');
  } else if (context.idempotency.seen(idempotencyKey)) {
    duplicateResult = deny(
      'DUPLICATE_ORDER',
      'idempotency',
      'This order has already been submitted. It was not transmitted a second time.',
    );
  } else {
    duplicateResult = pass('idempotency', 'No prior submission recorded for this order.');
  }
  if (halted(duplicateResult)) return finalise();

  // ── 7. Open-order quota ──────────────────────────────────────────────────
  const openOrders = context.openOrderCount ?? 0;
  if (
    halted(
      openOrders < MAX_OPEN_ORDERS
        ? pass('open_orders', `${openOrders} open orders.`, openOrders, MAX_OPEN_ORDERS)
        : deny(
            'MAX_OPEN_ORDERS',
            'open_orders',
            `Open-order limit of ${MAX_OPEN_ORDERS} reached. Cancel a resting order before routing another.`,
            openOrders,
            MAX_OPEN_ORDERS,
          ),
    )
  ) {
    return finalise();
  }

  // ── 8. Control 1 — notional ceilings ─────────────────────────────────────
  const referencePrice = notionalReferencePrice(intent, context.quote);
  if (referencePrice === null) {
    // Fail closed: with no reference price the notional ceiling cannot be
    // evaluated at all, and an unmeasurable order is not a permitted order.
    checks.push(
      deny(
        'FAT_FINGER_NOTIONAL',
        'notional_ceiling_per_order',
        'Order cannot be priced against current market data. Order not transmitted.',
        null,
        MAX_NOTIONAL_PER_ORDER_USD,
      ),
    );
    return finalise();
  }

  /*
   * Every ceiling — per order, per day — is tested against the worst credible
   * fill rather than the user's own price. See `ceilingReferencePrice`.
   *
   * The ticket displays its own figure from `notionalReferencePrice`, and says
   * which price that was, so nothing here changes what the user is shown.
   */
  const ceilingNotionalUsd = orderNotionalUsd(
    intent,
    ceilingReferencePrice(intent, context.quote) ?? referencePrice,
  );
  if (
    halted(
      ceilingNotionalUsd <= MAX_NOTIONAL_PER_ORDER_USD
        ? pass(
            'notional_ceiling_per_order',
            'Order notional is within the per-order ceiling.',
            ceilingNotionalUsd,
            MAX_NOTIONAL_PER_ORDER_USD,
          )
        : deny(
            'FAT_FINGER_NOTIONAL',
            'notional_ceiling_per_order',
            `Order notional of ${formatUsd(ceilingNotionalUsd)} exceeds the per-order ceiling of ${formatUsd(MAX_NOTIONAL_PER_ORDER_USD)}.`,
            ceilingNotionalUsd,
            MAX_NOTIONAL_PER_ORDER_USD,
          ),
    )
  ) {
    return finalise();
  }

  const usedToday =
    context.dayNotionalUsedUsd ?? context.dailyNotional?.usedUsd(context.userId, context.now) ?? 0;
  const projectedToday = usedToday + ceilingNotionalUsd;
  if (
    halted(
      projectedToday <= MAX_NOTIONAL_PER_USER_PER_DAY_USD
        ? pass(
            'notional_ceiling_per_day',
            'Aggregate daily notional is within the ceiling.',
            projectedToday,
            MAX_NOTIONAL_PER_USER_PER_DAY_USD,
          )
        : deny(
            'FAT_FINGER_NOTIONAL',
            'notional_ceiling_per_day',
            `Aggregate notional of ${formatUsd(projectedToday)} for the session exceeds the daily ceiling of ${formatUsd(MAX_NOTIONAL_PER_USER_PER_DAY_USD)}.`,
            projectedToday,
            MAX_NOTIONAL_PER_USER_PER_DAY_USD,
          ),
    )
  ) {
    return finalise();
  }

  // ── 9. Control 2 — participation in 30-day ADV ───────────────────────────
  const adv30 = instrument.adv30;
  let advResult: RiskCheckResult;
  if (adv30 === null || !Number.isFinite(adv30) || adv30 <= 0) {
    // Mandated fail-closed branch: no volume history means no way to know the
    // order is not a manipulative share of the day's volume.
    advResult = deny(
      'LIQUIDITY_ADV_LIMIT',
      'adv_participation',
      'Thirty-day volume history is unavailable for this symbol. Order not transmitted.',
      null,
      ADV_PARTICIPATION_LIMIT,
    );
  } else {
    const participation = shares / adv30;
    advResult =
      participation <= ADV_PARTICIPATION_LIMIT
        ? pass(
            'adv_participation',
            `Order is ${(participation * 100).toFixed(3)}% of 30-day average daily volume.`,
            participation,
            ADV_PARTICIPATION_LIMIT,
          )
        : deny(
            'LIQUIDITY_ADV_LIMIT',
            'adv_participation',
            `Quantity is ${(participation * 100).toFixed(2)}% of 30-day average daily volume, above the ${(ADV_PARTICIPATION_LIMIT * 100).toFixed(0)}% participation limit. Maximum permitted quantity is ${maxQuantityForAdv(adv30).toLocaleString('en-US')} shares.`,
            participation,
            ADV_PARTICIPATION_LIMIT,
          );
  }
  if (halted(advResult)) return finalise();

  // ── 10. Control 3 — order price parameters ───────────────────────────────
  let priceResult: RiskCheckResult;
  if (intent.type === 'market') {
    priceResult = pass('price_tolerance', 'Market order carries no user-supplied price.');
  } else {
    const collarReference = priceCollarReference(intent.side, context.quote);
    if (collarReference === null) {
      // Fail closed: the collar is the control that stops a $100 limit on a $10
      // stock, and it cannot run without a reference price.
      priceResult = deny(
        'PRICE_TOLERANCE_NBBO',
        'price_tolerance',
        'No NBBO or last trade price available to validate the order price. Order not transmitted.',
      );
    } else {
      priceResult = evaluatePriceParameters(intent, collarReference);
    }
  }
  if (halted(priceResult)) return finalise();

  // ── 11. Control 4 — buying power and intraday margin ─────────────────────
  const account = context.account ?? null;
  let fundsResult: RiskCheckResult;
  if (account === null) {
    // Fail closed. The mandate requires the pre-flight GET /v2/account before
    // routing; with no snapshot the platform cannot assert the trade is funded,
    // and the verbatim message is the one the user must see.
    fundsResult = deny(
      'INSUFFICIENT_FUNDS',
      'buying_power',
      INSUFFICIENT_FUNDS_MESSAGE,
      null,
      null,
    );
  } else {
    fundsResult = evaluateBuyingPower(intent, referencePrice, account, symbol);
  }
  if (halted(fundsResult)) return finalise();

  // ── Approved ─────────────────────────────────────────────────────────────
  // Reservations happen only on approval and only when committing, so a
  // rejected or previewed order never consumes a user's daily quota.
  if (context.commit !== false) {
    if (idempotencyKey !== null) context.idempotency?.record(idempotencyKey, context.now);
    /*
     * Reserve the same figure the ceiling was tested against.
     *
     * The per-day check above projects `usedToday + ceilingNotionalUsd` — the
     * worse of the stated price and the side of the book a marketable order
     * would reach — and this line used to reserve `notionalUsd`, the stated
     * price. Every approved order therefore consumed less quota than it had been
     * measured against, and the gap compounds: fifty-four sell limits priced
     * 6% through the bid recorded $498,584 of usage against the $500,000 ceiling
     * while carrying $530,475 of credible exposure. Checking in one currency and
     * charging in another is exactly the marketable-limit gap `ceilingReferencePrice`
     * exists to close, reintroduced a day at a time.
     */
    context.dailyNotional?.add(context.userId, context.now, ceilingNotionalUsd);
  }
  return finalise();
}

/**
 * Quantity validation.
 *
 * The ticket's quantity field defaults to null and is populated only by physical
 * keyboard entry, so every one of these branches is a real inbound state: an
 * untouched field, a pasted decimal, a zero, a negative. A fractional quantity is
 * refused rather than rounded — rounding would mean the platform altered a
 * user-supplied parameter, and the ledger's whole purpose is proving it never does.
 */
/**
 * The first order parameter that diverges from the token's payload, or null.
 *
 * Compared field by field rather than by deep equality so the rejection can name
 * which parameter changed — "the quantity does not match" is actionable, "the
 * token does not match" is not. The symbol comparison is case-insensitive because
 * the token is minted from the normalised symbol while an intent may arrive in any
 * case.
 */
function tokenBindingMismatch(
  payload: IntentTokenPayload,
  intent: OrderIntent,
): 'symbol' | 'side' | 'quantity' | 'orderType' | null {
  if (payload.symbol.toUpperCase() !== intent.symbol.toUpperCase()) return 'symbol';
  if (payload.side !== intent.side) return 'side';
  // A null quantity is caught by the ticket-structure check, so it is not a
  // binding failure here.
  if (intent.quantity !== null && payload.quantity !== intent.quantity) return 'quantity';
  if (payload.orderType !== intent.type) return 'orderType';
  return null;
}

function validateQuantity(quantity: number | null): { result: RiskCheckResult; shares: number } {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) {
    return {
      result: deny('INVALID_QUANTITY', 'quantity', 'Enter a share quantity.', null, MIN_QUANTITY),
      shares: 0,
    };
  }
  if (!Number.isInteger(quantity)) {
    return {
      result: deny(
        'INVALID_QUANTITY',
        'quantity',
        'Quantity must be a whole number of shares.',
        quantity,
        MIN_QUANTITY,
      ),
      shares: 0,
    };
  }
  if (quantity < MIN_QUANTITY) {
    return {
      result: deny(
        'INVALID_QUANTITY',
        'quantity',
        `Quantity must be at least ${MIN_QUANTITY} share.`,
        quantity,
        MIN_QUANTITY,
      ),
      shares: 0,
    };
  }
  return {
    result: pass('quantity', `${quantity} shares.`, quantity, MIN_QUANTITY),
    shares: quantity,
  };
}

/**
 * Directional price-parameter test.
 *
 * Only the aggressive side of a limit price is collared, per the mandate's
 * pseudocode: a buy priced far above the offer and a sell priced far below the
 * bid are erroneous, while the passive directions (a buy below the market, a sell
 * above it) are ordinary resting orders and must route untouched. Stop prices get
 * the wide symmetric sanity band instead, because they are placed away from the
 * market by design.
 */
function evaluatePriceParameters(intent: OrderIntent, reference: number): RiskCheckResult {
  const tolerance = limitPriceTolerance(reference);

  if ((intent.type === 'limit' || intent.type === 'stop_limit') && finitePositive(intent.limitPrice)) {
    const limitPrice = intent.limitPrice;
    const deviation = priceDeviation(limitPrice, reference);
    const aggressiveDeviation = intent.side === 'buy' ? deviation : -deviation;
    if (aggressiveDeviation > tolerance) {
      return deny(
        'PRICE_TOLERANCE_NBBO',
        'price_tolerance',
        `Limit price of ${formatUsd(limitPrice)} is ${(aggressiveDeviation * 100).toFixed(1)}% ${intent.side === 'buy' ? 'above' : 'below'} the ${intent.side === 'buy' ? 'offer' : 'bid'} of ${formatUsd(reference)}, outside the ${(tolerance * 100).toFixed(0)}% tolerance band.`,
        aggressiveDeviation,
        tolerance,
      );
    }
  }

  if ((intent.type === 'stop' || intent.type === 'stop_limit') && finitePositive(intent.stopPrice)) {
    const stopPrice = intent.stopPrice;
    const stopDeviation = Math.abs(priceDeviation(stopPrice, reference));
    if (stopDeviation > STOP_PRICE_SANITY_DEVIATION) {
      return deny(
        'PRICE_TOLERANCE_NBBO',
        'price_tolerance',
        `Stop price of ${formatUsd(stopPrice)} deviates ${(stopDeviation * 100).toFixed(1)}% from the reference price of ${formatUsd(reference)}, outside the ${(STOP_PRICE_SANITY_DEVIATION * 100).toFixed(0)}% sanity band.`,
        stopDeviation,
        STOP_PRICE_SANITY_DEVIATION,
      );
    }
  }

  return pass('price_tolerance', 'Order price is within the tolerance band.', reference, tolerance);
}

/**
 * Pre-trade buying-power and intraday-margin test.
 *
 * Two independent conditions deny, matching the mandate's reconstruction: the
 * trade costing more than the available capital, or the trade creating a
 * projected maintenance-margin deficit. Both surface the verbatim message —
 * 'Insufficient Funds / Margin Limit Exceeded' — because that string is a
 * required text asset, and the numeric detail lives in `observed`/`limit` where
 * the ledger and the drill-down can use it without changing the copy.
 *
 * Account balances are read here and nowhere else. The mandate permits balance
 * data to be consumed "ONLY for the defensive pre-trade buying-power/margin
 * check", never to propose a size, so no quantity, weight or allocation is ever
 * derived from these numbers.
 */
function evaluateBuyingPower(
  intent: OrderIntent,
  referencePrice: number,
  account: AccountSnapshot,
  symbol: string,
): RiskCheckResult {
  const held = positionQuantity(account, symbol);
  const required = requiredCapitalUsd(intent, referencePrice, held);

  const available = Number.isFinite(account.buyingPower) ? account.buyingPower : account.cash;
  if (required > available) {
    return deny('INSUFFICIENT_FUNDS', 'buying_power', INSUFFICIENT_FUNDS_MESSAGE, required, available);
  }

  // Projected maintenance requirement against projected equity. An at-market
  // trade does not change equity, so a deficit can only arise from the added
  // exposure — which is exactly the "creates or increases an intraday margin
  // deficit" condition brokers reject on.
  const projectedGrossExposure = account.grossExposure + required;
  const projectedMaintenance = projectedGrossExposure * MAINTENANCE_MARGIN_RATE;
  const projectedDeficit = projectedMaintenance - account.equity;
  if (projectedDeficit > 0) {
    return deny(
      'INSUFFICIENT_FUNDS',
      'intraday_margin',
      INSUFFICIENT_FUNDS_MESSAGE,
      projectedMaintenance,
      account.equity,
    );
  }

  return pass('buying_power', 'Buying power and maintenance margin are sufficient.', required, available);
}

/** Currency formatting for rejection copy. Plain and terminal-like. */
function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
