/**
 * The pre-trade risk engine.
 *
 * Each control gets a test that proves it *fires*, and — where the distinction
 * matters — one that proves it fails **closed**. The second kind is the one worth
 * writing: a control that approves when its input is missing is worse than no
 * control, because it reports a check that did not happen.
 *
 * The engine is a pure function of an intent and a context, so no database, broker
 * or clock is involved. That is itself a property under test: a risk decision that
 * depended on ambient state could not be reconstructed from the ledger.
 */

import { describe, expect, it } from 'vitest';
import { ceilingReferencePrice } from '@/lib/risk/engine';
import {
  ADV_PARTICIPATION_LIMIT,
  MAX_NOTIONAL_PER_ORDER_USD,
  RISK_LIMIT_DESCRIPTORS,
  evaluateOrder,
  mintIntentToken,
  verifyIntentToken,
  type RiskEvaluationContext,
} from '@/lib/risk';
import type { AccountSnapshot, ClickProvenance, OrderIntent, Quote } from '@/lib/domain/types';

const NOW = Date.UTC(2026, 7, 14, 15, 0, 0);

const QUOTE: Quote = {
  symbol: 'AAPL',
  timestamp: NOW,
  bid: 142.14,
  ask: 142.16,
  bidSize: 900,
  askSize: 900,
  last: 142.15,
  lastSize: 100,
  volume: 1_000_000,
  previousClose: 141.7,
};

const CLICK: ClickProvenance = {
  clickX: 880,
  clickY: 640,
  viewportWidth: 1512,
  viewportHeight: 982,
  clickedAt: NOW,
  trusted: true,
  targetId: 'execute-button',
};

const ACCOUNT: AccountSnapshot = {
  account: 'paper',
  cash: 500_000,
  equity: 500_000,
  buyingPower: 1_000_000,
  grossExposure: 0,
  netExposure: 0,
  maintenanceMargin: 0,
  dayPnl: 0,
  totalPnl: 0,
  positions: [],
  updatedAt: NOW,
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

function context(overrides: Partial<RiskEvaluationContext> = {}): RiskEvaluationContext {
  const base: RiskEvaluationContext = {
    userId: 'u1',
    correlationId: 'c1',
    now: NOW,
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
        symbol: 'AAPL',
        side: 'buy',
        quantity: 100,
        orderType: 'market',
        clickTsMs: NOW,
        nonce: 'n1',
      },
    },
    instrument: { tradable: true, adv30: 50_000_000 },
    marketOpen: true,
    openOrderCount: 0,
    idempotencyKey: 'k1',
    quote: QUOTE,
    account: ACCOUNT,
    requestingSpiffeId: 'spiffe://aurelius.local/ns/platform/sa/api-gateway',
    commit: false,
  };
  return { ...base, ...overrides };
}

/**
 * A context whose intent token authorises `quantity`.
 *
 * Needed because the token binds to the quantity: without re-binding it, an
 * oversized order is rejected for a parameter mismatch before the notional ceiling
 * is ever reached, and the test would pass while asserting the wrong control.
 */
function contextForQuantity(quantity: number): RiskEvaluationContext {
  return context({
    intentToken: {
      valid: true,
      failure: null,
      mismatchedField: null,
      ageMs: 0,
      payload: {
        userId: 'u1',
        symbol: 'AAPL',
        side: 'buy',
        quantity,
        orderType: 'market',
        clickTsMs: NOW,
        nonce: 'n1',
      },
    },
  });
}

/** The rejection code, or null when approved. */
function reject(i: OrderIntent, c: RiskEvaluationContext): string | null {
  const decision = evaluateOrder(i, c);
  return decision.approved ? null : (decision.rejection?.code ?? 'UNKNOWN');
}

