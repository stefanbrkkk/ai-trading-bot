/**
 * Regression tests for the pre-trade ceilings and the order-routing endpoint.
 *
 * Every case here is a defect that reproduced against the running platform, and
 * the theme they share is the one the product's whole posture rests on: a number
 * a control is checked against and the number it is charged has to be the same
 * number. Four of these were the same disagreement wearing different clothes —
 * a ceiling measured at the aggressive price and a quota charged at the stated
 * one, a quota window anchored at an instant most of its own rows precede, a cap
 * counting one order status while the unwind it bounds walks three, and a stop
 * price that was treated as a bound on the fill when it is only a trigger.
 *
 * They are asserted against independently computed expectations — the touch
 * price times the quantity, the ledger sum, the published constant — rather than
 * against recorded output, because a wrong implementation reproduces its own
 * wrong numbers perfectly reliably.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountSnapshot,
  ClickProvenance,
  Order,
  OrderIntent,
  Quote,
  RiskDecision,
} from '@/lib/domain/types';

process.env.AURELIUS_DATA_DIR = ':memory:';

const { closeDb, resetDb } = await import('@/lib/db/client');
const { acceptedNotionalUsdSince, findUserByEmail, insertOrder, setLiveTradingUnlocked, upsertUser } =
  await import('@/lib/db/repositories');
const { buildOrderContext, quotaNotionalUsd } = await import('@/lib/api/orderContext');
const { ceilingReferencePrice, evaluateOrder, notionalReferencePrice } = await import(
  '@/lib/risk/engine'
);
const { MAX_NOTIONAL_PER_ORDER_USD, MAX_NOTIONAL_PER_USER_PER_DAY_USD } = await import(
  '@/lib/risk/limits'
);
const { fromNewYork, toNewYork } = await import('@/lib/market/calendar');
const { InMemoryDailyNotionalStore } = await import('@/lib/risk/ports');

type RiskEvaluationContext = Parameters<typeof evaluateOrder>[1];

// A Tuesday. 14:00 UTC is 10:00 ET, inside the regular session; 12:00 UTC is
// 08:00 ET, an hour and a half before the open.
const SESSION = Date.parse('2026-08-18T14:00:00Z');
const PRE_MARKET = Date.parse('2026-08-18T12:00:00Z');
const AFTERNOON = Date.parse('2026-08-18T18:00:00Z');

function quote(symbol: string, bid: number, ask: number, last: number): Quote {
  return {
    symbol,
    timestamp: SESSION,
    bid,
    ask,
    bidSize: 500,
    askSize: 500,
    last,
    lastSize: 100,
    volume: 1_000_000,
    previousClose: last,
  };
}

/** The quote from the reproduction: a two-cent spread around 141.76. */
const AAPL = quote('AAPL', 141.75, 141.77, 141.76);

/** The quote the fat-finger ceiling was originally written against. */
const PG = quote('PG', 288.87, 288.93, 288.9);

const CLICK: ClickProvenance = {
  clickX: 640,
  clickY: 480,
  viewportWidth: 1440,
  viewportHeight: 900,
  clickedAt: SESSION,
  trusted: true,
  targetId: 'execute',
};

const ACCOUNT: AccountSnapshot = {
  account: 'paper',
  cash: 5_000_000,
  equity: 5_000_000,
  buyingPower: 10_000_000,
  grossExposure: 0,
  netExposure: 0,
  maintenanceMargin: 0,
  dayPnl: 0,
  totalPnl: 0,
  positions: [],
  updatedAt: SESSION,
};

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    symbol: 'AAPL',
    side: 'buy',
    type: 'market',
    quantity: 100,
    notional: null,
    limitPrice: null,
    stopPrice: null,
    timeInForce: 'day',
    account: 'paper',
    signalId: null,
    ...overrides,
  };
}

/**
 * A context whose token authorises exactly the intent given, so an evaluation
 * reaches the control under test instead of stopping at a binding mismatch.
 */
function context(
  forIntent: OrderIntent,
  overrides: Partial<RiskEvaluationContext> = {},
): RiskEvaluationContext {
  return {
    userId: 'u1',
    correlationId: 'c1',
    now: SESSION,
    killSwitchEngaged: false,
    subscription: { status: 'active', liveTradingUnlocked: true },
    click: CLICK,
    intentToken: {
      valid: true,
      failure: null,
      mismatchedField: null,
      ageMs: 0,
      payload: {
        userId: 'u1',
        symbol: forIntent.symbol,
        side: forIntent.side,
        quantity: forIntent.quantity ?? 0,
        orderType: forIntent.type,
        clickTsMs: SESSION,
        nonce: 'n1',
      },
    },
    instrument: { tradable: true, adv30: 50_000_000 },
    marketOpen: true,
    openOrderCount: 0,
    idempotencyKey: null,
    quote: AAPL,
    account: ACCOUNT,
    commit: false,
    ...overrides,
  };
}

function observed(decision: RiskDecision, check: string): number | null {
  return decision.checks.find((c) => c.check === check)?.observed ?? null;
}

/** UTC ms of 00:00 New York on the calendar day containing `utcMs`. */
function newYorkDayStart(utcMs: number): number {
  const parts = toNewYork(utcMs);
  return fromNewYork(parts.year, parts.month, parts.day, 0);
}

const APPROVED: RiskDecision = {
  approved: true,
  checks: [],
  rejection: null,
  evaluatedAt: SESSION,
  spiffeId: 'spiffe://aurelius.local/ns/trading/sa/risk-engine',
  elapsedMs: 0,
};

/**
 * Persists one order the way the routing endpoint does.
 *
 * The quota figure comes from the endpoint's own `quotaNotionalUsd`, not from a
 * copy of its arithmetic: a test that re-derived the number here would keep
 * passing if the endpoint went back to persisting the stated price, which is
 * precisely the defect being guarded.
 */
function routeOrder(
  id: string,
  userId: string,
  forIntent: OrderIntent,
  quote: Quote | null,
  createdAt: number,
  status: Order['status'] = 'submitted',
): void {
  const quota = quotaNotionalUsd(forIntent, quote);
  insertOrder(
    {
      id,
      userId,
      symbol: forIntent.symbol,
      side: forIntent.side,
      type: forIntent.type,
      quantity: forIntent.quantity ?? 0,
      limitPrice: forIntent.limitPrice,
      stopPrice: forIntent.stopPrice,
      timeInForce: forIntent.timeInForce,
      account: forIntent.account,
      status,
      filledQuantity: 0,
      averageFillPrice: null,
      createdAt,
      updatedAt: createdAt,
      signalId: null,
      riskDecision: APPROVED,
      brokerRequest: null,
      brokerStatus: null,
      brokerResponse: null,
      brokerOrderId: null,
    },
    {
      intentToken: `tok-${id}`,
      correlationId: `corr-${id}`,
      ...(quota === null ? {} : { notionalCents: Math.round(quota * 100) }),
    },
  );
}

function seedUser(email: string): string {
  return upsertUser({ email, displayName: email.split('@')[0] ?? 'Trader', role: 'trader' }).id;
}

beforeEach(() => {
  resetDb();
});