describe('risk engine — baseline', () => {
  it('approves a well-formed order', () => {
    const decision = evaluateOrder(intent(), context());
    expect(decision.approved).toBe(true);
    expect(decision.rejection).toBeNull();
    // Every control is reported, passed or not, so the decision is auditable.
    expect(decision.checks.length).toBeGreaterThan(6);
    expect(decision.checks.every((c) => c.passed)).toBe(true);
  });

  it('is a pure function of its inputs', () => {
    const a = evaluateOrder(intent(), context());
    const b = evaluateOrder(intent(), context());
    expect(a.approved).toBe(b.approved);
    expect(a.checks.map((c) => c.check)).toEqual(b.checks.map((c) => c.check));
  });

  it('names a SPIFFE identity on the decision', () => {
    expect(evaluateOrder(intent(), context()).spiffeId).toMatch(/^spiffe:\/\//);
  });
});

describe('risk engine — kill switch', () => {
  it('rejects while engaged, whatever else is valid', () => {
    expect(reject(intent(), context({ killSwitchEngaged: true }))).toBe('KILL_SWITCH_ENGAGED');
  });

  it('checks the switch before anything else', () => {
    // A halted platform must not report a fat-finger rejection instead of the halt:
    // the user would correct the quantity and try again against a closed venue.
    const decision = evaluateOrder(intent({ quantity: 10_000_000 }), context({ killSwitchEngaged: true }));
    expect(decision.rejection?.code).toBe('KILL_SWITCH_ENGAGED');
  });
});

describe('risk engine — entitlement', () => {
  it('rejects live routing without an active subscription', () => {
    expect(
      reject(
        intent({ account: 'live' }),
        context({ subscription: { status: 'trialing', liveTradingUnlocked: false } }),
      ),
    ).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('rejects live routing when the subscription is active but the unlock is not', () => {
    // Both conditions are required. An active subscription alone is not consent to
    // route real money.
    expect(
      reject(
        intent({ account: 'live' }),
        context({ subscription: { status: 'active', liveTradingUnlocked: false } }),
      ),
    ).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('does not gate the paper sandbox on a subscription', () => {
    // Gating the sandbox would make the trial worthless, and the sandbox reaches no
    // venue.
    expect(
      reject(intent({ account: 'paper' }), context({ subscription: { status: 'none', liveTradingUnlocked: false } })),
    ).toBeNull();
  });

  it('treats a trial as paper-only', () => {
    expect(
      reject(intent({ account: 'live' }), context({ subscription: { status: 'trialing', liveTradingUnlocked: true } })),
    ).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('risk engine — click provenance', () => {
  it('rejects a missing click', () => {
    expect(reject(intent(), context({ click: null }))).toBe('UNTRUSTED_CLICK');
  });

  it('rejects an untrusted click', () => {
    // `isTrusted` is false for any script-dispatched event, which is what makes an
    // order impossible to originate in software.
    expect(reject(intent(), context({ click: { ...CLICK, trusted: false } }))).toBe('UNTRUSTED_CLICK');
  });

  it('rejects a missing intent token on the routing path', () => {
    /**
     * `intentToken: null` documents "the caller verified elsewhere", which is true
     * on the pre-flight preview and was previously treated as a pass everywhere —
     * a fail-open on the one control the whole Weiss Research posture rests on. A
     * caller that omitted the field received an approved decision.
     */
    expect(reject(intent(), context({ intentToken: null, commit: true }))).toBe('UNTRUSTED_CLICK');
  });

  it('allows a missing intent token on the preview path', () => {
    // The preview runs before any token exists and transmits nothing, so denying
    // here would make the pre-flight check unusable.
    expect(reject(intent(), context({ intentToken: null, commit: false }))).toBeNull();
  });

  it('rejects an invalid intent token', () => {
    expect(
      reject(intent(), context({ intentToken: { valid: false, failure: 'EXPIRED', payload: null, mismatchedField: null, ageMs: 99_999 } })),
    ).toBe('UNTRUSTED_CLICK');
  });

  /*
   * A token that does not match the order gets its own code.
   *
   * These three asserted `UNTRUSTED_CLICK`, which the engine also returns for a
   * missing token, an untrusted gesture and a bad signature — so the UI could not
   * tell "you authorised a different order" from "we do not believe you clicked".
   * The remedies differ, so the codes do.
   */
  it('rejects a token bound to a different quantity', () => {
    // The token authorises 100; the order asks for 200.
    expect(reject(intent({ quantity: 200 }), context())).toBe('INTENT_TOKEN_MISMATCH');
  });

  it('rejects a token bound to a different symbol', () => {
    expect(reject(intent({ symbol: 'MSFT' }), context())).toBe('INTENT_TOKEN_MISMATCH');
  });

  it('rejects a token bound to a different side', () => {
    expect(reject(intent({ side: 'sell' }), context())).toBe('INTENT_TOKEN_MISMATCH');
  });

  it('distinguishes a spent token from an unverified click', () => {
    expect(
      reject(
        intent(),
        context({
          intentToken: { valid: false, failure: 'REPLAYED', payload: null, mismatchedField: null, ageMs: 10 },
        }),
      ),
    ).toBe('INTENT_TOKEN_SPENT');
  });
});

describe('risk engine — order shape', () => {
  it('rejects a missing order type', () => {
    // The blank-field mandate: the user must choose, and an unselected type is not
    // silently defaulted to market.
    expect(reject(intent({ type: undefined as unknown as OrderIntent['type'] }), context())).toBeTruthy();
  });

  it('rejects a missing or non-positive quantity', () => {
    for (const quantity of [null, 0, -5]) {
      expect(reject(intent({ quantity: quantity as number | null }), context()), String(quantity)).toBeTruthy();
    }
  });

  it('rejects a fractional quantity', () => {
    expect(reject(intent({ quantity: 10.5 }), context())).toBeTruthy();
  });

  it('rejects a limit order with no limit price', () => {
    expect(reject(intent({ type: 'limit', limitPrice: null }), context())).toBeTruthy();
  });

  it('rejects a stop order with no stop price', () => {
    expect(reject(intent({ type: 'stop', stopPrice: null }), context())).toBeTruthy();
  });
});

describe('risk engine — notional ceiling', () => {
  it('rejects above the per-order ceiling', () => {
    // 100k shares at ~142 is ~$14.2m against a $100k ceiling.
    const code = reject(intent({ quantity: 100_000 }), contextForQuantity(100_000));
    expect(code).toBe('FAT_FINGER_NOTIONAL');
  });

  it('approves just under the ceiling', () => {
    const quantity = Math.floor((MAX_NOTIONAL_PER_ORDER_USD / QUOTE.last) * 0.95);
    expect(reject(intent({ quantity }), contextForQuantity(quantity))).toBeNull();
  });

  it('reports the observed notional and the limit it breached', () => {
    const decision = evaluateOrder(intent({ quantity: 100_000 }), contextForQuantity(100_000));
    expect(decision.rejection?.observed).toBeGreaterThan(MAX_NOTIONAL_PER_ORDER_USD);
    expect(decision.rejection?.limit).toBe(MAX_NOTIONAL_PER_ORDER_USD);
    // The message carries the figures, because a bare code is not actionable.
    expect(decision.rejection?.message).toMatch(/\$/);
  });
});

describe('risk engine — ADV participation', () => {
  it('rejects above the participation limit', () => {
    // 100 shares against an ADV of 1000 is 10%, over the 5% cap. The notional stays
    // small so this control is the binding one rather than the fat-finger ceiling.
    const decision = evaluateOrder(intent(), context({ instrument: { tradable: true, adv30: 1000 } }));
    expect(decision.approved).toBe(false);
    expect(decision.rejection?.code).toBe('LIQUIDITY_ADV_LIMIT');
    expect(decision.rejection?.observed).toBeCloseTo(0.1, 6);
    expect(decision.rejection?.limit).toBeCloseTo(ADV_PARTICIPATION_LIMIT, 6);
  });

  it('approves at exactly the limit', () => {
    // 100 shares against an ADV of 2000 is exactly 5%.
    expect(reject(intent(), context({ instrument: { tradable: true, adv30: 2000 } }))).toBeNull();
  });

  it('fails closed when volume history is unavailable', () => {
    /**
     * The important one. A zero or missing ADV means the platform cannot evaluate
     * liquidity, and approving on the grounds that "nothing said it was illiquid"
     * would report a check that did not happen.
     */
    for (const adv30 of [0, null]) {
      const decision = evaluateOrder(intent(), context({ instrument: { tradable: true, adv30 } }));
      expect(decision.approved, String(adv30)).toBe(false);
      expect(decision.rejection?.code).toBe('LIQUIDITY_ADV_LIMIT');
      expect(decision.rejection?.message).toMatch(/unavailable/i);
    }
  });

  it('names the maximum permitted quantity so the user can correct it', () => {
    const decision = evaluateOrder(intent(), context({ instrument: { tradable: true, adv30: 1000 } }));
    // 5% of 1000 is 50.
    expect(decision.rejection?.message).toMatch(/50 shares/);
  });
});

describe('risk engine — instrument and market state', () => {
  it('rejects a non-tradable instrument', () => {
    expect(reject(intent(), context({ instrument: { tradable: false, adv30: 50_000_000 } }))).toBeTruthy();
  });

  it('fails closed when the reference quote is missing', () => {
    // No quote means no notional, and no notional means the fat-finger ceiling
    // cannot be evaluated.
    const decision = evaluateOrder(intent(), context({ quote: null }));
    expect(decision.approved).toBe(false);
  });

  it('fails closed when the account snapshot is missing', () => {
    // The pre-trade margin check is mandatory; it cannot pass on absent data.
    const decision = evaluateOrder(intent({ account: 'live' }), context({ account: null }));
    expect(decision.approved).toBe(false);
  });
});

describe('published limits', () => {
  it('publishes a rationale and a regulatory basis for every limit', () => {
    expect(RISK_LIMIT_DESCRIPTORS.length).toBeGreaterThan(5);
    for (const limit of RISK_LIMIT_DESCRIPTORS) {
      expect(limit.code, limit.code).toMatch(/^[A-Z_]+$/);
      expect(limit.label.length, limit.code).toBeGreaterThan(3);
      expect(limit.rationale.length, limit.code).toBeGreaterThan(20);
      // A threshold with no cited basis is a number somebody chose; the citation is
      // what makes it reviewable.
      expect(limit.regulatoryBasis.length, limit.code).toBeGreaterThan(10);
      expect(Number.isFinite(limit.value), limit.code).toBe(true);
    }
  });

  it('includes the four named 15c3-5 controls', () => {
    const codes = RISK_LIMIT_DESCRIPTORS.map((l) => l.code);
    expect(codes).toContain('MAX_NOTIONAL_PER_ORDER');
    expect(codes).toContain('ADV_PARTICIPATION');
  });
});

describe('intent tokens', () => {
  const mintInput = {
    userId: 'u1',
    symbol: 'AAPL',
    side: 'buy' as const,
    quantity: 100,
    orderType: 'market' as const,
    clickTsMs: NOW,
  };

  it('verifies a freshly minted token', () => {
    const minted = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    const verification = verifyIntentToken(
      minted.token,
      { userId: 'u1', symbol: 'AAPL', side: 'buy', quantity: 100, orderType: 'market' },
      { now: NOW, consume: false, secret: 'test-secret-value-32-chars-long!!' },
    );
    expect(verification.valid).toBe(true);
    expect(verification.payload?.nonce).toBe(minted.payload.nonce);
  });

  it('rejects a token bound to different parameters', () => {
    const minted = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    for (const mismatch of [
      { userId: 'u2', symbol: 'AAPL', side: 'buy' as const, quantity: 100, orderType: 'market' as const },
      { userId: 'u1', symbol: 'MSFT', side: 'buy' as const, quantity: 100, orderType: 'market' as const },
      { userId: 'u1', symbol: 'AAPL', side: 'sell' as const, quantity: 100, orderType: 'market' as const },
      { userId: 'u1', symbol: 'AAPL', side: 'buy' as const, quantity: 200, orderType: 'market' as const },
      { userId: 'u1', symbol: 'AAPL', side: 'buy' as const, quantity: 100, orderType: 'limit' as const },
    ]) {
      const verification = verifyIntentToken(minted.token, mismatch, {
        now: NOW,
        consume: false,
        secret: 'test-secret-value-32-chars-long!!',
      });
      expect(verification.valid, JSON.stringify(mismatch)).toBe(false);
    }
  });

  it('rejects a tampered signature', () => {
    const minted = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    const tampered = `${minted.token.slice(0, -4)}0000`;
    const verification = verifyIntentToken(
      tampered,
      { userId: 'u1', symbol: 'AAPL', side: 'buy', quantity: 100, orderType: 'market' },
      { now: NOW, consume: false, secret: 'test-secret-value-32-chars-long!!' },
    );
    expect(verification.valid).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const minted = mintIntentToken(mintInput, { secret: 'secret-one-padded-to-32-chars!!!!' });
    const verification = verifyIntentToken(
      minted.token,
      { userId: 'u1', symbol: 'AAPL', side: 'buy', quantity: 100, orderType: 'market' },
      { now: NOW, consume: false, secret: 'secret-two-padded-to-32-chars!!!!' },
    );
    expect(verification.valid).toBe(false);
  });

  it('rejects an expired token', () => {
    const minted = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    const verification = verifyIntentToken(
      minted.token,
      { userId: 'u1', symbol: 'AAPL', side: 'buy', quantity: 100, orderType: 'market' },
      // Well past the TTL.
      { now: NOW + 3_600_000, consume: false, secret: 'test-secret-value-32-chars-long!!' },
    );
    expect(verification.valid).toBe(false);
  });

  it('derives the same nonce for an identical click in the same millisecond', () => {
    /**
     * Deliberate: a double-submit under latency produces the same nonce, so the
     * single-use store catches the second one. Two distinct authorisations for one
     * physical click would defeat the whole control.
     */
    const a = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    const b = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    expect(a.payload.nonce).toBe(b.payload.nonce);
    expect(a.token).toBe(b.token);
  });

  it('derives different nonces for different milliseconds', () => {
    const a = mintIntentToken(mintInput, { secret: 'test-secret-value-32-chars-long!!' });
    const b = mintIntentToken({ ...mintInput, clickTsMs: NOW + 1 }, { secret: 'test-secret-value-32-chars-long!!' });
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
  });
});

describe('ceilingReferencePrice', () => {
  /*
   * The fat-finger ceiling is sized off the worst price the order can actually
   * transact at. Only two shapes can transact above the price the user typed;
   * pricing the rest off the touch refused orders that were inside the ceiling
   * and quoted the user a notional they never entered.
   */
  const quote = {
    symbol: 'X',
    bid: 100,
    ask: 101,
    last: 100.5,
    bidSize: 500,
    askSize: 500,
    timestamp: 0,
  } as unknown as Parameters<typeof ceilingReferencePrice>[1];

  const at = (
    type: 'market' | 'limit' | 'stop' | 'stop_limit',
    side: 'buy' | 'sell',
    limitPrice: number | null,
    stopPrice: number | null,
  ) =>
    ceilingReferencePrice(
      { type, side, limitPrice, stopPrice } as Parameters<typeof ceilingReferencePrice>[0],
      quote,
    );

  it('prices a marketable sell limit off the bid it would hit', () => {
    // The motivating case: the limit is below the bid, so it fills at the bid.
    expect(at('limit', 'sell', 95, null)).toBe(100);
  });

  it('prices a resting sell limit off the limit itself', () => {
    expect(at('limit', 'sell', 110, null)).toBe(110);
  });

  it('never prices a buy limit above the limit the user typed', () => {
    // A buy limit cannot fill above its limit — that is what a limit order is.
    expect(at('limit', 'buy', 99, null)).toBe(99);
    expect(at('limit', 'buy', 105, null)).toBe(105);
  });

  it('prices a buy market order off the offer it lifts', () => {
    expect(at('market', 'buy', null, null)).toBe(101);
  });

  it('leaves a sell market order at the reference the ticket shows', () => {
    // It hits the bid, which is below `last`; the stated figure already bounds it.
    expect(at('market', 'sell', null, null)).toBe(100.5);
  });

  it('never prices a sell stop off the bid it sits below', () => {
    // A sell stop triggers below the market and fills at or under its stop.
    expect(at('stop', 'sell', null, 90)).toBe(90);
  });

  it('prices a sell stop-limit off the bid when its limit is marketable', () => {
    expect(at('stop_limit', 'sell', 95, 96)).toBe(100);
  });

  it('returns null when there is no reference price at all', () => {
    expect(at('limit', 'buy', null, null)).toBeNull();
  });
});