afterAll(() => {
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
//  The stop price is a trigger, not a bound on the fill
// ─────────────────────────────────────────────────────────────────────────────

describe('ceilingReferencePrice — stops', () => {
  it('prices a buy stop that is already through the market off the offer it lifts', () => {
    // A buy stop below the last trade triggers on receipt and becomes a market
    // order. Priced at the stop it measured 71.02 against a 141.77 offer.
    expect(ceilingReferencePrice(intent({ type: 'stop', side: 'buy', stopPrice: 71.02 }), AAPL)).toBe(
      141.77,
    );
  });

  it('leaves a correctly placed buy stop at the stop the user typed', () => {
    // It triggers above the offer, so the offer is not the bound — the stop is.
    expect(ceilingReferencePrice(intent({ type: 'stop', side: 'buy', stopPrice: 150 }), AAPL)).toBe(150);
  });

  it('leaves a sell stop at its stop from either side of the market', () => {
    // Below the market it fills at or under the stop; above the market it
    // triggers on receipt and hits a bid lower still. The stop bounds both.
    expect(ceilingReferencePrice(intent({ type: 'stop', side: 'sell', stopPrice: 130 }), AAPL)).toBe(130);
    expect(ceilingReferencePrice(intent({ type: 'stop', side: 'sell', stopPrice: 150 }), AAPL)).toBe(150);
  });

  it('still prices a marketable sell limit off the bid', () => {
    // The case the ceiling was written for, unchanged by the stop repair.
    expect(
      ceilingReferencePrice(intent({ type: 'limit', side: 'sell', limitPrice: 271.56 }), PG),
    ).toBe(288.87);
  });

  it('still refuses to price a buy limit above the limit the user typed', () => {
    expect(ceilingReferencePrice(intent({ type: 'limit', side: 'buy', limitPrice: 141 }), AAPL)).toBe(141);
  });
});

describe('Control 1 against a stop through the market', () => {
  it('measures the reproduction at the offer and rejects it on the per-order ceiling', () => {
    // 1,408 AAPL BUY STOP @ 71.02: −49.9%, inside the ±50% stop sanity band,
    // and it filled at 141.94 for $199,852 against a published $100,000 cap.
    const i = intent({ type: 'stop', side: 'buy', stopPrice: 71.02, quantity: 1408 });
    const decision = evaluateOrder(i, context(i));
    expect(decision.approved).toBe(false);
    expect(decision.rejection?.code).toBe('FAT_FINGER_NOTIONAL');
    expect(decision.rejection?.check).toBe('notional_ceiling_per_order');
    expect(observed(decision, 'notional_ceiling_per_order')).toBeCloseTo(1408 * AAPL.ask, 6);
    expect(observed(decision, 'notional_ceiling_per_order')).toBeGreaterThan(MAX_NOTIONAL_PER_ORDER_USD);
  });

  it('rejects the same shape below the ceiling as a market order in disguise', () => {
    // Ten shares never approaches the notional cap, so the control that has to
    // catch it is the price-parameter one.
    const i = intent({ type: 'stop', side: 'buy', stopPrice: 71.02, quantity: 10 });
    const decision = evaluateOrder(i, context(i));
    expect(decision.approved).toBe(false);
    expect(decision.rejection?.code).toBe('PRICE_TOLERANCE_NBBO');
    expect(decision.rejection?.check).toBe('price_tolerance');
    expect(decision.rejection?.message).toContain('would trigger on receipt');
  });

  it('rejects a sell stop placed above the bid for the same reason', () => {
    const i = intent({ type: 'stop', side: 'sell', stopPrice: 150, quantity: 10 });
    const decision = evaluateOrder(i, context(i));
    expect(decision.rejection?.code).toBe('PRICE_TOLERANCE_NBBO');
    expect(decision.rejection?.message).toContain('at or through the bid');
  });

  it('routes correctly placed stops on both sides untouched', () => {
    for (const i of [
      intent({ type: 'stop', side: 'buy', stopPrice: 150, quantity: 10 }),
      intent({ type: 'stop', side: 'sell', stopPrice: 130, quantity: 10 }),
    ]) {
      expect(evaluateOrder(i, context(i)).approved).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Checked in one currency, charged in the same one
// ─────────────────────────────────────────────────────────────────────────────

describe('the daily quota is charged what the ceiling was checked against', () => {
  it('persists exactly the figure the per-order ceiling observed', () => {
    for (const [i, quote] of [
      [intent({ type: 'limit', side: 'sell', limitPrice: 133.61, quantity: 700 }), AAPL],
      [intent({ type: 'limit', side: 'sell', limitPrice: 271.56, quantity: 34 }), PG],
      [intent({ type: 'market', side: 'buy', quantity: 100 }), AAPL],
      [intent({ type: 'limit', side: 'buy', limitPrice: 141, quantity: 100 }), AAPL],
      [intent({ type: 'stop', side: 'sell', stopPrice: 130, quantity: 100 }), AAPL],
    ] as [OrderIntent, Quote][]) {
      const decision = evaluateOrder(i, context(i, { quote }));
      expect(quotaNotionalUsd(i, quote)).toBeCloseTo(
        observed(decision, 'notional_ceiling_per_order') ?? Number.NaN,
        9,
      );
    }
  });

  it('charges the marketable sell limit at the bid, not at the limit', () => {
    // AAPL bid 141.75: the engine tested $99,225 and the ledger recorded the
    // $93,527 the limit implied — 6.1% of every such order, missing from a
    // $500,000 brake.
    const i = intent({ type: 'limit', side: 'sell', limitPrice: 133.61, quantity: 700 });
    expect(quotaNotionalUsd(i, AAPL)).toBeCloseTo(700 * 141.75, 9);
    expect(notionalReferencePrice(i, AAPL)).toBe(133.61);
  });

  it('never transmits more credible exposure in a day than the published ceiling', () => {
    /*
     * The whole loop, against the real ledger: admit orders while the engine
     * approves them, persist each one the way the routing endpoint does, and
     * compare what was actually transmitted against the published cap. Charging
     * the stated price let fifty-four PG sell limits show $498,584 of usage
     * while carrying $530,475 of exposure.
     */
    const userId = seedUser('quota@aurelius.test');
    const i = intent({ type: 'limit', side: 'sell', limitPrice: 271.56, quantity: 34 });
    const perOrder = quotaNotionalUsd(i, PG) ?? 0;
    let admitted = 0;

    for (let n = 0; n < 400; n += 1) {
      const usedToday = acceptedNotionalUsdSince(userId, newYorkDayStart(SESSION));
      const decision = evaluateOrder(
        i,
        context(i, { userId, quote: PG, dayNotionalUsedUsd: usedToday, commit: true }),
      );
      if (!decision.approved) {
        expect(decision.rejection?.check).toBe('notional_ceiling_per_day');
        break;
      }
      routeOrder(`ord_q${n}`, userId, i, PG, SESSION);
      admitted += 1;
    }

    expect(admitted).toBeGreaterThan(0);
    const transmitted = admitted * perOrder;
    const ledger = acceptedNotionalUsdSince(userId, newYorkDayStart(SESSION));
    expect(ledger).toBeCloseTo(transmitted, 2);
    expect(transmitted).toBeLessThanOrEqual(MAX_NOTIONAL_PER_USER_PER_DAY_USD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The window the quota is measured over
// ─────────────────────────────────────────────────────────────────────────────

describe('the daily notional window', () => {
  it('counts an order routed before the open, all day', async () => {
    /*
     * Anchoring the window at the 09:30 open made it a future instant for every
     * pre-market request, and `created_at >= since` then excluded those rows for
     * the rest of the session too. Twenty resting day orders totalling $1.99M
     * were accepted against a $500,000 ceiling while the counter read zero.
     */
    const userId = seedUser('premarket@aurelius.test');
    const i = intent({ type: 'limit', side: 'sell', limitPrice: 271.56, quantity: 34 });
    routeOrder('ord_pre', userId, i, PG, PRE_MARKET);
    const perOrder = quotaNotionalUsd(i, PG) ?? 0;

    const built = await buildOrderContext({
      user: findUserByEmail('premarket@aurelius.test')!,
      intent: i,
      click: null,
      intentToken: null,
      idempotencyKey: null,
      correlationId: 'c-pre',
      commit: false,
      now: PRE_MARKET,
    });

    for (const at of [PRE_MARKET, SESSION, AFTERNOON]) {
      expect(built.context.dailyNotional?.usedUsd(userId, at)).toBeCloseTo(perOrder, 2);
    }
  });

  it('agrees with the in-memory reference store about where a day starts', () => {
    /*
     * `InMemoryDailyNotionalStore` — the implementation the engine's own unit
     * tests drive — buckets by New York calendar date. The ledger-backed port
     * has to mean the same thing by "today" or the tests and production are
     * measuring different windows.
     */
    const store = new InMemoryDailyNotionalStore();
    store.add('u1', PRE_MARKET, 1_000);
    expect(store.usedUsd('u1', AFTERNOON)).toBe(1_000);
    expect(newYorkDayStart(PRE_MARKET)).toBe(newYorkDayStart(AFTERNOON));
    // And it is the exchange-local day, not the UTC one: 20:00 ET is still today.
    expect(newYorkDayStart(Date.parse('2026-08-19T02:00:00Z'))).toBe(newYorkDayStart(SESSION));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The open-order cap counts what the unwind walks
// ─────────────────────────────────────────────────────────────────────────────

describe('the open-order cap', () => {
  it('counts every working status, including a partial fill', async () => {
    /*
     * The kill switch unwinds 'pending_risk', 'submitted' and
     * 'partially_filled'. The cap is sold on bounding that unwind, so it has to
     * count the same three. A partial fill leaves a resting remainder that
     * nothing in the platform transitions further, so counting only 'submitted'
     * let those accumulate across sessions while the cap read zero.
     */
    const userId = seedUser('cap@aurelius.test');
    const i = intent({ type: 'limit', side: 'buy', limitPrice: 141, quantity: 10 });
    routeOrder('ord_s', userId, i, AAPL, SESSION, 'submitted');
    routeOrder('ord_p', userId, i, AAPL, SESSION, 'partially_filled');
    routeOrder('ord_r', userId, i, AAPL, SESSION, 'pending_risk');
    routeOrder('ord_f', userId, i, AAPL, SESSION, 'filled');
    routeOrder('ord_c', userId, i, AAPL, SESSION, 'canceled');

    const built = await buildOrderContext({
      user: findUserByEmail('cap@aurelius.test')!,
      intent: i,
      click: null,
      intentToken: null,
      idempotencyKey: null,
      correlationId: 'c-cap',
      commit: false,
      now: SESSION,
    });

    expect(built.context.openOrderCount).toBe(3);
  });

  it('counts only the account the order is destined for', async () => {
    const userId = seedUser('accounts@aurelius.test');
    const paper = intent({ type: 'limit', side: 'buy', limitPrice: 141, quantity: 10 });
    routeOrder('ord_pa', userId, paper, AAPL, SESSION, 'partially_filled');
    routeOrder(
      'ord_li',
      userId,
      { ...paper, account: 'live' },
      AAPL,
      SESSION,
      'partially_filled',
    );

    const built = await buildOrderContext({
      user: findUserByEmail('accounts@aurelius.test')!,
      intent: paper,
      click: null,
      intentToken: null,
      idempotencyKey: null,
      correlationId: 'c-acct',
      commit: false,
      now: SESSION,
    });

    expect(built.context.openOrderCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Controls that report only what they evaluated
// ─────────────────────────────────────────────────────────────────────────────

describe('the idempotency control', () => {
  it('reports itself unarmed when no key was supplied', () => {
    // It used to print the same sentence as a lookup that found nothing, so the
    // pre-flight panel showed a PASS for an evaluation that never happened.
    const i = intent();
    const check = evaluateOrder(i, context(i)).checks.find((c) => c.check === 'idempotency');
    expect(check?.passed).toBe(true);
    expect(check?.message).toContain('No idempotency key was supplied');
    expect(check?.message).not.toContain('No prior submission recorded');
  });

  it('denies a repeat when a caller does supply one', () => {
    const i = intent();
    const seen = new Set<string>(['retry-1']);
    const decision = evaluateOrder(
      i,
      context(i, {
        idempotencyKey: 'retry-1',
        idempotency: { seen: (k: string) => seen.has(k), record: (k: string) => void seen.add(k) },
      }),
    );
    expect(decision.rejection?.code).toBe('DUPLICATE_ORDER');
  });

  it('reports a real lookup that found nothing as exactly that', () => {
    const i = intent();
    const decision = evaluateOrder(
      i,
      context(i, {
        idempotencyKey: 'fresh-1',
        idempotency: { seen: () => false, record: () => undefined },
      }),
    );
    const check = decision.checks.find((c) => c.check === 'idempotency');
    expect(check?.message).toBe('No prior submission recorded for this order.');
  });
});

describe('the kill-switch control', () => {
  it('denies when the caller supplied no halt state at all', () => {
    /*
     * The fallback used to be `isKillSwitchEngaged()`, a process-global that
     * nothing installs and which therefore answers `false` however engaged the
     * real, ledger-backed halt is. On a fail-closed engine that is the wrong
     * default for the one control that stops everything.
     */
    const i = intent();
    const { killSwitchEngaged: _omitted, ...rest } = context(i);
    void _omitted;
    const decision = evaluateOrder(i, rest as RiskEvaluationContext);
    expect(decision.approved).toBe(false);
    expect(decision.rejection?.code).toBe('KILL_SWITCH_ENGAGED');
    expect(decision.rejection?.check).toBe('kill_switch');
  });

  it('still routes when the caller says the platform is open', () => {
    const i = intent();
    expect(evaluateOrder(i, context(i, { killSwitchEngaged: false })).approved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Accepting the terms is not an entitlement change
// ─────────────────────────────────────────────────────────────────────────────

describe('clickwrap acceptance and the live-routing entitlement', () => {
  it('leaves the flag alone when the acceptance carries it through', () => {
    /*
     * `upsertUser` writes `live_trading_unlocked` from its bound parameter
     * unconditionally, and that parameter defaults to false — so an upsert that
     * omits the field clears it. `acceptTerms` omitted it, which made accepting
     * the terms a silent, unaudited revocation of live routing, repeated on
     * every version bump because acceptance is required again each time.
     */
    const id = seedUser('unlocked@aurelius.test');
    setLiveTradingUnlocked(id, true);
    const before = findUserByEmail('unlocked@aurelius.test')!;
    expect(before.liveTradingUnlocked).toBe(true);

    // The write `acceptTerms` performs, field for field.
    upsertUser({
      id: before.id,
      email: before.email,
      displayName: before.displayName,
      role: before.role,
      liveTradingUnlocked: before.liveTradingUnlocked,
      tosAcceptedAt: SESSION,
      tosVersion: '2026-01-15',
    });

    const after = findUserByEmail('unlocked@aurelius.test')!;
    expect(after.liveTradingUnlocked).toBe(true);
    expect(after.tosAcceptedAt).toBe(SESSION);
    expect(after.tosVersion).toBe('2026-01-15');
  });

  it('does not grant the flag to an account that never had it', () => {
    const id = seedUser('locked@aurelius.test');
    const before = findUserByEmail('locked@aurelius.test')!;
    expect(before.liveTradingUnlocked).toBe(false);
    upsertUser({
      id,
      email: before.email,
      displayName: before.displayName,
      role: before.role,
      liveTradingUnlocked: before.liveTradingUnlocked,
      tosAcceptedAt: SESSION,
      tosVersion: '2026-01-15',
    });
    expect(findUserByEmail('locked@aurelius.test')!.liveTradingUnlocked).toBe(false);
  });
});
